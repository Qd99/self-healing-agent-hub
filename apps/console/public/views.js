import { icon } from "./icons.js";
import { renderStudioDashboard } from "./dashboard.js";
import { renderApprovalPage } from "./approval-views.js";
import { escapeHtml as e, filterTasks, formatDuration } from "./model.js";

export const pages = {
  overview: { title: "工作台", icon: "LayoutDashboard" },
  tasks: { title: "全部任务", icon: "ListChecks" },
  approvals: { title: "审批中心", icon: "GitPullRequestArrow" },
  engines: { title: "Agent 引擎", icon: "Bot" },
  rules: { title: "路由规则", icon: "Workflow" },
  safety: { title: "安全策略", icon: "ShieldCheck" },
  activity: { title: "活动记录", icon: "Activity" },
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
const nowDate = () =>
  new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(new Date());
const timeOf = (value) => {
  const d = new Date(value);
  return Number.isNaN(+d)
    ? "—"
    : new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(d);
};
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
  return `<span class="status-label ${value}"><i class="status-dot"></i>${statusNames[value]}</span>`;
}
function mark(item) {
  const value = safeStatus(stateOf(item));
  return `<span class="status-mark ${value}" aria-label="${statusNames[value]}">${value === "completed" ? icon("Check", 14) : value === "failed" ? icon("CircleAlert", 14) : ["cancelled", "skipped"].includes(value) ? icon("Square", 10) : ""}</span>`;
}
const action = (name, extra = "") => `data-action="${name}" ${extra}`;
const taskButton = (id, label, tab = "trace", className = "text-button") =>
  `<button class="${className}" ${action("open-task", `data-id="${e(id)}" data-tab="${e(tab)}"`)}>${label}</button>`;
const empty = (title, description = "") =>
  `<div class="empty">${icon("ListTodo")}<div>${e(title)}</div>${description ? `<p>${e(description)}</p>` : ""}</div>`;
const periodSelect = (days) =>
  `<label class="sr-only" for="period">时间范围</label><select id="period" class="period-select" aria-label="时间范围">${[
    [1, "今天"],
    [7, "近 7 天"],
    [30, "近 30 天"],
  ]
    .map(
      ([n, t]) =>
        `<option value="${n}" ${days === n ? "selected" : ""}>${t}</option>`,
    )
    .join("")}</select>`;

