import test from "node:test";
import assert from "node:assert/strict";

import {
  createDemoSnapshot,
  applyDemoAction,
} from "../apps/console/public/data.js";
import {
  escapeHtml,
  formatDuration,
  filterTasks,
  getMetrics,
  getTrend,
} from "../apps/console/public/model.js";

const NOW = Date.parse("2026-11-09T10:00:00.000Z");

function task(status, options = {}) {
  const id = options.id ?? "task-one";
  const createdAt = options.createdAt ?? "2026-11-09T09:00:00.000Z";
  return {
    task: {
      id,
      type: "type-error",
      priority: "high",
      payload: {
        repo: "demo/chat-app",
        branch: "feature/chat",
        files: ["src/chat/MessageList.tsx"],
        errorDetails: {
          code: "TS2322",
          message: "Message is possibly undefined",
        },
        context: { retryCount: 0 },
      },
      metadata: {
        triggeredBy: "webhook",
        triggeredAt: createdAt,
        source: "demo",
        createdAt,
      },
    },
    status: { taskId: id, status, ...options.statusInfo },
    title: options.title ?? "聊天模块类型检查",
    engineId: "fast",
    trace: [],
    diff: [],
    ...(options.reviewState ? { reviewState: options.reviewState } : {}),
    ...(options.result ? { result: options.result } : {}),
  };
}

function result(durationMs) {
  return {
    taskId: "task-one",
    success: true,
    action: "committed",
    logs: ["fixture"],
    evidence: { beforeState: { errors: 1 }, afterState: { errors: 0 } },
    timings: {
      startedAt: "2026-11-09T09:00:00.000Z",
      completedAt: "2026-11-09T09:01:00.000Z",
      durationMs,
    },
  };
}

function freeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child))
      freeze(child);
  }
  return value;
}

test("escapes all HTML metacharacters before displaying untrusted text", () => {
  assert.equal(
    escapeHtml(`<img src="x" onerror='alert(1)'>&`),
    "&lt;img src=&quot;x&quot; onerror=&#39;alert(1)&#39;&gt;&amp;",
  );
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(12), "12");
});

test("formats durations without displaying invalid or negative measurements", () => {
  assert.equal(formatDuration(null), "—");
  assert.equal(formatDuration(NaN), "—");
  assert.equal(formatDuration(-10), "—");
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(450), "450ms");
  assert.equal(formatDuration(61000), "1m 1s");
  assert.equal(formatDuration(3720000), "1h 2m");
});

test("filters the last seven calendar days using the Shanghai midnight boundary", () => {
  const tasks = [
    task("completed", { id: "old", createdAt: "2026-11-02T15:59:59.999Z" }),
    task("completed", {
      id: "boundary",
      createdAt: "2026-11-02T16:00:00.000Z",
    }),
    task("running", { id: "today" }),
    task("pending", { id: "future", createdAt: "2026-11-09T11:00:00.000Z" }),
    task("failed", { id: "invalid", createdAt: "invalid" }),
  ];
  assert.deepEqual(
    filterTasks(tasks, { days: 7, now: NOW }).map((item) => item.task.id),
    ["boundary", "today"],
  );
});

test("combines literal case-insensitive search with independent review filtering", () => {
  const tasks = [
    task("pending", {
      id: "review-me",
      title: "Review the CHAT parser",
      reviewState: "pending",
    }),
    task("pending", { id: "queued", title: "Review the CHAT parser" }),
    task("completed", { id: "finished" }),
  ];
  assert.deepEqual(
    filterTasks(tasks, {
      query: "chat parser",
      status: "review",
      now: NOW,
    }).map((item) => item.task.id),
    ["review-me"],
  );
  assert.equal(
    filterTasks(tasks, { query: "MESSAGELIST.TSX", now: NOW }).length,
    3,
  );
  assert.equal(filterTasks(tasks, { query: ".*", now: NOW }).length, 0);
  assert.deepEqual(
    filterTasks(tasks, { status: "completed", now: NOW }).map(
      (item) => item.task.id,
    ),
    ["finished"],
  );
});

test("allows an explicit all-date filter without mutating the task array", () => {
  const tasks = freeze([
    task("completed", { createdAt: "2020-01-01T00:00:00.000Z" }),
  ]);
  const filtered = filterTasks(tasks, { days: 0, now: NOW });
  assert.equal(filtered.length, 1);
  assert.notEqual(filtered, tasks);
});

test("calculates success rate only from completed and failed tasks", () => {
  const tasks = [
    task("completed", { result: result(1000) }),
    task("completed", { result: result(3000) }),
    task("failed", {
      result: { ...result(2000), success: false, action: "failed" },
    }),
    task("running", { result: result(900000) }),
    task("pending", { reviewState: "pending", result: result(900000) }),
    task("cancelled"),
    task("skipped"),
  ];
  assert.deepEqual(getMetrics(tasks), {
    total: 7,
    completed: 2,
    failed: 1,
    running: 1,
    pending: 1,
    review: 1,
    successRate: 200 / 3,
    averageDurationMs: 2000,
  });
});

