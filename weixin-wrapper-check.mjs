// Run inside the candidate image. All credentials/state below belong to this fixture.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const cwd = "/opt/railway-wrapper";
console.log("WEIXIN_WRAPPER_CHECK: fixture revision 1 starting");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-full-wrapper-"));
const state = path.join(root, "state");
const workspace = path.join(root, "workspace");
const token = crypto.randomBytes(32).toString("hex");
const password = crypto.randomBytes(32).toString("hex");
const basic = `Basic ${Buffer.from(`fixture:${password}`).toString("base64")}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const redact = (text) => text.replaceAll(token, "[fixture-token]").replaceAll(password, "[fixture-password]").replaceAll(basic, "[fixture-basic]");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let done = false;
    const finish = (open) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(1_000, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function checkWrapperWs(connectToken, expectedDetailCode) {
  // Reuse the official image's WS dependency; install nothing in the fixture.
  const WebSocket = createRequire("/app/package.json")("ws");
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyRaw = publicKey.export({ format: "jwk" }).x;
  const deviceId = crypto.createHash("sha256")
    .update(Buffer.from(publicKeyRaw, "base64url")).digest("hex");

  return new Promise((resolve, reject) => {
    let done = false;
    let challenged = false;
    const id = crypto.randomUUID();
    const ws = new WebSocket(base.replace(/^http/, "ws"), {
      perMessageDeflate: false,
      headers: {
        authorization: basic,
        origin: base,
        "x-forwarded-for": "198.51.100.23",
        "x-forwarded-proto": "https",
      },
    });
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ws.terminate();
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(
      () => finish(new Error("WS fixture handshake timed out")), 40_000,
    );
    ws.on("error", finish);
    ws.on("unexpected-response", (_req, response) => {
      response.resume();
      finish(new Error(`WS upgrade returned ${response.statusCode}`));
    });
    ws.on("close", (code) => {
      if (!done) finish(new Error(`WS closed before result: ${code}`));
    });
    ws.on("message", (raw) => {
      if (done) return;
      try {
        const frame = JSON.parse(String(raw));
        if (frame.type === "event" && frame.event === "connect.challenge") {
          assert.equal(challenged, false, "Expected exactly one WS challenge");
          challenged = true;
          const { nonce, ts } = frame.payload;
          assert.equal(typeof nonce, "string");
          assert.ok(nonce.length > 0);
          assert.ok(Number.isInteger(ts) && ts >= 0);
          const scopes = ["operator.read"];
          // Official v3 device signature binds the server's nonce and timestamp.
          const signaturePayload = [
            "v3", deviceId, "cli", "cli", "operator", scopes.join(","),
            String(ts), connectToken, nonce, "linux", "",
          ].join("|");
          ws.send(JSON.stringify({
            type: "req", id, method: "connect",
            params: {
              minProtocol: 4, maxProtocol: 4,
              client: {
                id: "cli", mode: "cli", version: "2026.11.6", platform: "linux",
              },
              role: "operator", scopes, caps: [],
              // HTTP Basic remains untouched; Gateway auth comes from this frame.
              auth: { token: connectToken },
              device: {
                id: deviceId, publicKey: publicKeyRaw, signedAt: ts, nonce,
                signature: crypto.sign(
                  null, Buffer.from(signaturePayload), privateKey,
                ).toString("base64url"),
              },
            },
          }));
          return;
        }
        if (frame.type !== "res" || frame.id !== id) return;
        assert.ok(challenged, "WS response must follow connect.challenge");
        assert.equal(frame.ok, false, "Unpaired fixture must not authenticate");
        assert.equal(frame.error?.details?.code, expectedDetailCode);
        if (expectedDetailCode === "PAIRING_REQUIRED") {
          assert.equal(frame.error.code, "NOT_PAIRED");
          assert.equal(typeof frame.error.details.requestId, "string");
        }
        finish();
      } catch (error) { finish(error); }
    });
  });
}

async function logFixtureTrustedProxies() {
  // Fixture state only. Avoid starting a second CLI while testing the 2 GB limit.
  const config = JSON.parse(fs.readFileSync(path.join(state, "openclaw.json"), "utf8"));
  const proxies = config.gateway?.trustedProxies;
  assert.deepEqual(proxies, ["127.0.0.1"], "Migration must retain narrow proxy trust");
  console.log("WEIXIN_WRAPPER_CHECK: migrated gateway.trustedProxies retained");
}

const port = await freePort();
let gatewayPort;
do { gatewayPort = await freePort(); } while (gatewayPort === port);
for (const dir of [state, workspace, path.join(root, "home"), path.join(root, "tmp")]) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}
// Same minimal 3.8-era shape as cloud-fixture.mjs, with a legacy memory setting
// so the real Doctor migration is exercised before the wrapper starts.
fs.writeFileSync(path.join(state, "openclaw.json"), JSON.stringify({
  meta: { lastTouchedVersion: "2026.3.8" },
  agents: { defaults: {
    workspace, model: { primary: "openai/gpt-5.4" }, models: { "openai/gpt-5.4": {} },
    memorySearch: { enabled: false },
  } },
  gateway: {
    port: gatewayPort, mode: "local", bind: "loopback", auth: { mode: "token", token },
    trustedProxies: ["127.0.0.1"], tailscale: { mode: "off", resetOnExit: false },
    remote: { token },
    controlUi: { basePath: "/openclaw", allowedOrigins: [`http://127.0.0.1:${port}`] },
  },
}), { mode: 0o600 });

