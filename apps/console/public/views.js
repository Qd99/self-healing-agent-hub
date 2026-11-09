import { icon } from "./icons.js";
import { renderStudioDashboard } from "./dashboard.js";
import { renderApprovalPage } from "./approval-views.js";
import { escapeHtml as e, formatDuration } from "./model.js";
import { renderTaskPage } from "./task-views.js";
import { renderSidebar, renderTopbar } from "./navigation.js";

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
  return `${renderSidebar(s, pages)}<div class="shell">${renderTopbar(s, pages)}<main id="main-content" class="content" tabindex="-1">${renderPage(s)}</main></div>`;
}

function renderPage(s) {
  const header = `<div class="page-heading"><h1>${s.view === "overview" ? "自愈工作台" : pages[s.view].title}</h1><div class="row">${["overview", "tasks"].includes(s.view) ? `<button class="btn" data-action="refresh" aria-label="刷新工作台" title="刷新">${icon("RefreshCw", 15)}</button><button class="btn primary" data-action="new-task" ${!s.snapshot?.capabilities.trigger ? 'disabled title="执行引擎尚未接入"' : ""}>${icon("Plus", 14)}发起巡检</button>` : s.view === "activity" ? `<button class="btn" data-action="export" ${!s.snapshot ? "disabled" : ""}>${icon("Download", 14)}导出记录</button>` : s.view === "approvals" ? `<span class="studio-state review">${icon("LockKeyhole", 13)}${s.mode === "demo" ? "演示审批" : "只读审批"}</span>` : ""}</div></div>`;
  if (s.loading)
    return (
      header +
      `<div role="status" aria-label="正在读取配置" class="skeleton-block">${Array.from({ length: 4 }, () => `<div class="loading-row"><div class="loading-line"></div><div class="loading-line"></div></div>`).join("")}</div>`
    );
  if (!s.snapshot && s.view !== "settings") return header + connectionError(s);
  const views = {
    overview: renderStudioDashboard,
    approvals: renderApprovalPage,
    tasks: renderTaskPage,
    engines,
    rules,
    safety,
    activity,
    settings,
  };
  return header + views[s.view](s);
}
function connectionError(s) {
  return `<div class="inline-notice error"><strong>无法连接管理服务</strong><p>${e(s.error || "请确认管理服务已经启动。")}</p><div class="row"><button class="btn compact" ${action("refresh")}>${icon("RefreshCw", 13)}重新连接</button><button class="btn compact" ${action("mode", 'data-mode="demo"')}>查看演示</button></div></div>`;
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
  const demo = s.mode === "demo";
  const unavailable = Boolean(s.error) || !snap;
  const tone = unavailable ? "error" : demo ? "demo" : "connected";
  const status = unavailable ? "未连接" : demo ? "演示可用" : "已连接 · 只读";
  const sourceFile = (kind) => {
    if (!snap) return "未读取";
    if (demo) return "演示模板";
    const source = kind === "config" ? snap.configSource : snap.rulesSource;
    if (source === "configured") return `healing-${kind}.json`;
    if (source === "example") return `healing-${kind}.example.json`;
    return "未提供";
  };
  const demoActions =
    !unavailable &&
    ["trigger", "cancel", "retry", "approve"].some(
      (key) => snap?.capabilities?.[key] === true,
    );
  const readAt = snap?.generatedAt;
  return `<section class="connection-settings" aria-label="工作空间连接">
    <div class="cs-card">
      <header class="cs-header"><h2>数据来源</h2>${!unavailable ? `<button type="button" class="cs-refresh" ${action("refresh")} aria-label="刷新连接状态">${icon("RefreshCw", 14)}刷新</button>` : ""}</header>
      <div class="cs-sources" role="group" aria-label="选择数据来源">
        <button type="button" class="cs-source ${demo ? "is-active" : ""}" ${action("mode", 'data-mode="demo"')} aria-pressed="${demo}">${icon("FlaskConical", 19)}<span><strong>交互演示</strong><small>会话内模拟</small></span></button>
        <button type="button" class="cs-source ${!demo ? "is-active" : ""}" ${action("mode", 'data-mode="live"')} aria-pressed="${!demo}">${icon("Plug", 19)}<span><strong>管理服务</strong><small>同源只读配置</small></span></button>
      </div>
      ${unavailable ? `<div class="cs-error" role="alert">${icon("WifiOff", 18)}<div><strong>${demo ? "演示数据暂不可用" : "无法连接管理服务"}</strong><p>${e(s.error || "请启动管理服务后重新连接。")}</p></div><button type="button" class="cs-reconnect" ${action("refresh")}>${icon("RefreshCw", 13)}重新连接</button></div>` : ""}
      <dl class="cs-properties">
        <div><dt>项目</dt><dd class="cs-project">${e(snap?.project?.repo || "—")}</dd></div>
        <div><dt>分支</dt><dd><code>${e(snap?.project?.defaultBranch || "—")}</code></dd></div>
        <div><dt>连接状态</dt><dd><span class="cs-status ${tone}"><i aria-hidden="true"></i>${status}</span></dd></div>
        <div><dt>最近读取</dt><dd>${readAt ? `<time datetime="${e(readAt)}">${dateTime(readAt)}<span class="cs-timezone">UTC+8</span></time>` : "—"}</dd></div>
      </dl>
      <dl class="cs-capabilities" aria-label="可用能力">
        <div><dt>${demo ? "演示操作" : "配置读取"}</dt><dd class="${(!demo && !unavailable) || demoActions ? "is-available" : ""}">${unavailable ? "未连接" : demo && !demoActions ? "未开放" : "可用"}</dd></div>
        <div><dt>真实执行</dt><dd>未接入</dd></div>
      </dl>
      <details class="cs-details">
        <summary><span>${icon("Terminal", 15)}接入与接口信息</span>${icon("ChevronDown", 14)}</summary>
        <div class="cs-details-content">
          <div class="cs-setup"><h3>本地启动</h3><p>在仓库根目录运行：</p><pre><code>npm run dev</code></pre><p>默认地址 <code>http://127.0.0.1:8787</code></p></div>
          <dl class="cs-technical">
            <div><dt>管理接口</dt><dd><code>GET /api/healing/snapshot</code></dd></div>
            <div><dt>项目配置</dt><dd><code>${e(sourceFile("config"))}</code></dd></div>
            <div><dt>路由规则</dt><dd><code>${e(sourceFile("rules"))}</code></dd></div>
          </dl>
          <p class="cs-contract-note">真实执行、审批与回滚尚未接入，任务写入接口返回 501。</p>
        </div>
      </details>
    </div>
  </section>`;
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