export function renderShell(s) {
  const snap = s.snapshot;
  const project =
    snap?.project?.repo?.split("/").at(-1) || "self-healing-agent-hub";
  const review =
    snap?.tasks.filter((t) => t.reviewState === "pending").length || 0;
  const navigation = Object.entries(pages)
    .filter(([id]) => id !== "settings")
    .map(
      ([id, p]) =>
        `<a href="#${id}" class="nav-item ${s.view === id ? "active" : ""}" ${s.view === id ? 'aria-current="page"' : ""}>${icon(p.icon)}<span>${p.title}</span>${id === "approvals" && review ? `<span class="nav-count">${review}</span>` : ""}</a>`,
    )
    .join("");
  return `<aside class="sidebar ${s.mobileNav ? "mobile-open" : ""}" aria-label="主导航">
    <div class="brand"><a href="#overview" aria-label="heal 工作台"><span class="brand-mark">${icon("Layers", 20)}</span><span class="brand-copy">heal<small>AGENT WORKSPACE</small></span></a><button class="icon-button sidebar-close" data-action="close-nav" aria-label="关闭导航">${icon("X")}</button></div>
    <button class="workspace row" data-action="navigate" data-view="settings" aria-label="工作区连接设置"><span class="workspace-icon">${icon("FolderGit2", 17)}</span><span class="grow"><span class="workspace-title">Self-healing hub</span><small>${s.mode === "demo" ? "演示工作空间" : "项目配置工作空间"}</small></span>${icon("ChevronDown", 12)}</button>
    <div class="nav-label">WORKSPACE</div><nav class="nav-list">${navigation}</nav>
    <div class="sidebar-bottom"><div class="sidebar-note">${icon("ShieldCheck", 24)}<div><strong>每次变更，清晰可见</strong><small>流程 · 审批 · 验证记录</small></div></div><nav class="nav-list"><a href="#settings" class="nav-item ${s.view === "settings" ? "active" : ""}" ${s.view === "settings" ? 'aria-current="page"' : ""}>${icon("Settings2")}连接设置</a><div class="nav-item"><span>外观</span><div class="theme-switch" role="group" aria-label="外观主题"><button class="theme-option" data-action="theme" data-theme="light" aria-label="浅色主题" aria-pressed="${s.theme === "light"}">${icon("Sun", 14)}</button><button class="theme-option" data-action="theme" data-theme="dark" aria-label="深色主题" aria-pressed="${s.theme === "dark"}">${icon("Moon", 14)}</button></div></div></nav><div class="account"><span class="avatar">Q</span><div class="grow">Qd99<small>个人工作空间</small></div>${icon("ChevronDown", 12)}</div></div>
  </aside><div class="sidebar-backdrop ${s.mobileNav ? "open" : ""}" data-action="close-nav"></div><div class="shell"><header class="topbar"><div class="row grow"><button class="icon-button mobile-menu" data-action="open-nav" aria-label="打开导航">${icon("Menu")}</button><div class="breadcrumb">${icon("PanelTop", 15)}<span class="project-name truncate muted">${e(project)}</span><span class="separator">/</span><span>${pages[s.view].title}</span></div></div><div class="topbar-actions"><button class="search-trigger" data-action="search" aria-label="搜索任务">${icon("Search", 14)}<span class="search-label">搜索工作空间</span><span class="keycap">⌘ K</span></button><button class="mode-badge" data-action="navigate" data-view="settings">${s.mode === "demo" ? "演示模式" : snap ? "只读连接" : "未连接"}</button><button class="topbar-notice" data-action="navigate" data-view="approvals" aria-label="待办审批">${icon("Bell", 16)}${review ? "<i></i>" : ""}</button><span class="avatar" aria-label="当前工作空间所有者 Qd99">Q</span></div></header><main id="main-content" class="content" tabindex="-1">${renderPage(s)}</main></div>`;
}

function renderPage(s) {
  const titles = {
    overview: "查看 Agent 运行、审批与修复记录。",
    approvals: "从候选方案到执行授权，让每次决定都有迹可循。",
    tasks: "查看每一次诊断、修复与验证。",
    engines: "一个任务入口，按问题复杂度分配执行引擎。",
    rules: "事件如何匹配，以及交给哪个引擎。",
    safety: "控制每次修复的范围、验证与失败处理。",
    activity: "保留每一次状态变化与人工决策。",
    settings: "选择数据来源，检查管理台的连接状态。",
  };
  const header = `<div class="page-heading"><div class="heading-with-icon"><span class="heading-icon">${icon(pages[s.view].icon, 22)}</span><div><h1>${s.view === "overview" ? "自愈工作台" : pages[s.view].title}</h1><p class="heading-description">${titles[s.view] || ""}</p></div></div><div class="row">${["overview", "tasks"].includes(s.view) ? `<button class="btn" data-action="refresh" aria-label="刷新工作台">${icon("RefreshCw", 13)}刷新</button><button class="btn primary" data-action="new-task" ${!s.snapshot?.capabilities.trigger ? 'disabled title="执行引擎尚未接入"' : ""}>${icon("Plus", 14)}发起巡检</button>` : s.view === "activity" ? `<button class="btn" data-action="export" ${!s.snapshot ? "disabled" : ""}>${icon("Download", 14)}导出记录</button>` : s.view === "approvals" ? `<span class="studio-state review">${icon("LockKeyhole", 13)}${s.mode === "demo" ? "演示审批 · 不执行修复" : "只读审批"}</span>` : ""}</div></div>`;
  if (s.loading)
    return (
      header +
      `<div role="status" aria-label="正在读取配置" class="skeleton-block">${Array.from({ length: 4 }, () => `<div class="loading-row"><div class="loading-line"></div><div class="loading-line"></div></div>`).join("")}</div>`
    );
  if (!s.snapshot && s.view !== "settings")
    return header + connectionError(s) + footer(s);
  const views = {
    overview: renderStudioDashboard,
    approvals: renderApprovalPage,
    tasks: taskList,
    engines,
    rules,
    safety,
    activity,
    settings,
  };
  return header + views[s.view](s) + footer(s);
}
function footer(s) {
  return `<footer class="page-footer">${icon("Info", 13)}<span>${s.mode === "demo" ? "演示数据 · 操作仅保存在本次浏览器会话，不会执行真实修复。" : s.snapshot ? "配置视图 · 执行引擎尚未接入，管理接口当前只读。" : "真实服务尚未连接。"}</span></footer>`;
}
function connectionError(s) {
  return `<div class="inline-notice error"><strong>无法连接管理服务</strong><p>${e(s.error || "请确认管理服务已经启动。")}</p><div class="row"><button class="btn compact" ${action("refresh")}>${icon("RefreshCw", 13)}重新连接</button><button class="btn compact" ${action("mode", 'data-mode="demo"')}>查看演示</button></div></div>`;
}

