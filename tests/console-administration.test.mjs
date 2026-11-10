import test from "node:test";
import assert from "node:assert/strict";

import { createDemoSnapshot } from "../apps/console/public/data.js";
import * as administrationModel from "../apps/console/public/administration-model.js";
import * as administrationViews from "../apps/console/public/administration-views.js";
import { createAdministrationController } from "../apps/console/public/administration-controller.js";

test("rule toggles send their independent rules revision after unrelated snapshot changes", () => {
  let sent;
  const state = {
    mode: "live",
    snapshot: {
      mode: "live",
      revision: 100,
      configRevisions: { rules: 3, monitoring: 7 },
      capabilities: { updateRules: true },
      rules: [{ id: "rule-a", enabled: true }],
      activity: [],
    },
  };
  const controller = createAdministrationController({
    state,
    render() {},
    toast() {},
    openRule() {},
    openActivity() {},
    setSnapshot() {},
    api: {
      updateRule(id, body) {
        sent = { id, ...body };
      },
    },
    runMutation(key, request) {
      request();
    },
  });
  controller.handleClick(
    {},
    { dataset: { action: "toggle-rule", id: "rule-a" } },
  );
  assert.deepEqual(sent, {
    id: "rule-a",
    enabled: false,
    expectedRevision: 100,
    expectedConfigRevision: 3,
  });
});
import {
  describeActivity,
  filterActivities,
  groupActivities,
  exportActivitiesJSON,
  describeRuleConditions,
  describeRuleProcessor,
  filterRules,
  canUpdateRules,
} from "../apps/console/public/administration-model.js";

const NOW = Date.parse("2026-11-09T10:00:00.000Z");
const event = (id, fields = {}) => ({
  id,
  at: "2026-11-09T09:00:00.000Z",
  action: "retry",
  actor: "操作员",
  message: "已发起重试",
  taskId: "AGT-0001",
  ...fields,
});

test("activity descriptions use supplied action and never infer actors or outcomes", () => {
  assert.equal(describeActivity(event("one")).category, "tasks");
  for (const [action, label, icon] of [
    ["late-result", "补录执行回执", "History"],
    ["reconciled", "核对执行结果", "CheckCheck"],
    ["retry-interrupted", "重试任务已停止", "Square"],
  ]) {
    const record = event(action, { action });
    const description = describeActivity(record);
    assert.equal(description.label, label);
    assert.equal(description.category, "tasks");
    assert.equal(description.icon, icon);
    assert.deepEqual(
      filterActivities([record], { category: "tasks", query: label }).map(
        (entry) => entry.id,
      ),
      [action],
    );
  }
  assert.equal(
    describeActivity(event("one", { action: "approve-gate" })).category,
    "approvals",
  );
  assert.equal(
    describeActivity(event("one", { action: "toggle-rule" })).category,
    "rules",
  );
  const unstructured = describeActivity({
    message: "修复失败，但审批已经通过",
  });
  assert.equal(unstructured.category, "other");
  assert.equal(unstructured.label, "操作记录");
  assert.equal(unstructured.actor, "未提供操作者");
  assert.equal(unstructured.message, "修复失败，但审批已经通过");
});

test("activity filters intersect literal search, event category and Shanghai calendar dates", () => {
  const records = Object.freeze([
    event("old", { at: "2026-11-02T15:59:59.999Z" }),
    event("boundary", { at: "2026-11-02T16:00:00.000Z", actor: "ALICE" }),
    event("approval", { action: "approve", actor: "Alice" }),
    event("today", { actor: "Alice" }),
    event("future", { at: "2026-11-09T11:00:00.000Z", actor: "Alice" }),
    event("invalid", { at: "unknown", actor: "Alice" }),
  ]);
  assert.deepEqual(
    filterActivities(records, {
      query: "alice",
      category: "tasks",
      days: 7,
      now: NOW,
    }).map((x) => x.id),
    ["today", "boundary"],
  );
  assert.equal(filterActivities(records, { query: ".*", now: NOW }).length, 0);
  assert.equal(
    filterActivities(records, { query: "AGT-0001", days: 0, now: NOW }).length,
    6,
  );
  assert.equal(filterActivities(records, { days: 1, now: NOW }).length, 2);
});

