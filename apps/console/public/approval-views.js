import { icon } from "./icons.js";
import { escapeHtml as e } from "./model.js";
import { getApprovalFlow } from "./approvals.js";
import { uiButton, uiEmpty, uiStatus } from "./ui.js";

const nodeIcons = {
  plan: "ScanSearch",
  quality: "FlaskConical",
  safety: "ShieldCheck",
  "code-review": "UserRoundCheck",
  "execution-auth": "GitPullRequestArrow",
  execute: "GitMerge",
};
const nodeTones = {
  plan: "blue",
  quality: "violet",
  safety: "teal",
  "code-review": "amber",
  "execution-auth": "violet",
  execute: "slate",
};
const nodeNames = {
  plan: "诊断与方案",
  quality: "质量检查",
  safety: "安全检查",
  "code-review": "代码审阅",
  "execution-auth": "执行授权",
  execute: "执行与归档",
};
const statusNames = {
  running: "执行中",
  failed: "执行失败",
  completed: "已完成",
  pending: "待审批",
  blocked: "等待前序",
  rejected: "已拒绝",
  queued: "等待执行器",
  unknown: "暂无证据",
  approved: "已授权",
  unavailable: "未接入",
  cancelled: "已取消",
  skipped: "已跳过",
};
const statusIcons = {
  running: "Play",
  failed: "CircleAlert",
  completed: "Check",
  pending: "Clock3",
  blocked: "LockKeyhole",
  rejected: "X",
  queued: "Clock3",
  unknown: "CircleAlert",
  approved: "CheckCheck",
  unavailable: "CircleAlert",
  cancelled: "Ban",
  skipped: "ArrowRight",
};
const positions = {
  plan: [23, 106],
  quality: [207, 30],
  safety: [207, 182],
  "code-review": [391, 106],
  "execution-auth": [575, 106],
  execute: [759, 106],
};
const safeStatus = (value) =>
  Object.hasOwn(statusNames, value) ? value : "unknown";
const action = (name, attributes = "") => `data-action="${name}" ${attributes}`;
const taskAction = (name, id, extra = "") =>
  action(name, `data-id="${e(id)}" ${extra}`);
const timeOf = (value) => {
  const d = new Date(value);
  return Number.isFinite(d.getTime())
    ? new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(d)
    : "—";
};
const stateBadge = (status, text) => {
  const value = safeStatus(status);
  return uiStatus({
    label: text || statusNames[value],
    tone: ["completed", "approved"].includes(value)
      ? "success"
      : ["rejected", "failed"].includes(value)
        ? "error"
        : value === "pending"
          ? "warning"
          : ["queued", "running"].includes(value)
            ? "info"
            : "neutral",
    icon: statusIcons[value],
    className: `af-state af-state-${value}`,
  });
};
const initials = (name) =>
  String(name || "—")
    .slice(0, 1)
    .toUpperCase();
const nodeIcon = (node, size = 20) =>
  icon(nodeIcons[node.id] || "Workflow", size);
const filesOf = (entry) => (Array.isArray(entry.diff) ? entry.diff : []);
const approvalEntries = (state) =>
  (state.snapshot?.tasks || []).filter(
    (entry) => entry.approvalFlow || entry.reviewState,
  );

