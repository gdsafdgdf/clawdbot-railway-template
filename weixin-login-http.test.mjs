import test from "node:test";
import assert from "node:assert/strict";
import { validateWeixinRequest, validateWeixinBody } from "./src/weixin-login-http.mjs";

const headers = {
  host: "assistant.example", origin: "https://assistant.example",
  "x-forwarded-proto": "https", "content-type": "application/json",
  "sec-fetch-site": "same-origin",
};
const request = (overrides = {}) => validateWeixinRequest({ method: "POST", headers, ...overrides });

test("same-origin Railway HTTPS and local HTTP requests are accepted", () => {
  assert.equal(request(), null);
  assert.equal(request({ headers: { ...headers, "content-type": "application/json; charset=utf-8" } }), null);
  assert.equal(request({ headers: {
    host: "127.0.0.1:4321", origin: "http://127.0.0.1:4321", "content-type": "application/json",
  } }), null);
  assert.equal(request({ headers: { ...headers, "x-forwarded-proto": undefined }, encrypted: true }), null);
});

test("missing, cross-site, wrong-scheme and wrong-port origins are rejected", () => {
  for (const origin of [undefined, "null", "https://evil.example", "http://assistant.example", "https://assistant.example:444"]) {
    assert.equal(request({ headers: { ...headers, origin } }).status, 403);
  }
  assert.equal(request({ headers: { ...headers, "sec-fetch-site": "cross-site" } }).status, 403);
  assert.equal(request({ headers: { ...headers, "sec-fetch-site": "same-site" } }).status, 403);
});

test("form posts and non-POST methods cannot trigger a login action", () => {
  for (const method of ["GET", "PUT", "DELETE", "OPTIONS"]) assert.equal(request({ method }).status, 405);
  for (const type of [undefined, "text/plain", "application/x-www-form-urlencoded", "application/jsonp"]) {
    assert.equal(request({ headers: { ...headers, "content-type": type } }).status, 415);
  }
});

test("action schemas reject extra fields, arbitrary commands and malformed PINs without echoing input", () => {
  const id = "12345678-1234-1234-1234-123456789abc";
  for (const action of ["start", "status"]) assert.equal(validateWeixinBody(action, {}), null);
  assert.equal(validateWeixinBody("cancel", { id }), null);
  assert.equal(validateWeixinBody("verify", { id, pin: "012345" }), null);
  const invalid = [
    ["start", { command: "arbitrary-secret" }], ["status", { id }], ["cancel", {}],
    ["verify", { id, pin: 1234 }], ["verify", { id, pin: "12\n34" }],
    ["verify", { id, pin: "secret-value" }], ["verify", { id: "../path", pin: "1234" }],
    ["start", []], ["start", null], ["shell", {}],
  ];
  for (const [action, body] of invalid) {
    const result = validateWeixinBody(action, body);
    assert.ok(result.status >= 400);
    assert.doesNotMatch(JSON.stringify(result), /arbitrary-secret|secret-value|\.\.\/path/);
  }
});