// Do not inherit provider keys, Railway credentials, production paths or settings.
const env = {
  PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin", HOME: path.join(root, "home"),
  TMPDIR: path.join(root, "tmp"), NODE_ENV: "production", PORT: String(port),
  OPENCLAW_ENTRY: "/app/openclaw.mjs", OPENCLAW_NODE: process.execPath,
  OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
  OPENCLAW_WORKSPACE_DIR: workspace, OPENCLAW_GATEWAY_TOKEN: token,
  INTERNAL_GATEWAY_PORT: String(gatewayPort), INTERNAL_GATEWAY_HOST: "127.0.0.1",
  OPENCLAW_NO_RESPAWN: "1", SETUP_PASSWORD: password,
  OPENCLAW_BOOTSTRAP_WEIXIN: "2.4.10",
};
const wrapper = spawn(process.execPath, ["src/railway-start.mjs"], {
  cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"],
});
let tail = "";
let sawActivation = false;
let exit;
let spawnFailure;
for (const stream of [wrapper.stdout, wrapper.stderr]) stream.on("data", (chunk) => {
  const text = String(chunk);
  sawActivation ||= text.includes("[activation] checking retained OpenClaw state");
  tail = (tail + redact(text)).slice(-24_000);
});
wrapper.once("error", (error) => { spawnFailure = error; });
const closed = new Promise((resolve) => wrapper.once("close", (code, signal) => {
  exit = { code, signal }; resolve(exit);
}));
const get = (url, headers = {}) => fetch(url, { headers, signal: AbortSignal.timeout(5_000) });
const base = `http://127.0.0.1:${port}`;
const direct = `http://127.0.0.1:${gatewayPort}`;
let passed = false;

