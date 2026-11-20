// Optional, once-per-volume installation. OpenClaw owns every plugin/config mutation.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const WEIXIN_VERSION = "2.4.10";
export const WEIXIN_PACKAGE = "@tencent-weixin/openclaw-weixin";
const PLUGIN_ID = "openclaw-weixin";
const SPEC = `npm:${WEIXIN_PACKAGE}@${WEIXIN_VERSION}`;
const PINNED_SPEC = `${WEIXIN_PACKAGE}@${WEIXIN_VERSION}`;
const inFlight = new Map();

function privateWrite(file, value, { exclusive = false } = {}) {
  const fd = fs.openSync(file, exclusive ? "wx" : "w", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function syncDirectory(directory) {
  const fd = fs.openSync(directory, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// This is a cold inventory check, not proof that a live Gateway loaded the plugin.
export function inspectWeixinInventory(stdout) {
  const inventory = JSON.parse(stdout);
  if (!inventory || !Array.isArray(inventory.plugins)) {
    throw new Error("Plugin inventory did not contain a plugins array");
  }
  if (inventory.plugins.some(plugin => !plugin || typeof plugin.id !== "string") ||
      inventory.diagnostics?.some(item => item?.level === "error")) {
    throw new Error("Plugin inventory was incomplete or reported an error");
  }
  const matches = inventory.plugins.filter(plugin => plugin?.id === PLUGIN_ID);
  if (matches.length === 0) return { state: "missing" };
  if (matches.length !== 1) return { state: "conflict", reason: "duplicate-plugin-id" };
  const plugin = matches[0];
  // The v2026.11.6 cold listing omits packageName/packageVersion. Defer
  // authoritative package identity to inspect; still reject explicit mismatches.
  if ((plugin.packageName !== undefined && plugin.packageName !== WEIXIN_PACKAGE) || plugin.version !== WEIXIN_VERSION ||
      (plugin.packageVersion !== undefined && plugin.packageVersion !== WEIXIN_VERSION)) {
    return { state: "conflict", reason: "package-or-version-mismatch" };
  }
  if (typeof plugin.enabled !== "boolean" || !["loaded", "disabled", "error"].includes(plugin.status)) {
    return { state: "conflict", reason: "plugin-state-unknown" };
  }
  if (plugin.dependencyStatus?.requiredInstalled !== true) {
    return { state: "conflict", reason: "dependencies-not-verified" };
  }
  return { state: "present", id: PLUGIN_ID, version: WEIXIN_VERSION,
    enabled: plugin.enabled, status: plugin.status };
}

export function inspectWeixinRuntime(stdout, { requireExplicitEnablement = false } = {}) {
  const report = JSON.parse(stdout);
  const inventory = inspectWeixinInventory(JSON.stringify({ plugins: [report?.plugin] }));
  const install = report?.install;
  if (inventory.state !== "present" || inventory.enabled !== true || inventory.status !== "loaded" ||
      report.plugin.imported !== true) throw new Error("Plugin runtime loading was not verified");
  if (report.plugin.packageName !== WEIXIN_PACKAGE || install?.source !== "npm" || install.spec !== PINNED_SPEC ||
      install.resolvedSpec !== PINNED_SPEC || install.version !== WEIXIN_VERSION) {
    throw new Error("Plugin npm installation provenance was not verified");
  }
  if (requireExplicitEnablement && report.plugin.explicitlyEnabled !== true) {
    throw new Error("Explicit plugin enablement was not verified");
  }
  return { id: PLUGIN_ID, version: WEIXIN_VERSION, enabled: true, imported: true,
    explicitlyEnabled: report.plugin.explicitlyEnabled === true, source: "npm", spec: PINNED_SPEC };
}

/** A runner result is usable only after its process and owned group have stopped. */
export function createOpenClawRunner({
  timeoutMs = 180_000,
  terminateGraceMs = 5_000,
  killGraceMs = 5_000,
  outputLimitBytes = 2 * 1024 * 1024,
} = {}) {
  return ({ entry, args, env }) => new Promise(resolve => {
    const grouped = process.platform !== "win32";
    const child = spawn(process.execPath, [entry, ...args], {
      env: { ...env, OPENCLAW_NO_RESPAWN: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: grouped,
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let closed = false;
    let code = null;
    let signal = null;
    let error;
    let finished = false;
    let termAt;
    let killSent = false;
    let cleanupNeeded = false;
    const capture = (stream, chunk) => {
      const bytes = Buffer.from(chunk);
      const current = stream === "stdout" ? stdout : stderr;
      const remaining = Math.max(0, outputLimitBytes - current.length);
      const next = Buffer.concat([current, bytes.subarray(0, remaining)]);
      if (stream === "stdout") {
        stdout = next;
        stdoutTruncated ||= bytes.length > remaining;
      } else {
        stderr = next;
        stderrTruncated ||= bytes.length > remaining;
      }
    };
    child.stdout.on("data", chunk => capture("stdout", chunk));
    child.stderr.on("data", chunk => capture("stderr", chunk));
    const groupExists = () => {
      if (!child.pid) return false;
      try { process.kill(grouped ? -child.pid : child.pid, 0); return true; }
      catch (cause) { return cause.code !== "ESRCH"; }
    };
    const send = nextSignal => {
      if (!child.pid) return;
      try { process.kill(grouped ? -child.pid : child.pid, nextSignal); }
      catch (cause) { if (cause.code !== "ESRCH") error ||= cause.message; }
    };
    const finish = custodyReleased => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      clearInterval(poll);
      process.off("SIGTERM", onTerm);
      process.off("SIGINT", onInt);
      resolve({ code, signal, timedOut, interrupted, cleanupNeeded, custodyReleased, error,
        stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"),
        stdoutTruncated, stderrTruncated });
    };
    let interrupted;
    const terminate = reason => {
      if (termAt !== undefined) return;
      if (reason === "timeout") timedOut = true;
      else if (reason === "cleanup") cleanupNeeded = true;
      else interrupted = reason;
      termAt = Date.now();
      send("SIGTERM");
    };
    const onTerm = () => terminate("SIGTERM");
    const onInt = () => terminate("SIGINT");
    process.on("SIGTERM", onTerm);
    process.on("SIGINT", onInt);
    const deadline = setTimeout(() => terminate("timeout"), timeoutMs);
    const poll = setInterval(() => {
      if (closed && !groupExists()) return finish(true);
      if (termAt === undefined) return;
      const elapsed = Date.now() - termAt;
      if (!killSent && elapsed >= terminateGraceMs) { killSent = true; send("SIGKILL"); }
      if (elapsed >= terminateGraceMs + killGraceMs) finish(false);
    }, 25);
    child.on("error", cause => { error = cause.message; });
    child.once("close", (exitCode, exitSignal) => {
      closed = true;
      code = exitCode;
      signal = exitSignal;
      if (!groupExists()) finish(true);
      // Any surviving CLI-owned descendants must settle before Gateway startup.
      else terminate("cleanup");
    });
  });
}

function commandSucceeded(result) {
  return result?.custodyReleased === true && result.code === 0 && !result.signal &&
    !result.timedOut && !result.interrupted && !result.cleanupNeeded && !result.error;
}

/**
 * Call once after retained-volume migration and before starting the Gateway.
 * The official CLI owns all plugin/config writes and enforces its trust policy.
 * This fixed catalog package needs no capability override. A new consent request
 * must fail for review rather than silently acquiring more capabilities.
 */
export function bootstrapWeixin(options = {}) {
  const key = options.stateDir;
  if (inFlight.has(key)) return inFlight.get(key);
  const pending = runBootstrap(options).finally(() => {
    if (inFlight.get(key) === pending) inFlight.delete(key);
  });
  inFlight.set(key, pending);
  return pending;
}

async function runBootstrap({
  env = process.env,
  stateDir,
  entry = "/app/openclaw.mjs",
  run = createOpenClawRunner(),
} = {}) {
  const requested = env.OPENCLAW_BOOTSTRAP_WEIXIN;
  if (requested === undefined || requested === "") return { status: "disabled", continueStartup: true };
  if (requested !== WEIXIN_VERSION) return { status: "unsupported-version", continueStartup: true };
  if (!stateDir || !path.isAbsolute(stateDir) || !path.isAbsolute(entry)) {
    return { status: "invalid-path", continueStartup: true };
  }

  const directory = path.join(stateDir, "railway-bootstrap", `weixin-${WEIXIN_VERSION}`);
  const attemptFile = path.join(directory, "attempt.json");
  const verifiedFile = path.join(directory, "verified.json");
  const diagnosticsFile = path.join(directory, `diagnostics-${randomUUID()}.json`);
  const diagnostics = { version: WEIXIN_VERSION, startedAt: new Date().toISOString(), commands: [] };
  let ownsAttempt = false;
  let canContinue = true;

  const saveDiagnostics = ({ required = false } = {}) => {
    try {
      privateWrite(diagnosticsFile, diagnostics);
      syncDirectory(directory);
    } catch (cause) {
      diagnostics.writeError = String(cause?.message ?? cause);
      // Once installation has begun, a full disk must not prevent inspection
      // or cleanup of a package that may already have committed.
      if (required) throw cause;
    }
  };
  const result = (status, extra = {}) => ({ status, continueStartup: canContinue,
    diagnosticsPath: diagnosticsFile,
    ...(diagnostics.writeError ? { diagnosticsWarning: diagnostics.writeError } : {}), ...extra });
  const invoke = async args => {
    const command = { args, startedAt: new Date().toISOString() };
    diagnostics.commands.push(command);
    saveDiagnostics();
    let outcome;
    try { outcome = await run({ entry, args, env }); }
    catch (cause) {
      // A throwing runner cannot prove that a mutation child has been reaped.
      outcome = { code: null, custodyReleased: false, error: String(cause?.message ?? cause) };
    }
    const logged = { ...outcome };
    // A bundled-plugin inventory can be large. Keep its parser budget separate
    // from bounded on-volume diagnostics so ordinary restarts do not fill data.
    for (const stream of ["stdout", "stderr"]) {
      if (typeof logged[stream] === "string" && Buffer.byteLength(logged[stream]) > 64 * 1024) {
        logged[stream] = Buffer.from(logged[stream]).subarray(0, 64 * 1024).toString("utf8");
        logged[`${stream}DiagnosticTruncated`] = true;
      }
    }
    Object.assign(command, logged, { completedAt: new Date().toISOString() });
    if (outcome.custodyReleased !== true || outcome.interrupted) canContinue = false;
    saveDiagnostics();
    return outcome;
  };
  const inventory = async () => {
    const outcome = await invoke(["plugins", "list", "--json"]);
    if (!commandSucceeded(outcome) || outcome.stdoutTruncated) {
      throw new Error("Official plugin inventory was not available");
    }
    return inspectWeixinInventory(outcome.stdout);
  };
  const verifyRuntime = async (options) => {
    const outcome = await invoke(["plugins", "inspect", PLUGIN_ID, "--runtime", "--json"]);
    if (!commandSucceeded(outcome) || outcome.stdoutTruncated) {
      throw new Error("Official runtime inspection did not complete successfully");
    }
    return inspectWeixinRuntime(outcome.stdout, options);
  };
  const recordVerified = plugin => {
    privateWrite(verifiedFile, { ...plugin, checkedAt: new Date().toISOString(),
      sourceOfVerification: "official-cli-runtime-inspection", diagnosticsPath: diagnosticsFile });
    syncDirectory(directory);
  };
  const disableNewInstall = async reason => {
    // This is restricted to a package absent before this invocation's install.
    // Never disable, overwrite, or repair a user's existing installation here.
    if (!canContinue) return result("runtime-unverified", { reason });
    const disabled = await invoke(["plugins", "disable", PLUGIN_ID]);
    if (commandSucceeded(disabled)) {
      canContinue = false;
      const check = await inventory();
      if (check.state === "present" && check.enabled === false && check.status === "disabled") {
        canContinue = true;
        return result("installed-disabled", { reason });
      }
    }
    canContinue = false;
    return result("disable-unverified", { reason });
  };

  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const before = await inventory();
    if (before.state === "present") {
      if (!before.enabled || before.status !== "loaded") {
        return result("needs-review", { reason: "existing-plugin-not-enabled" });
      }
      try {
        const plugin = await verifyRuntime({ requireExplicitEnablement: true });
        recordVerified(plugin);
        return result("verified-existing", { plugin });
      } catch (cause) {
        return result("needs-review", { reason: String(cause?.message ?? cause) });
      }
    }
    if (before.state !== "missing") return result("needs-review", { reason: before.reason });
    // Gate installation only: manual repairs remain visible and verifiable on later boots.
    // A lost result may already have committed, so never automatically repeat installation.
    if (fs.existsSync(attemptFile)) return result("already-attempted");
    try {
      saveDiagnostics({ required: true });
      privateWrite(attemptFile, { version: WEIXIN_VERSION, spec: SPEC, startedAt: diagnostics.startedAt }, { exclusive: true });
      ownsAttempt = true;
      syncDirectory(directory);
    } catch (cause) {
      if (cause.code === "EEXIST") return result("already-attempted");
      throw cause;
    }
    const args = ["plugins", "install", SPEC, "--pin", "--force", "--no-enable"];
    const install = await invoke(args);
    if (!canContinue) return result("install-failed");
    const installSucceeded = commandSucceeded(install);
    // A nonzero exit can occur after a commit. Reconcile what the CLI actually
    // installed before allowing Gateway startup; never repeat the installation.
    const after = await inventory();
    if (!installSucceeded && after.state === "missing") return result("install-failed");
    if (after.state !== "present") return result("verification-failed", { reason: after.reason ?? after.state });
    // This opt-in explicitly requests installation and enablement. The retained
    // allowlist may leave a newly installed plugin disabled after --no-enable;
    // the official enable command adds this requested plugin without replacing
    // that allowlist. Existing disabled installations returned above unchanged.
    const enabled = await invoke(["plugins", "enable", PLUGIN_ID]);
    if (!commandSucceeded(enabled)) return await disableNewInstall("explicit-enable-failed");
    let plugin;
    try {
      plugin = await verifyRuntime({ requireExplicitEnablement: true });
    } catch (cause) {
      return await disableNewInstall(String(cause?.message ?? cause));
    }
    recordVerified(plugin);
    return result("installed-and-verified", { plugin,
      ...(!installSucceeded ? { warning: "install-exit-failed-but-runtime-verified" } : {}) });
  } catch (cause) {
    diagnostics.error = String(cause?.message ?? cause);
    diagnostics.attemptRecorded = ownsAttempt;
    try { saveDiagnostics(); } catch { /* Never change OpenClaw state to repair diagnostics. */ }
    return result("bootstrap-failed");
  }
}
