import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function run({ configured = true, fail = false, legacy = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-activation-test-"));
  try {
    mkdirSync(path.join(root, "src"));
    mkdirSync(path.join(root, "state"));
    if (configured) writeFileSync(path.join(root, "state/openclaw.json"), "{}");
    copyFileSync(new URL("./src/railway-start.mjs", import.meta.url), path.join(root, "src/railway-start.mjs"));
    copyFileSync(new URL("./src/weixin-bootstrap.mjs", import.meta.url), path.join(root, "src/weixin-bootstrap.mjs"));
    writeFileSync(path.join(root, "fake-openclaw.mjs"), `
      import assert from 'node:assert/strict';
      assert.deepEqual(process.argv.slice(2), ['doctor','--fix','--non-interactive']);
      assert.ok(process.env.OPENCLAW_IMAGE_ACTIVATION_CAPTURE_MARKER);
      assert.equal(process.env.CLAWDBOT_STATE_DIR, undefined);
      assert.equal(process.env.OPENCLAW_NO_RESPAWN, '1');
      console.log('DOCTOR'); process.exit(${fail ? 17 : 0});
    `);
    writeFileSync(path.join(root, "src/server.js"), `console.log('WRAPPER:' + process.env.OPENCLAW_NO_RESPAWN);`);
    const env = { PATH: process.env.PATH, HOME: root, OPENCLAW_ENTRY: path.join(root, "fake-openclaw.mjs") };
    env[legacy ? "CLAWDBOT_STATE_DIR" : "OPENCLAW_STATE_DIR"] = path.join(root, "state");
    return spawnSync(process.execPath, ["src/railway-start.mjs"], {cwd: root, env, encoding:"utf8", timeout:10000});
  } finally { rmSync(root, {recursive:true, force:true}); }
}

test("migration finishes before wrapper starts", () => {
  const r = run(); assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('DOCTOR')); assert.ok(r.stdout.includes('WRAPPER:1'));
  assert.ok(r.stdout.indexOf('DOCTOR') < r.stdout.indexOf('WRAPPER:1'));
});
test("failed migration prevents gateway/wrapper startup", () => {
  const r = run({fail:true}); assert.equal(r.status, 17);
  assert.ok(!r.stdout.includes('WRAPPER'));
});
test("new volume can reach initial setup without a config", () => {
  const r = run({configured:false}); assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes('DOCTOR')); assert.ok(r.stdout.includes('WRAPPER:1'));
});
test("legacy Railway state variable is normalized before migration", () => {
  const r = run({legacy:true}); assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('DOCTOR')); assert.ok(r.stdout.includes('WRAPPER:1'));
});
