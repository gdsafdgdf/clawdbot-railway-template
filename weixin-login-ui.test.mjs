import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

test("a lost start response is reconciled even after an idle snapshot", async () => {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      value: "", textContent: "", style: {}, hidden: false, disabled: false,
      removeAttribute(name) { delete this[name]; }, appendChild() {},
    });
    return elements.get(id);
  };
  const timers = new Map();
  let timerId = 0;
  let statusCalls = 0;
  let failOnePoll = false;
  let state = { active: false, id: null, phase: "idle", message: "Idle" };
  const response = (body) => Promise.resolve({ ok: true, json: async () => body });
  const context = {
    document: { hidden: false, getElementById: element, addEventListener() {}, createElement: () => element("created") },
    window: { addEventListener() {} },
    URL, console: { warn() {} },
    setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    fetch(url) {
      if (url.endsWith("/weixin/start")) {
        state = { active: true, id: "fixture-job", phase: "waiting", message: "Scan", qrText: "fixture-qr" };
        failOnePoll = true;
        return Promise.reject(new Error("fixture network interruption"));
      }
      if (url.endsWith("/weixin/status")) {
        statusCalls++;
        if (failOnePoll) { failOnePoll = false; return Promise.reject(new Error("fixture retry")); }
        return response({ ...state });
      }
      if (url.endsWith("/auth-groups")) return response({ authGroups: [{ value: "fixture", options: [] }] });
      return response({ configured: true });
    },
  };
  vm.runInNewContext(await fs.readFile(new URL("./src/setup-app.js", import.meta.url), "utf8"), context);
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  await settle();
  assert.equal(statusCalls, 1);
  element("weixinStart").onclick();
  await settle();
  const first = [...timers.values()].find((timer) => timer.delay === 500);
  assert.ok(first, "failed mutation must schedule reconciliation");
  await first.callback();
  const retry = [...timers.values()].find((timer) => timer.delay === 1500);
  assert.ok(retry, "failed reconciliation must retry even when the last state was idle");
  await retry.callback();
  assert.equal(statusCalls, 3);
  assert.equal(element("weixinQr").textContent, "fixture-qr");
  assert.equal(element("weixinStart").disabled, true);
  assert.equal(element("weixinCancel").hidden, false);
});
