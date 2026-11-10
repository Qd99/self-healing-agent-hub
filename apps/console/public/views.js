import { icon } from "./icons.js";
import { renderStudioDashboard } from "./dashboard.js";
import {
  renderConnectionSettings,
  renderSessionForm,
} from "./connection-views.js";
import { renderApprovalPage } from "./approval-views.js";
import { escapeHtml as e, formatDuration } from "./model.js";
import { renderTaskPage } from "./task-views.js";
import { renderSidebar, renderTopbar } from "./navigation.js";
import { renderMonitoringPage } from "./monitoring-views.js";
import {
  renderActivityPage,
  renderRulesPage,
  renderRoutingDetail,
} from "./administration-views.js";
import { filterActivities } from "./administration-model.js";
import { uiButton, uiStatus, uiEmpty, uiSelect } from "./ui.js";
import { renderTaskFeedback, renderReconciliation } from "./task-feedback.js";

export const pages = {
  overview: { title: "工作台", icon: "LayoutDashboard" },
  tasks: { title: "全部任务", icon: "ListChecks" },
  approvals: { title: "审批中心", icon: "GitPullRequestArrow" },
  engines: { title: "执行引擎", icon: "Bot" },
  rules: { title: "路由规则", icon: "Workflow" },
  safety: { title: "安全策略", icon: "ShieldCheck" },
  activity: { title: "操作记录", icon: "History" },
  monitoring: { title: "监控面板", icon: "ChartNoAxesCombined" },
  settings: { title: "连接设置", icon: "Settings2" },
};
export const taskTypes = {
  "lint-error": "Lint 错误",
  "format-error": "代码格式",
  "type-error": "类型错误",
  "unit-test-failure": "单元测试",
  "e2e-test-failure": "端到端测试",
  "architecture-violation": "架构检查",
  "security-issue": "安全检查",
  "ci-failure": "CI 失败",
  "doc-outdated": "文档同步",
  "dependency-issue": "依赖检查",
  "performance-regression": "性能回归",
};
const statusNames = {
  completed: "已完成",
  failed: "失败",
  running: "运行中",
  pending: "队列中",
  cancelled: "已取消",
  skipped: "已跳过",
  review: "待审阅",
};
const engineName = (id) =>
  id === "fast"
    ? "Direct AI"
    : id === "complex"
      ? "ZCode Workflow"
      : String(id || "未分配");
const stateOf = (item) =>
  item.reviewState === "pending" ? "review" : item.status.status;
const dateTime = (value) => {
  const d = new Date(value);
  return Number.isNaN(+d)
    ? "—"
    : new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(d);
};
const safeStatus = (status) =>
  Object.hasOwn(statusNames, status) ? status : "pending";
export function statusLabel(item) {
  const value = safeStatus(stateOf(item));
  return uiStatus({
    label: statusNames[value],
    tone:
      value === "completed"
        ? "success"
        : value === "failed"
          ? "error"
          : value === "running"
            ? "info"
            : value === "review"
              ? "warning"
              : "neutral",
    className: `status-label ${value}`,
  });
}
const action = (name, extra = "") => `data-action="${name}" ${extra}`;
const empty = (title, description = "") =>
  uiEmpty({ icon: "ListTodo", title, description });
const periodSelect = (days) =>
  uiSelect({
    id: "period",
    label: "时间范围",
    value: days,
    className: "page-period",
    options: [
      { value: 1, label: "今天" },
      { value: 7, label: "近 7 天" },
      { value: 30, label: "近 30 天" },
    ],
  });

export function renderShell(s) {
  const storage = s.snapshot?.storage;
  const warning =
    storage?.status === "read-only"
      ? `<div class="detail-callout storage-warning" role="status"><strong>存储只读${storage.reason ? ` · ${e(storage.reason)}` : ""}</strong><p>${e(storage.message || "当前无法写入，可以继续查看和导出记录。")}</p></div>`
      : "";
  return `${renderSidebar(s, pages)}<div class="shell">${renderTopbar(s, pages)}<main id="main-content" class="content" tabindex="-1">${warning}${renderPage(s)}</main></div>`;
}

