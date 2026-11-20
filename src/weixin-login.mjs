import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

const OUTPUT_LIMIT = 64 * 1024;
// OpenClaw's normalizeAccountId produces lowercase, at most 64-character keys.
const SAFE_ACCOUNT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function requestError(message, statusCode = 409) {
  return Object.assign(new Error(message), { statusCode });
}

async function regularJson(file, maxBytes) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

/** Read only a credential-presence fact; never return an account or secret. */
export async function hasWeixinCredentials(stateDir) {
  const root = path.join(stateDir, "openclaw-weixin");
  try {
    for (const directory of [root, path.join(root, "accounts")]) {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    }
    const ids = await regularJson(path.join(root, "accounts.json"), OUTPUT_LIMIT);
    if (!Array.isArray(ids) || !ids.length || ids.length > 256) return false;
    if (ids.some((id) => typeof id !== "string" || !SAFE_ACCOUNT_ID.test(id))) {
      return false;
    }
    for (const id of ids) {
      const account = await regularJson(path.join(root, "accounts", `${id}.json`), OUTPUT_LIMIT);
      if (typeof account?.token === "string" && account.token.trim() &&
          typeof account.userId === "string" && account.userId.trim()) return true;
    }
  } catch {
    // Missing, malformed, or redirected state is not a successful login.
  }
  return false;
}

