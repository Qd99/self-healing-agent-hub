import test from "node:test";
import assert from "node:assert/strict";

import {
  createDemoSnapshot,
  applyDemoAction,
} from "../apps/console/public/data.js";
import { getApprovalFlow } from "../apps/console/public/approvals.js";
import {
  DEFAULT_TASK_FILTERS,
  getTaskDisplayStatus,
  getTaskList,
  getTaskFilterOptions,
  planBulkAction,
  applyDemoBulkAction,
  exportTasksCSV,
  exportTasksJSON,
} from "../apps/console/public/task-model.js";

const NOW = Date.parse("2026-11-09T10:00:00.000Z");

function entry(id, options = {}) {
  const createdAt = options.createdAt ?? "2026-11-09T09:00:00.000Z";
  return {
    title: options.title ?? `修复聊天组件 ${id}`,
    engineId: options.engine ?? "fast",
    task: {
      id,
      type: options.type ?? "type-error",
      priority: options.priority ?? "high",
      payload: {
        repo: options.repo ?? "demo/chat-app",
        branch: options.branch ?? "main",
        files: options.files ?? ["src/ChatPanel.tsx"],
        errorDetails: { message: "private diagnostic detail" },
        context: { retryCount: 0, token: "never-export-this-secret" },
      },
      metadata: {
        createdAt,
        triggeredAt: createdAt,
        triggeredBy: options.source ?? "webhook",
        source: "Detailed internal event source",
      },
    },
    status: {
      taskId: id,
      status: options.status ?? "completed",
      ...options.statusInfo,
    },
    trace: [],
    diff: [],
    ...(options.reviewState ? { reviewState: options.reviewState } : {}),
    ...(options.duration !== undefined
      ? { result: { timings: { durationMs: options.duration } } }
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

const ids = (tasks) => tasks.map((item) => item.task.id);
const find = (snapshot, id) =>
  snapshot.tasks.find((item) => item.task.id === id);

test("default task filters retain older tasks and paginate ten rows", () => {
  const tasks = Array.from({ length: 12 }, (_, index) =>
    entry(`task-${String(index + 1).padStart(2, "0")}`, {
      createdAt: "2020-01-01T00:00:00.000Z",
    }),
  );
  const result = getTaskList(tasks, {
    filters: DEFAULT_TASK_FILTERS,
    now: NOW,
  });
  assert.equal(result.total, 12);
  assert.equal(result.items.length, 10);
  assert.equal(result.pageCount, 2);
  assert.equal(result.page, 1);
  assert.equal(result.pageSize, 10);
  assert.equal(result.start, 1);
  assert.equal(result.end, 10);
  assert.equal(getTaskList(tasks, { now: NOW }).total, 12);
});

test("pending review is an exclusive display status distinct from the queue", () => {
  const tasks = [
    entry("review", { status: "pending", reviewState: "pending" }),
    entry("queued", { status: "pending" }),
    entry("approved", { status: "pending", reviewState: "approved" }),
  ];
  assert.equal(getTaskDisplayStatus(tasks[0]), "review");
  assert.equal(getTaskDisplayStatus(tasks[1]), "pending");
  assert.deepEqual(
    ids(getTaskList(tasks, { filters: { status: "pending" }, now: NOW }).items),
    ["approved", "queued"],
  );
  assert.deepEqual(
    ids(getTaskList(tasks, { filters: { status: "review" }, now: NOW }).items),
    ["review"],
  );
});

test("task filters intersect engine, type, priority, trigger source and branch", () => {
  const base = {
    title: "Parser repair",
    engine: "complex",
    type: "unit-test-failure",
    priority: "urgent",
    source: "manual",
    branch: "fix/parser",
  };
  const tasks = freeze([
    entry("match", base),
    entry("engine", { ...base, engine: "fast" }),
    entry("type", { ...base, type: "lint-error" }),
    entry("priority", { ...base, priority: "low" }),
    entry("source", { ...base, source: "cron" }),
    entry("branch", { ...base, branch: "main" }),
  ]);
  const result = getTaskList(tasks, {
    filters: { ...base, query: "PARSER", status: "completed" },
    now: NOW,
  });
  assert.deepEqual(ids(result.items), ["match"]);
  assert.equal(result.counts.all, 1);
  assert.equal(result.counts.completed, 1);
});

test("search matches literal case-insensitive visible task fields", () => {
  const tasks = [
    entry("AGT-91", {
      title: "Parser repair",
      repo: "demo/my-repository",
      branch: "feature/search",
      files: ["src/ChatPanel.tsx"],
    }),
  ];
  for (const query of [
    " PARSER REPAIR ",
    "agt-91",
    "MY-REPOSITORY",
    "FEATURE/SEARCH",
    "chatpanel.TSX",
  ]) {
    assert.equal(getTaskList(tasks, { filters: { query }, now: NOW }).total, 1);
  }
  for (const query of [
    ".*",
    "never-export-this-secret",
    "private diagnostic",
  ]) {
    assert.equal(getTaskList(tasks, { filters: { query }, now: NOW }).total, 0);
  }
});

test("recent-day filters include the Shanghai midnight boundary and exclude future dates", () => {
  const tasks = [
    entry("old", { createdAt: "2026-11-02T15:59:59.999Z" }),
    entry("boundary", { createdAt: "2026-11-02T16:00:00.000Z" }),
    entry("today"),
    entry("future", { createdAt: "2026-11-09T10:00:00.001Z" }),
    entry("invalid", { createdAt: "not-a-date" }),
  ];
  assert.deepEqual(
    ids(getTaskList(tasks, { filters: { days: 7 }, now: NOW }).filtered),
    ["today", "boundary"],
  );
  assert.equal(getTaskList(tasks, { filters: { days: 0 }, now: NOW }).total, 3);
  assert.deepEqual(
    ids(getTaskList(tasks, { filters: { days: 1 }, now: NOW }).items),
    ["today"],
  );
});

test("status counts use all non-status filters and never double count reviews", () => {
  const statuses = [
    "running",
    "pending",
    "failed",
    "completed",
    "cancelled",
    "skipped",
  ];
  const tasks = [
    ...statuses.map((status) => entry(status, { status, source: "manual" })),
    entry("review", {
      status: "pending",
      reviewState: "pending",
      source: "manual",
    }),
    entry("outside-source", { status: "failed", source: "cron" }),
    entry("outside-engine", {
      status: "failed",
      source: "manual",
      engine: "complex",
    }),
  ];
  const result = getTaskList(tasks, {
    filters: { status: "failed", source: "manual", engine: "fast" },
    now: NOW,
  });
  assert.deepEqual(ids(result.items), ["failed"]);
  assert.deepEqual(result.counts, {
    all: 7,
    review: 1,
    running: 1,
    pending: 1,
    failed: 1,
    completed: 1,
    cancelled: 1,
    skipped: 1,
  });
});

test("pagination clamps out-of-range pages and supports only the three page sizes", () => {
  const tasks = Array.from({ length: 23 }, (_, index) =>
    entry(`task-${String(index + 1).padStart(2, "0")}`),
  );
  const last = getTaskList(tasks, { page: 99, pageSize: 10, now: NOW });
  assert.deepEqual(ids(last.items), ["task-21", "task-22", "task-23"]);
  assert.equal(last.page, 3);
  assert.equal(last.pageCount, 3);
  assert.equal(last.start, 21);
  assert.equal(last.end, 23);
  for (const [pageSize, wantedCount] of [
    [10, 3],
    [20, 2],
    [50, 1],
    [500, 3],
  ]) {
    const result = getTaskList(tasks, { page: -1, pageSize, now: NOW });
    assert.equal(result.page, 1);
    assert.equal(result.pageCount, wantedCount);
    assert.equal(result.pageSize, pageSize === 500 ? 10 : pageSize);
  }
  const empty = getTaskList([], { page: 20, now: NOW });
  assert.equal(empty.page, 1);
  assert.equal(empty.pageCount, 1);
  assert.equal(empty.start, 0);
  assert.equal(empty.end, 0);
  assert.deepEqual(empty.items, []);
});

test("sorting uses stable ID ties, priority rank and known duration without mutating input", () => {
  const tasks = freeze([
    entry("e", { priority: "medium", duration: -1 }),
    entry("d", {
      priority: "high",
      createdAt: "2026-11-09T07:00:00.000Z",
      statusInfo: {
        startedAt: "2026-11-09T07:00:00.000Z",
        completedAt: "2026-11-09T07:00:00.300Z",
      },
    }),
    entry("c", { priority: "high", duration: 10 }),
    entry("b", {
      priority: "urgent",
      createdAt: "2026-11-09T08:00:00.000Z",
      duration: 200,
    }),
    entry("a", { priority: "low", duration: 100 }),
  ]);
  for (const [sort, expected] of [
    ["created-desc", ["a", "c", "e", "b", "d"]],
    ["created-asc", ["d", "b", "a", "c", "e"]],
    ["priority-desc", ["b", "c", "d", "e", "a"]],
    ["duration-desc", ["d", "b", "a", "c", "e"]],
    ["unknown", ["a", "c", "e", "b", "d"]],
  ]) {
    assert.deepEqual(
      ids(getTaskList(tasks, { sort, now: NOW }).filtered),
      expected,
    );
  }
  assert.deepEqual(ids(tasks), ["e", "d", "c", "b", "a"]);
});

test("filter options use observed primitive values with deterministic order", () => {
  const tasks = freeze([
    entry("a", { engine: "fast", priority: "low", source: "webhook" }),
    entry("b", {
      engine: "complex",
      priority: "urgent",
      source: "manual",
      branch: "fix/a",
      type: "lint-error",
    }),
    entry("c", { engine: "fast", priority: "high", source: "cron" }),
    entry("duplicate", { engine: "fast", priority: "low", source: "webhook" }),
  ]);
  const expected = {
    engines: ["complex", "fast"],
    types: ["lint-error", "type-error"],
    priorities: ["urgent", "high", "low"],
    sources: ["cron", "manual", "webhook"],
    branches: ["fix/a", "main"],
  };
  assert.deepEqual(getTaskFilterOptions(tasks), expected);
  assert.deepEqual(getTaskFilterOptions([...tasks].reverse()), expected);
});

test("bulk cancellation plans deduplicate explicit IDs and explain every skipped task", () => {
  const snapshot = freeze(createDemoSnapshot(NOW));
  const running = snapshot.tasks.find(
    (item) => item.status.status === "running",
  );
  const review = snapshot.tasks.find((item) => item.reviewState === "pending");
  const completed = snapshot.tasks.find(
    (item) => item.status.status === "completed",
  );
  const plan = planBulkAction(snapshot, {
    type: "cancel",
    ids: [
      running.task.id,
      review.task.id,
      completed.task.id,
      "missing",
      running.task.id,
    ],
  });
  assert.deepEqual(plan.requestedIds, [
    running.task.id,
    review.task.id,
    completed.task.id,
    "missing",
  ]);
  assert.deepEqual(plan.eligible, [
    { id: running.task.id, title: running.title },
    { id: review.task.id, title: review.title },
  ]);
  assert.deepEqual(
    plan.skipped.map((item) => item.id),
    [completed.task.id, "missing"],
  );
  assert.ok(
    plan.skipped.every(
      (item) => typeof item.reason === "string" && item.reason.length > 0,
    ),
  );
  assert.equal(plan.canExecute, true);
  assert.equal(plan.type, "cancel");
});

test("bulk retries are eligible only for failed or cancelled tasks", () => {
  const original = createDemoSnapshot(NOW);
  const running = original.tasks.find(
    (item) => item.status.status === "running",
  );
  const snapshot = applyDemoAction(
    original,
    { type: "cancel", id: running.task.id },
    NOW,
  );
  const failed = snapshot.tasks.filter(
    (item) => item.status.status === "failed",
  );
  const review = snapshot.tasks.find((item) => item.reviewState === "pending");
  const plan = planBulkAction(snapshot, {
    type: "retry",
    ids: [failed[0].task.id, running.task.id, review.task.id],
  });
  assert.deepEqual(
    plan.eligible.map((item) => item.id),
    [failed[0].task.id, running.task.id],
  );
  assert.deepEqual(
    plan.skipped.map((item) => item.id),
    [review.task.id],
  );
});

test("bulk plans require an explicit true capability and local reducers never mutate live data", () => {
  const original = createDemoSnapshot(NOW);
  for (const type of ["cancel", "retry"]) {
    const target = original.tasks.find(
      (item) =>
        item.status.status === (type === "cancel" ? "running" : "failed"),
    );
    for (const snapshot of [
      {
        ...original,
        mode: "live",
        capabilities: { ...original.capabilities, [type]: false },
      },
      {
        ...original,
        capabilities: { ...original.capabilities, [type]: false },
      },
      { ...original, capabilities: {} },
      { ...original, capabilities: { [type]: "true" } },
    ]) {
      freeze(snapshot);
      const before = JSON.stringify(snapshot);
      const plan = planBulkAction(snapshot, { type, ids: [target.task.id] });
      assert.equal(plan.canExecute, false);
      assert.deepEqual(plan.eligible, []);
      assert.ok(plan.reason.length > 0);
      assert.equal(plan.skipped.length, 1);
      const result = applyDemoBulkAction(
        snapshot,
        { type, ids: [target.task.id] },
        NOW,
      );
      assert.deepEqual(result.report.applied, []);
      assert.equal(result.report.skipped.length, 1);
      assert.equal(JSON.stringify(result.snapshot), before);
      assert.equal(JSON.stringify(snapshot), before);
    }
  }
});

test("empty or malformed selection never expands to all tasks and approval cannot be batched", () => {
  const snapshot = freeze(createDemoSnapshot(NOW));
  for (const selection of [
    undefined,
    null,
    [],
    "AGT-2048",
    [null, {}, 1, "", "  "],
  ]) {
    const plan = planBulkAction(snapshot, { type: "cancel", ids: selection });
    assert.equal(plan.canExecute, false);
    assert.deepEqual(plan.eligible, []);
    const result = applyDemoBulkAction(
      snapshot,
      { type: "cancel", ids: selection },
      NOW,
    );
    assert.deepEqual(result.snapshot, snapshot);
    assert.deepEqual(result.report.applied, []);
  }
  for (const type of [
    undefined,
    null,
    "approve",
    "approve-gate",
    "trigger",
    "unknown",
  ]) {
    assert.throws(() => planBulkAction(snapshot, { type, ids: ["AGT-2048"] }));
    assert.throws(() =>
      applyDemoBulkAction(snapshot, { type, ids: ["AGT-2048"] }, NOW),
    );
  }
  assert.throws(() => planBulkAction(snapshot));
  assert.throws(() => applyDemoBulkAction(snapshot));
});

test("bulk cancellation preserves evidence and earlier approval decisions immutably", () => {
  let snapshot = createDemoSnapshot(NOW);
  const reviewId = snapshot.tasks.find((item) => item.reviewState === "pending")
    .task.id;
  snapshot = applyDemoAction(
    snapshot,
    { type: "approve-gate", id: reviewId, payload: { nodeId: "code-review" } },
    NOW,
  );
  const running = snapshot.tasks.find(
    (item) => item.status.status === "running",
  );
  const completed = snapshot.tasks.find(
    (item) => item.status.status === "completed",
  );
  freeze(snapshot);
  const before = JSON.stringify(snapshot);
  const result = applyDemoBulkAction(
    snapshot,
    {
      type: "cancel",
      ids: [reviewId, running.task.id, completed.task.id, "missing", reviewId],
    },
    NOW + 1000,
  );
  assert.equal(result.report.requested, 4);
  assert.deepEqual(
    result.report.applied.map((item) => item.id),
    [reviewId, running.task.id],
  );
  assert.deepEqual(
    result.report.skipped.map((item) => item.id),
    [completed.task.id, "missing"],
  );
  assert.equal(JSON.stringify(snapshot), before);
  const cancelled = find(result.snapshot, reviewId);
  assert.equal(cancelled.status.status, "cancelled");
  assert.equal(cancelled.reviewState, undefined);
  assert.deepEqual(
    cancelled.result.evidence,
    find(snapshot, reviewId).result.evidence,
  );
  const flow = getApprovalFlow(cancelled);
  assert.equal(flow.currentGate, null);
  assert.equal(
    flow.nodes.find((node) => node.id === "code-review").status,
    "completed",
  );
  assert.equal(
    flow.nodes.find((node) => node.id === "execution-auth").status,
    "blocked",
  );
  assert.equal(flow.history.at(-1).decision, "cancelled");
  assert.equal(result.snapshot.activity.length, snapshot.activity.length + 2);
});

test("bulk retries create unique pending tasks and preserve every original attempt", () => {
  const snapshot = freeze(createDemoSnapshot(NOW));
  const failed = snapshot.tasks.filter(
    (item) => item.status.status === "failed",
  );
  const before = JSON.stringify(snapshot);
  const result = applyDemoBulkAction(
    snapshot,
    {
      type: "retry",
      ids: failed.map((item) => item.task.id),
    },
    NOW + 1000,
  );
  assert.equal(result.report.requested, 3);
  assert.equal(result.report.applied.length, 3);
  assert.deepEqual(result.report.skipped, []);
  assert.equal(result.snapshot.tasks.length, 51);
  assert.equal(new Set(ids(result.snapshot.tasks)).size, 51);
  assert.equal(
    new Set(result.report.applied.map((item) => item.newId)).size,
    3,
  );
  for (const applied of result.report.applied) {
    const original = find(snapshot, applied.id);
    const retried = find(result.snapshot, applied.newId);
    assert.deepEqual(find(result.snapshot, applied.id), original);
    assert.equal(retried.status.status, "pending");
    assert.equal(retried.task.payload.context.retryOf, applied.id);
    assert.equal(retried.task.payload.context.retryCount, 1);
    assert.equal(retried.result, undefined);
    assert.equal(retried.approvalFlow, undefined);
  }
  assert.equal(JSON.stringify(snapshot), before);
});

test("bulk execution revalidates eligibility after a confirmation plan becomes stale", () => {
  const original = createDemoSnapshot(NOW);
  const candidates = original.tasks
    .filter(
      (item) =>
        item.status.status === "running" || item.reviewState === "pending",
    )
    .slice(0, 2);
  const action = { type: "cancel", ids: ids(candidates) };
  assert.equal(planBulkAction(original, action).eligible.length, 2);
  const changed = applyDemoAction(
    original,
    { type: "cancel", id: candidates[0].task.id },
    NOW,
  );
  const result = applyDemoBulkAction(changed, action, NOW + 1000);
  assert.deepEqual(
    result.report.applied.map((item) => item.id),
    [candidates[1].task.id],
  );
  assert.deepEqual(
    result.report.skipped.map((item) => item.id),
    [candidates[0].task.id],
  );
  const revoked = {
    ...original,
    capabilities: { ...original.capabilities, cancel: false },
  };
  assert.equal(
    applyDemoBulkAction(revoked, action, NOW).report.applied.length,
    0,
  );
});

test("CSV exports explicit visible fields with BOM, RFC quoting and formula neutralization", () => {
  const item = freeze(
    entry("safe-1", {
      title: ' \t=HYPERLINK("x")',
      status: "pending",
      reviewState: "pending",
      branch: 'fix/"quote",\nbranch',
      duration: 1000,
    }),
  );
  const csv = exportTasksCSV([item], { mode: "demo", now: NOW });
  assert.equal(
    csv,
    '\uFEFF"任务 ID","任务标题","任务类型","状态","优先级","执行引擎","触发来源","仓库","分支","创建时间","耗时（毫秒）"\r\n' +
      '"safe-1","\' \t=HYPERLINK(""x"")","type-error","review","high","fast","webhook","demo/chat-app","fix/""quote"",\nbranch","2026-11-09T09:00:00.000Z","1000"\r\n',
  );
  assert.equal(csv.includes("never-export-this-secret"), false);
  assert.equal(csv.includes("private diagnostic detail"), false);
  assert.equal(csv.includes("Detailed internal event source"), false);
});

test("CSV neutralizes formulas behind whitespace, control and format characters", () => {
  for (const title of [
    "=1+1",
    " +SUM(A1)",
    "\t-1",
    " \u0001@cmd",
    "\r\n\uFEFF=1",
    "\u200B=1",
  ]) {
    const csv = exportTasksCSV([entry("safe", { title })], { now: NOW });
    assert.ok(
      csv.includes(`,"'${title}",`),
      `unsafe spreadsheet cell: ${JSON.stringify(title)}`,
    );
  }
});

test("JSON exports only the safe summary projection with explicit export context", () => {
  const task = freeze(entry("safe", { duration: 0 }));
  const data = JSON.parse(exportTasksJSON([task], { mode: "demo", now: NOW }));
  assert.deepEqual(data, {
    mode: "demo",
    exportedAt: "2026-11-09T10:00:00.000Z",
    tasks: [
      {
        id: "safe",
        title: "修复聊天组件 safe",
        type: "type-error",
        status: "completed",
        priority: "high",
        engine: "fast",
        source: "webhook",
        repo: "demo/chat-app",
        branch: "main",
        createdAt: "2026-11-09T09:00:00.000Z",
        duration: 0,
      },
    ],
  });
  assert.equal(
    JSON.stringify(data).includes("never-export-this-secret"),
    false,
  );
});
