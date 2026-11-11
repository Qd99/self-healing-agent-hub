import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
function fail(field) {
  throw new Error(`Invalid worker configuration: ${field}`);
}
function object(value, keys, name) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    fail(name);
  return value;
}
function text(v, n) {
  if (
    typeof v !== "string" ||
    !v.trim() ||
    v.length > 4096 ||
    [...v].some((c) => c.charCodeAt(0) < 32)
  )
    fail(n);
  return v;
}
function number(v, fallback, min, max, n) {
  v ??= fallback;
  if (!Number.isInteger(v) || v < min || v > max) fail(n);
  return v;
}
function url(v, n) {
  let u;
  try {
    u = new URL(text(v, n));
  } catch {
    fail(n);
  }
  if (
    u.username ||
    u.password ||
    u.hash ||
    !(
      u.protocol === "https:" ||
      (u.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))
    )
  )
    fail(n);
  return u;
}
export function resolveConfig(
  input,
  { env = process.env, baseDir = process.cwd() } = {},
) {
  const c = structuredClone(
    object(
      input,
      [
        "version",
        "hub",
        "workerId",
        "engineId",
        "dataDir",
        "repository",
        "model",
        "checks",
        "github",
        "publish",
        "pollIntervalMs",
        "heartbeatIntervalMs",
      ],
      "root",
    ),
  );
  if (c.version !== 1) fail("version");
  object(c.hub, ["url", "tokenEnv"], "hub");
  object(c.repository, ["fullName", "branch", "localPath"], "repository");
  object(
    c.model,
    ["endpoint", "model", "tokenEnv", "contextPaths", "timeoutMs"],
    "model",
  );
  object(c.checks, ["image", "commands", "timeoutMs"], "checks");
  c.github ??= {};
  object(c.github, ["tokenEnv"], "github");
  c.publish ??= { enabled: false };
  object(c.publish, ["enabled"], "publish");
  const hub = url(c.hub.url, "hub.url");
  if (hub.pathname !== "/" || hub.search) fail("hub.url must be an origin");
  c.hub.url = hub.origin;
  c.model.endpoint = url(c.model.endpoint, "model.endpoint").href;
  c.workerId = text(c.workerId, "workerId");
  if (!/^[a-zA-Z0-9._-]{1,120}$/.test(c.workerId)) fail("workerId");
  c.engineId = c.engineId ?? "fast";
  text(c.engineId, "engineId");
  c.dataDir = resolve(baseDir, text(c.dataDir, "dataDir"));
  c.repository.localPath = resolve(
    baseDir,
    text(c.repository.localPath, "repository.localPath"),
  );
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(c.repository.fullName))
    fail("repository.fullName");
  c.repository.branch ??= "main";
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(c.repository.branch) ||
    c.repository.branch.includes("..") ||
    c.repository.branch.includes("//") ||
    c.repository.branch.endsWith("/") ||
    c.repository.branch.endsWith(".") ||
    c.repository.branch.endsWith(".lock")
  )
    fail("repository.branch");
  text(c.model.model, "model.model");
  if (
    !Array.isArray(c.model.contextPaths) ||
    c.model.contextPaths.length > 20 ||
    new Set(c.model.contextPaths).size !== c.model.contextPaths.length ||
    c.model.contextPaths.some(
      (p) =>
        typeof p !== "string" ||
        !p ||
        p.includes("\\") ||
        p.startsWith("/") ||
        p.split("/").some((x) => ["..", ".git", ""].includes(x)),
    )
  )
    fail("model.contextPaths");
  if (!/^\S+@sha256:[a-f0-9]{64}$/.test(c.checks.image)) fail("checks.image");
  if (
    !c.checks.commands ||
    typeof c.checks.commands !== "object" ||
    Array.isArray(c.checks.commands) ||
    !Object.keys(c.checks.commands).length
  )
    fail("checks.commands");
  for (const [id, argv] of Object.entries(c.checks.commands)) {
    text(id, "check id");
    if (!Array.isArray(argv) || !argv.length || argv.length > 50)
      fail("checks argv");
    argv.forEach((x) => text(x, "checks argv"));
  }
  for (const [section, fallback] of [
    ["hub", "HEALING_WORKER_TOKEN"],
    ["model", "HEALING_MODEL_TOKEN"],
    ["github", "HEALING_GITHUB_WRITE_TOKEN"],
  ]) {
    c[section].tokenEnv ??= fallback;
    if (!/^[A-Z_][A-Z0-9_]*$/.test(c[section].tokenEnv))
      fail(`${section}.tokenEnv`);
    const token = env[c[section].tokenEnv];
    if (typeof token !== "string" || !token.trim() || /[\r\n]/.test(token))
      fail(`${section} credential missing`);
    c[section].token = token;
  }
  if (typeof c.publish.enabled !== "boolean") fail("publish.enabled");
  c.model.timeoutMs = number(
    c.model.timeoutMs,
    120000,
    100,
    600000,
    "model.timeoutMs",
  );
  c.checks.timeoutMs = number(
    c.checks.timeoutMs,
    120000,
    100,
    600000,
    "checks.timeoutMs",
  );
  c.pollIntervalMs = number(
    c.pollIntervalMs,
    5000,
    100,
    60000,
    "pollIntervalMs",
  );
  c.heartbeatIntervalMs = number(
    c.heartbeatIntervalMs,
    15000,
    100,
    30000,
    "heartbeatIntervalMs",
  );
  return c;
}
export async function loadConfig(path, options = {}) {
  const absolute = resolve(path);
  let raw;
  try {
    raw = JSON.parse(await readFile(absolute, "utf8"));
  } catch {
    throw new Error("Cannot read worker configuration");
  }
  return resolveConfig(raw, { baseDir: dirname(absolute), ...options });
}
export function parseArgs(args) {
  const result = { config: null, once: false, checkConfig: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) fail("duplicate CLI option");
    seen.add(arg);
    if (arg === "--config") {
      result.config = args[++i];
      if (!result.config || result.config.startsWith("--")) fail("--config");
    } else if (arg === "--once") result.once = true;
    else if (arg === "--check-config") result.checkConfig = true;
    else fail("unknown CLI option");
  }
  if (!result.config) fail("--config required");
  return result;
}
export function readiness(config) {
  return {
    valid: true,
    workerId: config.workerId,
    engineId: config.engineId,
    repository: config.repository.fullName,
    branch: config.repository.branch,
    publishingEnabled: config.publish.enabled,
    credentialsConfigured: true,
    remoteConnectivityChecked: false,
  };
}