function renderPage(s) {
  const activityCount = s.snapshot
    ? filterActivities(s.snapshot.activity, s.activityFilters).length
    : 0;
  const header = `<div class="page-heading"><h1>${pages[s.view].title}</h1><div class="row page-heading-actions">${s.view === "overview" ? periodSelect(s.days) : ""}${["overview", "tasks"].includes(s.view) ? `${uiButton({ label: "", icon: "RefreshCw", action: "refresh", loading: s.loading || s.refreshing, className: "btn", attrs: 'aria-label="刷新工作台"', title: "刷新" })}${uiButton({ label: "发起巡检", icon: "Plus", action: "new-task", variant: "primary", disabled: !s.snapshot?.capabilities.trigger || Boolean(s.pendingAction) || s.authRequired, title: !s.snapshot?.capabilities.trigger ? "当前服务未开放创建任务" : "" })}` : s.view === "activity" ? uiButton({ label: "导出记录", icon: "Download", action: "administration-export", disabled: !activityCount }) : s.view === "approvals" && s.snapshot ? uiStatus({ label: s.mode === "demo" ? "演示审批" : s.snapshot.capabilities.approve ? "服务端审批" : "只读审批", icon: "LockKeyhole", tone: "neutral" }) : ""}</div></div>`;
  if (s.authRequired) return header + renderSessionForm(s);
  if (s.loading && s.view !== "settings")
    return (
      header +
      `<div role="status" aria-label="正在读取配置" class="skeleton-block">${Array.from({ length: 4 }, () => `<div class="loading-row"><div class="loading-line"></div><div class="loading-line"></div></div>`).join("")}</div>`
    );
  if (!s.snapshot && !["settings", "monitoring", "activity"].includes(s.view))
    return header + connectionError(s);
  const views = {
    overview: renderStudioDashboard,
    approvals: renderApprovalPage,
    tasks: renderTaskPage,
    engines,
    rules: renderRulesPage,
    safety,
    activity: renderActivityPage,
    monitoring: renderMonitoringPage,
    settings: renderConnectionSettings,
  };
  const stale =
    s.error && s.snapshot
      ? `<p class="ui-section-note" role="status">${icon("CircleAlert", 14)}${e(s.error)} 当前显示最近一次读取的数据。</p>`
      : "";
  return header + stale + views[s.view](s);
}
function connectionError() {
  return `<section class="ui-card connection-unavailable">${uiEmpty({
    icon: "Plug",
    title: "尚未连接管理服务",
    description: "连接后，任务和运行数据会显示在这里。",
    action: uiButton({
      label: "连接设置",
      icon: "ArrowUpRight",
      action: "navigate",
      variant: "primary",
      attrs: 'data-view="settings"',
    }),
  })}</section>`;
}

function engines(s) {
  return `<div class="ui-setting-stack">${s.snapshot.engines.map((x) => `<section class="ui-card"><header class="ui-section-header"><h2>${icon(x.id === "fast" ? "Zap" : "Workflow", 17)}${e(engineName(x.id))}</h2>${uiStatus({ label: { unavailable: "等待 Agent 接入", idle: "可领取任务", running: "运行中", error: "连接异常" }[x.status] || "状态未知", icon: x.status === "running" ? "Activity" : "Plug", tone: x.status === "running" ? "info" : x.status === "idle" ? "success" : "neutral" })}</header><dl class="ui-config-grid"><div><dt>适用任务</dt><dd>${x.id === "fast" ? "格式、Lint 与轻量修复" : "诊断、多步骤修复与验证"}</dd></div><div><dt>配置模型</dt><dd>${e(x.model || "未配置")}</dd></div><div><dt>引擎类型</dt><dd><code>${e(x.type)}</code></dd></div><div><dt>关联规则</dt><dd>${uiButton({ label: `${s.snapshot.rules.filter((r) => r.processor.engine === x.id).length} 条路由规则`, action: "navigate", variant: "ghost", attrs: 'data-view="rules"' })}</dd></div></dl></section>`).join("")}<details class="ui-card ui-fold"><summary>执行引擎接入说明</summary><div class="ui-fold-content">当前展示${s.mode === "demo" ? "示例" : "已读取的"}配置，任务由已认证的 Agent 领取并回传进度与结果。显示已配置不代表 Agent 在线，实际运行以任务记录为准。</div></details></div>`;
}

