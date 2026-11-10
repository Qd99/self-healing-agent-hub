import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createConsoleServer } from "../apps/healing-hub/src/console-server.mjs";

const config = {
  version: "1.0.0",
  project: { id: "sample", repo: "owner/sample", defaultBranch: "main" },
  engines: {
    fast: { type: "direct-ai", provider: "anthropic", model: "sample-model" },
    complex: { type: "zcode-workflow", config: { model: "workflow-model" } },
  },
  triggers: {
    webhooks: { enabled: true, events: ["push", "workflow_run"] },
    cron: { healthCheck: { enabled: true, schedule: "*/30 * * * *" } },
    manual: {
      enabled: true,
      requireAuth: true,
      apiEndpoint: "/api/healing/trigger",
    },
  },
  safety: {
    maxFilesPerFix: 5,
    protectedPaths: ["deploy/", "*.env"],
    requiredChecks: ["npm test"],
    circuitBreaker: {
      enabled: true,
      failureThreshold: 3,
      windowMinutes: 60,
      cooldownMinutes: 30,
    },
    autoRollback: {
      enabled: true,
      ciTimeout: 600000,
      notifyOn: ["github-issue"],
    },
  },
};

const rules = {
  version: "1.0.0",
  rules: [
    {
      id: "ci-retry",
      name: "CI retry",
      enabled: true,
      match: { taskType: "ci-failure", "context.retryCount": { $lt: 3 } },
      processor: { engine: "fast", action: "retry", priority: "high" },
    },
  ],
};

const capabilities = {
  importCi: false,
  verifyResult: false,
  trigger: true,
  cancel: true,
  retry: true,
  approve: true,
  updateRules: true,
  updateMonitoring: true,
  reconcile: true,
};

function get(base, path, method = "GET", body) {
  return new Promise((resolve, reject) => {
    const req = request(`${base}`, { path, method, agent: false }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        text += chunk;
      });
      res.on("end", () =>
        resolve({ status: res.statusCode, headers: res.headers, text }),
      );
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function fixture(t) {
  const rootDir = await mkdtemp(join(tmpdir(), "healing-console-"));
  const publicDir = join(rootDir, "apps/console/public");
  await mkdir(join(rootDir, "configs"), { recursive: true });
  await mkdir(join(publicDir, "assets"), { recursive: true });
  await Promise.all([
    writeFile(
      join(rootDir, "configs/healing-config.example.json"),
      JSON.stringify(config),
    ),
    writeFile(
      join(rootDir, "configs/healing-rules.example.json"),
      JSON.stringify(rules),
    ),
    writeFile(
      join(publicDir, "index.html"),
      "<!doctype html><title>Console</title>",
    ),
    writeFile(join(publicDir, "app.js"), "export const ready = true;"),
    writeFile(join(publicDir, "styles.css"), "body { color: teal; }"),
    writeFile(join(publicDir, ".env"), "PUBLIC_SECRET_SHOULD_NOT_ESCAPE"),
    writeFile(
      join(publicDir, "assets/index.html"),
      "DIRECTORY_INDEX_SHOULD_NOT_ESCAPE",
    ),
    writeFile(join(publicDir, "private.key"), "PRIVATE_KEY_SHOULD_NOT_ESCAPE"),
    writeFile(
      join(rootDir, "server-secret.txt"),
      "ROOT_SECRET_SHOULD_NOT_ESCAPE",
    ),
  ]);
  const server = createConsoleServer({ rootDir, publicDir });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await server.shutdown();
    await rm(rootDir, { recursive: true, force: true });
  });
  return {
    rootDir,
    publicDir,
    base: `http://127.0.0.1:${server.address().port}`,
  };
}

