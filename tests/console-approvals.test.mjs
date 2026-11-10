import test from "node:test";
import assert from "node:assert/strict";
import {
  createDemoSnapshot,
  applyDemoAction,
} from "../apps/console/public/data.js";
import { getApprovalFlow } from "../apps/console/public/approvals.js";
import {
  renderApprovalPage,
  renderFlowCanvas,
} from "../apps/console/public/approval-views.js";

const NOW = Date.parse("2026-11-09T10:00:00.000Z");
const firstReview = (snapshot) =>
  snapshot.tasks.find((entry) => entry.reviewState === "pending");
const find = (snapshot, id) =>
  snapshot.tasks.find((entry) => entry.task.id === id);

test("a skipped live execution remains terminal in the approval graph", () => {
  const entry = firstReview(createDemoSnapshot(NOW));
  entry.approvalFlow.source = "server";
  entry.approvalFlow.status = "approved";
  entry.approvalFlow.gates.forEach((gate) => {
    gate.status = "approved";
  });
  entry.status.status = "skipped";
  entry.status.message = "Agent 已确认无需执行变更。";
  entry.execution = { phase: "done", cancelRequested: false };
  const execution = getApprovalFlow(entry).nodes.find(
    (node) => node.id === "execute",
  );
  assert.equal(execution.status, "skipped");
  assert.equal(execution.detail, "Agent 已确认无需执行变更。");
  const html = renderFlowCanvas(entry, { mode: "live" });
  assert.match(html, /aria-label="执行与归档，已跳过"/);
  assert.doesNotMatch(html, /aria-label="执行与归档，等待执行器"/);
  delete entry.status.message;
  assert.match(
    getApprovalFlow(entry).nodes.find((node) => node.id === "execute").detail,
    /跳过/,
  );
});

test("approved live requests describe their actual execution state", () => {
  for (const [status, expected] of [
    ["pending", "已授权，等待执行器"],
    ["running", "已授权，执行中"],
    ["completed", "已授权，已完成"],
    ["failed", "已授权，执行失败"],
    ["skipped", "已授权，已跳过"],
    ["cancelled", "已取消，流程停止"],
  ]) {
    const snapshot = createDemoSnapshot(NOW);
    const entry = firstReview(snapshot);
    snapshot.tasks = [entry];
    snapshot.mode = "live";
    entry.approvalFlow.source = "server";
    entry.approvalFlow.status =
      status === "cancelled" ? "cancelled" : "approved";
    entry.approvalFlow.gates.forEach((gate) => {
      gate.status = "approved";
    });
    entry.status.status = status;
    entry.execution = {
      phase: ["pending", "running"].includes(status) ? "execute" : "done",
    };
    const html = renderApprovalPage({
      mode: "live",
      snapshot,
      approvalFilter: "all",
    });
    const subtitle = html
      .match(/<span class="af-request-stage">([\s\S]*?)<\/span>/)?.[1]
      .replace(/<[^>]+>/g, "");
    assert.equal(subtitle, expected, status);
    assert.doesNotMatch(html, /等待执行器处理/, status);
  }
});

test("an action proposal without a diff displays its submitted plan and evidence access", () => {
  const snapshot = createDemoSnapshot(NOW);
  const entry = firstReview(snapshot);
  snapshot.tasks = [entry];
  snapshot.mode = "live";
  entry.approvalFlow.source = "server";
  entry.diff = [];
  entry.proposal = {
    kind: "action",
    id: "action-proposal",
    summary: "为失败的诊断创建 Issue",
    submittedAt: new Date(NOW).toISOString(),
    contentHash: "f".repeat(64),
  };
  const state = { mode: "live", snapshot, approvalTab: "diff" };
  const html = renderApprovalPage(state);
  assert.match(html, /此方案不修改代码/);
  assert.match(html, /为失败的诊断创建 Issue/);
  assert.match(html, /data-action="open-task"[^>]*data-tab="evidence"/);
  assert.doesNotMatch(html, /尚无候选变更|Agent 提交变更后/);
  delete entry.proposal;
  assert.match(renderApprovalPage(state), /尚无候选变更/);
});

