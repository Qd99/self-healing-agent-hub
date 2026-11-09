import { createServer } from "node:http";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeMonitoringConfig } from "../../console/public/monitoring-model.js";

const defaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
const capabilities = Object.freeze({
  trigger: false,
  cancel: false,
  retry: false,
  approve: false,
  updateRules: false,
});
const taskTypes = new Set([
  "lint-error",
  "format-error",
  "type-error",
  "unit-test-failure",
  "e2e-test-failure",
  "architecture-violation",
  "security-issue",
  "ci-failure",
  "doc-outdated",
  "dependency-issue",
  "performance-regression",
]);
const priorities = new Set(["urgent", "high", "medium", "low"]);
const mediaTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

class ConsoleError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function object(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Expected an object.");
  return value;
}

function string(value) {
  if (typeof value !== "string" || !value.trim())
    throw new TypeError("Expected a nonempty string.");
  return value;
}

function boolean(value) {
  if (typeof value !== "boolean") throw new TypeError("Expected a boolean.");
  return value;
}

function number(value) {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new TypeError("Expected a finite number.");
  return value;
}

function count(value) {
  if (!Number.isSafeInteger(number(value)) || value < 0)
    throw new TypeError("Expected a nonnegative integer.");
  return value;
}

function strings(value) {
  if (!Array.isArray(value)) throw new TypeError("Expected an array.");
  return value.map(string);
}

function member(values) {
  return (value) => {
    if (!values.has(value)) throw new TypeError("Unsupported value.");
    return value;
  };
}

// Never spread a configuration object into a response, even after deleting secrets.
// Each nested object must pass through its own explicit, typed allowlist.
function pick(value, fields, required = []) {
  const source = object(value);
  const result = {};
  for (const [key, validate] of Object.entries(fields)) {
    if (Object.hasOwn(source, key)) result[key] = validate(source[key]);
    else if (required.includes(key))
      throw new TypeError("Missing a required field.");
  }
  return result;
}

function projectConfig(input) {
  const config = object(input);
  const project = pick(
    config.project,
    { id: string, repo: string, defaultBranch: string },
    ["id", "repo", "defaultBranch"],
  );
  const configuredEngines = object(config.engines);
  const engines = [];
  for (const [id, name] of [
    ["fast", "Fast Engine"],
    ["complex", "Complex Workflow"],
  ]) {
    if (!Object.hasOwn(configuredEngines, id)) continue;
    const source = object(configuredEngines[id]);
    const safe = pick(
      source,
      { type: string, provider: string, model: string },
      ["type"],
    );
    const nested = pick(source.config, { model: string });
    if (!safe.model && nested.model) safe.model = nested.model;
    engines.push({
      id,
      name,
      ...safe,
      configured: true,
      implemented: false,
      status: "unavailable",
      message: "Configuration is present; no execution engine is connected.",
    });
  }
  const safety = pick(config.safety, {
    maxFilesPerFix: count,
    protectedPaths: strings,
    requiredChecks: strings,
    circuitBreaker: (value) =>
      pick(value, {
        enabled: boolean,
        failureThreshold: count,
        windowMinutes: count,
        cooldownMinutes: count,
      }),
    autoRollback: (value) =>
      pick(value, { enabled: boolean, ciTimeout: count, notifyOn: strings }),
  });
  const triggers = pick(config.triggers, {
    webhooks: (value) => pick(value, { enabled: boolean, events: strings }),
    cron: (value) =>
      pick(
        value,
        Object.fromEntries(
          ["healthCheck", "qualityScan", "dependencyAudit"].map((name) => [
            name,
            (job) => pick(job, { enabled: boolean, schedule: string }),
          ]),
        ),
      ),
    manual: (value) => pick(value, { enabled: boolean, requireAuth: boolean }),
  });
  return {
    project,
    engines,
    safety,
    triggers,
    monitoring: normalizeMonitoringConfig(config.monitoring),
  };
}

function projectRules(input) {
  const source = object(input);
  const version = string(source.version);
  if (!Array.isArray(source.rules))
    throw new TypeError("Expected a rules array.");
  const rules = source.rules.map((rule) =>
    pick(
      rule,
      {
        id: string,
        name: string,
        enabled: boolean,
        match: (value) =>
          pick(value, {
            taskType: member(taskTypes),
            "context.retryCount": (condition) =>
              pick(condition, {
                $lt: number,
                $lte: number,
                $gt: number,
                $gte: number,
                $eq: number,
              }),
          }),
        processor: (value) =>
          pick(
            value,
            {
              engine: string,
              action: string,
              priority: member(priorities),
              workflow: string,
            },
            ["engine", "action", "priority"],
          ),
      },
      ["id", "name", "enabled", "match", "processor"],
    ),
  );
  return { version, rules };
}

