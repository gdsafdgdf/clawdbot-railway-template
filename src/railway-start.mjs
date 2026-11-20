// Run retained-volume migration before the wrapper can accept requests or start a gateway.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { bootstrapWeixin } from "./weixin-bootstrap.mjs";

for (const suffix of ["PUBLIC_PORT", "STATE_DIR", "WORKSPACE_DIR", "GATEWAY_TOKEN", "CONFIG_PATH"]) {
  const legacy = `CLAWDBOT_${suffix}`;
  const current = `OPENCLAW_${suffix}`;
  if (process.env[legacy] && !process.env[current]) process.env[current] = process.env[legacy];
  delete process.env[legacy];
}
process.env.OPENCLAW_NO_RESPAWN = "1";

const entry = process.env.OPENCLAW_ENTRY?.trim() || "/app/openclaw.mjs";
const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
const config = process.env.OPENCLAW_CONFIG_PATH?.trim() || path.join(stateDir, "openclaw.json");

if (fs.existsSync(config)) {
  // Doctor itself creates this marker only after its pre-migration capture is sealed.
  // /tmp belongs to this container; replacing the image gives the next upgrade a fresh capture.
  const key = createHash("sha256").update(JSON.stringify([entry, config])).digest("hex").slice(0, 32);
  const env = {
    ...process.env,
    OPENCLAW_IMAGE_ACTIVATION_CAPTURE_MARKER: path.join(os.tmpdir(), `railway-openclaw-activation-${key}`),
  };
  console.log("[activation] checking retained OpenClaw state before starting the gateway");
  const child = spawn(process.execPath, [entry, "doctor", "--fix", "--non-interactive"], {
    stdio: "inherit", env,
  });
  let interrupted;
  const forward = (signal) => {
    interrupted = signal;
    child.kill("SIGTERM");
  };
  const onTerm = () => forward("SIGTERM");
  const onInt = () => forward("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  let failed;
  child.on("error", error => { failed = error; });
  const outcome = await new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  process.off("SIGTERM", onTerm);
  process.off("SIGINT", onInt);
  if (failed || interrupted || outcome.signal || outcome.code !== 0) {
    console.error("[activation] migration did not finish successfully; wrapper has not been started");
    process.exit(outcome.code || (interrupted === "SIGINT" ? 130 : 1));
  }
  const weixin = await bootstrapWeixin({ env: process.env, stateDir, entry });
  if (weixin.status !== "disabled") {
    console.log(`[weixin-bootstrap] ${weixin.status}`);
    if (weixin.diagnosticsPath) console.log(`[weixin-bootstrap] diagnostics: ${weixin.diagnosticsPath}`);
  }
  if (!weixin.continueStartup) {
    console.error("[weixin-bootstrap] maintenance did not release state safely; gateway has not been started");
    process.exit(1);
  }
}

// Replace this process so tini directly supervises the wrapper and forwards shutdown signals.
process.execve(process.execPath, [process.execPath, "src/server.js"], process.env);