test("snapshot labels example configuration, enables management and reports disconnected engines", async (t) => {
  const { base } = await fixture(t);
  const before = Date.now();
  const response = await get(base, "/api/healing/snapshot");
  assert.equal(response.status, 200);
  assert.match(response.headers["content-type"], /^application\/json/);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  const snapshot = JSON.parse(response.text);
  assert.equal(snapshot.apiVersion, 1);
  assert.equal(snapshot.mode, "live");
  assert.equal(snapshot.configSource, "example");
  assert.equal(snapshot.rulesSource, "example");
  assert.equal(snapshot.rulesVersion, "1.0.0");
  assert.ok(Date.parse(snapshot.generatedAt) >= before);
  assert.ok(Date.parse(snapshot.generatedAt) <= Date.now());
  assert.deepEqual(snapshot.capabilities, capabilities);
  assert.deepEqual(snapshot.tasks, []);
  assert.deepEqual(snapshot.activity, []);
  assert.deepEqual(snapshot.project, {
    id: "sample",
    repo: "owner/sample",
    defaultBranch: "main",
  });
  assert.equal(snapshot.engines.length, 2);
  for (const engine of snapshot.engines) {
    assert.equal(engine.configured, true);
    assert.equal(engine.implemented, false);
    assert.equal(engine.status, "unavailable");
    assert.ok(engine.message.length > 0);
  }
  assert.equal(snapshot.engines[1].model, "workflow-model");
  assert.deepEqual(snapshot.rules[0].match, {
    taskType: "ci-failure",
    "context.retryCount": { $lt: 3 },
  });
  assert.equal(snapshot.safety.circuitBreaker.failureThreshold, 3);
  assert.equal(snapshot.triggers.cron.healthCheck.schedule, "*/30 * * * *");
});

test("configured snapshot projects safe fields and excludes credentials and unknown fields at every level", async (t) => {
  const { base, rootDir } = await fixture(t);
  const actual = structuredClone(config);
  actual.project.repo = "owner/production";
  actual.project.privateKey = "needle-project-private";
  actual.engines.fast.apiKey = "needle-api-key";
  actual.engines.fast.endpoint =
    "https://user:needle-endpoint-password@example.invalid";
  actual.engines.complex.endpoint =
    "https://example.invalid?key=needle-endpoint-token";
  actual.engines.complex.config.secret = "needle-engine-secret";
  actual.engines.unknownEngine = { type: "needle-unknown-engine" };
  actual.triggers.webhooks.secret = "needle-webhook-secret";
  actual.triggers.manual.apiEndpoint =
    "https://user:needle-manual-password@example.invalid";
  actual.triggers.cron.unknownJob = { schedule: "needle-cron-secret" };
  actual.safety.circuitBreaker.secret = "needle-circuit-secret";
  actual.safety.unknown = "needle-safety-secret";
  actual.github = { privateKey: "needle-github-private" };
  actual.unknown = { secret: "needle-unknown-secret" };
  const actualRules = structuredClone(rules);
  actualRules.rules[0].name = "Production CI retry";
  actualRules.rules[0].unknown = "needle-rule-secret";
  actualRules.rules[0].match.secret = "needle-match-secret";
  actualRules.rules[0].match["context.retryCount"].secret =
    "needle-condition-secret";
  actualRules.rules[0].processor.apiKey = "needle-processor-secret";
  await Promise.all([
    writeFile(
      join(rootDir, "configs/healing-config.json"),
      JSON.stringify(actual),
    ),
    writeFile(
      join(rootDir, "configs/healing-rules.json"),
      JSON.stringify(actualRules),
    ),
  ]);
  const response = await get(base, "/api/healing/snapshot");
  assert.equal(response.status, 200);
  assert.doesNotMatch(response.text, /needle-/);
  const snapshot = JSON.parse(response.text);
  assert.equal(snapshot.configSource, "configured");
  assert.equal(snapshot.rulesSource, "configured");
  assert.equal(snapshot.project.repo, "owner/production");
  assert.equal(snapshot.rules[0].name, "Production CI retry");
  assert.deepEqual(Object.keys(snapshot.project).sort(), [
    "defaultBranch",
    "id",
    "repo",
  ]);
  assert.deepEqual(
    snapshot.engines.map((engine) => engine.id),
    ["fast", "complex"],
  );
  assert.deepEqual(snapshot.triggers.manual, {
    enabled: true,
    requireAuth: true,
  });
});