function taskList(s) {
  const items = filterTasks(s.snapshot.tasks, {
    query: s.query,
    status: s.status,
    days: s.days,
  });
  return `<div class="filterbar"><label class="search-field">${icon("Search", 14)}<input id="task-search" type="search" placeholder="搜索任务名称、ID 或文件…" aria-label="搜索任务" value="${e(s.query)}" /></label><label class="sr-only" for="status-filter">任务状态</label><select class="filter-select" id="status-filter">${[
    ["all", "全部状态"],
    ["review", "待审阅"],
    ["running", "运行中"],
    ["pending", "队列中"],
    ["completed", "已完成"],
    ["failed", "失败"],
    ["cancelled", "已取消"],
    ["skipped", "已跳过"],
  ]
    .map(
      ([v, t]) =>
        `<option value="${v}" ${s.status === v ? "selected" : ""}>${t}</option>`,
    )
    .join(
      "",
    )}</select>${periodSelect(s.days)}</div><div id="task-results">${taskTable(items)}<p class="table-total">${items.length} 项任务 · 按创建时间筛选 · Asia/Shanghai</p></div>`;
}
export function taskTable(items) {
  return items.length
    ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>任务</th><th>状态</th><th>执行引擎</th><th>耗时</th><th>创建时间</th><th><span class="sr-only">详情</span></th></tr></thead><tbody>${items.map((t) => `<tr><td><button class="table-name-button" ${action("open-task", `data-id="${e(t.task.id)}"`)}><span class="task-title">${e(t.title)}</span><div class="table-meta"><span class="mono">${e(t.task.id)}</span> · ${e(taskTypes[t.task.type] || t.task.type)}</div></button></td><td>${statusLabel(t)}</td><td class="nowrap muted">${e(engineName(t.engineId))}</td><td class="nowrap muted">${formatDuration(t.result?.timings?.durationMs)}</td><td class="nowrap muted">${dateTime(t.task.metadata.createdAt)}</td><td>${taskButton(t.task.id, icon("ArrowUpRight", 14) + '<span class="sr-only">详情</span>')}</td></tr>`).join("")}</tbody></table></div>`
    : empty("没有匹配的任务", "试试其他关键词、状态或时间范围。");
}

function engines(s) {
  return `<div class="settings-layout"><div><div class="inline-notice">${s.mode === "demo" ? "当前展示两条演示路由。具体引擎尚未实现，模型与健康状态不代表真实连接。" : "读取到引擎配置。当前仓库仅有 WorkflowEngine 抽象接口，具体执行器尚未接入。"}</div>${s.snapshot.engines.map((x) => `<article class="engine-detail"><div class="engine-heading"><div class="engine-icon">${icon(x.id === "fast" ? "Zap" : "Workflow", 18)}</div><div class="grow"><h2>${e(engineName(x.id))}</h2><p class="table-meta">${x.id === "fast" ? "快速通道 · 格式、Lint 与轻量修复" : "复杂工作流 · 诊断、多步骤修复与验证"}</p></div><span class="mode-badge">未接入</span></div><dl class="engine-details-grid"><div><dt>引擎类型</dt><dd><code>${e(x.type)}</code></dd></div><div><dt>配置模型</dt><dd>${e(x.model || "未配置")}</dd></div><div><dt>路由标识</dt><dd><code>${e(x.id)}</code></dd></div><div><dt>匹配规则</dt><dd>${s.snapshot.rules.filter((r) => r.processor.engine === x.id).length} 条</dd></div></dl><p class="engine-note">${icon("Info", 13)}${e(x.message || "无执行器健康检查结果。")}</p></article>`).join("")}</div><aside class="help-note"><h3>如何接入</h3><p>实现已有 WorkflowEngine 的 execute、healthCheck、cancel 与 getStatus 方法，再将运行数据提供给管理接口。</p><p class="margin-top">健康状态来自执行器；配置文件存在不会被视为引擎在线。</p><a class="inline-link" href="https://github.com/Qd99/self-healing-agent-hub" target="_blank" rel="noopener noreferrer">查看框架仓库 ${icon("ArrowUpRight", 11)}</a></aside></div>`;
}

function rules(s) {
  return `<div class="inline-notice">${s.mode === "demo" ? "开关仅修改本次演示的路由状态。" : "配置文件只读；修改规则需通过服务端配置管理。"}<span class="faint"> ${s.snapshot.rules.length} 条规则 · ${s.mode === "demo" ? "演示模板" : s.snapshot.rulesSource === "configured" ? "实际配置" : "示例配置"}</span></div><div class="table-wrap"><table class="data-table"><thead><tr><th>规则名称</th><th>任务类型</th><th>执行引擎</th><th>动作</th><th>状态</th><th></th></tr></thead><tbody>${s.snapshot.rules.map((r) => `<tr><td><button class="table-name-button" ${action("rule-detail", `data-id="${e(r.id)}"`)}><span class="task-title">${e(r.name)}</span><div class="table-meta mono">${e(r.id)}</div></button></td><td>${e(taskTypes[r.match.taskType] || r.match.taskType || "全部")}</td><td class="nowrap">${e(engineName(r.processor.engine))}</td><td><code>${e(r.processor.action)}</code></td><td><button class="switch" role="switch" aria-checked="${r.enabled}" aria-label="${e(r.name)}" ${action("toggle-rule", `data-id="${e(r.id)}"`)} ${s.mode !== "demo" ? 'disabled title="真实规则当前只读"' : ""}><i></i></button></td><td><button class="icon-button" ${action("rule-detail", `data-id="${e(r.id)}"`)} aria-label="查看${e(r.name)}">${icon("ChevronRight", 14)}</button></td></tr>`).join("")}</tbody></table></div>`;
}

function safety(s) {
  const a = s.snapshot.safety;
  const layers = [
    ["L1", "修复前检查", "限制变更范围，保护敏感文件。"],
    ["L2", "修复后验证", "验证任务结果与检查证据。"],
    ["L3", "自动回滚", "失败处理与回滚策略。"],
    ["L4", "熔断保护", "限制重复失败带来的影响。"],
  ];
  return `<div class="settings-layout"><div><div class="inline-notice">以下为${s.mode === "demo" ? "演示" : s.snapshot.configSource === "example" ? "示例" : "实际"}策略配置。执行层尚未接入，配置状态不代表防护已在运行。</div>${layers.map(([n, title, desc], i) => `<section class="settings-section"><h2><span class="mono muted">${n}</span>　${title}</h2><p>${desc}</p>${i === 0 ? `<div class="config-row"><span>单次修改文件上限</span><span>${e(a.maxFilesPerFix ?? "未配置")} 个</span></div><div class="config-row"><span>受保护路径</span><span class="muted">${a.protectedPaths?.length || 0} 项</span></div><div class="token-list">${(a.protectedPaths || []).map((p) => `<span class="token">${e(p)}</span>`).join("")}</div>` : i === 1 ? `<ul class="checked-list">${(a.requiredChecks || []).map((c) => `<li>${icon("Terminal")}<code>${e(c)}</code></li>`).join("") || '<li class="muted">未配置检查命令</li>'}</ul>` : i === 2 ? `<div class="config-row"><span>自动回滚</span><span>${a.autoRollback?.enabled ? "配置为启用" : "未启用"}</span></div><div class="config-row"><span>等待 CI 结果</span><span>${formatDuration(a.autoRollback?.ciTimeout)}</span></div><div class="config-row"><span>通知目标</span><span>${e(a.autoRollback?.notifyOn?.join("、") || "未配置")}</span></div>` : `<div class="config-row"><span>失败熔断</span><span>${a.circuitBreaker?.enabled ? "配置为启用" : "未启用"}</span></div><div class="config-row"><span>失败阈值<small>在统计窗口内达到阈值时暂停</small></span><span>${e(a.circuitBreaker?.windowMinutes ?? "—")} 分钟 / ${e(a.circuitBreaker?.failureThreshold ?? "—")} 次</span></div><div class="config-row"><span>冷却时间</span><span>${e(a.circuitBreaker?.cooldownMinutes ?? "—")} 分钟</span></div>`}</section>`).join("")}</div><aside class="help-note"><h3>配置与运行分开</h3><p>这里展示策略内容。任务执行时的实际通过、失败、回滚结果应由服务端提供，并出现在该任务的验证证据中。</p><p class="margin-top">变更审阅是管理台的独立状态，没有修改框架的任务状态枚举。</p></aside></div>`;
}

function activity(s) {
  return s.snapshot.activity.length
    ? `<div class="spread section-title"><span>最近活动</span><span class="faint">${s.snapshot.activity.length} 条 · 北京时间</span></div>${s.snapshot.activity.map((a) => `<article class="audit-row"><span class="audit-dot ${a.level === "error" ? "error" : a.level === "warning" ? "warning" : ""}"></span><div class="grow"><p class="audit-message">${e(a.message)}</p><div class="audit-meta">${e(a.actor || "系统")}${a.taskId ? ` · ${taskButton(a.taskId, e(a.taskId))}` : ""}</div></div><time datetime="${e(a.at)}">${dateTime(a.at)}</time></article>`).join("")}`
    : empty("还没有活动记录", "运行数据与审计存储接入后，会在这里持续记录。");
}

function settings(s) {
  const snap = s.snapshot;
  return `<div class="settings-layout"><div><section class="settings-section"><h2>数据来源</h2><p>演示操作与真实服务隔离。切换来源会关闭当前任务详情。</p><div class="connection-options" role="group" aria-label="数据来源"><button class="connection-option ${s.mode === "demo" ? "active" : ""}" ${action("mode", 'data-mode="demo"')} aria-pressed="${s.mode === "demo"}"><span class="radio"></span><div><h3>交互演示</h3><p>体验审阅、取消与重试，数据仅存于内存。</p></div></button><button class="connection-option ${s.mode === "live" ? "active" : ""}" ${action("mode", 'data-mode="live"')} aria-pressed="${s.mode === "live"}"><span class="radio"></span><div><h3>真实管理服务</h3><p>连接同源 API，读取项目实际配置。</p></div></button></div>${s.error ? connectionError(s) : ""}</section><section class="settings-section"><div class="spread"><h2>连接详情</h2><button class="text-button" ${action("refresh")}>${icon("RefreshCw", 12)}刷新</button></div><div class="config-row"><span>数据状态</span><span>${s.mode === "demo" ? "演示快照" : snap ? "只读配置已连接" : "未连接"}</span></div><div class="config-row"><span>配置来源</span><span>${!snap ? "—" : s.mode === "demo" ? "演示模板" : snap.configSource === "example" ? "healing-config.example.json" : "healing-config.json"}</span></div><div class="config-row"><span>规则来源</span><span>${!snap ? "—" : s.mode === "demo" ? "演示模板" : snap.rulesSource === "configured" ? "healing-rules.json" : "healing-rules.example.json"}</span></div><div class="config-row"><span>仓库</span><code>${e(snap?.project?.repo || "—")}</code></div><div class="config-row"><span>分支</span><code>${e(snap?.project?.defaultBranch || "—")}</code></div><div class="config-row"><span>最近读取</span><span>${snap ? dateTime(snap.generatedAt) : "—"}</span></div></section><section class="settings-section"><h2>本地接入</h2><p>在项目根目录启动同源管理台。在线设计预览不包含执行服务。</p><pre class="code-block">npm run dev
# http://127.0.0.1:8787
# GET /api/healing/snapshot</pre><p class="margin-top">网关读取现有配置并过滤敏感字段。当前没有具体执行器，任务写操作返回 501。</p></section><section class="settings-section"><h2>可用能力</h2><div class="config-row"><span>配置读取</span><span>${snap ? "可用" : "未连接"}</span></div><div class="config-row"><span>真实任务执行、取消与重试</span><span class="muted">尚未接入</span></div><div class="config-row"><span>真实审批与回滚</span><span class="muted">尚未接入</span></div></section></div><aside class="help-note"><h3>如实显示连接状态</h3><p>服务连接失败时显示错误。不会自动切换到演示数据，也不会把配置存在显示为 Agent 在线。</p><p class="margin-top">API Key、GitHub 私钥与 Webhook Secret 留在服务端，不进入管理台响应。</p></aside></div>`;
}