function safety(s) {
  const a = s.snapshot.safety;
  const property = (label, value) =>
    `<div><dt>${e(label)}</dt><dd>${value}</dd></div>`;
  return `<div class="ui-setting-stack"><section class="ui-card"><header class="ui-section-header"><h2>${icon("ShieldCheck", 17)}变更范围</h2>${uiStatus({ label: "配置只读", icon: "LockKeyhole" })}</header><dl class="ui-config-grid">${property("单次修改上限", `${e(a.maxFilesPerFix ?? "未配置")} 个文件`)}${property("受保护路径", `${a.protectedPaths?.length || 0} 项`)}</dl><div class="ui-section-note"><div class="token-list">${(a.protectedPaths || []).map((path) => `<code class="token">${e(path)}</code>`).join("") || "未配置受保护路径"}</div></div></section>
    <section class="ui-card"><header class="ui-section-header"><h2>${icon("FlaskConical", 17)}修复后验证</h2><span class="muted">${a.requiredChecks?.length || 0} 项检查</span></header><div class="ui-section-note">${(a.requiredChecks || []).map((check) => `<p class="ui-info-line">${icon("Terminal", 14)}<code>${e(check)}</code></p>`).join("") || "未配置检查命令"}</div></section>
    <section class="ui-card"><header class="ui-section-header"><h2>${icon("RotateCcw", 17)}失败回滚</h2>${uiStatus({ label: a.autoRollback?.enabled ? "配置已启用" : "未启用", tone: a.autoRollback?.enabled ? "success" : "neutral" })}</header><dl class="ui-config-grid">${property("等待 CI 结果", formatDuration(a.autoRollback?.ciTimeout))}${property("通知目标", e(a.autoRollback?.notifyOn?.join("、") || "未配置"))}</dl></section>
    <section class="ui-card"><header class="ui-section-header"><h2>${icon("ShieldAlert", 17)}连续失败保护</h2>${uiStatus({ label: a.circuitBreaker?.enabled ? "配置已启用" : "未启用", tone: a.circuitBreaker?.enabled ? "success" : "neutral" })}</header><dl class="ui-config-grid">${property("失败阈值", `${e(a.circuitBreaker?.windowMinutes ?? "—")} 分钟内 ${e(a.circuitBreaker?.failureThreshold ?? "—")} 次`)}${property("冷却时间", `${e(a.circuitBreaker?.cooldownMinutes ?? "—")} 分钟`)}</dl></section>
    <details class="ui-card ui-fold"><summary>配置如何生效</summary><div class="ui-fold-content">${s.mode === "demo" ? "此处为演示策略。" : s.snapshot.configSource === "example" ? "此处为示例文件中的策略。" : "此处为已读取的项目策略。"}服务端在候选方案进入审批前核对变更路径、文件数量和必需检查；回滚与执行结果以 Agent 回传的实际证据为准。</div></details></div>`;
}