test("each snapshot rereads actual files and reports config and rules sources independently", async (t) => {
  const { base, rootDir } = await fixture(t);
  const initialResponse = await get(base, "/api/healing/snapshot");
  assert.equal(initialResponse.status, 200);
  const first = JSON.parse(initialResponse.text);
  assert.equal(first.configSource, "example");
  const actual = structuredClone(config);
  actual.project.id = "new-project";
  await writeFile(
    join(rootDir, "configs/healing-config.json"),
    JSON.stringify(actual),
  );
  const second = JSON.parse((await get(base, "/api/healing/snapshot")).text);
  assert.equal(second.configSource, "configured");
  assert.equal(second.rulesSource, "example");
  assert.equal(second.project.id, "new-project");
});

for (const [name, filename, contents, code] of [
  [
    "invalid config JSON",
    "healing-config.json",
    '{"secret":"needle-broken-json",',
    "CONFIG_INVALID",
  ],
  [
    "invalid config shape",
    "healing-config.json",
    '{"project":[]}',
    "CONFIG_INVALID",
  ],
  [
    "invalid known config value",
    "healing-config.json",
    JSON.stringify({
      ...config,
      safety: { maxFilesPerFix: "needle-invalid-number" },
    }),
    "CONFIG_INVALID",
  ],
  [
    "null config section",
    "healing-config.json",
    JSON.stringify({ ...config, safety: null }),
    "CONFIG_INVALID",
  ],
  [
    "null engine section",
    "healing-config.json",
    JSON.stringify({ ...config, engines: null }),
    "CONFIG_INVALID",
  ],
  [
    "invalid rules JSON",
    "healing-rules.json",
    '{"secret":"needle-broken-rules",',
    "RULES_INVALID",
  ],
  [
    "invalid rules shape",
    "healing-rules.json",
    '{"version":"1","rules":{}}',
    "RULES_INVALID",
  ],
]) {
  test(`${name} returns an explicit error without falling back to example data or echoing input`, async (t) => {
    const { base, rootDir } = await fixture(t);
    await writeFile(join(rootDir, "configs", filename), contents);
    const response = await get(base, "/api/healing/snapshot");
    assert.equal(response.status, 500);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(JSON.parse(response.text).error.code, code);
    assert.doesNotMatch(response.text, /needle-|owner\/sample/);
  });
}

test("an unreadable actual configuration is an error even when examples exist", async (t) => {
  const { base, rootDir } = await fixture(t);
  await mkdir(join(rootDir, "configs/healing-config.json"));
  const response = await get(base, "/api/healing/snapshot");
  assert.equal(response.status, 500);
  assert.equal(JSON.parse(response.text).error.code, "CONFIG_READ_ERROR");
});

test("a broken actual configuration symlink does not silently select the example", async (t) => {
  const { base, rootDir } = await fixture(t);
  await symlink(
    join(rootDir, "missing-config"),
    join(rootDir, "configs/healing-config.json"),
  );
  const response = await get(base, "/api/healing/snapshot");
  assert.equal(response.status, 500);
  assert.equal(JSON.parse(response.text).error.code, "CONFIG_READ_ERROR");
});

for (const [filename, code] of [
  ["healing-config.example.json", "CONFIG_MISSING"],
  ["healing-rules.example.json", "RULES_MISSING"],
]) {
  test(`missing ${filename} produces an actionable unavailable response`, async (t) => {
    const { base, rootDir } = await fixture(t);
    await rm(join(rootDir, "configs", filename));
    const response = await get(base, "/api/healing/snapshot");
    assert.equal(response.status, 503);
    assert.equal(JSON.parse(response.text).error.code, code);
  });
}

test("unauthorized mutations fail CSRF validation without creating tasks or echoing bodies", async (t) => {
  const { base } = await fixture(t);
  for (const path of [
    "/api/healing/trigger",
    "/api/healing/tasks/task-1/cancel",
    "/api/healing/tasks/task-1/retry",
    "/api/healing/approvals/approval-1/decision",
  ]) {
    const response = await get(
      base,
      path,
      "POST",
      '{"secret":"needle-request-secret"}',
    );
    assert.equal(response.status, 403, path);
    assert.equal(JSON.parse(response.text).error.code, "CSRF_REJECTED");
    assert.doesNotMatch(response.text, /needle-/);
    assert.equal(response.headers["cache-control"], "no-store");
  }
  assert.deepEqual(
    JSON.parse((await get(base, "/api/healing/snapshot")).text).tasks,
    [],
  );
});

