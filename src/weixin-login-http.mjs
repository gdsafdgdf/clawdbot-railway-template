// This endpoint carries short-lived login material. Reject cross-site requests
// before parsing a body, and never include the submitted data in an error.
export function validateWeixinRequest({ method, headers, encrypted = false }) {
  if (method !== "POST") return { status: 405, error: "请使用 POST 请求。" };
  if (headers["sec-fetch-site"] && headers["sec-fetch-site"] !== "same-origin") {
    return { status: 403, error: "请从当前设置页面操作。" };
  }
  const protocol = encrypted || headers["x-forwarded-proto"] === "https" ? "https" : "http";
  try {
    const expected = new URL(`${protocol}://${headers.host}`).origin;
    if (typeof headers.origin !== "string" || headers.origin !== expected) {
      return { status: 403, error: "请从当前设置页面操作。" };
    }
  } catch {
    return { status: 403, error: "请从当前设置页面操作。" };
  }
  if (!/^application\/json(?:\s*;|$)/i.test(headers["content-type"] || "")) {
    return { status: 415, error: "请求必须使用 JSON。" };
  }
  return null;
}

export function validateWeixinBody(action, body) {
  const fields = { start: [], status: [], verify: ["id", "pin"], cancel: ["id"] }[action];
  if (!fields) return { status: 404, error: "未知的微信连接操作。" };
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some((key) => !fields.includes(key))) {
    return { status: 400, error: "请求格式不正确。" };
  }
  if (fields.includes("id") && (typeof body.id !== "string" ||
      !/^[a-f0-9-]{36}$/.test(body.id))) {
    return { status: 400, error: "连接任务编号不正确。" };
  }
  if (action === "verify" && (typeof body.pin !== "string" || !/^\d{4,12}$/.test(body.pin))) {
    return { status: 400, error: "验证码须为 4 至 12 位数字。" };
  }
  return null;
}