test("activity level filters use supplied severity without inferring success from the action", () => {
  const records = [
    event("info", { action: "completed", level: "info" }),
    event("warning", { level: "warning" }),
    event("error", { level: "error" }),
    event("explicit-success", { action: "retry", level: "success" }),
    event("missing"),
    event("custom", { level: "debug" }),
    event("approval", { action: "approve", level: "info" }),
  ];
  assert.deepEqual(
    filterActivities(records, { level: "info", category: "tasks" }).map(
      (entry) => entry.id,
    ),
    ["info"],
  );
  assert.deepEqual(
    filterActivities(records, { level: "warning" }).map((entry) => entry.id),
    ["warning"],
  );
  assert.deepEqual(
    filterActivities(records, { level: "error" }).map((entry) => entry.id),
    ["error"],
  );
  assert.deepEqual(
    filterActivities(records, { level: "success" }).map((entry) => entry.id),
    ["explicit-success"],
  );
  assert.equal(describeActivity(records[0]).level.tone, "neutral");
  assert.equal(describeActivity(records[3]).level.tone, "success");
  assert.deepEqual(
    filterActivities(records, { level: "unknown" }).map((entry) => entry.id),
    ["missing", "custom"],
  );
});

const pagedRecords = () =>
  Array.from({ length: 31 }, (_, index) =>
    event(`record-${index + 1}`, {
      at: new Date(NOW - index * 60_000).toISOString(),
      level: index % 2 === 0 ? "info" : "warning",
    }),
  );

test("activity pagination applies filters before the 15-record page boundary and clamps stale pages", () => {
  assert.equal(typeof administrationModel.getActivityPage, "function");
  const records = Object.freeze(pagedRecords());
  const result = administrationModel.getActivityPage(records, {
    filters: { level: "info" },
    page: 2,
    now: NOW,
  });
  assert.deepEqual(
    result.items.map((entry) => entry.id),
    ["record-31"],
  );
  assert.equal(result.total, 16);
  assert.equal(result.page, 2);
  assert.equal(result.pageCount, 2);
  assert.equal(result.pageSize, 15);
  assert.equal(result.start, 16);
  assert.equal(result.end, 16);
  assert.equal(
    administrationModel.getActivityPage(records, { page: 99 }).page,
    3,
  );
  for (const page of [0, -2, 1.5, NaN, Infinity]) {
    assert.equal(
      administrationModel.getActivityPage(records, { page }).page,
      1,
    );
  }
  assert.equal(
    administrationModel.getActivityPage(records, { page: "2" }).page,
    2,
  );
  assert.equal(records[0].id, "record-1");
});

test("missing or malformed activity has an empty first page", () => {
  assert.equal(typeof administrationModel.getActivityPage, "function");
  for (const records of [undefined, null, {}, [null, "invalid", []]]) {
    const result = administrationModel.getActivityPage(records, { page: 7 });
    assert.deepEqual(result.items, []);
    assert.equal(result.total, 0);
    assert.equal(result.page, 1);
    assert.equal(result.start, 0);
    assert.equal(result.end, 0);
  }
});

test("activity export includes every filtered record even when the table is on a later page", () => {
  const result = JSON.parse(
    exportActivitiesJSON(
      { mode: "live", activity: pagedRecords() },
      { level: "info", page: 2 },
      { now: NOW },
    ),
  );
  assert.equal(result.count, 16);
  assert.equal(result.activity[0].id, "record-1");
  assert.equal(result.activity[15].id, "record-31");
  assert.ok(result.activity.every((entry) => entry.level === "info"));
});

test("activity table exposes one detail action per visible record without embedding log messages", () => {
  const html = administrationViews.renderActivityPage({
    snapshot: { activity: pagedRecords(), tasks: [] },
    activityPage: 2,
  });
  const body = html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] || "";
  assert.equal((body.match(/<tr\b/g) || []).length, 15);
  assert.equal(
    (body.match(/<button\b[^>]*data-action="activity-detail"/g) || []).length,
    15,
  );
  assert.match(body, /data-id="record-16"/);
  assert.match(body, /data-id="record-30"/);
  assert.doesNotMatch(body, /data-id="record-31"/);
  assert.doesNotMatch(body, /已发起重试|data-action="open-task"/);
  assert.match(html, /id="activity-level"/);
  assert.match(html, /16[–—-]30/);
});

