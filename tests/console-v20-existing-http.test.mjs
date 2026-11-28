import test from "node:test";
import assert from "node:assert/strict";
import { createV20Hub } from "./helpers/v20-hub.mjs";
import { createV20Client } from "../apps/console/public/v20/api/client.js";
import { existingPath } from "../packages/contract/src/console-p1.mjs";

function browser(hub) {
  let cookie;
  const requests = [];
  const api = createV20Client({
    fetch: async (path, init) => {
      const headers = new Headers(init.headers);
      headers.set("Origin", hub.base);
      if (cookie) headers.set("Cookie", cookie);
      requests.push({
        path,
        method: init.method,
        token: headers.has("Authorization"),
        csrf: headers.has("X-Heal-CSRF"),
      });
      const res = await fetch(hub.base + path, { ...init, headers });
      const next = res.headers.get("set-cookie");
      if (next) cookie = next.split(";")[0];
      return res;
    },
  });
  return { api, requests };
}

test("V20 uses the current protected Hub endpoints to create, cancel and retry a real isolated task", async (t) => {
  const hub = await createV20Hub(t);
  const { api, requests } = browser(hub);
  await assert.rejects(api.mutateExisting("taskCreate", { body: {} }), {
    code: "CSRF_REQUIRED",
  });
  await api.login(hub.token);
  const made = await api.mutateExisting("taskCreate", {
    body: { title: "V20 接线任务", type: "format-error", priority: "medium" },
  });
  const row = made.snapshot.tasks.find((x) => x.task.id === made.taskId);
  assert.equal(row.title, "V20 接线任务");
  assert.equal(row.status.status, "pending");
  assert.equal(Object.hasOwn(made.snapshot, "csrfToken"), false);
  await assert.rejects(
    api.mutateExisting("taskCancel", {
      id: made.taskId,
      body: { expectedRevision: row.revision + 1 },
    }),
    { status: 409 },
  );
  const cancelled = await api.mutateExisting("taskCancel", {
    id: made.taskId,
    body: { expectedRevision: row.revision },
  });
  const ended = cancelled.snapshot.tasks.find((x) => x.task.id === made.taskId);
  assert.equal(ended.status.status, "cancelled");
  const retry = await api.mutateExisting("taskRetry", {
    id: made.taskId,
    body: { expectedRevision: ended.revision },
  });
  assert.notEqual(retry.taskId, made.taskId);
  assert.equal(
    retry.snapshot.tasks.find((x) => x.task.id === retry.taskId).task.payload
      .context.retryOf,
    made.taskId,
  );
  assert.ok(requests.slice(1).every((x) => !x.token && x.csrf));
});

test("V20 reads existing record lists and distinguishes an unconfigured connector from empty results", async (t) => {
  const hub = await createV20Hub(t);
  const { api, requests } = browser(hub);
  await api.login(hub.token);
  const list = await api.readExisting("recordsRead", {
    query: { kind: "knowledge" },
  });
  assert.deepEqual(list.items, []);
  await assert.rejects(api.readExisting("githubIssues"), {
    status: 422,
    code: "WORKBENCH_UNCONFIGURED",
  });
  await assert.rejects(api.readExisting("taskCreate"), {
    code: "INVALID_ACTION",
  });
  assert.equal(requests.length, 3);
  assert.ok(
    requests.slice(1).every((x) => x.method === "GET" && !x.csrf && !x.token),
  );
});

test("bulk writes expose partial outcomes and do not bypass task versions", async (t) => {
  const hub = await createV20Hub(t);
  const { api } = browser(hub);
  await api.login(hub.token);
  const create = (title) =>
    api.mutateExisting("taskCreate", {
      body: { title, type: "format-error", priority: "medium" },
    });
  const first = await create("当前版本"),
    second = await create("旧版本");
  const rows = second.snapshot.tasks;
  const rev = (id) => rows.find((row) => row.task.id === id).revision;
  const result = await api.mutateExisting("taskBulk", {
    body: {
      type: "cancel",
      items: [
        { id: first.taskId, revision: rev(first.taskId) },
        { id: second.taskId, revision: rev(second.taskId) + 1 },
      ],
    },
  });
  assert.deepEqual(
    result.report.applied.map((row) => row.id),
    [first.taskId],
  );
  assert.deepEqual(
    result.report.skipped.map((row) => row.id),
    [second.taskId],
  );
  assert.equal(
    result.snapshot.tasks.find((row) => row.task.id === second.taskId).status
      .status,
    "pending",
  );
});

test("V20 saves the actual monitor configuration with its revision, but does not claim connectivity", async (t) => {
  const hub = await createV20Hub(t);
  const { api } = browser(hub);
  const initial = await api.login(hub.token);
  const check = () => api.mutateExisting("monitoringCheck");
  assert.equal((await check()).check.status, "unconfigured");
  const rule = initial.rules[0];
  const changed = await api.mutateExisting("ruleUpdate", {
    id: rule.id,
    body: {
      enabled: !rule.enabled,
      expectedConfigRevision: initial.configRevisions.rules,
    },
  });
  assert.equal(
    changed.snapshot.rules.find((x) => x.id === rule.id).enabled,
    !rule.enabled,
  );
  const body = {
    expectedConfigRevision: initial.configRevisions.monitoring,
    monitoring: {
      grafana: {
        baseUrl: "https://grafana.fixture.invalid",
        dashboardUid: "agent-hub",
        dashboardSlug: "agent-hub",
        namespaceVariable: "namespace",
        datasourceVariable: "datasource",
      },
      datasource: {
        type: "prometheus",
        uid: "fixture-source",
        name: "fixture",
      },
      namespaces: ["agent-hub"],
    },
  };
  const saved = await api.mutateExisting("monitoringUpdate", { body });
  assert.equal(
    saved.snapshot.monitoring.grafana.baseUrl,
    "https://grafana.fixture.invalid",
  );
  assert.notEqual(
    (await check()).check.status,
    "ready",
    "an unavailable external source must not report success",
  );
  await assert.rejects(api.mutateExisting("monitoringUpdate", { body }), {
    status: 409,
  });
});

test("generated existing paths only allow one literal task id and no machine paths", () => {
  assert.equal(
    existingPath("taskRetry", "task-1"),
    "/api/healing/tasks/task-1/retry",
  );
  assert.throws(() => existingPath("taskRetry", "../worker/claim"));
  assert.throws(() => existingPath("workerClaim"));
});
