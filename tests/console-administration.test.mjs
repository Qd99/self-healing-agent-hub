import test from "node:test";
import assert from "node:assert/strict";

import { createDemoSnapshot } from "../apps/console/public/data.js";
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

test("rule mutation requires both demo contexts and the explicit updateRules capability", () => {
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