test("approving the first human gate leaves the task waiting for execution authorization", () => {
  const original = createDemoSnapshot(NOW);
  const target = firstReview(original);
  const next = applyDemoAction(
    original,
    {
      type: "approve",
      id: target.task.id,
      payload: { nodeId: "code-review", comment: "已查看变更", round: 1 },
    },
    NOW + 1000,
  );
  assert.equal(find(next, target.task.id).reviewState, "pending");
  assert.equal(find(next, target.task.id).status.status, "pending");
  assert.equal(find(original, target.task.id).reviewState, "pending");
  assert.equal(
    getApprovalFlow(find(next, target.task.id)).currentNodeId,
    "execution-auth",
  );
  assert.equal(getApprovalFlow(target).currentNodeId, "code-review");
});

test("two serial approvals unlock only the simulated execution queue and preserve validation evidence", () => {
  const original = createDemoSnapshot(NOW);
  const target = firstReview(original);
  const first = applyDemoAction(
    original,
    {
      type: "approve-gate",
      id: target.task.id,
      payload: { nodeId: "code-review", round: 1 },
    },
    NOW + 1000,
  );
  const final = applyDemoAction(
    first,
    {
      type: "approve-gate",
      id: target.task.id,
      payload: { nodeId: "execution-auth", comment: "同意进入队列", round: 1 },
    },
    NOW + 2000,
  );
  const item = find(final, target.task.id);
  const flow = getApprovalFlow(item);
  assert.equal(flow.status, "approved");
  assert.equal(flow.currentGate, null);
  assert.equal(item.reviewState, "approved");
  assert.equal(item.status.status, "pending");
  assert.equal(item.result.changes.applied, false);
  assert.equal(item.result.action, "skipped");
  assert.deepEqual(item.result.evidence, target.result.evidence);
  assert.equal(
    flow.nodes.find((node) => node.id === "execute").status,
    "queued",
  );
  assert.deepEqual(
    flow.history
      .filter((item) => item.decision === "approved")
      .map((item) => item.nodeId),
    ["code-review", "execution-auth"],
  );
  assert.equal(final.activity.length, original.activity.length + 2);
});

test("blocked, repeated and stale-round decisions cannot skip an approval gate", () => {
  const original = createDemoSnapshot(NOW);
  const id = firstReview(original).task.id;
  for (const type of ["approve", "reject"]) {
    assert.throws(
      () =>
        applyDemoAction(original, {
          type,
          id,
          payload: { comment: "缺少节点" },
        }),
      /节点/,
    );
  }
  assert.throws(
    () =>
      applyDemoAction(original, {
        type: "approve-gate",
        id,
        payload: { nodeId: "execution-auth" },
      }),
    /节点/,
  );
  assert.throws(
    () => applyDemoAction(original, { type: "approve-gate", id, payload: {} }),
    /节点/,
  );
  assert.throws(
    () =>
      applyDemoAction(original, {
        type: "approve-gate",
        id,
        payload: { nodeId: "code-review", round: 0 },
      }),
    /轮次/,
  );
  const next = applyDemoAction(
    original,
    { type: "approve-gate", id, payload: { nodeId: "code-review" } },
    NOW + 1000,
  );
  for (const type of ["approve-gate", "reject-gate", "approve", "reject"]) {
    assert.throws(
      () =>
        applyDemoAction(next, {
          type,
          id,
          payload: { nodeId: "code-review", comment: "旧表单" },
        }),
      /节点/,
    );
  }
  assert.equal(getApprovalFlow(find(next, id)).currentNodeId, "execution-auth");
});

test("rejecting the first gate stops downstream execution and records a required reason", () => {
  const original = createDemoSnapshot(NOW);
  const id = firstReview(original).task.id;
  const rejected = applyDemoAction(
    original,
    {
      type: "reject-gate",
      id,
      payload: { nodeId: "code-review", comment: "需要补充边界用例" },
    },
    NOW + 1000,
  );
  const item = find(rejected, id);
  const flow = getApprovalFlow(item);
  assert.equal(item.status.status, "cancelled");
  assert.equal(item.reviewState, "rejected");
  assert.equal(flow.status, "rejected");
  assert.equal(flow.currentGate, null);
  assert.equal(
    flow.nodes.find((node) => node.id === "code-review").status,
    "rejected",
  );
  assert.equal(
    flow.nodes.find((node) => node.id === "execution-auth").status,
    "blocked",
  );
  assert.equal(
    flow.nodes.find((node) => node.id === "execute").status,
    "blocked",
  );
  assert.equal(flow.history.at(-1).comment, "需要补充边界用例");
  assert.equal(flow.history.at(-1).at, "2026-11-09T10:00:01.000Z");
  assert.equal(flow.history.at(-1).actor, "Qd99");
  assert.equal(rejected.activity[0].level, "warning");
});