export function renderTaskDetail(item, s) {
  const tab = s.detailTab;
  const status = stateOf(item);
  let body = "";
  if (tab === "trace")
    body = `<div class="detail-callout">${e(item.task.payload.errorDetails?.message || item.status.message || "暂无诊断信息")}</div>${item.trace.length ? item.trace.map((t) => `<div class="trace-step ${t.parentId ? "child" : ""}"><span class="trace-node ${["completed", "running", "failed"].includes(t.status) ? t.status : ""}">${icon(t.status === "completed" ? "Check" : t.status === "running" ? "Play" : t.status === "failed" ? "X" : "Circle", 11)}</span><div class="grow"><p class="trace-title">${e(t.title)}</p><p class="trace-detail">${e(t.detail || "")}</p></div><span class="trace-duration">${t.durationMs != null ? formatDuration(t.durationMs) : t.status === "running" ? "进行中" : "—"}</span></div>`).join("") : empty("还没有执行步骤")}`;
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
    const evidence = item.result?.evidence;
    body = evidence
      ? `<section class="evidence-section"><h3>修复前</h3><p class="detail-callout">${e(evidence.beforeState?.summary || JSON.stringify(evidence.beforeState))}</p><h3>修复后</h3><p class="detail-callout">${e(evidence.afterState?.summary || JSON.stringify(evidence.afterState))}</p></section><section class="evidence-section"><h3>检查结果</h3>${(evidence.checksPass || []).map((c) => `<div class="evidence-row green">${icon("Check")}<code>${e(c)}</code></div>`).join("")}${(evidence.checksFail || []).map((c) => `<div class="evidence-row red">${icon("X")}<code>${e(c)}</code></div>`).join("")}${!(evidence.checksPass?.length || evidence.checksFail?.length) ? '<p class="muted">没有检查结果</p>' : ""}</section><section class="evidence-section"><h3>耗时</h3>${Object.entries(
          item.result.timings.stages || {},
        )
          .map(
            ([name, ms]) =>
              `<div class="metric-row"><span>${e(name)}</span><span>${formatDuration(ms)}</span></div>`,
          )
          .join(
            "",
          )}<div class="metric-row"><span>合计</span><span>${formatDuration(item.result.timings.durationMs)}</span></div></section>`
      : empty("验证证据尚未生成");
  } else
    body = item.result?.logs?.length
      ? `<div class="log-lines">${e(item.result.logs.join("\n\n"))}</div>`
      : empty("暂无执行日志");
  const can = (key) => s.mode === "demo" && s.snapshot.capabilities[key];
  const buttons =
    status === "review"
      ? `<button class="btn" data-action="close-detail">稍后处理</button><button class="btn primary" data-action="select-approval" data-id="${e(item.task.id)}">${icon("GitPullRequestArrow", 15)}打开审批流</button>`
      : ["pending", "running"].includes(status)
        ? `<button class="btn" ${action("task-action", `data-command="cancel" data-id="${e(item.task.id)}"`)} ${can("cancel") ? "" : "disabled"}>${icon("Square", 12)}取消任务</button>`
        : ["failed", "cancelled"].includes(status)
          ? `<button class="btn primary" ${action("task-action", `data-command="retry" data-id="${e(item.task.id)}"`)} ${can("retry") ? "" : "disabled"}>${icon("RefreshCw", 13)}重新尝试</button>`
          : `<button class="btn" ${action("close-detail")}>关闭详情</button>`;
  return `<div class="detail-top"><span class="row">${icon("ListTodo", 14)}<span class="mono">${e(item.task.id)}</span><span>/</span><span>任务详情</span></span><button class="icon-button" ${action("close-detail")} aria-label="关闭任务详情">${icon("X", 17)}</button></div><div class="detail-heading">${statusLabel(item)}<h2 id="detail-title">${e(item.title)}</h2><div class="detail-metadata"><span>${e(engineName(item.engineId))}</span><span>·</span><span class="row">${icon("GitBranch", 12)}${e(item.task.payload.branch)}</span><span>·</span><span>${dateTime(item.task.metadata.createdAt)}</span></div></div><div class="tabs detail-tabs" role="tablist" aria-label="任务详情">${[
    ["trace", "执行过程"],
    ["diff", "代码变更"],
    ["evidence", "验证证据"],
    ["logs", "日志"],
  ]
    .map(
      ([id, title]) =>
        `<button class="tab ${tab === id ? "active" : ""}" role="tab" aria-selected="${tab === id}" ${action("detail-tab", `data-tab="${id}"`)}>${icon({ trace: "Workflow", diff: "FileDiff", evidence: "FlaskConical", logs: "Terminal" }[id], 14)}${title}${id === "diff" ? `<span class="tab-count">${item.diff?.length || 0}</span>` : ""}</button>`,
    )
    .join(
      "",
    )}</div><div class="detail-content">${body}</div><div class="detail-bottom"><small>${s.mode === "demo" ? "演示操作 · 不会提交真实变更" : "真实操作尚未接入"}</small><div class="row">${buttons}</div></div>`;
}

