/** Explicit approval evidence and a two-gate state machine for the local demo. */
const copy = (value) => structuredClone(value);
const HUMAN_GATES = [
  {
    id: "code-review",
    title: "代码审阅",
    role: "代码审阅人",
    detail: "确认候选 diff、验证证据与变更范围。",
  },
  {
    id: "execution-auth",
    title: "执行授权",
    role: "执行授权人",
    detail: "确认允许本轮候选方案进入执行队列。",
  },
];
const EDGES = [
  { from: "plan", to: "quality" },
  { from: "plan", to: "safety" },
  { from: "quality", to: "code-review" },
  { from: "safety", to: "code-review" },
  { from: "code-review", to: "execution-auth" },
  { from: "execution-auth", to: "execute" },
];
const automaticNodes = [
  { id: "plan", title: "诊断与方案", kind: "agent" },
  { id: "quality", title: "质量验证", kind: "check" },
  { id: "safety", title: "安全检查", kind: "check" },
];
const validNodeStatuses = new Set([
  "completed",
  "pending",
  "blocked",
  "rejected",
  "queued",
  "cancelled",
  "unknown",
  "running",
  "failed",
  "skipped",
]);
const gatesForRound = () =>
  HUMAN_GATES.map((gate, index) => ({
    ...gate,
    actor: "Qd99",
    status: index === 0 ? "pending" : "blocked",
  }));

/** Called only while constructing explicitly fictional fixture tasks. */
export function createDemoApprovalFlow(entry, at) {
  if (entry?.task?.payload?.context?.demo !== true)
    throw new Error("审批演示只能使用虚构任务");
  const id = entry.task.id;
  const check = (suffix) => {
    const step = entry.trace.find((item) => item.id === `${id}-${suffix}`);
    return {
      status: step?.status === "completed" ? "completed" : "unknown",
      detail: step?.detail || "尚无检查证据",
      at,
    };
  };
  return {
    schemaVersion: 1,
    source: "demo-fixture",
    round: 1,
    status: "pending",
    checks: {
      plan: check("patch"),
      quality: check("validate"),
      safety: check("safety"),
    },
    gates: gatesForRound(),
    history: [
      {
        id: `${id}-approval-1-submitted`,
        round: 1,
        nodeId: "code-review",
        decision: "submitted",
        actor:
          entry.engineId === "fast"
            ? "Direct AI（演示）"
            : "ZCode Workflow（演示）",
        at,
        comment: "提交候选方案；两个人工关卡依次审批。",
      },
    ],
  };
}