test("rejecting execution authorization keeps the earlier code review decision", () => {
  let snapshot = createDemoSnapshot(NOW);
  const id = firstReview(snapshot).task.id;
  snapshot = applyDemoAction(
    snapshot,
    { type: "approve-gate", id, payload: { nodeId: "code-review" } },
    NOW + 1000,
  );
  snapshot = applyDemoAction(
    snapshot,
    {
      type: "reject-gate",
      id,
      payload: { nodeId: "execution-auth", comment: "暂不允许执行" },
    },
    NOW + 2000,
  );
  const flow = getApprovalFlow(find(snapshot, id));
  assert.equal(
    flow.nodes.find((node) => node.id === "code-review").status,
    "completed",
  );
  assert.equal(
    flow.nodes.find((node) => node.id === "execution-auth").status,
    "rejected",
  );
  assert.equal(
    flow.nodes.find((node) => node.id === "execute").status,
    "blocked",
  );
  assert.equal(
    flow.history.filter((item) => item.decision === "approved").length,
    1,
  );
});

test("resubmitting starts a fresh round and retains all earlier decisions", () => {
  let snapshot = createDemoSnapshot(NOW);
  const original = firstReview(snapshot);
  const id = original.task.id;
  snapshot = applyDemoAction(
    snapshot,
    {
      type: "reject-gate",
      id,
      payload: { nodeId: "code-review", comment: "说明不足" },
    },
    NOW + 1000,
  );
  const previousHistory = getApprovalFlow(find(snapshot, id)).history;
  const next = applyDemoAction(
    snapshot,
    {
      type: "resubmit-approval",
      id,
      payload: { comment: "已补充说明，请重新审阅", round: "1" },
    },
    NOW + 2000,
  );
  const item = find(next, id);
  const flow = getApprovalFlow(item);
  assert.equal(flow.round, 2);
  assert.equal(flow.currentNodeId, "code-review");
  assert.equal(flow.status, "pending");
  assert.equal(item.status.status, "pending");
  assert.equal(item.status.completedAt, undefined);
  assert.equal(item.reviewState, "pending");
  assert.deepEqual(
    flow.history.slice(0, previousHistory.length),
    previousHistory,
  );
  assert.equal(flow.history.at(-1).decision, "resubmitted");
  assert.equal(flow.history.at(-1).round, 2);
  assert.deepEqual(item.result.evidence, original.result.evidence);
  assert.throws(
    () =>
      applyDemoAction(next, {
        type: "approve-gate",
        id,
        payload: { nodeId: "code-review", round: 1 },
      }),
    /轮次/,
  );
});

test("decision comments validate empty, malformed and overlong inputs without changing the snapshot", () => {
  const snapshot = createDemoSnapshot(NOW);
  const id = firstReview(snapshot).task.id;
  const before = JSON.stringify(snapshot);
  for (const comment of [undefined, "  ", 3, {}, "原".repeat(501)]) {
    assert.throws(() =>
      applyDemoAction(snapshot, {
        type: "reject-gate",
        id,
        payload: { nodeId: "code-review", comment },
      }),
    );
  }
  assert.throws(() =>
    applyDemoAction(snapshot, {
      type: "approve-gate",
      id,
      payload: { nodeId: "code-review", comment: "a".repeat(501) },
    }),
  );
  assert.throws(() =>
    applyDemoAction(snapshot, {
      type: "resubmit-approval",
      id,
      payload: { comment: "重新审批" },
    }),
  );
  assert.equal(JSON.stringify(snapshot), before);
});

test("new approval commands are rejected in live mode even when demo-looking tasks are supplied", () => {
  const snapshot = { ...createDemoSnapshot(NOW), mode: "live" };
  const id = firstReview(snapshot).task.id;
  for (const type of ["approve-gate", "reject-gate", "resubmit-approval"]) {
    assert.throws(
      () =>
        applyDemoAction(snapshot, {
          type,
          id,
          payload: { nodeId: "code-review", comment: "说明" },
        }),
      /演示|demo/,
    );
  }
});

test("missing real approval evidence is projected as unknown rather than inferred success", () => {
  const item = structuredClone(firstReview(createDemoSnapshot(NOW)));
  delete item.approvalFlow;
  item.task.payload.context.demo = false;
  const flow = getApprovalFlow(item);
  assert.equal(flow.status, "unavailable");
  assert.equal(flow.currentGate, null);
  assert.equal(flow.currentNodeId, "");
  assert.ok(flow.nodes.every((node) => node.status === "unknown"));
  assert.deepEqual(flow.history, []);
});