async function readConfiguration(rootDir, stem, kind, project) {
  const configuredPath = join(rootDir, "configs", `${stem}.json`);
  let source = "configured";
  let filename = configuredPath;
  try {
    // lstat distinguishes a missing file from a present but broken symlink.
    await lstat(configuredPath);
  } catch (error) {
    if (error.code !== "ENOENT")
      throw new ConsoleError(
        500,
        `${kind}_READ_ERROR`,
        `Cannot read ${stem}.json.`,
      );
    source = "example";
    filename = join(rootDir, "configs", `${stem}.example.json`);
  }
  let contents;
  try {
    contents = await readFile(filename, "utf8");
  } catch (error) {
    if (source === "example" && error.code === "ENOENT") {
      throw new ConsoleError(
        503,
        `${kind}_MISSING`,
        `No ${stem}.json or ${stem}.example.json is available.`,
      );
    }
    throw new ConsoleError(
      500,
      `${kind}_READ_ERROR`,
      `Cannot read the ${source} ${stem} file.`,
    );
  }
  try {
    return { source, value: project(JSON.parse(contents)) };
  } catch {
    throw new ConsoleError(
      500,
      `${kind}_INVALID`,
      `The ${source} ${stem} file must contain valid JSON and supported field types.`,
    );
  }
}

async function snapshot(rootDir) {
  const [config, rules] = await Promise.all([
    readConfiguration(rootDir, "healing-config", "CONFIG", projectConfig),
    readConfiguration(rootDir, "healing-rules", "RULES", projectRules),
  ]);
  return {
    apiVersion: 1,
    mode: "live",
    generatedAt: new Date().toISOString(),
    configSource: config.source,
    rulesSource: rules.source,
    rulesVersion: rules.value.version,
    ...config.value,
    capabilities,
    rules: rules.value.rules,
    tasks: [],
    activity: [],
  };
}

function json(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(body);
}

function fail(response, status, code, message, headers) {
  json(response, status, { error: { code, message } }, headers);
}

function pathname(request) {
  let path;
  try {
    // Inspect the original path before a URL parser can normalize away '..'.
    path = decodeURIComponent((request.url ?? "/").split("?")[0]);
  } catch {
    throw new ConsoleError(400, "BAD_REQUEST", "Malformed request path.");
  }
  if (path.includes("\0"))
    throw new ConsoleError(400, "BAD_REQUEST", "Malformed request path.");
  if (
    !path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part.startsWith("."))
  ) {
    throw new ConsoleError(404, "NOT_FOUND", "Resource not found.");
  }
  return path;
}

async function staticFile(request, response, publicDir, path) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    fail(
      response,
      405,
      "METHOD_NOT_ALLOWED",
      "Use GET or HEAD for console assets.",
      { Allow: "GET, HEAD" },
    );
    return;
  }
  const candidate = resolve(
    publicDir,
    `.${path === "/" ? "/index.html" : path}`,
  );
  const type = mediaTypes.get(extname(candidate).toLowerCase());
  if (!type) throw new ConsoleError(404, "NOT_FOUND", "Resource not found.");
  try {
    const [root, file] = await Promise.all([
      realpath(publicDir),
      realpath(candidate),
    ]);
    const within = relative(root, file);
    if (
      !within ||
      isAbsolute(within) ||
      within.split(sep).some((part) => part.startsWith(".")) ||
      !mediaTypes.has(extname(file).toLowerCase())
    ) {
      throw new ConsoleError(404, "NOT_FOUND", "Resource not found.");
    }
    if (!(await stat(file)).isFile())
      throw new ConsoleError(404, "NOT_FOUND", "Resource not found.");
    const body = await readFile(file);
    response.writeHead(200, {
      "Content-Type": type,
      "Content-Length": body.length,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch (error) {
    if (error instanceof ConsoleError) throw error;
    if (["ENOENT", "ENOTDIR", "EACCES", "ELOOP"].includes(error.code)) {
      throw new ConsoleError(404, "NOT_FOUND", "Resource not found.");
    }
    throw error;
  }
}

/** Create an unbound, read-only management server. No engine or shell is invoked. */
export function createConsoleServer({
  rootDir = defaultRoot,
  publicDir = join(rootDir, "apps/console/public"),
} = {}) {
  const configRoot = resolve(rootDir);
  const assetRoot = resolve(publicDir);
  return createServer((request, response) => {
    void (async () => {
      const path = pathname(request);
      if (path === "/api/healing/snapshot") {
        if (request.method !== "GET") {
          fail(
            response,
            405,
            "METHOD_NOT_ALLOWED",
            "Use GET for the snapshot.",
            { Allow: "GET" },
          );
          return;
        }
        json(response, 200, await snapshot(configRoot));
        return;
      }
      if (path === "/api" || path.startsWith("/api/")) {
        request.resume();
        const mutation =
          path === "/api/healing/trigger" ||
          /^\/api\/healing\/tasks\/[^/]+\/(cancel|retry)$/.test(path) ||
          /^\/api\/healing\/approvals\/[^/]+\/decision$/.test(path);
        if (request.method === "POST" && mutation) {
          fail(
            response,
            501,
            "NOT_IMPLEMENTED",
            "No execution engine is connected. The management API is read-only.",
          );
        } else {
          fail(response, 404, "NOT_FOUND", "API route not found.");
        }
        return;
      }
      await staticFile(request, response, assetRoot, path);
    })().catch((error) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof ConsoleError)
        fail(response, error.status, error.code, error.message);
      else
        fail(
          response,
          500,
          "INTERNAL_ERROR",
          "The console request could not be completed.",
        );
    });
  });
}
