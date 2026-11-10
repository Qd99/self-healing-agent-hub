import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  cp,
  rm,
  writeFile,
  readFile,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpRequest } from "node:http";
import { createConsoleServer } from "../apps/healing-hub/src/console-server.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const operatorToken = "integration-console-token-123456";
const workerToken = "integration-worker-token-1234567";

async function fixture(t, options = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), "heal-live-api-"));
  await cp(join(repo, "configs"), join(rootDir, "configs"), {
    recursive: true,
  });
  const configPath = join(rootDir, "configs/healing-config.example.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.project = {
    id: "integration",
    repo: "owner/project",
    defaultBranch: "main",
  };
  await writeFile(configPath, JSON.stringify(config));
  await mkdir(join(rootDir, "public"));
  await writeFile(
    join(rootDir, "public/index.html"),
    "<!doctype html><title>Heal</title>",
  );
  const resolvedOptions =
    typeof options === "function" ? await options(rootDir) : options;
  let server;
  const start = async () => {
    server = createConsoleServer({
      rootDir,
      publicDir: join(rootDir, "public"),
      consoleToken: operatorToken,
      workerToken,
      ...resolvedOptions,
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  };
  let base = await start();
  t.after(async () => {
    if (server.listening) {
      if (server.shutdown) await server.shutdown();
      else await new Promise((resolve) => server.close(resolve));
    }
    await rm(rootDir, { recursive: true, force: true });
  });
  return {
    get base() {
      return base;
    },
    async restart() {
      await server.shutdown();
      base = await start();
    },
    async request(
      path,
      { method = "GET", cookie, csrf, token, body, headers = {} } = {},
    ) {
      const response = await fetch(`${base}/api/healing${path}`, {
        method,
        headers: {
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(csrf ? { "X-Heal-CSRF": csrf } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { response, status: response.status, data: await response.json() };
    },
    async login() {
      const response = await fetch(`${base}/api/healing/session`, {
        method: "POST",
        headers: { Authorization: `Bearer ${operatorToken}`, Origin: base },
      });
      const data = await response.json();
      assert.equal(response.status, 200, JSON.stringify(data));
      return {
        cookie: response.headers.get("set-cookie").split(";")[0],
        csrf: data.snapshot.csrfToken,
        snapshot: data.snapshot,
        cookieHeader: response.headers.get("set-cookie"),
      };
    },
  };
}

test("real API requires a management session, CSRF and same-origin writes", async (t) => {
  const api = await fixture(t);
  assert.equal((await api.request("/snapshot")).status, 401);
  const invalid = await api.request("/session", {
    method: "POST",
    token: "wrong-token",
  });
  assert.equal(invalid.status, 401);
  const session = await api.login();
  assert.match(session.cookieHeader, /HttpOnly/i);
  assert.match(session.cookieHeader, /SameSite=Strict/i);
  assert.ok(session.csrf.length >= 32);
  assert.equal(session.snapshot.mode, "live");
  assert.equal(session.snapshot.capabilities.trigger, true);
  const body = { title: "检查格式", type: "format-error", priority: "medium" };
  assert.equal(
    (
      await api.request("/trigger", {
        method: "POST",
        cookie: session.cookie,
        body,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await api.request("/trigger", {
        method: "POST",
        ...session,
        body,
        headers: { Origin: "https://untrusted.example" },
      })
    ).status,
    403,
  );
  const created = await api.request("/trigger", {
    method: "POST",
    ...session,
    body,
    headers: { Origin: api.base },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.snapshot.tasks.length, 1);
  assert.equal(created.data.snapshot.tasks[0].task.id, created.data.taskId);
  assert.equal(created.data.snapshot.tasks[0].status.status, "pending");
  assert.ok(created.data.snapshot.activity.length > 0);
  assert.equal(
    created.data.snapshot.tasks[0].task.payload.context.demo,
    undefined,
  );
  const logout = await api.request("/session", {
    method: "DELETE",
    ...session,
  });
  assert.equal(logout.status, 200);
  assert.equal(
    (await api.request("/snapshot", { cookie: session.cookie })).status,
    401,
  );
});

test("API task writes persist after restart and reject stale revisions", async (t) => {
  const api = await fixture(t);
  let session = await api.login();
  const created = await api.request("/trigger", {
    method: "POST",
    ...session,
    body: {
      title: "实际任务",
      type: "lint-error",
      priority: "high",
      description: "由集成请求创建",
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const task = created.data.snapshot.tasks[0];
  const cancel = await api.request(`/tasks/${task.task.id}/cancel`, {
    method: "POST",
    ...session,
    body: { expectedRevision: task.revision },
  });
  assert.equal(cancel.status, 200, JSON.stringify(cancel.data));
  const stale = await api.request(`/tasks/${task.task.id}/retry`, {
    method: "POST",
    ...session,
    body: { expectedRevision: task.revision },
  });
  assert.equal(stale.status, 409);
  await api.restart();
  session = await api.login();
  assert.equal(session.snapshot.tasks.length, 1);
  assert.equal(session.snapshot.tasks[0].status.status, "cancelled");
  assert.equal(
    session.snapshot.activity.length,
    cancel.data.snapshot.activity.length,
  );
});

test("worker credentials are separate and actual evidence unlocks two-gate execution", async (t) => {
  const api = await fixture(t);
  const session = await api.login();
  const created = await api.request("/trigger", {
    method: "POST",
    ...session,
    body: { title: "候选修复联调", type: "lint-error", priority: "high" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const claimBody = { engineId: "fast", workerId: "test-agent" };
  assert.equal(
    (
      await api.request("/worker/claim", {
        method: "POST",
        token: operatorToken,
        body: claimBody,
      })
    ).status,
    401,
  );
  assert.equal(
    (await api.request("/snapshot", { token: workerToken })).status,
    401,
  );
  const claim = await api.request("/worker/claim", {
    method: "POST",
    token: workerToken,
    body: claimBody,
  });
  assert.equal(claim.status, 200, JSON.stringify(claim.data));
  assert.equal(claim.data.lease.phase, "diagnose");
  const id = claim.data.task.task.id;
  const proposal = await api.request(`/worker/tasks/${id}/proposal`, {
    method: "POST",
    token: workerToken,
    body: {
      leaseId: claim.data.lease.id,
      summary: "移除未使用的导入",
      diff: [
        {
          path: "src/app.js",
          additions: 0,
          deletions: 1,
          lines: [{ type: "remove", content: "import unused from 'unused';" }],
        },
      ],
      evidence: {
        beforeState: "lint 报告一个未使用导入",
        afterState: "候选工作区 lint 通过",
        testsRun: ["npm run typecheck", "npm run lint", "npm run test"],
        checksPass: ["npm run typecheck", "npm run lint", "npm run test"],
        checksFail: [],
      },
    },
  });
  assert.equal(proposal.status, 200, JSON.stringify(proposal.data));
  const read = () => api.request("/snapshot", { cookie: session.cookie });
  let entry = (await read()).data.tasks.find((item) => item.task.id === id);
  assert.equal(entry.approvalFlow.source, "server");
  assert.equal(entry.reviewState, "pending");
  const blockedClaim = await api.request("/worker/claim", {
    method: "POST",
    token: workerToken,
    body: claimBody,
  });
  assert.equal(blockedClaim.data.task, null);
  for (const nodeId of ["code-review", "execution-auth"]) {
    const decision = await api.request(`/approvals/${id}/decision`, {
      method: "POST",
      ...session,
      body: {
        decision: "approve",
        nodeId,
        round: entry.approvalFlow.round,
        comment: "已核对证据",
        expectedRevision: entry.revision,
      },
    });
    assert.equal(decision.status, 200, JSON.stringify(decision.data));
    entry = decision.data.snapshot.tasks.find((item) => item.task.id === id);
  }
  assert.equal(entry.status.status, "pending");
  const execution = await api.request("/worker/claim", {
    method: "POST",
    token: workerToken,
    body: claimBody,
  });
  assert.equal(execution.data.lease.phase, "execute");
  const at = new Date().toISOString();
  const completed = await api.request(`/worker/tasks/${id}/complete`, {
    method: "POST",
    token: workerToken,
    body: {
      leaseId: execution.data.lease.id,
      result: {
        taskId: id,
        success: true,
        action: "committed",
        changes: { files: ["src/app.js"], commit: "a".repeat(40) },
        logs: ["测试 Worker 返回的受控联调结果"],
        evidence: {
          beforeState: "before",
          afterState: "after",
          testsRun: ["npm run typecheck", "npm run lint", "npm run test"],
          checksPass: ["npm run typecheck", "npm run lint", "npm run test"],
          checksFail: [],
        },
        timings: { startedAt: at, completedAt: at, durationMs: 0 },
      },
    },
  });
  assert.equal(completed.status, 200, JSON.stringify(completed.data));
  const snapshot = (await read()).data;
  assert.equal(
    snapshot.tasks.find((item) => item.task.id === id).status.status,
    "completed",
  );
  const serialized = JSON.stringify(snapshot);
  assert.ok(!serialized.includes(execution.data.lease.id));
  assert.ok(!serialized.includes(operatorToken));
  assert.ok(!serialized.includes(workerToken));
});

test("API rejects invalid JSON media, overlarge requests and unknown API routes", async (t) => {
  const api = await fixture(t);
  const session = await api.login();
  const raw = (body, contentType) =>
    fetch(`${api.base}/api/healing/trigger`, {
      method: "POST",
      headers: {
        Cookie: session.cookie,
        "X-Heal-CSRF": session.csrf,
        "Content-Type": contentType,
      },
      body,
    });
  assert.equal((await raw("{}", "text/plain")).status, 415);
  assert.equal((await raw("{invalid", "application/json")).status, 400);
  assert.equal(
    (
      await raw(
        JSON.stringify({ title: "x".repeat(1_100_000) }),
        "application/json",
      )
    ).status,
    413,
  );
  assert.equal((await api.request("/missing", session)).status, 404);
  assert.equal(
    (await api.request("/snapshot", { method: "POST", ...session, body: {} }))
      .status,
    405,
  );
});

test("configuration and partial bulk outcomes are server-persisted and auditable", async (t) => {
  const api = await fixture(t);
  const session = await api.login();
  const requestId = "http-create-idempotency-check";
  const body = {
    requestId,
    title: "批量任务 A",
    type: "lint-error",
    priority: "high",
  };
  const first = await api.request("/trigger", {
    method: "POST",
    ...session,
    body,
  });
  const repeated = await api.request("/trigger", {
    method: "POST",
    ...session,
    body,
  });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal(repeated.data.taskId, first.data.taskId);
  assert.equal(repeated.data.snapshot.tasks.length, 1);
  const second = await api.request("/trigger", {
    method: "POST",
    ...session,
    body: { title: "批量任务 B", type: "format-error", priority: "low" },
  });
  const entries = second.data.snapshot.tasks;
  const bulk = await api.request("/tasks/bulk", {
    method: "POST",
    ...session,
    body: {
      type: "cancel",
      items: entries.map((entry, index) => ({
        id: entry.task.id,
        revision: index ? 0 : entry.revision,
      })),
    },
  });
  assert.equal(bulk.status, 200, JSON.stringify(bulk.data));
  assert.equal(bulk.data.report.applied.length, 1);
  assert.equal(bulk.data.report.skipped.length, 1);
  const snapshot = bulk.data.snapshot;
  const rule = snapshot.rules.find((item) => item.id === "lint-auto-fix");
  const toggle = await api.request(`/rules/${rule.id}`, {
    method: "PATCH",
    ...session,
    body: { enabled: false, expectedRevision: snapshot.revision },
  });
  assert.equal(toggle.status, 200, JSON.stringify(toggle.data));
  assert.equal(
    toggle.data.snapshot.rules.find((item) => item.id === rule.id).enabled,
    false,
  );
  const monitoring = {
    grafana: {
      baseUrl: "https://grafana.example.test",
      dashboardUid: "healing",
    },
    datasource: { type: "prometheus", uid: "prom-main", name: "Prometheus" },
    namespaces: ["agents"],
  };
  const saved = await api.request("/monitoring", {
    method: "PUT",
    ...session,
    body: { monitoring, expectedRevision: toggle.data.snapshot.revision },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.snapshot.monitoring.datasource.uid, "prom-main");
  assert.equal(saved.data.snapshot.monitoring.connectivity, "unverified");
  const check = await api.request("/monitoring/check", {
    method: "POST",
    ...session,
    body: {},
  });
  assert.equal(check.status, 200);
  assert.equal(
    check.data.check.status,
    "error",
    "unspecified allowed origins must not make an outbound request",
  );
  await api.restart();
  const restored = await api.login();
  assert.deepEqual(restored.snapshot.monitoring.namespaces, ["agents"]);
  assert.equal(
    restored.snapshot.rules.find((item) => item.id === rule.id).enabled,
    false,
  );
  assert.ok(
    restored.snapshot.activity.some((item) =>
      item.action.includes("monitoring"),
    ),
  );
});

test("tokenless mode is loopback-only and still requires CSRF", async (t) => {
  const api = await fixture(t, { consoleToken: "" });
  const snapshot = await api.request("/snapshot");
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.data.auth.required, false);
  // Undici ignores a custom Host header; use the raw HTTP client to test rebinding.
  const foreignHostStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(
      `${api.base}/api/healing/snapshot`,
      { headers: { Host: "attacker.example" } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal(
    (
      await api.request("/snapshot", {
        headers: { Origin: "https://attacker.example" },
      })
    ).status,
    403,
  );
  const body = { title: "本机任务", type: "lint-error", priority: "high" };
  assert.equal(
    (await api.request("/trigger", { method: "POST", body })).status,
    403,
  );
  const created = await api.request("/trigger", {
    method: "POST",
    csrf: snapshot.data.csrfToken,
    body,
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
});

test("monitoring checks identify the exact saved configuration even if it changes during the request", async (t) => {
  let releaseCheck;
  let reachedUpstream;
  const blocked = new Promise((resolve) => {
    releaseCheck = resolve;
  });
  const started = new Promise((resolve) => {
    reachedUpstream = resolve;
  });
  t.after(() => releaseCheck());
  const api = await fixture(t, {
    grafanaAllowedOrigins: ["https://a.example.test", "https://b.example.test"],
    grafanaFetch: async (url) => {
      assert.equal(new URL(url).origin, "https://a.example.test");
      if (new URL(url).pathname.endsWith("/api/health")) {
        reachedUpstream();
        await blocked;
        return Response.json({ database: "ok" });
      }
      return Response.json({
        uid: "prom-main",
        type: "prometheus",
        name: "Prometheus",
      });
    },
  });
  const session = await api.login();
  const monitoring = {
    grafana: { baseUrl: "https://a.example.test", dashboardUid: "dashboard-a" },
    datasource: { uid: "prom-main", name: "Prometheus" },
    namespaces: ["agents"],
  };
  const savedA = await api.request("/monitoring", {
    method: "PUT",
    ...session,
    body: { monitoring, expectedRevision: session.snapshot.revision },
  });
  assert.equal(savedA.status, 200);
  const pending = api.request("/monitoring/check", {
    method: "POST",
    ...session,
    body: {},
  });
  await started;
  const savedB = await api.request("/monitoring", {
    method: "PUT",
    ...session,
    body: {
      monitoring: {
        ...monitoring,
        grafana: {
          ...monitoring.grafana,
          baseUrl: "https://b.example.test",
          dashboardUid: "dashboard-b",
        },
      },
      expectedRevision: savedA.data.snapshot.revision,
    },
  });
  releaseCheck();
  assert.equal(savedB.status, 200);
  const checked = await pending;
  assert.equal(checked.status, 200);
  assert.equal(checked.data.check.status, "connected");
  assert.equal(checked.data.revision, savedA.data.snapshot.revision);
  assert.deepEqual(checked.data.monitoring, savedA.data.snapshot.monitoring);
  const current = await api.request("/snapshot", session);
  assert.equal(current.data.monitoring.grafana.dashboardUid, "dashboard-b");
});

for (const parentLink of [false, true]) {
  test(`private storage reached through a ${parentLink ? "parent" : "directory"} symlink cannot be served as a public asset`, async (t) => {
    const api = await fixture(t, async (rootDir) => {
      const target = join(rootDir, "public/private-data");
      await mkdir(target);
      await writeFile(
        join(target, "console-state.json"),
        JSON.stringify({ privateLease: "private-state-must-never-be-public" }),
      );
      await symlink(
        parentLink ? join(rootDir, "public") : target,
        join(rootDir, "storage-link"),
      );
      return {
        dataDir: join(
          rootDir,
          "storage-link",
          ...(parentLink ? ["private-data"] : []),
        ),
      };
    });
    const response = await fetch(`${api.base}/private-data/console-state.json`);
    const body = await response.text();
    assert.notEqual(response.status, 200);
    assert.ok(!body.includes("private-state-must-never-be-public"));
    const snapshot = await api.request("/snapshot", { token: operatorToken });
    assert.equal(snapshot.status, 500);
    assert.equal(snapshot.data.error.code, "UNSAFE_STORAGE_PATH");
  });
}

test("nonexistent storage under a symlinked public ancestor is rejected before creation", async (t) => {
  const api = await fixture(t, async (rootDir) => {
    await symlink(join(rootDir, "public"), join(rootDir, "storage-parent"));
    return { dataDir: join(rootDir, "storage-parent", "not-created", "state") };
  });
  const response = await api.request("/snapshot", { token: operatorToken });
  assert.equal(response.status, 500);
  assert.equal(response.data.error.code, "UNSAFE_STORAGE_PATH");
});