export function renderTaskDetail(item, s) {
  const tab = s.detailTab;
  const status = stateOf(item);
  let body = "";
  if (tab === "trace")
    body = `<div class="detail-callout"><strong>触发原因</strong><p>${e(item.task.payload.errorDetails?.message || "暂无触发描述")}</p></div>${item.trace.length ? item.trace.map((t) => `<div class="trace-step ${t.parentId ? "child" : ""}"><span class="trace-node ${["completed", "running", "failed"].includes(t.status) ? t.status : ""}">${icon(t.status === "completed" ? "Check" : t.status === "running" ? "Play" : t.status === "failed" ? "X" : "Circle", 11)}</span><div class="grow"><p class="trace-title">${e(t.title)}</p><p class="trace-detail">${e(t.detail || "")}</p></div><span class="trace-duration">${t.durationMs != null ? formatDuration(t.durationMs) : t.status === "running" ? "进行中" : "—"}</span></div>`).join("") : empty("还没有执行步骤")}`;
  else if (tab === "diff")
    body =
      (item.diff?.length
        ? item.diff
            .map(
              (file) =>
                `<div class="diff-file"><div class="diff-file-head">${icon("FileCode2", 13)}<span class="grow">${e(file.path)}</span><span class="diff-stats"><span class="green">+${e(file.additions)}</span><span class="red">−${e(file.deletions)}</span></span></div><div class="diff-lines">${file.lines.map((line, i) => `<div class="diff-line ${line.type === "add" ? "add" : line.type === "remove" ? "remove" : ""}"><span class="line-number">${i + 1}</span><span class="line-prefix">${line.type === "add" ? "+" : line.type === "remove" ? "−" : " "}</span><span>${e(line.content)}</span></div>`).join("")}</div></div>`,
            )
            .join("")
        : empty("暂时没有代码变更", "诊断完成后会显示候选修复。")) +
      `<p class="status-caption">${s.mode === "demo" ? "虚构代码片段，仅用于预览。" : "服务端返回的变更内容。"} 行号为片段行号。</p>`;
  else if (tab === "evidence") {
    const evidence = item.result?.evidence || item.evidence;
    const timings = item.result?.timings;
    body = evidence
      ? `${!item.result ? '<p class="status-caption">候选方案验证证据 · 执行结果尚未回传</p>' : ""}<section class="evidence-section"><h3>修复前</h3><p class="detail-callout">${e(evidence.beforeState?.summary || JSON.stringify(evidence.beforeState))}</p><h3>修复后</h3><p class="detail-callout">${e(evidence.afterState?.summary || JSON.stringify(evidence.afterState))}</p></section><section class="evidence-section"><h3>检查结果</h3>${(evidence.checksPass || []).map((c) => `<div class="evidence-row green">${icon("Check")}<code>${e(c)}</code></div>`).join("")}${(evidence.checksFail || []).map((c) => `<div class="evidence-row red">${icon("X")}<code>${e(c)}</code></div>`).join("")}${!(evidence.checksPass?.length || evidence.checksFail?.length) ? '<p class="muted">没有检查结果</p>' : ""}</section><section class="evidence-section"><h3>耗时</h3>${Object.entries(
          timings?.stages || {},
        )
          .map(
            ([name, ms]) =>
              `<div class="metric-row"><span>${e(name)}</span><span>${formatDuration(ms)}</span></div>`,
          )
          .join(
            "",
          )}<div class="metric-row"><span>合计</span><span>${formatDuration(timings?.durationMs)}</span></div></section>`
      : empty("验证证据尚未生成");
  } else
    body = item.result?.logs?.length
      ? `<div class="log-lines">${e(item.result.logs.join("\n\n"))}</div>`
      : empty("暂无执行日志");
  const can = (key) =>
    s.mode === s.snapshot?.mode &&
    s.snapshot.capabilities[key] === true &&
    !s.pendingAction &&
    !s.authRequired &&
    !(key === "cancel" && item.execution?.cancelRequested) &&
    !(key === "retry" && item.reconciliation?.status === "required");
  const buttons =
    status === "review"
      ? `<button class="ui-button btn" data-action="close-detail">稍后处理</button><button class="ui-button btn primary" data-action="select-approval" data-id="${e(item.task.id)}">${icon("GitPullRequestArrow", 15)}打开审批流</button>`
      : ["pending", "running"].includes(status)
        ? `<button class="ui-button btn" ${action("task-action", `data-command="cancel" data-id="${e(item.task.id)}"`)} ${can("cancel") ? "" : "disabled"}>${icon("Square", 12)}${item.execution?.cancelRequested ? "等待取消确认" : s.pendingAction === `task:cancel:${item.task.id}` ? "提交中…" : "取消任务"}</button>`
        : ["failed", "cancelled"].includes(status)
          ? `<button class="ui-button btn primary" ${action("task-action", `data-command="retry" data-id="${e(item.task.id)}"`)} ${can("retry") ? "" : "disabled"}>${icon("RefreshCw", 13)}重新尝试</button>`
          : `<button class="ui-button btn" ${action("close-detail")}>关闭详情</button>`;
  return `<div class="detail-top"><span class="row">${icon("ListTodo", 14)}<span class="mono">${e(item.task.id)}</span><span>/</span><span>任务详情</span></span><button class="ui-icon-button icon-button" ${action("close-detail")} aria-label="关闭任务详情">${icon("X", 17)}</button></div><div class="detail-heading">${statusLabel(item)}<h2 id="detail-title">${e(item.title)}</h2><div class="detail-metadata"><span>${e(engineName(item.engineId))}</span><span>·</span><span class="row">${icon("GitBranch", 12)}${e(item.task.payload.branch)}</span><span>·</span><span>${dateTime(item.task.metadata.createdAt)}</span></div></div><div class="tabs detail-tabs ui-tabs" role="tablist" aria-label="任务详情">${[
    ["trace", "执行过程"],
    ["diff", "代码变更"],
    ["evidence", "验证证据"],
    ["logs", "执行日志"],
  ]
    .map(
      ([id, title]) =>
        `<button class="tab ui-tab ${tab === id ? "active" : ""}" role="tab" aria-selected="${tab === id}" ${action("detail-tab", `data-tab="${id}"`)}>${icon({ trace: "Workflow", diff: "FileDiff", evidence: "FlaskConical", logs: "Terminal" }[id], 14)}${title}${id === "diff" ? `<span class="tab-count">${item.diff?.length || 0}</span>` : ""}</button>`,
    )
    .join(
      "",
    )}</div><div class="detail-content">${renderTaskFeedback(item)}${renderReconciliation(item, s)}${body}</div><div class="detail-bottom"><small>${s.mode === "demo" ? "演示操作 · 不会提交真实变更" : item.execution?.cancelRequested ? "已请求取消，等待 Agent 确认停止" : "操作与执行证据由管理服务保存"}</small><div class="row">${buttons}</div></div>`;
}