/** Read-only graph projection. Missing evidence is unknown, never inferred from configuration. */
export function getApprovalFlow(entry) {
  const candidate = entry?.approvalFlow;
  const flow =
    candidate?.schemaVersion === 1 &&
    Array.isArray(candidate.gates) &&
    Array.isArray(candidate.history)
      ? candidate
      : null;
  const status =
    flow &&
    ["pending", "approved", "rejected", "cancelled"].includes(flow.status)
      ? flow.status
      : "unavailable";
  const nodes = automaticNodes.map((definition) => {
    const evidence = flow?.checks?.[definition.id];
    return {
      ...definition,
      status: validNodeStatuses.has(evidence?.status)
        ? evidence.status
        : "unknown",
      detail: evidence?.detail || "没有提供此节点的执行证据。",
      ...(evidence?.at ? { decidedAt: evidence.at } : {}),
    };
  });
  const checksComplete = nodes.every((node) => node.status === "completed");
  for (const definition of HUMAN_GATES) {
    const gate = flow?.gates.find((item) => item.id === definition.id);
    const rawStatus = gate?.status === "approved" ? "completed" : gate?.status;
    nodes.push({
      ...definition,
      kind: "human",
      status: validNodeStatuses.has(rawStatus) ? rawStatus : "unknown",
      detail: gate?.detail || definition.detail,
      ...(gate?.actor ? { actor: gate.actor } : {}),
      ...(gate?.decidedAt ? { decidedAt: gate.decidedAt } : {}),
      ...(gate?.comment ? { comment: gate.comment } : {}),
    });
  }
  const live = flow?.source === "server";
  const executionStatus = entry?.status?.status;
  const executed =
    live &&
    ["completed", "failed", "running", "cancelled", "skipped"].includes(
      executionStatus,
    ) &&
    (status === "approved" ||
      executionStatus === "cancelled" ||
      entry?.execution?.phase === "execute");
  nodes.push({
    id: "execute",
    title: "执行与归档",
    kind: "execution",
    status: executed
      ? executionStatus
      : status === "cancelled"
        ? "cancelled"
        : status === "approved"
          ? "queued"
          : flow
            ? "blocked"
            : "unknown",
    detail: executed
      ? entry?.execution?.cancelRequested
        ? "取消请求已提交，等待 Agent 确认停止。"
        : entry?.status?.message ||
          {
            completed: "Agent 已回传执行结果，任务已完成。",
            failed: "执行失败，检查任务日志和证据。",
            running: "Agent 正在执行已授权的候选方案。",
            cancelled: "任务已取消，已有证据与决定记录已保留。",
            skipped: "Agent 已回传跳过结果，任务已结束。",
          }[executionStatus]
      : status === "cancelled"
        ? "任务已取消，流程停止；保留既有证据与决定，不执行后续步骤。"
        : status === "approved"
          ? live
            ? "两级授权已完成，等待 Agent 领取执行任务。"
            : "已完成两级授权，等待执行器；未执行或提交真实变更。"
          : "需要两个审批关卡通过后才能进入队列。",
  });
  const pending =
    status === "pending" && checksComplete
      ? nodes.find((node) => node.kind === "human" && node.status === "pending")
      : null;
  const precedingComplete =
    pending &&
    HUMAN_GATES.slice(
      0,
      HUMAN_GATES.findIndex((gate) => gate.id === pending.id),
    ).every(
      (gate) =>
        nodes.find((node) => node.id === gate.id)?.status === "completed",
    );
  const currentGate = precedingComplete ? pending : null;
  return {
    taskId: entry?.task?.id || "",
    round: flow?.round || 0,
    status,
    currentNodeId: currentGate?.id || "",
    nodes,
    edges: copy(EDGES),
    history: copy(flow?.history || []),
    currentGate,
  };
}

function commentFrom(payload, required) {
  if (payload?.comment != null && typeof payload.comment !== "string")
    throw new Error("审批意见必须是文字");
  const comment = (payload?.comment || "").trim();
  if ((required && !comment) || Array.from(comment).length > 500)
    throw new Error(
      required ? "请填写 1–500 字的原因或说明" : "审批意见不能超过 500 字",
    );
  return comment;
}

function appendHistory(entry, flow, decision, nodeId, comment, at) {
  flow.history.push({
    id: `${entry.task.id}-approval-${flow.round}-${flow.history.length + 1}`,
    round: flow.round,
    nodeId,
    decision,
    actor: "Qd99",
    at,
    comment,
  });
}

