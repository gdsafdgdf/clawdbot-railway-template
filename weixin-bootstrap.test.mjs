import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bootstrapWeixin, createOpenClawRunner } from "./src/weixin-bootstrap.mjs";

const list = ["plugins", "list", "--json"];
const inspect = ["plugins", "inspect", "openclaw-weixin", "--runtime", "--json"];
const install = ["plugins", "install", "npm:@tencent-weixin/openclaw-weixin@2.4.10", "--pin", "--force", "--no-enable"];
const disable = ["plugins", "disable", "openclaw-weixin"];
const enable = ["plugins", "enable", "openclaw-weixin"];
const plugin = (overrides = {}) => ({ id: "openclaw-weixin", packageName: "@tencent-weixin/openclaw-weixin",
  version: "2.4.10", packageVersion: "2.4.10", enabled: true, explicitlyEnabled: true, status: "loaded", imported: true,
  dependencyStatus: { requiredInstalled: true }, ...overrides });
const inventory = plugins => JSON.stringify({ plugins, diagnostics: [] });
const runtime = (overrides = {}) => JSON.stringify({ plugin: plugin(), install: {
  source: "npm", spec: "@tencent-weixin/openclaw-weixin@2.4.10",
  resolvedSpec: "@tencent-weixin/openclaw-weixin@2.4.10", version: "2.4.10",
}, ...overrides });
const ok = stdout => ({ code: 0, custodyReleased: true, stdout: stdout ?? "", stderr: "" });

function fixture(t) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-bootstrap-test-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const marker = name => path.join(stateDir, "railway-bootstrap", "weixin-2.4.10", name);
  const env = { OPENCLAW_BOOTSTRAP_WEIXIN: "2.4.10" };
  const calls = [];
  const makeRunner = steps => async request => {
    calls.push(request.args);
    const step = steps.shift();
    assert.ok(step, `Unexpected CLI call: ${request.args.join(" ")}`);
    assert.deepEqual(request.args, step[0]);
    return typeof step[1] === "function" ? await step[1](request) : step[1];
  };
  return { stateDir, marker, env, calls, makeRunner,
    run: steps => bootstrapWeixin({ stateDir, env, run: makeRunner(steps) }) };
}

test("opt-in accepts only the reviewed exact version and makes no CLI calls otherwise", async t => {
  const f = fixture(t);
  for (const value of [undefined, "", "latest", "2.4.9", "2.4.10 --force"]) {
    const result = await bootstrapWeixin({ stateDir: f.stateDir,
      env: { OPENCLAW_BOOTSTRAP_WEIXIN: value }, run: () => assert.fail("must not execute") });
    assert.equal(result.continueStartup, true);
    assert.equal(result.status, value ? "unsupported-version" : "disabled");
  }
  assert.equal(fs.existsSync(f.marker("attempt.json")), false);
});