try {
  let ready = false;
  const deadline = Date.now() + 360_000;
  while (Date.now() < deadline) {
    if (spawnFailure) throw spawnFailure;
    if (exit) throw new Error(`Wrapper exited before ready: ${JSON.stringify(exit)}`);
    try {
      const response = await get(`${base}/readyz`);
      if (response.ok && (await response.json()).ready === true) { ready = true; break; }
    } catch { /* Migration and gateway startup may still be in progress. */ }
    await sleep(1_000);
  }
  assert.ok(ready, "Wrapper /readyz did not become ready within six minutes");
  assert.ok(sawActivation, "Retained-state activation was not observed");
  const bootstrapStatus = tail.match(/\[weixin-bootstrap\] ([a-z-]+)\n/)?.[1];
  console.log(`WEIXIN_WRAPPER_CHECK: bootstrap status ${bootstrapStatus || "missing"}`);
  assert.equal(bootstrapStatus, "installed-and-verified", "Fresh bootstrap must verify runtime and explicit enablement");
  console.log("WEIXIN_WRAPPER_CHECK: legacy fixture activation and wrapper /readyz passed");
  await logFixtureTrustedProxies();

  const startup = await get(`${direct}/startupz`);
  assert.equal(startup.status, 200, "Gateway /startupz");
  assert.match(startup.headers.get("content-type") || "", /application\/json/);
  assert.equal(typeof await startup.json(), "object", "Probe must be JSON, not SPA fallback");
  const loopbackUi = await get(`${base}/openclaw`, { authorization: basic, accept: "text/html" });
  const loopbackBody = await loopbackUi.text();
  console.log(`WEIXIN_WRAPPER_CHECK: loopback proxy HTTP ${loopbackUi.status}: ${redact(loopbackBody.slice(0, 400))}`);
  assert.equal(loopbackUi.status, 403, "Unattributable loopback proxy chain must fail closed");
  // Model Railway's edge client attribution using an RFC 5737 fixture address.
  // A loopback-only proxy chain is intentionally rejected by current Gateway.
  const ui = await get(`${base}/openclaw`, {
    authorization: basic, accept: "text/html", "x-forwarded-for": "198.51.100.23",
    "x-forwarded-proto": "https",
  });
  const uiBody = await ui.text();
  if (ui.status !== 200) {
    console.log(`WEIXIN_WRAPPER_CHECK: edge fixture proxy HTTP ${ui.status}: ${redact(uiBody.slice(0, 400))}`);
  }
  assert.equal(ui.status, 200, `Proxied /openclaw: ${redact(uiBody.slice(0, 400))}`);
  assert.match(ui.headers.get("content-type") || "", /text\/html/);
  assert.match(uiBody, /openclaw/i, "Expected Control UI HTML");
  console.log("WEIXIN_WRAPPER_CHECK: gateway /startupz and authenticated proxied /openclaw passed");

  const denied = await get(`${base}/setup`);
  assert.equal(denied.status, 401, "Fixture /setup must require authentication");
  const setup = await get(`${base}/setup`, { authorization: basic });
  assert.equal(setup.status, 200, "Fixture /setup must accept its random password");
  assert.match(setup.headers.get("content-type") || "", /text\/html/);
  assert.match(await setup.text(), /连接个人微信/);
  console.log("WEIXIN_WRAPPER_CHECK: fixture /setup 401 and authenticated panel passed");

  await checkWrapperWs(crypto.randomBytes(32).toString("hex"), "AUTH_TOKEN_MISMATCH");
  await checkWrapperWs(token, "PAIRING_REQUIRED");
  console.log("WEIXIN_WRAPPER_CHECK: WS challenge, token rejection and pairing gate passed");

  // Only this isolated fixture's generated credentials and temporary state are used.
  // QR/login responses stay in memory; assertions and logs never contain them.
  const wx = (action, body = {}, headers = {}) => fetch(`${base}/setup/api/weixin/${action}`, {
    method: "POST", headers: { authorization: basic, origin: base, "content-type": "application/json", ...headers },
    body: JSON.stringify(body), signal: AbortSignal.timeout(5_000),
  });
  assert.equal((await wx("status", {}, { authorization: "" })).status, 401);
  assert.equal((await wx("status", {}, { origin: "https://cross-site.invalid" })).status, 403);
  assert.equal((await wx("status", {}, { "content-type": "text/plain" })).status, 415);
  const initial = await wx("status");
  assert.equal(initial.headers.get("cache-control"), "no-store");
  assert.equal((await initial.json()).active, false);
  console.log("WEIXIN_WRAPPER_CHECK: protected QR endpoint auth, origin and body gates passed");
  let started;
  for (let i = 0; i < 40; i += 1) {
    const start = await wx("start");
    if (start.status === 200) { started = await start.json(); break; }
    assert.equal(start.status, 409, "Start should either succeed or briefly wait for boot");
    await sleep(1_000);
  }
  assert.ok(started?.id && started.active, "QR login did not start");
  assert.equal((await wx("start")).status, 409, "Duplicate login must be rejected");
  let qr = null;
  for (let i = 0; i < 120; i += 1) {
    const status = await wx("status");
    assert.equal(status.status, 200);
    const current = await status.json();
    assert.equal(current.active, true, "Login must keep custody until cancelled");
    if (current.qrText && current.loginUrl) { qr = current; break; }
    await sleep(1_000);
  }
  assert.ok(qr?.qrText && qr?.loginUrl, "Both QR matrix and backup link must be available");
  assert.equal(await portOpen(gatewayPort), false, "Gateway must stay stopped during low-memory login");
  // No third-party QR renderer: the CLI's QR matrix is rendered by this private panel.
  assert.ok(qr.qrText.split("\n").length >= 12, "Expected a complete QR matrix");
  assert.equal((await get(`${base}/setup/api/status`, { authorization: basic })).status, 409,
    "Other setup commands must not overlap login");
  assert.equal(tail.includes(qr.loginUrl), false, "Private login URL must not be logged");
  const logPaths = [];
  function visit(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, {withFileTypes:true})) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(p);
      else if (entry.isFile() && entry.name.endsWith(".log")) logPaths.push(p);
    }
  }
  visit(path.join(root, "tmp"));
  visit("/tmp/openclaw");
  for (const p of logPaths) {
    assert.equal(fs.readFileSync(p, "utf8").includes(qr.loginUrl), false, "Private login URL must not be persisted in logs");
  }
  console.log("WEIXIN_WRAPPER_CHECK: real QR matrix and backup link available privately; Gateway paused; no URL leakage");
  qr = null;
  const cancelled = await wx("cancel", { id: started.id });
  assert.equal(cancelled.status, 200);
  const cancelledState = await cancelled.json();
  assert.equal(cancelledState.qrText, null);
  assert.equal(cancelledState.loginUrl, null);
  let ended;
  for (let i = 0; i < 150; i += 1) {
    const current = await (await wx("status")).json();
    if (!current.active) { ended = current; break; }
    await sleep(1_000);
  }
  assert.ok(ended, "Login did not settle after cancellation");
  assert.equal(ended.phase, "cancelled");
  assert.equal(ended.credentialsVerified, false);
  assert.equal(ended.qrText, null);
  assert.equal(ended.loginUrl, null);
  assert.equal((await get(`${base}/readyz`)).status, 200, "Gateway readiness must recover after cancellation");
  assert.equal(fs.existsSync(path.join(state, "openclaw-weixin", "accounts.json")), false,
    "Unscanned fixture must not acquire credentials");
  console.log("WEIXIN_WRAPPER_CHECK: cancel clears QR, releases CLI and restores Gateway without credentials");

  wrapper.kill("SIGTERM");
  let stopTimer;
  try {
    const result = await Promise.race([
      closed,
      new Promise((_, reject) => { stopTimer = setTimeout(() => reject(new Error("Wrapper did not close within 90 seconds")), 90_000); }),
    ]);
    assert.equal(result.signal, null, "Wrapper should handle SIGTERM, not die from it");
    assert.equal(result.code, 0, "Wrapper should shut down cleanly");
  } finally { clearTimeout(stopTimer); }
  assert.equal(await portOpen(port), false, "Wrapper listener survived shutdown");
  assert.equal(await portOpen(gatewayPort), false, "Gateway listener survived wrapper shutdown");
  console.log("WEIXIN_WRAPPER_CHECK: SIGTERM closed wrapper and gateway cleanly");
  passed = true;
} catch (error) {
  console.error(`WEIXIN_WRAPPER_CHECK: FAILED: ${redact(String(error))}`);
  console.error("WEIXIN_WRAPPER_CHECK: subprocess output retained only in fixture memory");
  process.exitCode = 1;
} finally {
  if (!passed && wrapper.pid) {
    // Only this test's newly-created process group; never discover or kill by port.
    try { process.kill(-wrapper.pid, "SIGTERM"); } catch {}
    await Promise.race([closed, sleep(5_000)]);
    try { process.kill(-wrapper.pid, "SIGKILL"); } catch {}
  }
  fs.rmSync(root, { recursive: true, force: true });
}
if (passed) console.log("WEIXIN_WRAPPER_CHECK: ALL PASSED");
