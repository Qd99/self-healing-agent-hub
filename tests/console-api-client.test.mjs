import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

const clientModule = await import("../apps/console/public/api-client.js");

async function server(t, responder) {
  const requests = [];
  const http = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const entry = {
      path: request.url,
      method: request.method,
      headers: request.headers,
      body: raw ? JSON.parse(raw) : undefined,
    };
    requests.push(entry);
    const result = await responder(entry);
    response.writeHead(result.status || 200, {
      "Content-Type": result.contentType || "application/json",
    });
    response.end(result.raw ?? JSON.stringify(result.body));
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        http.closeAllConnections();
        http.close(resolve);
      }),
  );
  const origin = `http://127.0.0.1:${http.address().port}`;
  const options = [];
  assert.equal(
    typeof clientModule.createApiClient,
    "function",
    "A real same-origin API client is required",
  );
  const client = clientModule.createApiClient({
    fetch: (path, init) => {
      options.push({ path, init });
      return fetch(new URL(path, origin), init);
    },
  });
  return { client, requests, options };
}

const snapshot = (revision = 1, csrfToken = "csrf-1") => ({
  apiVersion: 1,
  mode: "live",
  revision,
  csrfToken,
});

test("live mutations use same-origin cookie credentials and the latest server CSRF token", async (t) => {
  const h = await server(t, (request) => ({
    body:
      request.method === "GET"
        ? snapshot()
        : {
            snapshot: snapshot(2, "csrf-2"),
            message: "created",
            taskId: "task-1",
          },
  }));
  await h.client.getSnapshot();
  const created = await h.client.triggerTask({
    title: "Repair",
    type: "type-error",
    priority: "high",
    branch: "main",
  });
  await h.client.taskAction("task-1", "cancel", { expectedRevision: 3 });
  assert.equal(created.taskId, "task-1");
  assert.equal(h.requests[1].path, "/api/healing/trigger");
  assert.equal(h.requests[1].headers["x-heal-csrf"], "csrf-1");
  assert.equal(h.requests[2].headers["x-heal-csrf"], "csrf-2");
  assert.deepEqual(h.requests[2].body, { expectedRevision: 3 });
  assert.equal(h.requests[2].path, "/api/healing/tasks/task-1/cancel");
  assert.ok(h.options.every(({ init }) => init.credentials === "same-origin"));
  assert.ok(h.options.every(({ init }) => init.cache === "no-store"));
});

test("session exchange sends the management token only in Authorization and logout uses CSRF", async (t) => {
  const h = await server(t, (request) => ({
    body:
      request.method === "DELETE"
        ? { message: "signed out" }
        : { snapshot: snapshot(4, "session-csrf"), message: "signed in" },
  }));
  await h.client.createSession("private-token");
  await h.client.deleteSession();
  assert.equal(h.requests[0].path, "/api/healing/session");
  assert.equal(h.requests[0].headers.authorization, "Bearer private-token");
  assert.equal(h.requests[0].body, undefined);
  assert.equal(h.requests[1].method, "DELETE");
  assert.equal(h.requests[1].headers["x-heal-csrf"], "session-csrf");
  assert.equal(h.requests[1].headers.authorization, undefined);
  assert.ok(h.options.every(({ path }) => !path.includes("private-token")));
  await assert.rejects(
    h.client.triggerTask({ title: "After logout" }),
    (error) => error.code === "CSRF_REQUIRED",
  );
  assert.equal(h.requests.length, 2);
});

test("bulk, approvals, rules, monitoring save and check use the published contract", async (t) => {
  const checked = {
    check: { status: "error", message: "Not reachable" },
    monitoring: {
      grafana: {
        baseUrl: "https://grafana.example.com",
        dashboardUid: "healing",
      },
      datasource: { type: "prometheus", uid: "prom-main" },
      namespaces: ["production"],
    },
    revision: 12,
  };
  const h = await server(t, (request) => ({
    body: request.path.endsWith("/check")
      ? checked
      : request.method === "GET"
        ? snapshot()
        : { snapshot: snapshot(), message: "saved" },
  }));
  await h.client.getSnapshot();
  await h.client.bulkTaskAction({
    type: "retry",
    items: [{ id: "task-1", revision: 2 }],
  });
  await h.client.decideApproval("task-1", {
    decision: "approve",
    nodeId: "code-review",
    round: 1,
    comment: "",
    expectedRevision: 2,
  });
  await h.client.updateRule("rule #1", { enabled: false, expectedRevision: 1 });
  await h.client.updateMonitoring({
    monitoring: { namespaces: ["production"] },
    expectedRevision: 1,
  });
  const check = await h.client.checkMonitoring();
  assert.deepEqual(
    h.requests.slice(1).map(({ method, path }) => [method, path]),
    [
      ["POST", "/api/healing/tasks/bulk"],
      ["POST", "/api/healing/approvals/task-1/decision"],
      ["PATCH", "/api/healing/rules/rule%20%231"],
      ["PUT", "/api/healing/monitoring"],
      ["POST", "/api/healing/monitoring/check"],
    ],
  );
  assert.equal(h.requests[1].body.type, "retry");
  assert.deepEqual(h.requests[1].body.items, [{ id: "task-1", revision: 2 }]);
  assert.equal(typeof h.requests[1].body.requestId, "string");
  assert.deepEqual(h.requests[5].body, {});
  assert.equal(h.requests[2].body.expectedRevision, 2);
  assert.equal(h.requests[3].body.enabled, false);
  assert.equal(h.requests[4].body.expectedRevision, 1);
  assert.deepEqual(check, checked);
  // Check provenance is not a full snapshot and must not replace session state.
  h.client.setSnapshot(snapshot(2, "csrf-after-check"));
  await h.client.updateMonitoring({
    monitoring: checked.monitoring,
    expectedRevision: 2,
  });
  assert.equal(h.requests.at(-1).headers["x-heal-csrf"], "csrf-after-check");
});