test("fresh install uses fixed official flags, waits for real runtime proof, and records private evidence", async t => {
  const f = fixture(t);
  const config = path.join(f.stateDir, "openclaw.json");
  fs.writeFileSync(config, '{"sentinel":"keep"}');
  const result = await f.run([[list, ok(inventory([]))], [install, () => {
    assert.ok(fs.existsSync(f.marker("attempt.json")), "attempt must precede installer");
    assert.equal(fs.existsSync(f.marker("verified.json")), false);
    return ok();
  }], [list, ok(inventory([plugin({ explicitlyEnabled: false })]))], [enable, ok()], [inspect, ok(runtime())]]);
  assert.equal(result.status, "installed-and-verified");
  assert.equal(result.continueStartup, true);
  const proof = JSON.parse(fs.readFileSync(f.marker("verified.json"), "utf8"));
  assert.equal(proof.imported, true);
  assert.equal(proof.spec, "@tencent-weixin/openclaw-weixin@2.4.10");
  assert.equal(fs.statSync(f.marker("attempt.json")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(result.diagnosticsPath).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(config, "utf8"), '{"sentinel":"keep"}');
});

test("existing exact install is inspected without installation or config mutation", async t => {
  const f = fixture(t);
  const result = await f.run([[list, ok(inventory([plugin()]))], [inspect, ok(runtime())]]);
  assert.equal(result.status, "verified-existing");
  assert.equal(fs.existsSync(f.marker("attempt.json")), false);
  assert.deepEqual(f.calls, [list, inspect]);
});

test("an interrupted installation without explicit enablement is left for review", async t => {
  const f = fixture(t);
  const result = await f.run([
    [list, ok(inventory([plugin({ explicitlyEnabled: false })]))],
    [inspect, ok(runtime({ plugin: plugin({ explicitlyEnabled: false }) }))],
  ]);
  assert.equal(result.status, "needs-review");
  assert.equal(result.continueStartup, true);
});

test("existing disabled or conflicting packages are never enabled, replaced or disabled", async t => {
  for (const existing of [plugin({ enabled: false, status: "disabled" }), plugin({ version: "2.4.9" }),
    plugin({ packageName: "different" }), plugin({ dependencyStatus: undefined })]) {
    const f = fixture(t);
    const result = await f.run([[list, ok(inventory([existing]))]]);
    assert.equal(result.status, "needs-review");
    assert.equal(result.continueStartup, true);
    assert.deepEqual(f.calls, [list]);
    assert.equal(fs.existsSync(f.marker("attempt.json")), false);
  }
});

test("unknown inventory never becomes permission to install", async t => {
  for (const response of [ok("invalid-json"), ok("{}"), ok(inventory([null])),
    ok(JSON.stringify({ plugins: [], diagnostics: [{ level: "error" }] })),
    { ...ok(inventory([])), code: 1 }, { ...ok(inventory([])), stdoutTruncated: true }]) {
    const f = fixture(t);
    const result = await f.run([[list, response]]);
    assert.equal(result.status, "bootstrap-failed");
    assert.equal(fs.existsSync(f.marker("attempt.json")), false);
    assert.deepEqual(f.calls, [list]);
  }
});

test("failed install is not retried, but later manual repair can still verify", async t => {
  const f = fixture(t);
  const failure = await f.run([[list, ok(inventory([]))], [install, { ...ok(), code: 1, stderr: "consent required" }],
    [list, ok(inventory([]))]]);
  assert.equal(failure.status, "install-failed");
  assert.equal(failure.continueStartup, true);
  assert.equal(fs.existsSync(f.marker("verified.json")), false);
  const retry = await f.run([[list, ok(inventory([]))]]);
  assert.equal(retry.status, "already-attempted");
  assert.ok(fs.existsSync(failure.diagnosticsPath), "original diagnostics must survive restart");
  const repaired = await f.run([[list, ok(inventory([plugin()]))], [inspect, ok(runtime())]]);
  assert.equal(repaired.status, "verified-existing");
  assert.equal(f.calls.filter(args => args[1] === "install").length, 1);
});

test("simultaneous bootstrap callers share one complete installation and verification", async t => {
  const f = fixture(t);
  let release;
  const pause = new Promise(resolve => { release = resolve; });
  const run = f.makeRunner([[list, async () => { await pause; return ok(inventory([])); }],
    [install, ok()], [list, ok(inventory([plugin()]))], [enable, ok()], [inspect, ok(runtime())]]);
  const options = { stateDir: f.stateDir, env: f.env, run };
  const first = bootstrapWeixin(options);
  const second = bootstrapWeixin(options);
  assert.equal(first, second);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, "installed-and-verified");
  assert.equal(a, b);
  assert.equal(f.calls.filter(args => args[1] === "install").length, 1);
});

test("fresh disabled installation preserves activation policy instead of enabling it", async t => {
  const f = fixture(t);
  const result = await f.run([[list, ok(inventory([]))], [install, ok()],
    [list, ok(inventory([plugin({ enabled: false, status: "disabled" })]))]]);
  assert.equal(result.status, "installed-disabled");
  assert.equal(result.continueStartup, true);
  assert.equal(fs.existsSync(f.marker("verified.json")), false);
});

test("failed explicit enable cleans up only the new install and does not attempt runtime loading", async t => {
  const f = fixture(t);
  const result = await f.run([[list, ok(inventory([]))], [install, ok()],
    [list, ok(inventory([plugin({ explicitlyEnabled: false })]))], [enable, { ...ok(), code: 1 }],
    [disable, ok()], [list, ok(inventory([plugin({ enabled: false, status: "disabled" })]))]]);
  assert.equal(result.status, "installed-disabled");
  assert.equal(result.continueStartup, true);
  assert.ok(!f.calls.some(args => args[1] === "inspect"));
  assert.equal(fs.existsSync(f.marker("verified.json")), false);
});

test("runtime failure only disables this invocation's new install and verifies cleanup", async t => {
  for (const response of [ok(runtime({ plugin: plugin({ imported: false }) })),
    ok(runtime({ plugin: plugin({ status: "error" }) })),
    ok(runtime({ plugin: plugin({ explicitlyEnabled: false }) })),
    ok(runtime({ install: { source: "path", version: "2.4.10" } })),
    { ...ok(), code: 1 }, { ...ok(runtime()), timedOut: true }]) {
    const f = fixture(t);
    const result = await f.run([[list, ok(inventory([]))], [install, ok()],
      [list, ok(inventory([plugin()]))], [enable, ok()], [inspect, response], [disable, ok()],
      [list, ok(inventory([plugin({ enabled: false, status: "disabled" })]))]]);
    assert.equal(result.status, "installed-disabled");
    assert.equal(result.continueStartup, true);
    assert.equal(fs.existsSync(f.marker("verified.json")), false);
  }
});