test("activity detail retains full escaped evidence and only links to existing related objects", () => {
  assert.equal(typeof administrationViews.renderActivityDetail, "function");
  const message = '<script>alert("unsafe")</script>\n' + "完整记录 ".repeat(80);
  const record = event('audit-"1', {
    actor: "<operator>",
    message,
    level: "info",
    ruleId: "retry-rule",
  });
  const html = administrationViews.renderActivityDetail(record, {
    snapshot: {
      tasks: [{ task: { id: "AGT-0001" } }],
      rules: [{ id: "retry-rule" }],
    },
  });
  assert.match(
    html,
    /&lt;script&gt;alert\(&quot;unsafe&quot;\)&lt;\/script&gt;/,
  );
  assert.match(html, /&lt;operator&gt;/);
  assert.ok(html.includes("完整记录 ".repeat(80)));
  assert.doesNotMatch(html, /<script>|<operator>|ui-status-success/);
  assert.match(html, /ui-status-neutral/);
  assert.doesNotMatch(html, /ui-status-info/);
  assert.match(html, /2026-11-09T09:00:00.000Z/);
  assert.match(html, /data-action="open-task"[^>]*data-tab="trace"/);
  assert.match(html, /data-action="open-task"[^>]*data-tab="logs"/);
  assert.match(html, /data-action="rule-detail"[^>]*data-id="retry-rule"/);

  const missing = administrationViews.renderActivityDetail(record, {
    snapshot: { tasks: [], rules: [] },
  });
  assert.doesNotMatch(
    missing,
    /data-action="open-task"|data-action="rule-detail"/,
  );
  assert.match(missing, /AGT-0001/);
  assert.match(missing, /retry-rule/);
});

test("activity detail preserves unknown metadata without manufacturing a successful outcome", () => {
  assert.equal(typeof administrationViews.renderActivityDetail, "function");
  const html = administrationViews.renderActivityDetail({
    at: "invalid-date",
    action: "completed",
    level: "trace<custom>",
  });
  assert.match(html, /未提供操作者/);
  assert.match(html, /时间无效/);
  assert.match(html, /invalid-date/);
  assert.match(html, /trace&lt;custom&gt;/);
  assert.match(html, /未提供消息/);
  assert.doesNotMatch(
    html,
    /ui-status-success|<custom>|data-action="open-task"/,
  );
});

test("disconnected activity explains when records will appear and opens connection settings", () => {
  const html = administrationViews.renderActivityPage({ snapshot: null });
  assert.match(html, /管理服务连接后/);
  assert.match(html, /data-action="navigate"[^>]*data-view="settings"/);
  assert.doesNotMatch(html, /<tbody>|data-action="activity-detail"/);
  assert.doesNotThrow(() =>
    administrationViews.renderActivityPage({ snapshot: { activity: {} } }),
  );
});

function activityControllerHarness(overrides = {}) {
  const state = {
    snapshot: { activity: pagedRecords(), rules: [] },
    activityPage: 2,
    ...overrides,
  };
  const opened = [];
  const messages = [];
  const renders = [];
  const controller = createAdministrationController({
    state,
    render: () => renders.push(state.activityPage),
    toast: (message) => messages.push(message),
    openActivity: (id) => opened.push(id),
    openRule() {},
    setSnapshot: (snapshot) => (state.snapshot = snapshot),
  });
  return { state, controller, opened, messages, renders };
}

test("changing an activity filter returns to page one, including composed search input", () => {
  const h = activityControllerHarness();
  assert.equal(
    h.controller.handleInput({
      target: { id: "activity-search", value: "operator" },
      isComposing: true,
    }),
    true,
  );
  assert.equal(h.state.activityPage, 1);
  assert.deepEqual(h.renders, []);
  for (const [id, value] of [
    ["activity-category", "tasks"],
    ["activity-days", "7"],
    ["activity-level", "warning"],
  ]) {
    h.state.activityPage = 2;
    assert.equal(h.controller.handleChange({ target: { id, value } }), true);
    assert.equal(h.state.activityPage, 1);
  }
  assert.equal(h.state.activityFilters.level, "warning");
  h.state.activityPage = 2;
  h.controller.handleClick({}, { dataset: { action: "activity-reset" } });
  assert.equal(h.state.activityPage, 1);
  assert.equal(h.state.activityFilters.level, "all");
});

test("activity controller bounds page navigation and reconciles when refreshed records shrink", () => {
  const h = activityControllerHarness({ activityPage: -4 });
  assert.equal(h.state.activityPage, 1);
  assert.equal(
    h.controller.handleClick(
      {},
      { dataset: { action: "activity-page", page: "99" } },
    ),
    true,
  );
  assert.equal(h.state.activityPage, 3);
  h.state.snapshot.activity = [event("remaining")];
  h.controller.reconcile();
  assert.equal(h.state.activityPage, 1);
  h.controller.handleClick(
    {},
    { dataset: { action: "activity-page", page: "NaN" } },
  );
  assert.equal(h.state.activityPage, 1);
});

