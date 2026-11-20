import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { createWeixinLoginManager, hasWeixinCredentials } from "./src/weixin-login.mjs";

const QR = "████████████████\n██ ▄▀ ▄▀ ▄▀ ▄ ██\n████████████████\n";
const URL = "https://weixin.qq.com/test-only-login-link";
const tick = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate) {
  const end = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > end) assert.fail("fixture did not settle");
    await sleep(2);
  }
}

function fakeChild(events) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.input = [];
  child.stdin = new Writable({
    write(chunk, _encoding, callback) { child.input.push(chunk.toString()); callback(); },
  });
  child.signals = [];
  child.closed = false;
  child.kill = (signal) => { child.signals.push(signal); return true; };
  child.close = (code = 0, signal = null) => {
    if (child.closed) return;
    child.closed = true;
    events.push("close");
    child.emit("exit", code, signal);
    child.emit("close", code, signal);
  };
  return child;
}

async function fixture(t, options = {}) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "weixin-login-test-"));
  const events = [];
  const child = fakeChild(events);
  let lease = false;
  let spawns = 0;
  let restores = 0;
  const manager = createWeixinLoginManager({
    stateDir,
    timeoutMs: 60_000,
    killGraceMs: 10,
    spawnLogin() { events.push("spawn"); spawns++; return child; },
    async withGatewayStopped(action) {
      lease = true;
      events.push("lease");
      try { await options.stopGate?.promise; return await action(); }
      finally { lease = false; events.push("release"); }
    },
    async ensureGatewayRunning() {
      assert.equal(lease, false);
      assert.ok(!spawns || child.closed);
      restores++;
      events.push("restore");
      await options.restoreGate?.promise;
      if (options.restoreFailure) throw new Error("private runtime diagnostic");
    },
    signalChild(proc, signal) { assert.equal(proc, child); proc.kill(signal); },
    ...options.manager,
  });
  t.after(async () => {
    options.stopGate?.resolve();
    options.restoreGate?.resolve();
    const stopped = manager.shutdown();
    child.close(null, "SIGTERM");
    await stopped;
    await fs.rm(stateDir, { recursive: true, force: true });
  });
  return { stateDir, events, child, manager, get lease() { return lease; },
    get spawns() { return spawns; }, get restores() { return restores; } };
}

async function credentials(stateDir, id = "abcdef-im-bot", account = { token: "private-token", userId: "private-user" }) {
  const root = path.join(stateDir, "openclaw-weixin");
  await fs.mkdir(path.join(root, "accounts"), { recursive: true });
  await fs.writeFile(path.join(root, "accounts.json"), JSON.stringify([id]));
  await fs.writeFile(path.join(root, "accounts", `${id}.json`), JSON.stringify(account));
  return root;
}

test("successful login exposes only QR facts, then verifies credentials and restores after close", async (t) => {
  const f = await fixture(t);
  assert.equal(f.manager.status().phase, "idle");
  const started = f.manager.start();
  await until(() => f.spawns === 1);
  const bytes = Buffer.from(`${QR}\n备用链接：\n${URL}\nprivate-token <script>private-user</script>\n`);
  f.child.stdout.write(bytes.subarray(0, 11));
  f.child.stdout.write(bytes.subarray(11));
  const waiting = f.manager.status(started.id);
  assert.equal(waiting.active, true);
  assert.equal(waiting.qrText, QR.trimEnd());
  assert.equal(waiting.loginUrl, URL);
  assert.doesNotMatch(JSON.stringify(waiting), /private-token|private-user|script/);
  assert.throws(() => f.manager.start(), { statusCode: 409 });
  await credentials(f.stateDir);
  f.child.close();
  await until(() => !f.manager.status().active);
  const done = f.manager.status();
  assert.equal(done.phase, "complete");
  assert.equal(done.credentialsVerified, true);
  assert.equal(done.qrText, null);
  assert.equal(done.loginUrl, null);
  assert.equal(done.needsPin, false);
  assert.deepEqual(f.events, ["lease", "spawn", "close", "release", "restore"]);
});