export function renderCreate(s) {
  const draft = {
    title: "",
    type: "type-error",
    priority: "medium",
    branch: s.snapshot?.project.defaultBranch || "",
    ...s.createDraft,
  };
  const pending = s.pendingAction === "trigger";
  const canCreate =
    s.snapshot?.capabilities.trigger && !s.authRequired && !s.pendingAction;
  return `<div class="spread"><h2 id="create-title">发起巡检</h2><button class="ui-icon-button icon-button" ${action("close-create")} aria-label="关闭巡检表单">${icon("X", 17)}</button></div><p class="intro">${s.mode === "demo" ? "创建一个模拟任务，查看队列与任务详情。当前没有连接真实执行引擎。" : "创建任务后进入服务端队列，由 Agent 领取诊断；候选方案经过审批后才能执行。"}</p><form id="create-form"><div class="form-field"><label for="task-title">任务描述</label><input class="ui-input" id="task-title" name="title" required maxlength="160" placeholder="例如：检查聊天模块的类型错误" autocomplete="off" value="${e(draft.title)}" ${pending ? "disabled" : ""} /></div><div class="form-grid"><div class="form-field"><label for="task-type">任务类型</label><select class="ui-select-input" id="task-type" name="type" ${pending ? "disabled" : ""}>${Object.entries(
    taskTypes,
  )
    .map(
      ([v, t]) =>
        `<option value="${v}" ${v === draft.type ? "selected" : ""}>${t}</option>`,
    )
    .join(
      "",
    )}</select></div><div class="form-field"><label for="task-priority">优先级</label><select class="ui-select-input" id="task-priority" name="priority" ${pending ? "disabled" : ""}>${Object.entries(
    { low: "低", medium: "中", high: "高", urgent: "紧急" },
  )
    .map(
      ([value, label]) =>
        `<option value="${value}" ${draft.priority === value ? "selected" : ""}>${label}</option>`,
    )
    .join(
      "",
    )}</select></div></div><div class="form-field"><label for="task-branch">目标分支</label><input class="ui-input" id="task-branch" name="branch" required maxlength="200" value="${e(draft.branch)}" ${pending ? "disabled" : ""} /></div><p class="form-error" id="form-error" role="alert">${e(s.createError || "")}</p><div class="form-actions"><button class="ui-button btn" type="button" ${action("close-create")}>取消</button><button class="ui-button btn primary" type="submit" ${canCreate ? "" : "disabled"}>${pending ? "提交中…" : s.mode === "demo" ? "创建模拟任务" : "创建任务"} ${icon("ArrowRight", 13)}</button></div></form>`;
}

export function renderRuleDetail(rule, state = {}) {
  return renderRoutingDetail(rule, state);
}