test("activity detail opening rejects stale records and places return focus on the row action", () => {
  const h = activityControllerHarness();
  let focused = false;
  const row = {
    dataset: { action: "activity-detail", id: "record-1" },
    querySelector: () => ({ focus: () => (focused = true) }),
  };
  assert.equal(h.controller.handleClick({}, row), true);
  assert.deepEqual(h.opened, ["record-1"]);
  assert.equal(focused, true);
  h.controller.handleClick(
    {},
    { dataset: { action: "activity-detail", id: "gone" } },
  );
  assert.deepEqual(h.opened, ["record-1"]);
  assert.equal(h.messages.length, 1);
});

test("all-time activity retains undated evidence and date groups follow Shanghai midnight", () => {
  const records = [
    event("before", { at: "2026-11-08T15:59:59Z" }),
    event("after", { at: "2026-11-08T16:00:00Z" }),
    event("unknown", { at: "" }),
  ];
  const groups = groupActivities(
    filterActivities(records, { days: 0, now: NOW }),
  );
  assert.deepEqual(
    groups.map((x) => [x.date, x.items.map((y) => y.id)]),
    [
      ["2026-11-09", ["after"]],
      ["2026-11-08", ["before"]],
      ["unknown", ["unknown"]],
    ],
  );
});

test("activity export includes only filtered primitive allowlisted event fields", () => {
  const snapshot = createDemoSnapshot(NOW);
  snapshot.activity = [
    event("keep", {
      action: "toggle-rule",
      taskId: undefined,
      ruleId: "ci-retry",
      credentials: "private-extra",
      nested: { secret: "private-nested" },
    }),
    event("exclude", { action: "approve", message: "do-not-export" }),
  ];
  snapshot.privateToken = "private-snapshot";
  const result = JSON.parse(
    exportActivitiesJSON(snapshot, { category: "rules" }, { now: NOW }),
  );
  assert.equal(result.activity.length, 1);
  assert.deepEqual(result.activity[0], {
    id: "keep",
    at: "2026-11-09T09:00:00.000Z",
    action: "toggle-rule",
    actor: "操作员",
    message: "已发起重试",
    ruleId: "ci-retry",
  });
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal(JSON.stringify(result).includes("do-not-export"), false);
  assert.equal(Object.hasOwn(result, "tasks"), false);
  assert.equal(Object.hasOwn(result, "rules"), false);
});

test("rule descriptions preserve every retry bound and unrecognized condition", () => {
  const rule = {
    match: {
      taskType: "ci-failure",
      "context.retryCount": { $gte: 1, $lt: 3 },
      "context.branch": { $regex: "^release/" },
    },
    processor: {
      engine: "complex",
      action: "create-pr",
      priority: "urgent",
      workflow: "diagnose-and-fix",
    },
  };
  assert.deepEqual(describeRuleConditions(rule), [
    "任务类型为 CI 失败",
    "重试次数大于或等于 1",
    "重试次数小于 3",
    'context.branch 条件 {"$regex":"^release/"}',
  ]);
  assert.deepEqual(describeRuleConditions({ match: {} }), ["未设置匹配条件"]);
  const processor = describeRuleProcessor(rule);
  assert.equal(processor.engine, "ZCode Workflow");
  assert.equal(processor.action, "创建 Pull Request");
  assert.equal(processor.priority, "紧急");
  assert.equal(processor.workflow, "诊断并修复");
});

test("rule filters match names, IDs, human-readable conditions and engine without reordering", () => {
  const snapshot = createDemoSnapshot(NOW);
  assert.deepEqual(
    filterRules(snapshot.rules, { query: "重试次数" }).map((x) => x.id),
    ["ci-retry"],
  );
  assert.deepEqual(
    filterRules(snapshot.rules, {
      query: "DEPENDENCY",
      status: "disabled",
      engine: "complex",
    }).map((x) => x.id),
    ["dependency-update"],
  );
  assert.deepEqual(
    filterRules(snapshot.rules, { status: "enabled", engine: "complex" }).map(
      (x) => x.id,
    ),
    snapshot.rules
      .filter((x) => x.enabled && x.processor.engine === "complex")
      .map((x) => x.id),
  );
});

test("rule mutation requires matching source contexts and the explicit updateRules capability", () => {
  const snapshot = createDemoSnapshot(NOW);
  assert.equal(canUpdateRules({ mode: "demo", snapshot }), true);
  assert.equal(canUpdateRules({ mode: "live", snapshot }), false);
  assert.equal(
    canUpdateRules({ mode: "demo", snapshot: { ...snapshot, mode: "live" } }),
    false,
  );
  assert.equal(
    canUpdateRules({
      mode: "demo",
      snapshot: { ...snapshot, capabilities: { updateRules: false } },
    }),
    false,
  );
  assert.equal(canUpdateRules({ mode: "demo", snapshot: null }), false);
});
