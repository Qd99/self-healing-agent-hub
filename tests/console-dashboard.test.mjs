import test from "node:test";
import assert from "node:assert/strict";
import { createDemoSnapshot } from "../apps/console/public/data.js";
import { escapeHtml } from "../apps/console/public/model.js";
import { renderStudioDashboard } from "../apps/console/public/dashboard.js";

const NOW = Date.parse("2026-11-09T10:00:00.000Z");
const state = (snapshot, days = 7) => ({
  snapshot,
  mode: "demo",
  days,
  overviewTab: "focus",
});

test("dashboard reports expose exact drilldowns and keep recent tasks to four", (t) => {
  t.mock.method(Date, "now", () => NOW);
  const html = renderStudioDashboard(state(createDemoSnapshot(NOW)));
  for (const label of ["任务趋势", "任务状态", "问题类型", "引擎表现"])
    assert.ok(html.includes(label), label);
  assert.equal((html.match(/class="home-task-row"/g) || []).length, 4);
  for (const [dimension, value] of [
    ["status", "review"],
    ["status", "completed"],
    ["type", "unit-test-failure"],
    ["engine", "fast"],
    ["engine", "complex"],
  ])
    assert.ok(
      html.includes(`data-dimension="${dimension}" data-value="${value}"`),
      `${dimension}:${value}`,
    );
  assert.ok(html.includes("已完成 42 项"));
  assert.ok(html.includes("失败 3 项"));
  assert.ok(html.includes("待审批 2 项"));
  assert.ok(html.includes("按创建日期统计当前结果"));
});

test("dashboard escapes untrusted category, engine and task values", (t) => {
  t.mock.method(Date, "now", () => NOW);
  const snapshot = createDemoSnapshot(NOW);
  const entry = snapshot.tasks[0];
  const unsafe = `odd"><img src=x onerror='alert(1)'>&`;
  entry.title = unsafe;
  entry.task.id = unsafe;
  entry.task.type = unsafe;
  entry.engineId = unsafe;
  snapshot.tasks = [entry];
  const html = renderStudioDashboard(state(snapshot));
  assert.ok(html.includes(escapeHtml(unsafe)));
  assert.ok(!html.includes(unsafe));
  assert.ok(!html.includes("<img"));
  assert.ok(
    html.includes(`data-dimension="type" data-value="${escapeHtml(unsafe)}"`),
  );
  assert.ok(
    html.includes(`data-dimension="engine" data-value="${escapeHtml(unsafe)}"`),
  );
});

test("unknown groups remain visible without misleading exact-match drilldowns", (t) => {
  t.mock.method(Date, "now", () => NOW);
  const snapshot = createDemoSnapshot(NOW);
  const entry = snapshot.tasks[0];
  delete entry.task.type;
  delete entry.engineId;
  entry.status.status = "unrecognized-state";
  snapshot.tasks = [entry];
  const html = renderStudioDashboard(state(snapshot));
  for (const label of ["未知状态", "未知类型", "未知引擎"])
    assert.ok(html.includes(label), label);
  for (const dimension of ["status", "type", "engine"])
    assert.ok(
      !html.includes(`data-dimension="${dimension}" data-value="unknown"`),
    );
  assert.ok(!html.includes("NaN"));
  assert.ok(!html.includes("Infinity"));
});

test("empty reports keep unavailable rates distinct from zero counts", (t) => {
  t.mock.method(Date, "now", () => NOW);
  const snapshot = createDemoSnapshot(NOW);
  snapshot.tasks = [];
  const html = renderStudioDashboard(state(snapshot, 30));
  assert.ok(html.includes("当前范围内没有任务"));
  assert.ok(html.includes("暂无问题类型数据"));
  assert.ok(html.includes("暂无引擎任务数据"));
  assert.ok(html.includes("暂无有效耗时"));
  assert.ok(!html.includes('data-dimension="status"'));
  assert.ok(!html.includes("NaN"));
  assert.ok(!html.includes("Infinity"));
});