test("reports unknown rates and duration as null for an empty or unfinished queue", () => {
  assert.deepEqual(getMetrics([]), {
    total: 0,
    completed: 0,
    failed: 0,
    running: 0,
    pending: 0,
    review: 0,
    successRate: null,
    averageDurationMs: null,
  });
  assert.equal(getMetrics([task("running")]).successRate, null);
  assert.equal(
    getMetrics([task("completed", { result: result(-1) })]).averageDurationMs,
    null,
  );
});

test("uses status timestamps when a terminal task has no result duration", () => {
  const metrics = getMetrics([
    task("completed", {
      statusInfo: {
        startedAt: "2026-11-09T09:00:00.000Z",
        completedAt: "2026-11-09T09:02:00.000Z",
      },
    }),
  ]);
  assert.equal(metrics.averageDurationMs, 120000);
});

test("fills missing trend days and groups tasks by Shanghai creation dates", () => {
  const tasks = [
    task("completed", { createdAt: "2026-11-07T15:59:59.000Z" }),
    task("failed", { createdAt: "2026-11-07T16:00:00.000Z" }),
    task("completed", { createdAt: "2026-11-08T16:00:00.000Z" }),
    task("running"),
    task("failed", { createdAt: "2026-11-09T11:00:00.000Z" }),
  ];
  assert.deepEqual(getTrend(tasks, { days: 3, now: NOW }), [
    { date: "2026-11-07", label: "11/07", completed: 1, failed: 0 },
    { date: "2026-11-08", label: "11/08", completed: 0, failed: 1 },
    { date: "2026-11-09", label: "11/09", completed: 1, failed: 0 },
  ]);
});

test("creates an explicit fictional demo with 48 tasks and complete failure/review evidence", () => {
  const snapshot = createDemoSnapshot(NOW);
  assert.equal(snapshot.apiVersion, 1);
  assert.equal(snapshot.mode, "demo");
  assert.equal(snapshot.generatedAt, "2026-11-09T10:00:00.000Z");
  assert.equal(snapshot.configSource, "example");
  assert.match(snapshot.notice, /演示.*虚构/);
  assert.equal(snapshot.tasks.length, 48);
  assert.equal(new Set(snapshot.tasks.map((item) => item.task.id)).size, 48);
  const metrics = getMetrics(snapshot.tasks);
  assert.deepEqual(
    [
      metrics.completed,
      metrics.failed,
      metrics.running,
      metrics.pending,
      metrics.review,
    ],
    [42, 3, 1, 2, 2],
  );
  assert.equal(filterTasks(snapshot.tasks, { now: NOW }).length, 48);
  assert.equal(snapshot.tasks[0].status.status, "running");
  assert.match(snapshot.tasks[0].title, /聊天/);
  assert.equal(snapshot.tasks[0].task.type, "type-error");
  assert.ok(
    snapshot.tasks.every(
      (item) => !Number.isNaN(Date.parse(item.task.metadata.createdAt)),
    ),
  );
  assert.ok(
    snapshot.tasks.every((item) => item.task.payload.context.demo === true),
  );
  assert.ok(
    snapshot.engines.every(
      (engine) => !engine.implemented && engine.status === "unavailable",
    ),
  );
  assert.equal(JSON.stringify(snapshot).includes("apiKey"), false);
  for (const item of snapshot.tasks.filter(
    (item) => item.status.status === "failed" || item.reviewState === "pending",
  )) {
    assert.ok(item.diff.length > 0);
    assert.ok(item.trace.length > 0);
    assert.ok(item.result.evidence.beforeState);
    assert.ok(item.result.evidence.afterState);
    assert.ok(item.result.logs.length > 0);
    assert.equal(item.result.taskId, item.task.id);
  }
});

test("creates isolated snapshots so editing one fixture cannot affect another", () => {
  const first = createDemoSnapshot(NOW);
  const second = createDemoSnapshot(NOW);
  first.rules[0].enabled = false;
  first.tasks[0].diff[0].lines[0].content = "changed";
  assert.equal(second.rules[0].enabled, true);
  assert.notEqual(second.tasks[0].diff[0].lines[0].content, "changed");
});

test("cancels a running demo task without changing the original data", () => {
  const original = freeze(createDemoSnapshot(NOW));
  const target = original.tasks.find(
    (item) => item.status.status === "running",
  );
  const next = applyDemoAction(
    original,
    { type: "cancel", id: target.task.id },
    NOW + 1000,
  );
  assert.notEqual(next, original);
  assert.equal(original.tasks[0].status.status, "running");
  const cancelled = next.tasks.find((item) => item.task.id === target.task.id);
  assert.equal(cancelled.status.status, "cancelled");
  assert.equal(cancelled.status.completedAt, "2026-11-09T10:00:01.000Z");
  assert.equal(next.activity.length, original.activity.length + 1);
  assert.equal(next.activity[0].taskId, target.task.id);
});

