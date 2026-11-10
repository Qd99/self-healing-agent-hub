import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeMonitoringConfig } from "../../console/public/monitoring-model.js";

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
export class ConsoleError extends Error {
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

export async function loadConsoleConfiguration(rootDir) {
  const [config, rules] = await Promise.all([
    readConfiguration(rootDir, "healing-config", "CONFIG", projectConfig),
    readConfiguration(rootDir, "healing-rules", "RULES", projectRules),
  ]);
  return {
    configSource: config.source,
    rulesSource: rules.source,
    rulesVersion: rules.value.version,
    ...config.value,
    rules: rules.value.rules,
  };
}