function edgePath(from, to) {
  const a = positions[from],
    b = positions[to];
  if (!a || !b) return "";
  const x1 = a[0] + 144,
    y1 = a[1] + 50;
  const x2 = b[0],
    y2 = b[1] + 50;
  const middle = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${middle} ${y1}, ${middle} ${y2}, ${x2} ${y2}`;
}

/** A deterministic, accessible graph of the same approval state used by the forms. */
export function renderFlowCanvas(entry, options = {}) {
  const flow = getApprovalFlow(entry);
  if (flow.status === "unavailable")
    return uiEmpty({
      icon: "Workflow",
      title: "还没有审批流程",
      description: "收到审批请求后，这里会显示节点、检查证据与每次决定。",
      className: "af-empty-flow",
    });
  const compact = Boolean(options.compact);
  const zoom = Number.isFinite(options.zoom)
    ? Math.max(0.75, Math.min(1.25, options.zoom))
    : 1;
  const selected =
    options.selectedNodeId ||
    flow.currentNodeId ||
    flow.nodes.find((n) => n.status === "rejected")?.id ||
    "execute";
  const uid = `af-${String(entry.task.id).replace(/[^a-zA-Z0-9_-]/g, "")}-${compact ? "compact" : "full"}`;
  const availableNodes = flow.nodes.filter((node) =>
    Object.hasOwn(positions, node.id),
  );
  const byId = Object.fromEntries(
    availableNodes.map((node) => [node.id, node]),
  );
  const paths = flow.edges
    .filter((edge) => byId[edge.from] && byId[edge.to])
    .map((edge) => {
      const from = byId[edge.from],
        to = byId[edge.to];
      const done = from.status === "completed" && to.status === "completed";
      const current =
        from.status === "completed" && to.id === flow.currentNodeId;
      return `<path class="af-edge ${done ? "is-done" : ""} ${current ? "to-current" : ""}" d="${edgePath(edge.from, edge.to)}" marker-end="url(#${uid}-arrow)"></path>`;
    })
    .join("");
  return `<section class="af-flow ${compact ? "af-flow-compact" : ""}" aria-label="${e(entry.title)}的审批流程">
    ${compact ? "" : `<div class="af-canvas-toolbar"><span>${icon("Workflow", 15)}<strong>流程画布</strong><span class="af-toolbar-hint">点击节点查看详情</span></span><div class="af-zoom" role="group" aria-label="流程缩放"><button type="button" class="ui-icon-button" ${action("flow-zoom", 'data-direction="out"')} aria-label="缩小审批流程" ${zoom <= 0.75 ? "disabled" : ""}>${icon("ZoomOut", 15)}</button><span>${zoom === 1 ? "适应" : `${Math.round(zoom * 100)}%`}</span><button type="button" class="ui-icon-button" ${action("flow-zoom", 'data-direction="in"')} aria-label="放大审批流程" ${zoom >= 1.25 ? "disabled" : ""}>${icon("ZoomIn", 15)}</button><button type="button" class="ui-icon-button" ${action("flow-zoom", 'data-direction="reset"')} aria-label="适应画布">${icon("Maximize2", 14)}</button></div></div>`}
    <div class="af-canvas-scroll" tabindex="0" aria-label="审批流程画布，可横向滚动">
      <div class="af-canvas-space" style="--af-zoom:${compact ? 0.82 : zoom}"><div class="af-canvas">
        <svg class="af-connections" viewBox="0 0 930 320" width="930" height="320" aria-hidden="true"><defs><marker id="${uid}-arrow" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto" markerUnits="strokeWidth"><path d="M0 0 L4 2.5 L0 5" fill="none" stroke="context-stroke" stroke-width="1"></path></marker></defs>${paths}</svg>
        <span class="af-branch-caption" aria-hidden="true">并行检查</span>
        ${availableNodes
          .map((node) => {
            const [x, y] = positions[node.id];
            const status = safeStatus(node.status);
            const current = node.id === flow.currentNodeId;
            return `<button type="button" class="af-node af-node-${nodeTones[node.id]} af-node-${status} ${current ? "is-current" : ""} ${selected === node.id ? "is-selected" : ""}" style="left:${x}px;top:${y}px" ${taskAction("flow-node", entry.task.id, `data-node-id="${e(node.id)}"`)} aria-pressed="${selected === node.id}" aria-label="${e(node.title)}，${statusNames[status]}"><span class="af-node-top"><span class="af-node-icon">${nodeIcon(node)}</span><span class="af-node-indicator">${icon(statusIcons[status], 11)}</span></span><strong>${e(node.title)}</strong><span class="af-node-caption">${current ? "等待你处理" : node.kind === "human" ? e(node.actor || "审批人") : node.id === "plan" ? "Agent 生成候选方案" : statusNames[status]}</span>${current ? '<span class="af-current-label">当前节点</span>' : ""}</button>`;
          })
          .join("")}
      </div></div>
    </div>
    <div class="af-flow-foot"><div class="af-legend"><span><i class="done"></i>已完成</span><span><i class="waiting"></i>待审批</span><span><i class="blocked"></i>等待前序</span></div><span>${options.mode === "demo" ? "演示流程" : "服务端流程"} · 第 ${e(flow.round)} 轮</span></div>
  </section>`;
}

function renderRequest(entry, selected) {
  const flow = getApprovalFlow(entry);
  const status = safeStatus(flow.status);
  const pending = flow.status === "pending";
  const executionStatus = flow.nodes.find(
    (node) => node.id === "execute",
  )?.status;
  const current =
    flow.currentGate?.title ||
    (flow.status === "approved"
      ? `已授权，${statusNames[safeStatus(executionStatus)]}`
      : flow.status === "rejected"
        ? "等待重新发起审批"
        : flow.status === "cancelled"
          ? "已取消，流程停止"
          : "流程信息未接入");
  return `<button type="button" class="af-request ${selected ? "is-selected" : ""}" ${taskAction("select-approval", entry.task.id)} aria-pressed="${selected}"><span class="af-request-top"><span class="af-request-symbol ${pending ? "amber" : status === "approved" ? "teal" : status === "rejected" ? "red" : "slate"}">${icon(pending ? "GitPullRequestArrow" : status === "approved" ? "CheckCheck" : status === "rejected" ? "X" : "Workflow", 17)}</span><span class="mono">${e(entry.task.id)}</span>${pending ? '<i class="af-request-dot" aria-label="待审批"></i>' : ""}</span><strong>${e(entry.title)}</strong><span class="af-request-stage">${icon(pending ? "UserRoundCheck" : statusIcons[status], 12)}${e(current)}</span><span class="af-request-footer"><span>${filesOf(entry).length} 个文件</span><span>第 ${e(flow.round)} 轮</span></span></button>`;
}

function renderHistory(flow) {
  const decisions = {
    submitted: "发起审批",
    approved: "通过审批",
    rejected: "拒绝方案",
    resubmitted: "重新提交",
    cancelled: "取消任务",
  };
  const history = [...(flow.history || [])].sort(
    (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
  );
  if (!history.length)
    return uiEmpty({
      icon: "History",
      title: "还没有审批记录",
      description: "每次提交与决定都会保留在这里。",
      className: "af-empty",
    });
  return `<div class="af-history"><div class="af-history-heading"><span>${icon("History", 16)}审批记录</span><span>${history.length} 条 · 北京时间</span></div>${history
    .map((item) => {
      const decision = Object.hasOwn(decisions, item.decision)
        ? item.decision
        : "submitted";
      return `<article class="af-history-row"><span class="af-history-symbol ${decision === "rejected" || decision === "cancelled" ? "is-negative" : decision === "approved" ? "is-positive" : ""}">${icon(decision === "approved" ? "Check" : decision === "rejected" ? "X" : decision === "resubmitted" ? "RotateCcw" : "Send", 13)}</span><div><div class="af-history-title"><strong>${e(item.actor || "系统")}</strong><span>${decisions[decision]}</span><span class="af-round">第 ${e(item.round)} 轮</span></div><p>${e(nodeNames[item.nodeId] || "审批流程")}${item.comment ? ` · ${e(item.comment)}` : ""}</p></div><time datetime="${e(item.at || "")}">${timeOf(item.at)}</time></article>`;
    })
    .join("")}</div>`;
}

function renderChanges(entry) {
  const files = filesOf(entry);
  if (!files.length && entry.proposal?.kind === "action")
    return uiEmpty({
      icon: "ListChecks",
      title: "此方案不修改代码",
      description: entry.proposal.summary,
      className: "af-empty",
      action: uiButton({
        label: "查看验证证据",
        icon: "FlaskConical",
        action: "open-task",
        attrs: `data-id="${e(entry.task.id)}" data-tab="evidence"`,
        variant: "ghost",
      }),
    });
  if (!files.length)
    return uiEmpty({
      icon: "FileDiff",
      title: "尚无候选变更",
      description: "Agent 提交变更后可以在这里逐项审阅。",
      className: "af-empty",
    });
  return `<div class="af-changes"><div class="af-changes-heading"><span>${icon("FileDiff", 16)}候选变更</span><button type="button" class="ui-button ui-button-ghost af-text-button" ${taskAction("open-task", entry.task.id, 'data-tab="evidence"')}>${icon("FlaskConical", 14)}查看验证证据${icon("ArrowRight", 13)}</button></div>${files.map((file) => `<section class="af-diff-file"><header>${icon("Code2", 15)}<span>${e(file.path)}</span><span class="af-diff-count"><b>+${e(file.additions ?? 0)}</b><i>−${e(file.deletions ?? 0)}</i></span></header><div class="af-diff-scroll">${(file.lines || []).map((line, index) => `<div class="af-diff-line ${line.type === "add" ? "is-add" : line.type === "remove" ? "is-remove" : ""}"><span class="af-diff-number">${index + 1}</span><span class="af-diff-prefix" aria-label="${line.type === "add" ? "新增" : line.type === "remove" ? "删除" : "上下文"}">${line.type === "add" ? "+" : line.type === "remove" ? "−" : " "}</span><code>${e(line.content)}</code></div>`).join("")}</div></section>`).join("")}<p class="af-small-print">行号为展示片段行号，执行前请结合完整仓库上下文确认。</p></div>`;
}

function renderNodeInspector(entry, flow, state) {
  const selected =
    flow.nodes.find((node) => node.id === state.approvalNodeId) ||
    flow.nodes.find((node) => node.id === flow.currentNodeId) ||
    flow.nodes.find((node) => node.status === "rejected") ||
    flow.nodes.find((node) => node.id === "execute");
  if (!selected) return "";
  const current =
    selected.id === flow.currentNodeId &&
    selected.kind === "human" &&
    selected.status === "pending";
  const canDecide =
    current &&
    state.snapshot?.capabilities?.approve &&
    !state.pendingAction &&
    !state.authRequired;
  const canResubmit =
    flow.status === "rejected" &&
    !state.pendingAction &&
    !state.authRequired &&
    state.snapshot?.capabilities?.approve;
  const terminal = flow.status === "approved";
  const cancelled = flow.status === "cancelled";
  return `<section class="af-inspector"><div class="af-inspector-main"><div class="af-inspector-heading"><span class="af-inspector-icon af-tone-${nodeTones[selected.id] || "blue"}">${nodeIcon(selected, 22)}</span><div><p>节点详情</p><h3>${e(selected.title)}</h3></div>${stateBadge(selected.status)}</div><p class="af-node-description">${e(selected.detail || "等待服务端提供节点信息。")}</p><div class="af-facts"><div><span>${icon("UserRoundCheck", 13)}负责人</span><strong>${e(selected.actor || (selected.kind === "human" ? "未指定" : "自动检查"))}</strong></div><div><span>${icon("Clock3", 13)}处理时间</span><strong>${selected.decidedAt ? timeOf(selected.decidedAt) : current ? "等待决定" : "—"}</strong></div><div><span>${icon("FileDiff", 13)}变更范围</span><strong>${filesOf(entry).length} 个文件</strong></div></div>${selected.comment ? `<div class="af-decided-comment">${icon("MessageSquare", 14)}<p>${e(selected.comment)}</p></div>` : ""}<div class="af-evidence-links"><button type="button" class="ui-button ui-button-ghost" ${taskAction("open-task", entry.task.id, 'data-tab="diff"')}>${icon("FileDiff", 14)}代码变更${icon("ArrowRight", 12)}</button><button type="button" class="ui-button ui-button-ghost" ${taskAction("open-task", entry.task.id, 'data-tab="evidence"')}>${icon("ShieldCheck", 14)}验证证据${icon("ArrowRight", 12)}</button></div></div><div class="af-decision-panel">
    ${current ? `<form id="approval-decision-form" data-task-id="${e(entry.task.id)}" data-node-id="${e(selected.id)}" data-round="${e(flow.round)}"><input type="hidden" name="round" value="${e(flow.round)}"><div class="af-decision-heading"><span class="af-avatar">${e(initials(selected.actor))}</span><div><strong>需要你的决定</strong><span>${e(selected.actor || "审批人")} · ${e(selected.title)}</span></div><span class="af-gate-number">${selected.id === "code-review" ? "1" : "2"} / 2</span></div><label for="approval-comment">审批意见 <span>通过可选，拒绝必填</span></label><textarea class="ui-textarea" id="approval-comment" name="comment" maxlength="500" rows="3" placeholder="补充审阅意见或需要修改的内容…" ${canDecide ? "" : "disabled"}>${e(state.approvalComment || "")}</textarea>${state.approvalError ? `<p class="af-form-error" role="alert">${icon("CircleAlert", 13)}${e(state.approvalError)}</p>` : ""}<div class="af-decision-actions"><button type="submit" name="decision" value="reject-gate" class="ui-button ui-button-danger af-button af-button-reject" ${canDecide ? "" : "disabled"}>${icon("X", 15)}拒绝方案</button><button type="submit" name="decision" value="approve-gate" class="ui-button ui-button-primary af-button af-button-primary" ${canDecide ? "" : "disabled"}>${icon("Check", 16)}${selected.id === "code-review" ? "通过，进入下一关" : "确认执行授权"}</button></div><p class="af-decision-note">${icon("LockKeyhole", 12)}${state.mode === "demo" ? (selected.id === "code-review" ? "此关通过后，仍需完成执行授权。" : "仅演示授权，不会启动真实修复。") : "决定由管理服务记录；执行授权通过后，Agent 才能领取执行任务。"}</p></form>` : canResubmit ? `<form id="approval-resubmit-form" data-task-id="${e(entry.task.id)}" data-round="${e(flow.round)}"><input type="hidden" name="round" value="${e(flow.round)}"><div class="af-resolved-heading"><span class="af-resolved-icon is-rejected">${icon("RotateCcw", 24)}</span><div><h3>重新发起审批</h3><p>保留本轮记录，重新开始两级审批。</p></div></div><label for="resubmit-comment">重新提交说明</label><textarea class="ui-textarea" id="resubmit-comment" name="comment" maxlength="500" rows="3" required placeholder="说明重新提交的原因…">${e(state.approvalComment || "")}</textarea>${state.approvalError ? `<p class="af-form-error" role="alert">${icon("CircleAlert", 13)}${e(state.approvalError)}</p>` : ""}<button type="submit" class="ui-button ui-button-primary af-button af-button-primary af-wide">${icon("RotateCcw", 15)}重新发起审批</button><p class="af-decision-note">${state.mode === "demo" ? "沿用原候选方案与检查证据，仅重开演示审批。" : "服务端会重新核对候选方案和检查证据，并保留本轮决定。"}</p></form>` : `<div class="af-resolved"><span class="af-resolved-icon ${terminal ? "is-approved" : ""}">${icon(cancelled ? "Ban" : terminal ? "CheckCheck" : selected.status === "rejected" ? "X" : selected.status === "completed" ? "CircleCheck" : "LockKeyhole", 28)}</span><h3>${cancelled ? "任务已取消" : terminal ? "两级审批已通过" : selected.status === "rejected" ? "方案已停止" : selected.status === "completed" ? "该节点已完成" : "等待前序节点"}</h3><p>${cancelled ? "审批与执行已停止，已有的检查证据和决定记录仍可查看。" : terminal ? (state.mode === "demo" ? "候选变更已获得授权，等待执行器接入。真实修复尚未开始。" : e(flow.nodes.find((node) => node.id === "execute")?.detail || "授权已记录，执行状态以任务记录为准。")) : selected.status === "rejected" ? "拒绝记录已保留，后续执行被阻止。" : selected.status === "completed" ? "可以继续检查证据，或查看当前需要决定的节点。" : "完成前序检查与人工审批后，流程才会进入这里。"}</p>${flow.currentNodeId && selected.id !== flow.currentNodeId ? `<button type="button" class="ui-button ui-button-ghost af-button af-button-soft" ${taskAction("flow-node", entry.task.id, `data-node-id="${e(flow.currentNodeId)}"`)}>前往当前审批${icon("ArrowRight", 14)}</button>` : ""}</div>`}
    </div></section>`;
}

export function renderApprovalPage(state) {
  const entries = approvalEntries(state);
  const annotated = entries.map((entry) => ({
    entry,
    flow: getApprovalFlow(entry),
  }));
  const counts = {
    pending: annotated.filter((item) => item.flow.status === "pending").length,
    approved: annotated.filter((item) => item.flow.status === "approved")
      .length,
    rejected: annotated.filter((item) => item.flow.status === "rejected")
      .length,
  };
  const filter = state.approvalFilter === "all" ? "all" : "pending";
  const filtered = annotated.filter(
    (item) => filter === "all" || item.flow.status === "pending",
  );
  const selected =
    annotated.find((item) => item.entry.task.id === state.approvalTaskId) ||
    filtered[0] ||
    annotated[0];
  const tab = ["flow", "diff", "history"].includes(state.approvalTab)
    ? state.approvalTab
    : "flow";
  const stats = `<div class="af-overview" aria-label="审批概况">${[
    ["pending", "Clock3", "等待审批", "当前需要你的决定"],
    [
      "approved",
      "CheckCheck",
      "已授权",
      state.mode === "live" ? "已完成两级审批" : "等待执行器处理",
    ],
    ["rejected", "RotateCcw", "已拒绝", "保留记录，可重新提交"],
  ]
    .map(
      ([key, symbol, title, caption]) =>
        `<div class="ui-card af-stat af-stat-${key}"><span class="af-stat-icon">${icon(symbol, 19)}</span><div><span>${title}</span><strong>${counts[key]}</strong></div><p>${caption}</p></div>`,
    )
    .join("")}</div>`;
  if (!entries.length)
    return (
      stats +
      uiEmpty({
        icon: "GitPullRequestArrow",
        title: "当前没有审批请求",
        description:
          state.mode === "demo"
            ? "需要人工确认的候选方案会出现在这里。"
            : "审批服务尚未接入。连接后可查看真实请求、流程节点与决策记录。",
        className: "af-empty af-empty-page",
      })
    );
  const { entry, flow } = selected;
  return `${stats}<div class="af-workspace"><aside class="ui-card af-requests" aria-label="审批请求"><div class="af-requests-heading"><h2>${icon("GitPullRequestArrow", 16)}审批请求</h2><span>${entries.length}</span></div><div class="af-request-filter" role="group" aria-label="审批请求筛选"><button type="button" ${action("approval-filter", 'data-filter="pending"')} aria-pressed="${filter === "pending"}">待处理 <span>${counts.pending}</span></button><button type="button" ${action("approval-filter", 'data-filter="all"')} aria-pressed="${filter === "all"}">全部记录</button></div><div class="af-request-list">${filtered.length ? filtered.map((item) => renderRequest(item.entry, item.entry.task.id === entry.task.id)).join("") : uiEmpty({ icon: "CheckCheck", title: "待办已清空", description: "已处理的请求仍保留在全部记录中。", className: "af-list-empty", action: uiButton({ label: "查看全部记录", icon: "ArrowRight", action: "approval-filter", attrs: 'data-filter="all"', variant: "ghost", className: "af-text-button" }) })}</div><div class="af-requests-foot">${icon("ShieldCheck", 15)}<span>每次决定都有迹可循</span></div></aside><section class="ui-card af-review"><header class="af-review-heading"><div class="af-review-eyebrow"><span class="af-task-label">${icon("GitPullRequestArrow", 13)}${e(entry.task.id)}</span>${stateBadge(flow.status, flow.status === "pending" ? "等待人工审批" : undefined)}<span class="af-review-round">第 ${e(flow.round)} 轮</span></div><h2>${e(entry.title)}</h2><div class="af-review-meta"><span>${icon("Bot", 14)}${entry.engineId === "complex" ? "ZCode Workflow" : "Direct AI"}</span><span>${icon("FileDiff", 14)}${filesOf(entry).length} 个文件</span><span>${icon("UserRoundCheck", 14)}2 个人工关卡</span><span>${icon("LockKeyhole", 13)}${state.mode === "demo" ? "演示工作区" : state.snapshot?.capabilities.approve ? "服务端审批" : "只读审批"}</span></div></header><div class="ui-tabs af-review-tabs" role="tablist" aria-label="审批内容">${[
    ["flow", "Workflow", "审批流程"],
    ["diff", "FileDiff", "候选变更"],
    ["history", "History", "审批记录"],
  ]
    .map(
      ([id, symbol, title]) =>
        `<button type="button" role="tab" class="ui-tab ${tab === id ? "is-active" : ""}" aria-selected="${tab === id}" tabindex="${tab === id ? "0" : "-1"}" ${action("approval-tab", `data-tab="${id}"`)}>${icon(symbol, 15)}${title}${id === "diff" ? `<span>${filesOf(entry).length}</span>` : id === "history" ? `<span>${flow.history.length}</span>` : ""}</button>`,
    )
    .join(
      "",
    )}</div><div class="af-review-body">${flow.status === "unavailable" && tab === "flow" ? uiEmpty({ icon: "Workflow", title: "审批流程尚未接入", description: "没有服务端节点证据时，不推测检查或审批结果。", className: "af-empty" }) : tab === "flow" ? renderFlowCanvas(entry, { selectedNodeId: state.approvalNodeId, mode: state.mode, zoom: state.flowZoom }) + renderNodeInspector(entry, flow, state) : tab === "diff" ? renderChanges(entry) : renderHistory(flow)}</div></section></div>`;
}

/** Compact decision card for the overview; all actions lead to the full flow. */
export function renderApprovalTeaser(entry, state) {
  if (!entry)
    return `<section class="ui-card af-teaser af-teaser-empty">${uiEmpty({ icon: "CheckCheck", title: "审批待办已清空", description: "新的候选方案到达后，会在这里提醒你。" })}</section>`;
  const flow = getApprovalFlow(entry);
  const pending = flow.status === "pending";
  const current = flow.currentGate;
  return `<section class="ui-card af-teaser"><div class="af-teaser-top"><span class="af-teaser-icon">${icon("GitPullRequestArrow", 23)}</span><span class="af-teaser-kicker">${pending ? "需要你的决定" : "审批进展"}</span>${stateBadge(flow.status, pending ? "待审批" : undefined)}</div><h3>${e(entry.title)}</h3><p class="af-teaser-meta"><span class="mono">${e(entry.task.id)}</span><span>·</span><span>${filesOf(entry).length} 个文件</span></p><div class="af-teaser-gates">${flow.nodes
    .filter((node) => node.kind === "human")
    .map(
      (node, index) =>
        `<span class="af-mini-gate ${node.id === flow.currentNodeId ? "is-current" : ""} ${node.status === "completed" ? "is-done" : ""}"><i>${node.status === "completed" ? icon("Check", 10) : index + 1}</i>${e(node.title)}</span>${index === 0 ? '<span class="af-mini-gate-line"></span>' : ""}`,
    )
    .join(
      "",
    )}</div><div class="af-teaser-person"><span class="af-avatar">${e(initials(current?.actor || "审批人"))}</span><div><strong>${e(current?.actor || "审批人")}</strong><span>${current ? e(current.title) : flow.status === "approved" ? "已完成审批" : "流程记录"}</span></div><span class="af-teaser-lock">${icon("LockKeyhole", 14)}</span></div><button type="button" class="ui-button ui-button-primary af-button af-button-primary af-wide" ${taskAction("select-approval", entry.task.id)}>查看审批流${icon("ArrowRight", 15)}</button><p class="af-teaser-note">${state.mode === "demo" ? "模拟审批 · 不会执行真实修复" : "查看审批证据与决策记录"}</p></section>`;
}
