import test from "node:test";
import assert from "node:assert/strict";
import { createDemoSnapshot } from "../apps/console/public/data.js";
import {
  planBulkAction,
  applyDemoBulkAction,
} from "../apps/console/public/task-model.js";
import { canUpdateRules } from "../apps/console/public/administration-model.js";
import { getApprovalFlow } from "../apps/console/public/approvals.js";
import {
  renderShell,
  renderCreate,
  renderTaskDetail,
} from "../apps/console/public/views.js";
import { renderBulkDialog } from "../apps/console/public/task-views.js";

function live() {
  const snapshot = createDemoSnapshot();
  snapshot.mode = "live";
  snapshot.revision = 7;
  snapshot.csrfToken = "csrf";
  snapshot.auth = { required: true, actor: "Operator" };
  snapshot.capabilities.updateMonitoring = true;
  for (const entry of snapshot.tasks) {
    entry.revision = 3;
    delete entry.task.payload.context.demo;
    if (entry.approvalFlow) entry.approvalFlow.source = "server";
  }
  return {
    view: "tasks",
    mode: "live",
    snapshot,
    loading: false,
    error: "",
    theme: "light",
    days: 7,
  };
}

test("live task planning uses capabilities and revisions without invoking demo mutations", () => {
  const state = live();
  const entry = state.snapshot.tasks.find(
    (item) => item.status.status === "failed",
  );
  const plan = planBulkAction(state.snapshot, {
    type: "retry",
    ids: [entry.task.id],
  });
  assert.equal(plan.canExecute, true);
  assert.equal(plan.eligible[0].revision, 3);
  const result = applyDemoBulkAction(state.snapshot, {
    type: "retry",
    ids: [entry.task.id],
  });
  assert.equal(result.snapshot, state.snapshot);
  assert.equal(result.report.applied.length, 0);
});

test("live rule changes respect session and pending state", () => {
  const state = live();
  assert.equal(canUpdateRules(state), true);
  assert.equal(canUpdateRules({ ...state, pendingAction: "rule:1" }), false);
  assert.equal(canUpdateRules({ ...state, authRequired: true }), false);
  state.snapshot.capabilities.updateRules = false;
  assert.equal(canUpdateRules(state), false);
});

test("completed server approval projects completed execution and proposal evidence remains readable", () => {
  const state = live();
  const entry = state.snapshot.tasks.find((item) => item.approvalFlow);
  entry.approvalFlow.status = "approved";
  entry.approvalFlow.gates.forEach((gate) => {
    gate.status = "approved";
  });
  entry.status.status = "completed";
  const execution = getApprovalFlow(entry).nodes.find(
    (node) => node.id === "execute",
  );
  assert.equal(execution.status, "completed");
  assert.doesNotMatch(execution.detail, /未执行|等待执行器/);
  entry.evidence = {
    beforeState: { summary: "Candidate before" },
    afterState: { summary: "Candidate after" },
    checksPass: ["npm test"],
  };
  delete entry.result;
  const html = renderTaskDetail(entry, { ...state, detailTab: "evidence" });
  assert.match(html, /Candidate before/);
  assert.match(html, /npm test/);
  assert.match(html, /候选/);
});

test("live task forms and bulk confirmation retain the existing controls without demo claims", () => {
  const state = live();
  const entry = state.snapshot.tasks.find(
    (item) => item.status.status === "failed",
  );
  state.bulkPlan = planBulkAction(state.snapshot, {
    type: "retry",
    ids: [entry.task.id],
  });
  const form = renderCreate({
    ...state,
    createDraft: {
      title: "Unsaved repair",
      type: "lint-error",
      priority: "high",
      branch: "feature",
    },
  });
  assert.match(form, /value="Unsaved repair"/);
  assert.doesNotMatch(form, /创建模拟任务|当前没有连接真实执行引擎/);
  const bulk = renderBulkDialog(state);
  assert.match(bulk, /data-action="bulk-confirm"/);
  assert.doesNotMatch(bulk, /真实连接当前只读|模拟重试/);
});

test("authentication required renders a compact password login without exposing or persisting credentials", () => {
  const state = live();
  const html = renderShell({
    ...state,
    authRequired: true,
    authError: "登录已过期",
  });
  assert.match(html, /id="session-form"/);
  assert.match(html, /type="password"/);
  assert.match(html, /登录已过期/);
  assert.doesNotMatch(html, /value="csrf"/);
});

test("live monitoring offers server save and displays an explicit connection check separately from metrics", () => {
  const state = live();
  const html = renderShell({
    ...state,
    view: "monitoring",
    monitoringTab: "configuration",
    monitoringConfig: state.snapshot.monitoring,
    monitoringSource: "server",
    monitoringCheck: {
      status: "connected",
      checkedAt: "2026-11-10T00:00:00.000Z",
      message: "Grafana and datasource verified",
      checks: { grafana: "ok", datasource: "ok" },
    },
  });
  assert.match(html, /保存配置/);
  assert.match(html, /data-action="monitoring-check"/);
  assert.match(html, /Grafana and datasource verified/);
  assert.doesNotMatch(html, /保存到本机|保存为本机配置草稿/);
});