/** Returns a new task record. The enclosing snapshot still enforces demo-only writes. */
export function applyApprovalAction(entry, { type, payload } = {}, at) {
  if (
    entry?.task?.payload?.context?.demo !== true ||
    entry?.approvalFlow?.source !== "demo-fixture"
  )
    throw new Error("审批模拟仅适用于演示任务");
  const view = getApprovalFlow(entry);
  if (
    payload?.round != null &&
    (!Number.isInteger(Number(payload.round)) ||
      Number(payload.round) !== view.round)
  )
    throw new Error("审批轮次已变化，请刷新后再操作");
  const resubmit = type === "resubmit-approval";
  const rejected = type === "reject-gate" || type === "reject";
  if (
    ![
      "approve",
      "approve-gate",
      "reject",
      "reject-gate",
      "resubmit-approval",
    ].includes(type)
  )
    throw new Error("不支持的审批操作");
  const comment = commentFrom(payload, rejected || resubmit);
  if (resubmit) {
    if (
      view.status !== "rejected" ||
      entry.reviewState !== "rejected" ||
      entry.status.status !== "cancelled"
    )
      throw new Error("只有已拒绝的方案可以重新发起审批");
  } else {
    if (
      view.status !== "pending" ||
      entry.reviewState !== "pending" ||
      entry.status.status !== "pending" ||
      !view.currentGate
    )
      throw new Error("当前没有可处理的审批关卡");
    // Aliases also require a gate ID so an old button cannot approve the next gate.
    const nodeId = payload?.nodeId;
    if (nodeId !== view.currentNodeId)
      throw new Error("审批节点已变化或尚未解锁，请重新选择当前节点");
  }
  const next = copy(entry);
  const flow = next.approvalFlow;
  let message;
  if (resubmit) {
    flow.round += 1;
    flow.status = "pending";
    flow.gates = gatesForRound();
    next.reviewState = "pending";
    next.status.status = "pending";
    delete next.status.completedAt;
    message = `已重新发起「${next.title}」第 ${flow.round} 轮审批；沿用原候选方案和检查证据（演示）`;
    appendHistory(next, flow, "resubmitted", "code-review", comment, at);
  } else {
    const index = flow.gates.findIndex(
      (gate) => gate.id === view.currentNodeId,
    );
    const gate = flow.gates[index];
    gate.status = rejected ? "rejected" : "approved";
    gate.decidedAt = at;
    gate.comment = comment;
    appendHistory(
      next,
      flow,
      rejected ? "rejected" : "approved",
      gate.id,
      comment,
      at,
    );
    if (rejected) {
      flow.status = "rejected";
      flow.gates.slice(index + 1).forEach((later) => {
        later.status = "blocked";
      });
      next.reviewState = "rejected";
      next.status.status = "cancelled";
      next.status.completedAt = at;
      message = `已拒绝「${next.title}」的${gate.title}，后续执行已阻塞（演示）`;
    } else if (index + 1 < flow.gates.length) {
      flow.gates[index + 1].status = "pending";
      message = `「${next.title}」代码审阅已通过，等待执行授权（演示）`;
    } else {
      flow.status = "approved";
      next.reviewState = "approved";
      message = `「${next.title}」两级审批已通过，等待执行器；未提交真实变更`;
    }
  }
  next.status.message = message;
  const reviewStep = next.trace?.find(
    (step) => step.id === `${next.task.id}-finish`,
  );
  if (reviewStep) {
    reviewStep.title =
      flow.status === "approved"
        ? "两级审批通过"
        : flow.status === "rejected"
          ? "人工拒绝方案"
          : "等待人工审批";
    reviewStep.status = flow.status === "approved" ? "completed" : "pending";
    reviewStep.detail = message;
  }
  if (flow.status === "approved")
    next.trace.push({
      id: `${next.task.id}-approved-queue-${flow.round}`,
      title: "等待执行器",
      kind: "agent",
      status: "pending",
      detail: "全部操作仅在演示内存中完成；未执行真实修复。",
    });
  if (next.result?.logs)
    next.result.logs.push(
      `[${at}] [DEMO] ${message}${comment ? `；意见：${comment}` : ""}`,
    );
  return { entry: next, message };
}

export function cancelApprovalFlow(entry, at) {
  if (!entry.approvalFlow) return undefined;
  const flow = copy(entry.approvalFlow);
  const nodeId = getApprovalFlow(entry).currentNodeId || "execute";
  flow.status = "cancelled";
  flow.gates.forEach((gate) => {
    if (gate.status === "pending") gate.status = "blocked";
  });
  appendHistory(entry, flow, "cancelled", nodeId, "任务被取消，审批停止。", at);
  return flow;
}