test("retries by adding a new pending task and preserving the failed attempt", () => {
  const original = freeze(createDemoSnapshot(NOW));
  const target = original.tasks.find((item) => item.status.status === "failed");
  const next = applyDemoAction(
    original,
    { type: "retry", id: target.task.id },
    NOW + 1000,
  );
  assert.equal(next.tasks.length, original.tasks.length + 1);
  assert.deepEqual(
    next.tasks.find((item) => item.task.id === target.task.id),
    target,
  );
  assert.equal(next.tasks[0].status.status, "pending");
  assert.notEqual(next.tasks[0].task.id, target.task.id);
  assert.equal(
    next.tasks[0].task.payload.context.retryCount,
    (target.task.payload.context.retryCount ?? 0) + 1,
  );
  assert.equal(next.tasks[0].task.payload.context.retryOf, target.task.id);
  assert.equal(next.tasks[0].result, undefined);
});

test("simulated manual triggers create a pending task using the existing Task contract", () => {
  const original = freeze(createDemoSnapshot(NOW));
  const next = applyDemoAction(
    original,
    {
      type: "trigger",
      payload: {
        title: "检查消息解析",
        type: "unit-test-failure",
        priority: "high",
        branch: "feature/parser",
      },
    },
    NOW + 1000,
  );
  const created = next.tasks[0];
  assert.equal(created.title, "检查消息解析");
  assert.equal(created.task.type, "unit-test-failure");
  assert.equal(created.task.priority, "high");
  assert.equal(created.task.payload.branch, "feature/parser");
  assert.equal(created.task.metadata.triggeredBy, "manual");
  assert.equal(created.task.metadata.createdAt, "2026-11-09T10:00:01.000Z");
  assert.equal(created.status.status, "pending");
  assert.equal(created.engineId, "complex");
  assert.equal(created.task.payload.context.demo, true);
  assert.equal(original.tasks.length, 48);
});

test("approving or rejecting a review changes only valid original TaskStatus values", () => {
  const original = freeze(createDemoSnapshot(NOW));
  const target = original.tasks.find((item) => item.reviewState === "pending");
  const approved = applyDemoAction(
    original,
    { type: "approve", id: target.task.id },
    NOW + 1000,
  );
  const approvedTask = approved.tasks.find(
    (item) => item.task.id === target.task.id,
  );
  assert.equal(approvedTask.reviewState, "approved");
  assert.equal(approvedTask.status.status, "pending");
  const rejected = applyDemoAction(
    original,
    { type: "reject", id: target.task.id },
    NOW + 1000,
  );
  const rejectedTask = rejected.tasks.find(
    (item) => item.task.id === target.task.id,
  );
  assert.equal(rejectedTask.reviewState, "rejected");
  assert.equal(rejectedTask.status.status, "cancelled");
  assert.equal(
    original.tasks.find((item) => item.task.id === target.task.id).reviewState,
    "pending",
  );
});

test("toggles a demo routing rule immutably and records an audit activity", () => {
  const original = freeze(createDemoSnapshot(NOW));
  const target = original.rules[0];
  const next = applyDemoAction(
    original,
    { type: "toggle-rule", id: target.id },
    NOW + 1000,
  );
  assert.equal(next.rules[0].enabled, !target.enabled);
  assert.equal(original.rules[0].enabled, target.enabled);
  assert.equal(next.activity[0].action, "toggle-rule");
});

test("rejects every simulated write in live mode", () => {
  const snapshot = { ...createDemoSnapshot(NOW), mode: "live" };
  for (const type of [
    "trigger",
    "cancel",
    "retry",
    "approve",
    "reject",
    "toggle-rule",
  ]) {
    assert.throws(() => applyDemoAction(snapshot, { type }), /演示|demo/i);
  }
});

test("rejects invalid task transitions and missing rule or task identifiers", () => {
  const snapshot = createDemoSnapshot(NOW);
  const completed = snapshot.tasks.find(
    (item) => item.status.status === "completed",
  );
  const running = snapshot.tasks.find(
    (item) => item.status.status === "running",
  );
  for (const action of [
    { type: "cancel", id: completed.task.id },
    { type: "retry", id: running.task.id },
    { type: "approve", id: completed.task.id },
    { type: "reject", id: completed.task.id },
    { type: "cancel", id: "missing" },
    { type: "toggle-rule", id: "missing" },
    { type: "unknown" },
  ])
    assert.throws(() => applyDemoAction(snapshot, action));
});

test("validates manual trigger input before adding a task", () => {
  const snapshot = createDemoSnapshot(NOW);
  const valid = {
    title: "手动诊断",
    type: "type-error",
    priority: "high",
    branch: "main",
  };
  for (const payload of [
    { ...valid, title: "   " },
    { ...valid, type: "review" },
    { ...valid, priority: "super-high" },
    { ...valid, branch: "" },
  ])
    assert.throws(() =>
      applyDemoAction(snapshot, { type: "trigger", payload }),
    );
  assert.equal(snapshot.tasks.length, 48);
});