function plainOutput(raw) {
  return raw
    // Preserve ANSI background-only QR cells before removing terminal controls.
    .replace(/\u001b\[(?:\d+;)*40m( +)\u001b\[0m/g, (_, spaces) => "█".repeat(spaces.length))
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function loginPresentation(raw) {
  const plain = plainOutput(raw);
  let loginUrl = null;
  // CLI writes the URL followed by a newline. Do not publish a partial stream chunk.
  for (const match of plain.matchAll(/https:\/\/[^\s<>"'\u001b]+(?=[\s<>"'])/g)) {
    try {
      const url = new URL(match[0]);
      if (url.href.length <= 2048 && !url.username && !url.password && !url.port &&
          (url.hostname === "qq.com" || url.hostname.endsWith(".qq.com"))) loginUrl = url.href;
    } catch { /* A partial output chunk is retried with the next chunk. */ }
  }
  const rows = plain.split(/\r?\n/);
  let current = [];
  let qrText = null;
  for (const row of [...rows, "END"]) {
    if (row.length >= 12 && row.length <= 256 && /^[ \t█▄▀░▒▓■□⬛⬜]+$/.test(row)) {
      current.push(row.replace(/\t/g, " "));
    } else {
      if (current.length >= 3 && current.some((line) => /[█▄▀░▒▓■□⬛⬜]/.test(line))) {
        qrText = current.slice(-128).join("\n");
      }
      current = [];
    }
  }
  return { loginUrl, qrText };
}

export function createWeixinLoginManager({
  stateDir,
  spawnLogin,
  withGatewayStopped,
  ensureGatewayRunning,
  timeoutMs = 480_000,
  killGraceMs = 5_000,
  signalChild = (child, signal) => child.kill(signal),
  isProcessGroupAlive = () => false,
  groupPollMs = 100,
}) {
  let job = null;
  let runPromise = null;
  let child = null;
  let shuttingDown = false;
  let killTimer = null;
  let output = "";
  let storageFailed = false;
  let stopReason = null;

  function snapshot() {
    return job ? { ...job } : {
      id: null, phase: "idle", active: false, startedAt: null, expiresAt: null,
      message: "尚未开始微信连接。", qrText: null, loginUrl: null,
      needsPin: false, credentialsVerified: false,
    };
  }

  function requireJob(id) {
    if (!job || id !== job.id) throw requestError("微信连接任务不存在或已更换。", 404);
  }

  function clearPresentation() {
    job.qrText = null;
    job.loginUrl = null;
    job.needsPin = false;
    output = "";
  }

  function stopChild() {
    if (!child || killTimer) return;
    const owned = child;
    try { signalChild(owned, "SIGTERM"); } catch { /* Still await close; do not release ownership. */ }
    killTimer = setTimeout(() => {
      if (child !== owned) return;
      try { signalChild(owned, "SIGKILL"); } catch { /* No close means the lease stays held. */ }
    }, killGraceMs);
    killTimer.unref?.();
  }

  function stop(reason) {
    if (!job?.active || job.phase === "restoring" || stopReason) return;
    stopReason = reason;
    job.phase = "cancelling";
    job.message = reason === "timeout" ? "扫码已超时，正在结束连接进程。" : "正在取消微信连接。";
    clearPresentation();
    stopChild();
  }

  function receive(text) {
    if (!job?.active || stopReason || job.phase === "cleaning" || job.phase === "restoring") return;
    const accumulated = Buffer.from(output + text);
    output = accumulated.subarray(Math.max(0, accumulated.length - OUTPUT_LIMIT)).toString("utf8");
    if (/保存账号数据失败|failed to save account data/i.test(output)) storageFailed = true;
    for (const marker of ["二维码已过期", "正在刷新二维码", "二维码已更新"]) {
      const index = output.lastIndexOf(marker);
      if (index < 0) continue;
      output = output.slice(index + marker.length);
      job.qrText = null;
      job.loginUrl = null;
      job.needsPin = false;
      job.phase = "waiting";
      job.message = "二维码已过期，正在获取新二维码。";
    }
    const presentation = loginPresentation(output);
    if (presentation.qrText) job.qrText = presentation.qrText;
    if (presentation.loginUrl) job.loginUrl = presentation.loginUrl;
    const prompt = ["输入手机微信显示的数字", "你输入的数字不匹配"]
      .map((text) => ({ text, index: output.lastIndexOf(text) }))
      .sort((a, b) => b.index - a.index)[0];
    if (prompt.index >= 0) {
      job.needsPin = true;
      job.phase = "pin";
      job.message = "请填写手机微信显示的数字验证码。";
      output = output.slice(prompt.index + prompt.text.length);
    } else if (!job.needsPin && (job.qrText || job.loginUrl)) {
      job.message = "请用手机微信扫描二维码，并确认连接。";
    }
  }

  async function run() {
    let result = "failed";
    let message = "微信连接未完成，请重试。";
    const deadline = setTimeout(() => stop("timeout"), timeoutMs);
    deadline.unref?.();
    try {
      await withGatewayStopped(async () => {
        if (stopReason) return;
        job.phase = "waiting";
        job.message = "正在获取微信二维码。";
        child = spawnLogin();
        const owned = child;
        // Pipe failures (including an asynchronous EPIPE while submitting a PIN)
        // must end the owned process, not crash the wrapper or free its lease.
        const onPipeError = () => {
          if (child === owned) stop("pipe-error");
        };
        for (const stream of [owned.stdin, owned.stdout, owned.stderr]) {
          stream?.on("error", onPipeError);
        }
        const decoders = [new StringDecoder("utf8"), new StringDecoder("utf8")];
        const streams = [owned.stdout, owned.stderr];
        const listeners = streams.map((stream, index) => {
          const listener = (chunk) => receive(typeof chunk === "string" ? chunk : decoders[index].write(chunk));
          stream?.on("data", listener);
          return listener;
        });
        let spawnError = false;
        const onError = () => { spawnError = true; };
        owned.on("error", onError);
        const closed = await new Promise((resolve) => {
          owned.once("close", (code, signal) => resolve({ code, signal }));
          if (stopReason) stopChild();
        });
        streams.forEach((stream, index) => {
          stream?.off("data", listeners[index]);
          receive(decoders[index].end());
        });
        owned.off("error", onError);
        clearPresentation();
        // The leader's pipes can close while a detached descendant still owns
        // state. Keep the lease and signal escalation until the entire group is gone.
        const groupAlive = () => {
          try { return Boolean(isProcessGroupAlive(owned)); }
          catch { return true; }
        };
        while (groupAlive()) {
          job.phase = "cleaning";
          job.message = "正在结束微信连接的后台进程。";
          stopChild();
          await new Promise((resolve) => setTimeout(resolve, groupPollMs));
        }
        clearTimeout(killTimer);
        killTimer = null;
        child = null;
        if (stopReason) return;
        job.phase = "verifying";
        job.message = "正在确认微信连接已保存。";
        if (!spawnError && closed.code === 0 && !closed.signal && !storageFailed &&
            await hasWeixinCredentials(stateDir)) {
          job.credentialsVerified = true;
          result = "complete";
          message = "微信已连接。可以在手机微信中发消息给助手。";
        } else {
          message = "未确认微信凭据已保存，连接没有完成。请重试。";
        }
      });
    } catch {
      message = "微信连接无法完成，请检查服务状态后重试。";
    } finally {
      clearTimeout(deadline);
      if (stopReason) {
        result = stopReason === "timeout" ? "timedout" : stopReason === "pipe-error" ? "failed" : "cancelled";
        message = stopReason === "timeout" ? "微信扫码已超时，请重新连接。"
          : stopReason === "pipe-error" ? "扫码进程的连接已中断，请重新连接。" : "已取消微信连接。";
      }
      clearPresentation();
      if (!shuttingDown) {
        job.phase = "restoring";
        job.message = "正在恢复助手服务。";
        try {
          await ensureGatewayRunning();
        } catch {
          result = "failed";
          message = job.credentialsVerified
            ? "微信凭据已保存，但助手服务尚未恢复，请检查服务状态。"
            : "连接流程已结束，但助手服务尚未恢复，请检查服务状态。";
        }
      }
      job.phase = result;
      job.message = message;
      job.active = false;
      stopReason = null;
    }
  }

  return {
    start() {
      if (shuttingDown || job?.active) throw requestError("已有微信连接任务正在处理，请先完成或取消。" );
      output = "";
      storageFailed = false;
      stopReason = null;
      const now = Date.now();
      job = { id: randomUUID(), phase: "stopping", active: true, startedAt: now,
        expiresAt: now + timeoutMs, message: "正在暂停助手服务以连接微信。",
        qrText: null, loginUrl: null, needsPin: false, credentialsVerified: false };
      runPromise = run();
      return snapshot();
    },
    status(id) {
      if (id !== undefined && id !== null) requireJob(id);
      return snapshot();
    },
    verify(id, pin) {
      requireJob(id);
      if (typeof pin !== "string" || !/^\d{4,12}$/.test(pin)) throw requestError("验证码须为 4 至 12 位数字。", 400);
      if (!job.active || !job.needsPin || !child?.stdin || stopReason || child.stdin.writable === false) {
        throw requestError("当前没有等待输入的微信验证码。");
      }
      const owned = child;
      try {
        owned.stdin.write(`${pin}\n`, (error) => {
          if (error && child === owned) stop("pipe-error");
        });
      } catch {
        stop("pipe-error");
        throw requestError("验证码暂时无法提交，请重试连接。");
      }
      if (stopReason) return snapshot();
      job.needsPin = false;
      job.phase = "waiting";
      job.message = "正在等待微信验证结果。";
      return snapshot();
    },
    cancel(id) {
      requireJob(id);
      stop("cancel");
      return snapshot();
    },
    async shutdown() {
      shuttingDown = true;
      stop("cancel");
      await runPromise;
    },
  };
}
