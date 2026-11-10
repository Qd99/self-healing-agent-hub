import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const COOKIE = "heal_session";
const digest = (value) => createHash("sha256").update(value).digest();
const secret = () => randomBytes(32).toString("hex");
const matches = (left, right) =>
  typeof left === "string" &&
  typeof right === "string" &&
  right.length > 0 &&
  timingSafeEqual(digest(left), digest(right));

function denied(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function bearer(request) {
  const value = request.headers.authorization;
  return typeof value === "string" && /^Bearer [^\s]+$/i.test(value)
    ? value.slice(7)
    : "";
}

function cookieValue(request) {
  const values = String(request.headers.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${COOKIE}=`));
  return values.length === 1 ? values[0].slice(COOKIE.length + 1) : "";
}

export function isLoopback(host) {
  return [
    "localhost",
    "127.0.0.1",
    "::1",
    "[::1]",
    "::ffff:127.0.0.1",
  ].includes(String(host).toLowerCase());
}

/** Sessions never contain the configured operator or worker token. */
export function createConsoleAuth({
  consoleToken = "",
  workerToken = "",
  actor = "管理员",
  secureCookies = false,
  clock = Date.now,
  sessionTtlMs = 8 * 60 * 60 * 1000,
} = {}) {
  if (consoleToken && workerToken && matches(consoleToken, workerToken))
    throw new Error("Console and worker tokens must be different.");
  const sessions = new Map();
  const attempts = new Map();
  const localCsrf = secret();
  const cookie = (value, maxAge) =>
    `${COOKIE}=${value}; Path=/api/healing; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookies ? "; Secure" : ""}`;

  function assertOrigin(request) {
    if (request.headers["sec-fetch-site"] === "cross-site")
      throw denied(403, "ORIGIN_REJECTED", "不允许从其他网站访问管理接口。");
    if (request.headers.origin) {
      let origin;
      let host;
      try {
        origin = new URL(request.headers.origin);
        host = new URL(`http://${request.headers.host}`).host;
      } catch {
        throw denied(403, "ORIGIN_REJECTED", "请求来源无效。");
      }
      if (
        !["http:", "https:"].includes(origin.protocol) ||
        origin.host !== host
      )
        throw denied(
          403,
          "ORIGIN_REJECTED",
          "请从管理服务的同源工作台提交操作。",
        );
    }
  }

  function requireLocal(request) {
    let hostname;
    try {
      hostname = new URL(`http://${request.headers.host}`).hostname;
    } catch {}
    if (!isLoopback(request.socket.remoteAddress) || !isLoopback(hostname))
      throw denied(
        403,
        "LOCAL_ONLY",
        "远程访问需要在服务端配置 CONSOLE_API_TOKEN。",
      );
  }

  function prune() {
    const now = clock();
    for (const [key, value] of sessions)
      if (value.expiresAt <= now) sessions.delete(key);
    for (const [key, value] of attempts)
      if (value.until <= now) attempts.delete(key);
  }

  function authenticate(request) {
    assertOrigin(request);
    prune();
    if (!consoleToken) {
      requireLocal(request);
      return { actor: "本机管理员", csrfToken: localCsrf, via: "local" };
    }
    if (matches(bearer(request), consoleToken))
      return { actor, csrfToken: localCsrf, via: "bearer" };
    const sessionId = cookieValue(request);
    const session =
      sessionId && sessions.get(digest(sessionId).toString("hex"));
    if (!session)
      throw denied(401, "AUTH_REQUIRED", "请使用管理令牌登录工作台。");
    return { actor, csrfToken: session.csrfToken, via: "session" };
  }

  function assertWrite(request, identity) {
    assertOrigin(request);
    if (
      identity.via !== "bearer" &&
      !matches(request.headers["x-heal-csrf"], identity.csrfToken)
    )
      throw denied(
        403,
        "CSRF_REJECTED",
        "操作校验已失效，请刷新工作台后重试。",
      );
  }

  function login(request) {
    assertOrigin(request);
    prune();
    if (!consoleToken) return { identity: authenticate(request) };
    const key = request.socket.remoteAddress || "unknown";
    const attempt = attempts.get(key) || {
      count: 0,
      until: clock() + 15 * 60_000,
    };
    if (attempt.count >= 10)
      throw denied(429, "AUTH_RATE_LIMIT", "登录尝试过多，请稍后重试。");
    if (!matches(bearer(request), consoleToken)) {
      attempt.count += 1;
      if (attempts.size < 1000 || attempts.has(key)) attempts.set(key, attempt);
      throw denied(401, "AUTH_REQUIRED", "管理令牌无效。");
    }
    attempts.delete(key);
    if (sessions.size >= 1000) sessions.delete(sessions.keys().next().value);
    const id = secret();
    const csrfToken = secret();
    sessions.set(digest(id).toString("hex"), {
      csrfToken,
      expiresAt: clock() + sessionTtlMs,
    });
    return {
      identity: { actor, csrfToken, via: "session" },
      cookie: cookie(id, Math.floor(sessionTtlMs / 1000)),
    };
  }

  function logout(request) {
    const identity = authenticate(request);
    assertWrite(request, identity);
    const id = cookieValue(request);
    if (id) sessions.delete(digest(id).toString("hex"));
    return cookie("", 0);
  }

  function authenticateWorker(request) {
    assertOrigin(request);
    if (!workerToken)
      throw denied(
        503,
        "WORKER_AUTH_UNCONFIGURED",
        "服务端尚未配置 HEALING_WORKER_TOKEN。",
      );
    if (!matches(bearer(request), workerToken))
      throw denied(401, "WORKER_AUTH_REQUIRED", "Agent 凭据无效。");
    return { id: "agent", name: "Agent" };
  }

  function decorate(snapshot, identity) {
    return {
      ...snapshot,
      csrfToken: identity.csrfToken,
      auth: { required: Boolean(consoleToken), actor: identity.actor },
    };
  }

  return {
    authenticate,
    authenticateWorker,
    assertWrite,
    login,
    logout,
    decorate,
  };
}
