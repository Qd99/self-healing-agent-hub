import test from "node:test";
import assert from "node:assert/strict";

import { getDashboardAnalytics } from "../apps/console/public/analytics-model.js";

const NOW = Date.parse("2026-11-09T00:30:00.000Z");

function task(id, status = "completed", options = {}) {
  const createdAt = options.createdAt ?? "2026-11-09T00:00:00.000Z";
  return {
    task: {
      id,
      type: Object.hasOwn(options, "type") ? options.type : "type-error",
      priority: "medium",
      payload: {
        repo: "demo/analytics",
        branch: "main",
        files: ["src/example.js"],
        errorDetails: {},
        context: {},
      },
      metadata: {
        triggeredBy: "manual",
        triggeredAt: createdAt,
        source: "test",
        createdAt,
      },
    },
    status: { taskId: id, status, ...options.statusInfo },
    title: id,
    engineId: Object.hasOwn(options, "engineId") ? options.engineId : "fast",
    trace: [],
    diff: [],
    ...(options.reviewState ? { reviewState: options.reviewState } : {}),
    ...(Object.hasOwn(options, "durationMs")
      ? {
          result: {
            taskId: id,
            success: status === "completed",
            action: status === "failed" ? "failed" : "committed",
            logs: [],
            evidence: { beforeState: {}, afterState: {} },
            timings: {
              startedAt: "2026-11-09T00:00:00.000Z",
              completedAt: "2026-11-09T00:02:00.000Z",
              durationMs: options.durationMs,
            },
          },
        }
      : {}),
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

test("limits report periods to 1, 7 and 30 days with a seven-day fallback", () => {
  const entries = [
    task("too-old", "completed", { createdAt: "2026-10-10T15:59:59.999Z" }),
    task("thirty-day", "completed", { createdAt: "2026-10-10T16:00:00.000Z" }),
    task("seven-day", "completed", { createdAt: "2026-11-02T16:00:00.000Z" }),
    task("today"),
  ];
  const cases = [
    [1, 1, "2026-11-09", ["today"]],
    ["7", 7, "2026-11-03", ["seven-day", "today"]],
    [30, 30, "2026-10-11", ["thirty-day", "seven-day", "today"]],
    [0, 7, "2026-11-03", ["seven-day", "today"]],
    [-1, 7, "2026-11-03", ["seven-day", "today"]],
    [365, 7, "2026-11-03", ["seven-day", "today"]],
    [true, 7, "2026-11-03", ["seven-day", "today"]],
    ["invalid", 7, "2026-11-03", ["seven-day", "today"]],
  ];
  for (const [days, count, firstDate, ids] of cases) {
    const report = getDashboardAnalytics(entries, { days, now: NOW });
    assert.equal(report.days, count);
    assert.equal(report.daily?.length, count);
    assert.equal(report.daily?.[0]?.date, firstDate);
    assert.equal(report.daily?.at(-1)?.date, "2026-11-09");
    assert.deepEqual(
      report.tasks.map((entry) => entry.task.id),
      ids,
    );
    assert.equal(
      report.daily.reduce((sum, day) => sum + day.total, 0),
      ids.length,
    );
  }
});

test("uses Shanghai creation dates and excludes old, invalid and future tasks", () => {
  const report = getDashboardAnalytics(
    [
      task("old", "completed", { createdAt: "2026-11-02T15:59:59.999Z" }),
      task("first-day", "completed", { createdAt: "2026-11-02T16:00:00.000Z" }),
      task("before-midnight", "failed", {
        createdAt: "2026-11-08T15:59:59.999Z",
      }),
      task("after-midnight", "pending", {
        createdAt: "2026-11-08T16:00:00.000Z",
        reviewState: "pending",
      }),
      task("running", "running"),
      task("future", "completed", { createdAt: "2026-11-09T00:30:00.001Z" }),
      task("invalid", "failed", { createdAt: "invalid" }),
    ],
    { days: 7, now: NOW },
  );
  assert.deepEqual(
    report.tasks?.map((entry) => entry.task.id),
    ["first-day", "before-midnight", "after-midnight", "running"],
  );
  assert.deepEqual(report.daily, [
    {
      date: "2026-11-03",
      label: "11/03",
      total: 1,
      completed: 1,
      failed: 0,
      other: 0,
    },
    {
      date: "2026-11-04",
      label: "11/04",
      total: 0,
      completed: 0,
      failed: 0,
      other: 0,
    },
    {
      date: "2026-11-05",
      label: "11/05",
      total: 0,
      completed: 0,
      failed: 0,
      other: 0,
    },
    {
      date: "2026-11-06",
      label: "11/06",
      total: 0,
      completed: 0,
      failed: 0,
      other: 0,
    },
    {
      date: "2026-11-07",
      label: "11/07",
      total: 0,
      completed: 0,
      failed: 0,
      other: 0,
    },
    {
      date: "2026-11-08",
      label: "11/08",
      total: 1,
      completed: 0,
      failed: 1,
      other: 0,
    },
    {
      date: "2026-11-09",
      label: "11/09",
      total: 2,
      completed: 0,
      failed: 0,
      other: 2,
    },
  ]);
  assert.deepEqual(report.metrics, {
    total: 4,
    completed: 1,
    failed: 1,
    running: 1,
    pending: 1,
    review: 1,
    successRate: 50,
    averageDurationMs: null,
  });
});

test("partitions display states without double-counting pending reviews", () => {
  const entries = [
    task("completed"),
    task("failed", "failed"),
    task("running", "running"),
    task("review", "pending", { reviewState: "pending" }),
    task("queue", "pending"),
    task("cancelled", "cancelled"),
    task("skipped", "skipped"),
    task("unknown", "new-server-state"),
    task("missing", null),
  ];
  const report = getDashboardAnalytics(entries, { now: NOW });
  assert.deepEqual(
    report.statuses?.map(({ id, count }) => [id, count]),
    [
      ["completed", 1],
      ["failed", 1],
      ["running", 1],
      ["review", 1],
      ["pending", 1],
      ["cancelled", 1],
      ["skipped", 1],
      ["unknown", 2],
    ],
  );
  assert.equal(
    report.statuses.reduce((sum, group) => sum + group.count, 0),
    9,
  );
  assert.equal(
    report.statuses.find(({ id }) => id === "review").percent,
    100 / 9,
  );
  assert.equal(
    report.statuses.find(({ id }) => id === "unknown").percent,
    200 / 9,
  );
  assert.equal(
    report.daily.reduce((sum, day) => sum + day.other, 0),
    7,
  );
});

test("preserves unknown type groups and sorts count ties deterministically", () => {
  const values = [
    "type-error",
    "lint-error",
    "lint-error",
    undefined,
    "",
    "mystery",
    "__proto__",
    "constructor",
    "unknown",
  ];
  const entries = values.map((type, index) =>
    task(`type-${index}`, "completed", { type }),
  );
  const report = getDashboardAnalytics(entries, { now: NOW });
  assert.deepEqual(
    report.types?.map(({ id, count }) => [id, count]),
    [
      ["unknown", 3],
      ["lint-error", 2],
      ["__proto__", 1],
      ["constructor", 1],
      ["mystery", 1],
      ["type-error", 1],
    ],
  );
  assert.equal(
    report.types.reduce((sum, group) => sum + group.count, 0),
    9,
  );
  assert.equal(report.types[0].percent, 100 / 3);
  assert.deepEqual(
    getDashboardAnalytics([...entries].reverse(), { now: NOW }).types,
    report.types,
  );
});

test("compares observed engine outcomes using terminal denominators", () => {
  const report = getDashboardAnalytics(
    [
      task("fast-done", "completed", { durationMs: 1000 }),
      task("fast-failed", "failed", { durationMs: 3000 }),
      task("fast-running", "running", { durationMs: 900000 }),
      task("complex-done", "completed", {
        engineId: "complex",
        durationMs: 12000,
      }),
      task("complex-review", "pending", {
        engineId: "complex",
        reviewState: "pending",
        durationMs: 900000,
      }),
      task("unassigned", "pending", { engineId: undefined }),
      task("unknown", "running", { engineId: "unknown" }),
      task("special", "cancelled", { engineId: "__proto__" }),
    ],
    { now: NOW },
  );
  assert.deepEqual(report.engines, [
    {
      id: "fast",
      count: 3,
      percent: 37.5,
      completed: 1,
      failed: 1,
      successRate: 50,
      averageDurationMs: 2000,
    },
    {
      id: "complex",
      count: 2,
      percent: 25,
      completed: 1,
      failed: 0,
      successRate: 100,
      averageDurationMs: 12000,
    },
    {
      id: "unknown",
      count: 2,
      percent: 25,
      completed: 0,
      failed: 0,
      successRate: null,
      averageDurationMs: null,
    },
    {
      id: "__proto__",
      count: 1,
      percent: 12.5,
      completed: 0,
      failed: 0,
      successRate: null,
      averageDurationMs: null,
    },
  ]);
  assert.equal(
    report.engines.reduce((sum, group) => sum + group.count, 0),
    8,
  );
  assert.equal(report.metrics.successRate, 200 / 3);
});

test("matches existing duration fallback rules without treating missing samples as zero", () => {
  const statusInfo = {
    startedAt: "2026-11-09T00:00:00.000Z",
    completedAt: "2026-11-09T00:02:00.000Z",
  };
  const report = getDashboardAnalytics(
    [
      task("zero", "completed", { durationMs: 0 }),
      task("fallback", "completed", { statusInfo }),
      task("null", "failed", {
        durationMs: null,
        statusInfo: { ...statusInfo, completedAt: "2026-11-09T00:01:00.000Z" },
      }),
      task("negative", "completed", { durationMs: -1, statusInfo }),
      task("string", "completed", { durationMs: "1000", statusInfo }),
      task("nan", "completed", { durationMs: NaN, statusInfo }),
      task("infinite", "failed", { durationMs: Infinity, statusInfo }),
      task("running", "running", { durationMs: 900000 }),
      task("cancelled", "cancelled", { durationMs: 900000 }),
    ],
    { now: NOW },
  );
  assert.equal(report.metrics?.averageDurationMs, 60000);
  assert.equal(report.engines?.[0]?.averageDurationMs, 60000);
});

test("returns zero counts and unknown percentages for an empty report", () => {
  const report = getDashboardAnalytics([], { days: 1, now: NOW });
  assert.deepEqual(report.tasks, []);
  assert.deepEqual(report.types, []);
  assert.deepEqual(report.engines, []);
  assert.equal(report.metrics.successRate, null);
  assert.equal(report.metrics.averageDurationMs, null);
  assert.equal(report.metrics.total, 0);
  assert.deepEqual(report.daily, [
    {
      date: "2026-11-09",
      label: "11/09",
      total: 0,
      completed: 0,
      failed: 0,
      other: 0,
    },
  ]);
  assert.equal(report.statuses.length, 8);
  assert.ok(
    report.statuses.every(
      ({ count, percent }) => count === 0 && percent === null,
    ),
  );
});

test("does not let an invalid report clock bypass the time filter", () => {
  const report = getDashboardAnalytics([task("valid-task")], {
    days: 30,
    now: "invalid",
  });
  assert.deepEqual(report.tasks, []);
  assert.deepEqual(report.daily, []);
  assert.equal(report.metrics.total, 0);
  assert.deepEqual(report.types, []);
  assert.deepEqual(report.engines, []);
});

test("keeps the original snapshot and task ordering unchanged", () => {
  const entries = freeze([
    task("older", "failed", {
      createdAt: "2026-11-08T00:00:00.000Z",
      type: "lint-error",
      engineId: "complex",
    }),
    task("newer", "running", { type: "type-error" }),
  ]);
  const before = JSON.stringify(entries);
  const report = getDashboardAnalytics(entries, { now: NOW });
  assert.deepEqual(
    report.tasks?.map((entry) => entry.task.id),
    ["older", "newer"],
  );
  assert.notEqual(report.tasks, entries);
  assert.equal(JSON.stringify(entries), before);
});