test("existing install with invalid runtime provenance is left for review without disabling it", async t => {
  const f = fixture(t);
  const result = await f.run([[list, ok(inventory([plugin()]))], [inspect, ok(runtime({ install: {} }))]]);
  assert.equal(result.status, "needs-review");
  assert.equal(result.continueStartup, true);
  assert.deepEqual(f.calls, [list, inspect]);
  assert.equal(fs.existsSync(f.marker("verified.json")), false);
});

test("unreaped installer or interrupted boot cannot hand custody to Gateway", async t => {
  for (const bad of [{ ...ok(), code: null, custodyReleased: false, timedOut: true },
    { ...ok(), interrupted: "SIGTERM" }]) {
    const f = fixture(t);
    const result = await f.run([[list, ok(inventory([]))], [install, bad]]);
    assert.equal(result.continueStartup, false);
    assert.equal(result.status, "install-failed");
    assert.equal(fs.existsSync(f.marker("verified.json")), false);
  }
});

test("failed installer that already committed is reconciled and safely disabled on runtime failure", async t => {
  const f = fixture(t);
  const result = await f.run([[list, ok(inventory([]))], [install, { ...ok(), code: 1 }],
    [list, ok(inventory([plugin()]))], [enable, ok()], [inspect, { ...ok(), code: 1 }], [disable, ok()],
    [list, ok(inventory([plugin({ enabled: false, status: "disabled" })]))]]);
  assert.equal(result.status, "installed-disabled");
  assert.equal(result.continueStartup, true);
  assert.equal(fs.existsSync(f.marker("verified.json")), false);
});

test("unverified disable cannot report a safe continuation for this boot", async t => {
  const f = fixture(t);
  const result = await f.run([[list, ok(inventory([]))], [install, ok()],
    [list, ok(inventory([plugin()]))], [enable, ok()], [inspect, { ...ok(), code: 1 }], [disable, { ...ok(), code: 1 }]]);
  assert.equal(result.status, "disable-unverified");
  assert.equal(result.continueStartup, false);
  assert.equal(fs.existsSync(f.marker("verified.json")), false);
});

test("diagnostic write failure after install cannot skip runtime verification or cleanup", async t => {
  const f = fixture(t);
  const originalOpen = fs.openSync;
  let full = false;
  t.mock.method(fs, "openSync", (file, ...args) => {
    if (full && path.basename(String(file)).startsWith("diagnostics-")) {
      throw Object.assign(new Error("simulated full diagnostics volume"), { code: "ENOSPC" });
    }
    return originalOpen(file, ...args);
  });
  const result = await f.run([[list, ok(inventory([]))], [install, () => { full = true; return ok(); }],
    [list, ok(inventory([plugin()]))], [enable, ok()], [inspect, { ...ok(), code: 1 }], [disable, ok()],
    [list, ok(inventory([plugin({ enabled: false, status: "disabled" })]))]]);
  assert.equal(result.status, "installed-disabled");
  assert.equal(result.continueStartup, true);
  assert.match(result.diagnosticsWarning, /full diagnostics/);
});

test("failure to write a success marker does not disable a runtime that was verified", async t => {
  const f = fixture(t);
  const originalOpen = fs.openSync;
  t.mock.method(fs, "openSync", (file, ...args) => {
    if (file === f.marker("verified.json")) throw new Error("simulated marker write failure");
    return originalOpen(file, ...args);
  });
  const result = await f.run([[list, ok(inventory([]))], [install, ok()],
    [list, ok(inventory([plugin()]))], [enable, ok()], [inspect, ok(runtime())]]);
  assert.equal(result.status, "bootstrap-failed");
  assert.equal(result.continueStartup, true);
  assert.ok(!f.calls.some(args => args[1] === "disable"));
  assert.equal(fs.existsSync(f.marker("verified.json")), false);
});

test("real runner bounds output and waits for timeout termination before returning custody", async t => {
  const f = fixture(t);
  const entry = path.join(f.stateDir, "timeout.mjs");
  fs.writeFileSync(entry, "process.stdout.write('x'.repeat(1000)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");
  const run = createOpenClawRunner({ timeoutMs: 150, terminateGraceMs: 50, killGraceMs: 500, outputLimitBytes: 64 });
  const result = await run({ entry, args: [], env: process.env });
  assert.equal(result.timedOut, true);
  assert.equal(result.custodyReleased, true);
  assert.equal(result.signal, "SIGKILL");
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stdout.length, 64);
});