export function renderCreate(s) {
  return `<div class="spread"><h2 id="create-title">发起巡检</h2><button class="icon-button" ${action("close-create")} aria-label="关闭巡检表单">${icon("X", 17)}</button></div><p class="intro">创建一个模拟任务，查看队列与任务详情。当前没有连接真实执行引擎。</p><form id="create-form"><div class="form-field"><label for="task-title">任务描述</label><input id="task-title" name="title" required maxlength="160" placeholder="例如：检查聊天模块的类型错误" autocomplete="off" /></div><div class="form-grid"><div class="form-field"><label for="task-type">任务类型</label><select id="task-type" name="type">${Object.entries(
    taskTypes,
  )
    .map(
      ([v, t]) =>
        `<option value="${v}" ${v === "type-error" ? "selected" : ""}>${t}</option>`,
    )
    .join(
      "",
    )}</select></div><div class="form-field"><label for="task-priority">优先级</label><select id="task-priority" name="priority"><option value="low">低</option><option value="medium" selected>中</option><option value="high">高</option><option value="urgent">紧急</option></select></div></div><div class="form-field"><label for="task-branch">目标分支</label><input id="task-branch" name="branch" required maxlength="200" value="${e(s.snapshot.project.defaultBranch)}" /></div><p class="form-error" id="form-error" role="alert"></p><div class="form-actions"><button class="btn" type="button" ${action("close-create")}>取消</button><button class="btn primary" type="submit">创建模拟任务 ${icon("ArrowRight", 13)}</button></div></form>`;
}

export function renderRuleDetail(rule) {
  return `<div class="detail-top"><span>路由规则 / <span class="mono">${e(rule.id)}</span></span><button class="icon-button" ${action("close-detail")} aria-label="关闭规则详情">${icon("X", 17)}</button></div><div class="detail-heading"><p class="eyebrow">${rule.enabled ? "已启用配置" : "已停用配置"}</p><h2 id="detail-title">${e(rule.name)}</h2></div><div class="detail-content"><div class="detail-callout">任务匹配规则后会交给 ${e(engineName(rule.processor.engine))}，动作类型为 ${e(rule.processor.action)}。当前仅展示配置，不执行修复。</div><pre class="code-block">${e(JSON.stringify(rule, null, 2))}</pre></div><div class="detail-bottom"><small>来源：healing-rules 配置契约</small><button class="btn" ${action("close-detail")}>关闭</button></div>`;
}
