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

test("task detail separates the final error from its trigger and links only validated artifact identifiers", () => {
  const state = live();
  const entry = state.snapshot.tasks[0];
  entry.task.payload.repo = "owner/project";
  entry.task.payload.errorDetails = { message: "Initial trigger problem" };
  entry.status.status = "failed";
  entry.result = {
    success: false,
    action: "failed",
    changes: {
      commit: "b".repeat(40),
      pr: 42,
      issue: 43,
      files: ["src/fix.js"],
    },
    error: {
      code: "PUSH_REJECTED",
      message: "Final push rejected <script>",
      suggestedAction: "Check branch permissions",
    },
    url: "javascript:alert(1)",
  };
  const html = renderTaskDetail(entry, { ...state, detailTab: "trace" });
  assert.match(html, /最终结果/);
  assert.match(html, /触发原因/);
  assert.match(html, /Initial trigger problem/);
  assert.match(html, /PUSH_REJECTED/);
  assert.match(html, /Final push rejected &lt;script&gt;/);
  assert.match(html, /Check branch permissions/);
  assert.match(
    html,
    /href="https:\/\/github.com\/owner\/project\/commit\/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"/,
  );
  assert.match(
    html,
    /href="https:\/\/github.com\/owner\/project\/pull\/42"[^>]*rel="noopener noreferrer"/,
  );
  assert.match(html, /href="https:\/\/github.com\/owner\/project\/issues\/43"/);
  assert.match(html, /src\/fix.js/);
  assert.doesNotMatch(html, /javascript:/);
  for (const repo of [
    "https://evil.test/repo",
    "../project",
    "owner/project/../../evil",
    "owner/%2fproject",
    "owner/project?x=1",
  ]) {
    entry.task.payload.repo = repo;
    assert.doesNotMatch(
      renderTaskDetail(entry, state),
      /href="https:\/\/github.com\//,
    );
  }
  entry.task.payload.repo = "owner/project";
  entry.result.changes = {
    commit: "javascript:alert(1)",
    pr: "42/../../evil",
    issue: -2,
  };
  assert.doesNotMatch(renderTaskDetail(entry, state), /href=/);
});

test("required reconciliation blocks individual and bulk retry and retains form feedback", () => {
  const state = live();
  const entry = state.snapshot.tasks.find(
    (item) => item.status.status === "failed",
  );
  state.snapshot.capabilities.reconcile = true;
  entry.reconciliation = {
    status: "required",
    reason: "执行中断，需要核对仓库",
    updatedAt: "2026-11-10T00:00:00Z",
  };
  const html = renderTaskDetail(entry, {
    ...state,
    detailTab: "trace",
    reconciliationDraft: {
      taskId: entry.task.id,
      outcome: "changes-recorded",
      note: "已找到提交",
    },
    reconciliationError: "核对保存失败",
  });
  assert.match(html, /待核对/);
  assert.match(html, /id="reconciliation-form"/);
  assert.match(html, /value="no-changes"/);
  assert.match(html, /value="changes-recorded" selected/);
  assert.match(html, /已找到提交/);
  assert.match(html, /核对保存失败/);
  assert.match(html, /data-command="retry"[^>]*disabled/);
  const plan = planBulkAction(state.snapshot, {
    type: "retry",
    ids: [entry.task.id],
  });
  assert.equal(plan.canExecute, false);
  assert.match(plan.skipped[0].reason, /核对/);
  assert.match(plan.reason, /核对/);
  const pending = renderTaskDetail(entry, {
    ...state,
    pendingAction: `reconcile:${entry.task.id}`,
  });
  assert.match(pending, /保存中/);
  assert.match(pending, /name="note"[^>]*disabled/);
  entry.reconciliation = {
    ...entry.reconciliation,
    status: "resolved",
    resolution: {
      outcome: "changes-recorded",
      note: "已确认提交及 PR",
      actor: "Operator",
      at: "2026-11-10T01:00:00Z",
    },
  };
  const resolved = renderTaskDetail(entry, {
    ...state,
    reconciliationSuccess: "核对结论已保存",
  });
  assert.match(resolved, /核对结论已保存/);
  assert.match(resolved, /已确认提交及 PR/);
  assert.match(resolved, /Operator/);
  assert.doesNotMatch(resolved, /id="reconciliation-form"/);
  assert.equal(
    planBulkAction(state.snapshot, { type: "retry", ids: [entry.task.id] })
      .canExecute,
    true,
  );
});