test("API failures retain structured status/code and never turn into a successful snapshot", async (t) => {
  let requestCount = 0;
  const h = await server(t, () =>
    ++requestCount === 1
      ? {
          status: 401,
          body: { error: { code: "AUTH_REQUIRED", message: "请先登录" } },
        }
      : {
          status: 409,
          body: { error: { code: "REVISION_CONFLICT", message: "任务已变化" } },
        },
  );
  await assert.rejects(
    h.client.getSnapshot(),
    (error) =>
      error.status === 401 &&
      error.code === "AUTH_REQUIRED" &&
      error.message === "请先登录",
  );
  h.client.setSnapshot(snapshot());
  await assert.rejects(
    h.client.taskAction("task-1", "retry", { expectedRevision: 1 }),
    (error) => error.status === 409 && error.code === "REVISION_CONFLICT",
  );
});

test("an HTML static-host response is diagnosed as an unavailable management API", async (t) => {
  const h = await server(t, () => ({
    contentType: "text/html",
    raw: "<!doctype html><title>Preview</title>",
  }));
  await assert.rejects(
    h.client.getSnapshot(),
    (error) => error.code === "INVALID_RESPONSE" && /管理/.test(error.message),
  );
});

test("creation retries after an uncertain connection result reuse their request ID without automatic retry", async () => {
  const sent = [];
  let attempt = 0;
  const client = clientModule.createApiClient({
    fetch: async (path, options) => {
      sent.push(JSON.parse(options.body));
      if (++attempt === 1) throw new TypeError("network disconnected");
      return new Response(
        JSON.stringify({
          snapshot: snapshot(),
          taskId: "new-task",
          message: "created",
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    },
  });
  client.setSnapshot(snapshot());
  const input = { title: "Repair", type: "lint-error", priority: "medium" };
  await assert.rejects(client.triggerTask(input), (error) =>
    /结果尚未确认/.test(error.message),
  );
  assert.equal(sent.length, 1);
  await client.triggerTask(input);
  assert.equal(typeof sent[0].requestId, "string");
  assert.ok(sent[0].requestId.length > 10);
  assert.equal(sent[1].requestId, sent[0].requestId);
  await client.triggerTask(input);
  assert.notEqual(sent[2].requestId, sent[1].requestId);
  await client.taskAction("task-1", "retry", {
    expectedRevision: 1,
    requestId: "caller-key",
  });
  assert.equal(sent[3].requestId, "caller-key");
});

test("reconciliation uses the task revision and reuses an uncertain request identity", async () => {
  const requests = [];
  const client = clientModule.createApiClient({
    fetch: async (path, options) => {
      requests.push({ path, ...JSON.parse(options.body) });
      if (requests.length === 1) throw new TypeError("disconnected");
      return new Response(
        JSON.stringify({ snapshot: snapshot(), message: "已核对" }),
        { headers: { "Content-Type": "application/json" } },
      );
    },
  });
  client.setSnapshot(snapshot());
  const body = {
    expectedRevision: 9,
    outcome: "changes-recorded",
    note: "已核对仓库提交",
  };
  assert.equal(typeof client.reconcileTask, "function");
  await assert.rejects(
    client.reconcileTask("task #1", body),
    (error) => error.code === "NETWORK_ERROR",
  );
  await client.reconcileTask("task #1", body);
  assert.equal(requests[0].path, "/api/healing/tasks/task%20%231/reconcile");
  assert.equal(requests[0].expectedRevision, 9);
  assert.equal(requests[0].outcome, "changes-recorded");
  assert.equal(requests[0].note, "已核对仓库提交");
  assert.ok(requests[0].requestId);
  assert.equal(requests[1].requestId, requests[0].requestId);
});

test("CI import and verification use manager CSRF and only the specified contracts", async (t) => {
  const f = await server(t, (request) => ({
    body:
      request.method === "GET"
        ? snapshot()
        : { snapshot: snapshot(2), outcome: "created", taskId: "task-1" },
  }));
  await f.client.getSnapshot();
  await f.client.importCiBuild({ sourceId: "ci", buildNumber: 23 });
  await f.client.verifyTask("task #1", { expectedRevision: 4 });
  assert.equal(f.requests[1].path, "/api/healing/integrations/jenkins/builds");
  assert.equal(typeof f.requests[1].body.requestId, "string");
  assert.equal(f.requests[1].body.buildNumber, 23);
  assert.equal(
    f.requests[2].path,
    "/api/healing/tasks/task%20%231/verification",
  );
  assert.deepEqual(f.requests[2].body, { expectedRevision: 4 });
  assert.ok(
    f.requests.slice(1).every((r) => r.headers["x-heal-csrf"] === "csrf-1"),
  );
});