test("exit zero without durable credentials is not success", async (t) => {
  const f = await fixture(t);
  f.manager.start();
  await until(() => f.spawns === 1);
  f.child.close();
  await until(() => !f.manager.status().active);
  assert.equal(f.manager.status().phase, "failed");
  assert.equal(f.manager.status().credentialsVerified, false);
  assert.equal(f.restores, 1);
});

test("saved credentials do not hide a plugin-reported write failure", async (t) => {
  const f = await fixture(t);
  await credentials(f.stateDir);
  f.manager.start();
  await until(() => f.spawns === 1);
  f.child.stderr.write("⚠️ 保存账号数据失败: private-token\n");
  f.child.close();
  await until(() => !f.manager.status().active);
  assert.equal(f.manager.status().phase, "failed");
  assert.doesNotMatch(JSON.stringify(f.manager.status()), /private-token/);
});

test("PIN is validated and piped only while requested, including split UTF-8 and retry prompts", async (t) => {
  const f = await fixture(t);
  const { id } = f.manager.start();
  await until(() => f.spawns === 1);
  const prompt = Buffer.from("输入手机微信显示的数字，以继续连接：");
  f.child.stdout.write(prompt.subarray(0, 5));
  f.child.stdout.write(prompt.subarray(5));
  assert.equal(f.manager.status().needsPin, true);
  assert.throws(() => f.manager.verify("wrong-job", "123456"), { statusCode: 404 });
  for (const pin of [123456, "123", "1e1234", "123456\n", "1234567890123"]) {
    assert.throws(() => f.manager.verify(id, pin), { statusCode: 400 });
  }
  f.manager.verify(id, "123456");
  assert.equal(f.manager.status().needsPin, false);
  assert.deepEqual(f.child.input, ["123456\n"]);
  assert.doesNotMatch(JSON.stringify(f.manager.status()), /123456/);
  assert.throws(() => f.manager.verify(id, "123456"), { statusCode: 409 });
  f.child.stdout.write("❌ 你输入的数字不匹配，请重新输入：");
  assert.equal(f.manager.status().needsPin, true);
  f.manager.verify(id, "654321");
  assert.deepEqual(f.child.input, ["123456\n", "654321\n"]);
  f.child.close(1);
  await until(() => !f.manager.status().active);
});

test("asynchronous PIN pipe errors do not crash or release the lease before close", async (t) => {
  const f = await fixture(t);
  const { id } = f.manager.start();
  await until(() => f.spawns === 1);
  f.child.stdout.write("输入手机微信显示的数字，以继续连接：");
  f.manager.verify(id, "123456");
  f.child.stdin.emit("error", new Error("EPIPE private-token"));
  assert.equal(f.manager.status().phase, "cancelling");
  assert.equal(f.lease, true);
  assert.equal(f.restores, 0);
  f.child.close(null, "SIGTERM");
  await until(() => !f.manager.status().active);
  assert.equal(f.manager.status().phase, "failed");
  assert.doesNotMatch(JSON.stringify(f.manager.status()), /EPIPE|private-token/);
});

test("timeout escalates signals but waits for close rather than exit before restoration", async (t) => {
  const f = await fixture(t, { manager: { timeoutMs: 10, killGraceMs: 5 } });
  f.manager.start();
  await until(() => f.child.signals.includes("SIGKILL"));
  assert.deepEqual(f.child.signals, ["SIGTERM", "SIGKILL"]);
  f.child.emit("exit", null, "SIGKILL");
  await tick();
  assert.equal(f.lease, true);
  assert.equal(f.restores, 0);
  assert.equal(f.manager.status().active, true);
  assert.throws(() => f.manager.start(), { statusCode: 409 });
  f.child.close(null, "SIGKILL");
  await until(() => !f.manager.status().active);
  assert.equal(f.manager.status().phase, "timedout");
  assert.equal(f.restores, 1);
});