test("unknown API paths return JSON 404 instead of the console HTML", async (t) => {
  const { base } = await fixture(t);
  const response = await get(base, "/api/healing/not-a-route");
  assert.equal(response.status, 404);
  assert.match(response.headers["content-type"], /^application\/json/);
  assert.equal(JSON.parse(response.text).error.code, "NOT_FOUND");
});

test("serves only public files with appropriate media types and nosniff", async (t) => {
  const { base } = await fixture(t);
  for (const [path, media, body] of [
    ["/", "text/html", "<!doctype html><title>Console</title>"],
    ["/app.js?v=1", "text/javascript", "export const ready = true;"],
    ["/styles.css", "text/css", "body { color: teal; }"],
  ]) {
    const response = await get(base, path);
    assert.equal(response.status, 200);
    assert.ok(response.headers["content-type"].startsWith(media));
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.equal(response.text, body);
  }
  const head = await get(base, "/app.js", "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.text, "");
});

test("rejects dotfiles, directories, traversal, unsupported secret files and escaping symlinks", async (t) => {
  const { base, rootDir, publicDir } = await fixture(t);
  assert.equal(
    (await get(base, "/app.js")).status,
    200,
    "public files remain accessible",
  );
  await symlink(join(rootDir, "server-secret.txt"), join(publicDir, "leak.js"));
  await symlink(join(publicDir, ".env"), join(publicDir, "hidden.js"));
  await symlink(join(publicDir, "private.key"), join(publicDir, "key.js"));
  for (const path of [
    "/.env",
    "/%2eenv",
    "/.git/config",
    "/assets",
    "/assets/",
    "/private.key",
    "/../server-secret.txt",
    "/%2e%2e/server-secret.txt",
    "/%2e%2e%2fserver-secret.txt",
    "/%5c..%5cserver-secret.txt",
    "/leak.js",
    "/hidden.js",
    "/key.js",
    "/configs/healing-config.example.json",
  ]) {
    const response = await get(base, path);
    assert.equal(response.status, 404, path);
    assert.doesNotMatch(response.text, /SHOULD_NOT_ESCAPE|owner\/sample/, path);
  }
});

test("malformed URL encoding is handled as a client error without crashing the server", async (t) => {
  const { base } = await fixture(t);
  for (const path of ["/%zz", "/%00"]) {
    assert.equal((await get(base, path)).status, 400);
  }
  assert.equal((await get(base, "/")).status, 200);
});

test("the real example files are valid inputs to the public snapshot contract", async (t) => {
  const { base, rootDir } = await fixture(t);
  await Promise.all(
    ["healing-config.example.json", "healing-rules.example.json"].map(
      async (filename) => {
        const contents = await readFile(
          new URL(`../configs/${filename}`, import.meta.url),
        );
        await writeFile(join(rootDir, "configs", filename), contents);
      },
    ),
  );
  const response = await get(base, "/api/healing/snapshot");
  assert.equal(response.status, 200);
  const snapshot = JSON.parse(response.text);
  assert.equal(snapshot.project.repo, "owner/repo-name");
  assert.equal(snapshot.rules.length, 10);
  assert.doesNotMatch(
    response.text,
    /ANTHROPIC_API_KEY|GITHUB_APP_PRIVATE_KEY|WEBHOOK_SECRET|localhost:8080/,
  );
});

test(
  "the entry point defaults to localhost and locates repository config independently of cwd",
  { timeout: 5000 },
  async (t) => {
    const dataDir = await mkdtemp(join(tmpdir(), "heal-entry-state-"));
    const env = { ...process.env, PORT: "0", HEALING_DATA_DIR: dataDir };
    delete env.HOST;
    delete env.CONSOLE_API_TOKEN;
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(
          new URL("../apps/healing-hub/src/index.mjs", import.meta.url),
        ),
      ],
      {
        cwd: tmpdir(),
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }
      await rm(dataDir, { recursive: true, force: true });
    });
    let output = "";
    const address = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", () =>
        reject(new Error("Console entry point exited before listening.")),
      );
      child.stdout.on("data", (chunk) => {
        output += chunk;
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) resolve(match[0]);
      });
    });
    const response = await get(address, "/api/healing/snapshot");
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.text).mode, "live");
  },
);
