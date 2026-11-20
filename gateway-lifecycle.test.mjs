import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createGatewayLifecycle } from "./src/gateway-lifecycle.js";

function child() {
  const proc = new EventEmitter();
  proc.signals = [];
  proc.kill = (signal) => { proc.signals.push(signal); return true; };
  return proc;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("a stop waits for close, including after exit, before replacement or state writes", async () => {
  const lifecycle = createGatewayLifecycle();
  const proc = child();
  lifecycle.track(proc);
  let restored = false;
  const stopping = lifecycle.withStopped(() => { restored = true; });
  assert.deepEqual(proc.signals, ["SIGTERM"]);
  proc.emit("exit", 0, null);
  await Promise.resolve();
  assert.equal(lifecycle.child, proc);
  assert.equal(restored, false);
  assert.throws(() => lifecycle.assertCanStart(), /maintenance/);
  proc.emit("close", 0, null);
  await stopping;
  assert.equal(lifecycle.child, null);
  assert.equal(restored, true);
  const replacement = child();
  lifecycle.track(replacement);
  // A duplicate late event from an older generation cannot clear the new child.
  proc.emit("close", 0, null);
  assert.equal(lifecycle.child, replacement);
});

test("concurrent stops share the same close wait and send one signal", async () => {
  const lifecycle = createGatewayLifecycle();
  const proc = child();
  lifecycle.track(proc);
  const first = lifecycle.stop();
  const second = lifecycle.stop();
  assert.equal(first, second);
  assert.deepEqual(proc.signals, ["SIGTERM"]);
  proc.emit("close", 0, null);
  await Promise.all([first, second]);
});

test("timeout retains custody, blocks replacement, and never runs reset or restore", async () => {
  const lifecycle = createGatewayLifecycle({ stopTimeoutMs: 5 });
  const proc = child();
  lifecycle.track(proc);
  let changedState = false;
  await assert.rejects(
    lifecycle.withStopped(() => { changedState = true; }),
    /still tracking the existing process/,
  );
  assert.equal(changedState, false);
  assert.equal(lifecycle.child, proc);
  assert.throws(() => lifecycle.track(child()), /already managed/);
  assert.deepEqual(proc.signals, ["SIGTERM"]);
  // The listener retaining custody remains installed after the timeout.
  proc.emit("close", 0, null);
  assert.equal(lifecycle.child, null);
});

test("failure to signal retains custody and prevents state changes", async () => {
  const lifecycle = createGatewayLifecycle();
  const proc = child();
  proc.kill = () => { throw new Error("signal refused"); };
  lifecycle.track(proc);
  await assert.rejects(lifecycle.withStopped(() => assert.fail("must not write")), /signal refused/);
  assert.equal(lifecycle.child, proc);
  proc.emit("close", 0, null);
  assert.equal(lifecycle.child, null);
});

test("restore keeps automatic starts blocked after close until all writes finish", async () => {
  const lifecycle = createGatewayLifecycle();
  const proc = child();
  lifecycle.track(proc);
  const writeStarted = deferred();
  const finishWrite = deferred();
  const restoring = lifecycle.withStopped(async () => {
    writeStarted.resolve();
    await finishWrite.promise;
  });
  proc.emit("close", 0, null);
  await writeStarted.promise;
  assert.equal(lifecycle.child, null);
  assert.throws(() => lifecycle.assertCanStart(), /maintenance/);
  await assert.rejects(lifecycle.withStopped(() => {}), /maintenance/);
  finishWrite.resolve();
  await restoring;
  lifecycle.assertCanStart();
});

test("container shutdown rejects new work and still waits for its managed child", async () => {
  const lifecycle = createGatewayLifecycle();
  const proc = child();
  lifecycle.track(proc);
  const stopping = lifecycle.shutdown();
  assert.equal(lifecycle.child, proc);
  assert.throws(() => lifecycle.assertCanStart(), /stopping/);
  proc.emit("close", 0, null);
  await stopping;
  assert.equal(lifecycle.child, null);
  assert.throws(() => lifecycle.track(child()), /stopping/);
});