test("cancel clears QR immediately and holds maintenance until child close", async (t) => {
  const f = await fixture(t);
  const { id } = f.manager.start();
  await until(() => f.spawns === 1);
  f.child.stdout.write(`${QR}\n${URL}\n`);
  f.manager.cancel(id);
  f.manager.cancel(id);
  assert.equal(f.manager.status().qrText, null);
  assert.equal(f.manager.status().loginUrl, null);
  assert.deepEqual(f.child.signals, ["SIGTERM"]);
  assert.equal(f.lease, true);
  f.child.stdout.write(`${URL}\n`);
  assert.equal(f.manager.status().loginUrl, null);
  f.child.close(0);
  await until(() => !f.manager.status().active);
  assert.equal(f.manager.status().phase, "cancelled");
});

test("natural leader close retains custody until detached descendants are gone", async (t) => {
  let alive = true;
  const f = await fixture(t, { manager: {
    isProcessGroupAlive: () => alive,
    groupPollMs: 2,
    killGraceMs: 5,
  } });
  await credentials(f.stateDir);
  const { id } = f.manager.start();
  await until(() => f.spawns === 1);
  f.child.stdout.write(`${QR}\n${URL}\n`);
  f.child.close();
  await until(() => f.manager.status().phase === "cleaning");
  assert.equal(f.manager.status().qrText, null);
  assert.equal(f.manager.status().loginUrl, null);
  assert.equal(f.lease, true);
  assert.equal(f.restores, 0);
  assert.throws(() => f.manager.start(), { statusCode: 409 });
  f.child.stdout.write(`${URL}\n`);
  assert.equal(f.manager.status().loginUrl, null);
  await until(() => f.child.signals.includes("SIGKILL"));
  assert.deepEqual(f.child.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(f.manager.status(id).active, true);
  alive = false;
  await until(() => !f.manager.status().active);
  assert.equal(f.manager.status().phase, "complete");
  assert.equal(f.restores, 1);
});

test("cancelled leader close does not release surviving descendants", async (t) => {
  let alive = true;
  const f = await fixture(t, { manager: {
    isProcessGroupAlive: () => alive,
    groupPollMs: 2,
    killGraceMs: 5,
  } });
  const { id } = f.manager.start();
  await until(() => f.spawns === 1);
  f.manager.cancel(id);
  f.child.close(null, "SIGTERM");
  await until(() => f.child.signals.includes("SIGKILL"));
  assert.equal(f.lease, true);
  assert.equal(f.restores, 0);
  assert.deepEqual(f.child.signals, ["SIGTERM", "SIGKILL"]);
  alive = false;
  await until(() => !f.manager.status().active);
  assert.equal(f.manager.status().phase, "cancelled");
  assert.equal(f.restores, 1);
});

test("group probe errors fail closed and shutdown waits for a confirmed empty group", async (t) => {
  let probeFailed = true;
  const f = await fixture(t, { manager: {
    isProcessGroupAlive() {
      if (probeFailed) throw new Error("private group diagnostic");
      return false;
    },
    groupPollMs: 2,
    killGraceMs: 5,
  } });
  f.manager.start();
  await until(() => f.spawns === 1);
  f.child.close();
  await until(() => f.child.signals.includes("SIGKILL"));
  let finished = false;
  const stopped = f.manager.shutdown().then(() => { finished = true; });
  await sleep(5);
  assert.equal(finished, false);
  assert.equal(f.lease, true);
  assert.equal(f.restores, 0);
  assert.doesNotMatch(JSON.stringify(f.manager.status()), /private group/);
  probeFailed = false;
  await stopped;
  assert.equal(f.lease, false);
  assert.equal(f.restores, 0);
  assert.equal(f.manager.status().phase, "cancelled");
});

test("cancel while the Gateway is stopping never spawns a login child", async (t) => {
  const stopGate = deferred();
  const f = await fixture(t, { stopGate });
  const { id } = f.manager.start();
  f.manager.cancel(id);
  assert.equal(f.spawns, 0);
  assert.equal(f.lease, true);
  stopGate.resolve();
  await until(() => !f.manager.status().active);
  assert.equal(f.spawns, 0);
  assert.equal(f.restores, 1);
  assert.equal(f.manager.status().phase, "cancelled");
});

test("restoring owns the job; cancel cannot start another operation or alter completed login", async (t) => {
  const restoreGate = deferred();
  const f = await fixture(t, { restoreGate });
  await credentials(f.stateDir);
  const { id } = f.manager.start();
  await until(() => f.spawns === 1);
  f.child.close();
  await until(() => f.manager.status().phase === "restoring");
  f.manager.cancel(id);
  assert.equal(f.manager.status().phase, "restoring");
  assert.throws(() => f.manager.start(), { statusCode: 409 });
  restoreGate.resolve();
  await until(() => !f.manager.status().active);
  assert.equal(f.manager.status().phase, "complete");
});

test("shutdown waits for child close and never restarts the Gateway", async (t) => {
  const f = await fixture(t);
  f.manager.start();
  await until(() => f.spawns === 1);
  let finished = false;
  const shuttingDown = f.manager.shutdown().then(() => { finished = true; });
  await tick();
  assert.equal(finished, false);
  assert.equal(f.lease, true);
  f.child.close(null, "SIGTERM");
  await shuttingDown;
  assert.equal(f.restores, 0);
  assert.throws(() => f.manager.start(), { statusCode: 409 });
});

test("QR refresh removes the previous QR and URL, and partial or unsafe URLs stay hidden", async (t) => {
  const f = await fixture(t);
  f.manager.start();
  await until(() => f.spawns === 1);
  f.child.stdout.write(`${QR}\n${URL}\n`);
  f.child.stdout.write("二维码已过期，正在刷新...");
  assert.equal(f.manager.status().qrText, null);
  assert.equal(f.manager.status().loginUrl, null);
  f.child.stdout.write("\nhttps://evil.test/\nhttps://qq.com.evil.test/\nhttps://user@weixin.qq.com/\nhttps://weixin.qq.com:8443/\n");
  assert.equal(f.manager.status().loginUrl, null);
  f.child.stdout.write(`\n${QR}\nhttps://weixin.qq.com/new-`);
  assert.equal(f.manager.status().loginUrl, null);
  f.child.stdout.write("link\n");
  assert.equal(f.manager.status().loginUrl, "https://weixin.qq.com/new-link");
  assert.equal(f.manager.status().qrText, QR.trimEnd());
  f.child.close(1);
  await until(() => !f.manager.status().active);
});

test("spawn and restore failures retain only generic safe diagnostics", async (t) => {
  const f = await fixture(t, { restoreFailure: true, manager: {
    spawnLogin() { throw new Error("private-token spawn failed"); },
  } });
  f.manager.start();
  await until(() => !f.manager.status().active);
  assert.equal(f.manager.status().phase, "failed");
  assert.equal(f.restores, 1);
  assert.doesNotMatch(JSON.stringify(f.manager.status()), /private-token|private runtime/);
});

test("credential verification rejects malformed state, missing user IDs, traversal and symlinks", async (t) => {
  const f = await fixture(t);
  assert.equal(await hasWeixinCredentials(f.stateDir), false);
  const root = await credentials(f.stateDir, "abcdef-im-bot", { token: "secret" });
  assert.equal(await hasWeixinCredentials(f.stateDir), false);
  await credentials(f.stateDir);
  assert.equal(await hasWeixinCredentials(f.stateDir), true);
  const index = path.join(root, "accounts.json");
  await fs.writeFile(index, JSON.stringify(["../outside"]));
  assert.equal(await hasWeixinCredentials(f.stateDir), false);
  await fs.writeFile(index, JSON.stringify(["abcdef-im-bot"]));
  const accountPath = path.join(root, "accounts", "abcdef-im-bot.json");
  const elsewhere = path.join(f.stateDir, "outside.json");
  await fs.rename(accountPath, elsewhere);
  await fs.symlink(elsewhere, accountPath);
  assert.equal(await hasWeixinCredentials(f.stateDir), false);
  await fs.unlink(accountPath);
  await fs.rename(elsewhere, accountPath);
  await fs.rename(index, elsewhere);
  await fs.symlink(elsewhere, index);
  assert.equal(await hasWeixinCredentials(f.stateDir), false);
});