test("storage restrictions remain visible alongside readable task and export controls", () => {
  const state = live();
  state.snapshot.storage = {
    status: "read-only",
    reason: "STORE_FULL",
    message: "存储容量不足，请导出历史后联系管理员。",
  };
  state.snapshot.capabilities = {};
  const html = renderShell(state);
  assert.match(html, /只读/);
  assert.match(html, /存储容量不足/);
  assert.match(html, /STORE_FULL/);
  assert.match(html, /data-action="task-export"/);
  assert.match(html, /data-action="new-task"[^>]*disabled/);
});

test("interrupted receipt history preserves distinct side effects without changing the terminal status", () => {
  const state = live();
  const entry = state.snapshot.tasks[0];
  entry.status.status = "cancelled";
  entry.task.payload.repo = "owner/project";
  entry.resultReceipts = [
    {
      kind: "cancelled",
      receivedAt: "2026-11-10T01:00:00Z",
      result: {
        success: false,
        action: "failed",
        changes: { commit: "c".repeat(40) },
      },
    },
    {
      kind: "complete",
      receivedAt: "2026-11-10T01:01:00Z",
      result: { success: true, action: "pr-created", changes: { pr: 65 } },
    },
  ];
  const html = renderTaskDetail(entry, { ...state, detailTab: "logs" });
  assert.match(html, /已取消/);
  assert.match(html, /回执记录（2）/);
  assert.match(html, /取消回执/);
  assert.match(html, /完成回执/);
  assert.match(
    html,
    /href="https:\/\/github.com\/owner\/project\/commit\/cccccccccccccccccccccccccccccccccccccccc"/,
  );
  assert.match(html, /href="https:\/\/github.com\/owner\/project\/pull\/65"/);
});

test("ancestor reconciliation stop history escapes its reason, opens the original task, and does not permanently block retry", () => {
  const state = live();
  const entry = state.snapshot.tasks.find(
    (item) => item.status.status === "failed",
  );
  const original = state.snapshot.tasks.find((item) => item !== entry);
  original.task.id = "original-task";
  original.reconciliation = { status: "resolved", reason: "已重新核对" };
  entry.status.status = "cancelled";
  delete entry.reconciliation;
  entry.execution = {
    blockedByReconciliation: {
      taskId: "original-task",
      reason: "收到迟到证据 <img src=x onerror=alert(1)>",
      at: "2026-11-10T01:00:00Z",
    },
  };
  const html = renderTaskDetail(entry, { ...state, detailTab: "logs" });
  assert.match(html, /因原任务核对而停止/);
  assert.match(html, /历史停止记录/);
  assert.match(html, /收到迟到证据 &lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img/);
  assert.match(
    html,
    /data-action="open-task"[^>]*data-id="original-task"[^>]*><span>查看原任务<\/span>/,
  );
  assert.match(html, /2026-11-10T01:00:00Z/);
  assert.doesNotMatch(html, /data-command="retry"[^>]*disabled/);
  assert.equal(
    planBulkAction(state.snapshot, { type: "retry", ids: [entry.task.id] })
      .canExecute,
    true,
  );
  entry.status.status = "running";
  entry.execution.cancelRequested = true;
  assert.match(
    renderTaskDetail(entry, { ...state, detailTab: "trace" }),
    /因原任务核对而请求停止/,
  );
});
