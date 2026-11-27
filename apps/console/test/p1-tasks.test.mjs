import test from "node:test";
import assert from "node:assert/strict";
import {
  taskRows,
  taskDetail,
  overviewModel,
  taskListModel,
} from "../public/v20/domains/tasks/model.js";
import {
  renderOverview,
  renderTasks,
  renderTaskDetail,
} from "../public/v20/domains/tasks/views.js";
import { parseRoute, routeHref } from "../public/v20/app/routes.js";
import { snapshot } from "./helpers/snapshot.mjs";

const task = (id, status = "pending", extra = {}) => ({
  task: {
    id,
    type: "format-error",
    priority: "medium",
    payload: { repo: "test/repository", branch: "main" },
    metadata: { createdAt: "2026-11-27T01:00:00.000Z" },
  },
  title: `Task ${id}`,
  revision: 1,
  engineId: "fast",
  status: { status, progress: 25, message: "Service status" },
  execution: { phase: "diagnose", cancelRequested: false },
  ...extra,
});

test("overview, filters and details use the same actual task identities and states", () => {
  const value = snapshot({
    tasks: [
      task("a", "running"),
      task("b", "failed"),
      task("c", "pending", { reviewState: "pending" }),
      task("d"),
      task("e", "completed"),
    ],
  });
  const before = JSON.stringify(value);
  const view = overviewModel(value);
  assert.deepEqual(view.counts, {
    total: 5,
    running: 1,
    attention: 2,
    queued: 1,
    ended: 1,
  });
  assert.deepEqual(
    taskListModel(value, { scope: "attention" }).items.map((x) => x.id),
    ["b", "c"],
  );
  assert.equal(taskListModel(value, { query: "Task d" }).total, 1);
  assert.equal(taskListModel(value, { page: 999, pageSize: 2 }).page, 3);
  assert.equal(taskDetail(value, "unknown"), null);
  assert.equal(taskDetail(value, "a").id, "a");
  assert.equal(JSON.stringify(value), before);
});

test("a recent observation has an explicit time source and missing data stays unknown", () => {
  const value = snapshot({
    tasks: [
      task("a", "running", {
        observation: {
          events: [
            {
              observedAt: "2026-11-27T02:00:00Z",
              stage: "model",
              state: "running",
            },
          ],
        },
      }),
      task("b"),
    ],
  });
  const rows = taskRows(value);
  assert.equal(rows[0].timeSource, "执行器观测");
  assert.equal(rows[0].lastKnownAt, "2026-11-27T02:00:00Z");
  assert.equal(rows[1].timeSource, "任务创建");
  assert.equal(taskDetail(value, "b").observations.length, 0);
  assert.equal(taskDetail(value, "b").workerId, null);
  assert.deepEqual(overviewModel(snapshot()).counts, {
    total: 0,
    running: 0,
    attention: 0,
    queued: 0,
    ended: 0,
  });
});

test("P1 renderers escape server text, preserve real links and provide explicit empty states", () => {
  const value = snapshot({
    tasks: [
      task('a"<script>', "failed", {
        title: '<img src=x onerror="bad()">',
        result: {
          success: false,
          action: "failed",
          error: { code: "ERROR", message: "<script>bad()</script>" },
        },
      }),
    ],
  });
  const href = (id) => routeHref({ page: "tasks", taskId: id });
  for (const html of [
    renderOverview(overviewModel(value), { taskHref: href }),
    renderTasks(taskListModel(value), { taskHref: href }),
    renderTaskDetail(taskDetail(value, 'a"<script>')),
  ]) {
    assert.doesNotMatch(html, /<img|<script|onerror="/);
    assert.match(html, /&lt;img/);
  }
  assert.match(renderTasks(taskListModel(snapshot())), /没有任务/);
  assert.match(renderTaskDetail(null), /找不到/);
});

test("hash routes round-trip encoded task identities without interpreting them as HTML or modules", () => {
  const id = 'abc?x="<&';
  const route = parseRoute(
    routeHref({ page: "tasks", taskId: id, scope: "attention" }),
  );
  assert.equal(route.page, "tasks");
  assert.equal(route.taskId, id);
  assert.equal(route.scope, "attention");
  assert.equal(parseRoute("#../../data.js").page, "overview");
  assert.equal(parseRoute("#tasks?scope=unknown").scope, "all");
  assert.equal(parseRoute("#tasks?task=%").taskId, "%");
});