test("missing automatic validation evidence blocks decisions even when the human gate is pending", () => {
  const snapshot = createDemoSnapshot(NOW);
  const target = firstReview(snapshot);
  delete target.approvalFlow.checks.quality;
  const flow = getApprovalFlow(target);
  assert.equal(flow.currentGate, null);
  assert.equal(
    flow.nodes.find((node) => node.id === "quality").status,
    "unknown",
  );
  assert.throws(
    () =>
      applyDemoAction(snapshot, {
        type: "approve-gate",
        id: target.task.id,
        payload: { nodeId: "code-review" },
      }),
    /没有可处理/,
  );
});

test("cancelling an approval task freezes its gates and preserves the cancellation record", () => {
  const snapshot = createDemoSnapshot(NOW);
  const target = firstReview(snapshot);
  const cancelled = applyDemoAction(
    snapshot,
    { type: "cancel", id: target.task.id },
    NOW + 1000,
  );
  const item = find(cancelled, target.task.id);
  const flow = getApprovalFlow(item);
  assert.equal(item.status.status, "cancelled");
  assert.equal(flow.status, "cancelled");
  assert.equal(flow.currentGate, null);
  assert.equal(flow.currentNodeId, "");
  assert.equal(
    flow.nodes.find((node) => node.id === "execute").status,
    "cancelled",
  );
  assert.equal(
    flow.nodes.find((node) => node.id === "code-review").status,
    "blocked",
  );
  assert.equal(flow.history.at(-1).decision, "cancelled");
  assert.throws(() =>
    applyDemoAction(cancelled, {
      type: "approve-gate",
      id: target.task.id,
      payload: { nodeId: "code-review" },
    }),
  );
});

test("cancelling an authorized task retains its completed gates and evidence while stopping execution", () => {
  let snapshot = createDemoSnapshot(NOW);
  const id = firstReview(snapshot).task.id;
  for (const nodeId of ["code-review", "execution-auth"])
    snapshot = applyDemoAction(
      snapshot,
      { type: "approve-gate", id, payload: { nodeId, round: 1 } },
      NOW + 1000,
    );
  const before = find(snapshot, id);
  const history = getApprovalFlow(before).history;
  const cancelled = applyDemoAction(
    snapshot,
    { type: "cancel", id },
    NOW + 2000,
  );
  const item = find(cancelled, id);
  const flow = getApprovalFlow(item);
  assert.equal(flow.status, "cancelled");
  assert.equal(flow.currentGate, null);
  assert.equal(flow.currentNodeId, "");
  assert.deepEqual(flow.history.slice(0, -1), history);
  assert.equal(flow.history.at(-1).decision, "cancelled");
  assert.equal(flow.history.at(-1).nodeId, "execute");
  assert.deepEqual(item.approvalFlow.checks, before.approvalFlow.checks);
  assert.deepEqual(item.result.evidence, before.result.evidence);
  assert.deepEqual(
    flow.nodes
      .filter((node) => node.kind === "human")
      .map((node) => node.status),
    ["completed", "completed"],
  );
  assert.equal(
    flow.nodes.find((node) => node.id === "execute").status,
    "cancelled",
  );
  for (const type of ["approve-gate", "reject-gate", "resubmit-approval"])
    assert.throws(() =>
      applyDemoAction(cancelled, {
        type,
        id,
        payload: { nodeId: "execution-auth", round: 1, comment: "旧审批操作" },
      }),
    );
  assert.equal(getApprovalFlow(before).status, "approved");
});

test("graph projections and approval updates never mutate their input or expose writable fixture references", () => {
  const snapshot = createDemoSnapshot(NOW);
  const target = firstReview(snapshot);
  const before = JSON.stringify(snapshot);
  const graph = getApprovalFlow(target);
  graph.history[0].comment = "edited";
  graph.edges[0].to = "execute";
  graph.nodes[0].title = "edited";
  const next = applyDemoAction(
    snapshot,
    {
      type: "approve-gate",
      id: target.task.id,
      payload: { nodeId: "code-review" },
    },
    NOW + 1000,
  );
  assert.equal(JSON.stringify(snapshot), before);
  assert.notEqual(next, snapshot);
  assert.equal(getApprovalFlow(target).currentNodeId, "code-review");
  assert.equal(
    getApprovalFlow(find(next, target.task.id)).currentNodeId,
    "execution-auth",
  );
});
