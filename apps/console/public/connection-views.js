import { icon } from "./icons.js";
import { escapeHtml as e } from "./model.js";
import { normalizeMonitoringConfig } from "./monitoring-model.js";
import { uiButton, uiStatus } from "./ui.js";

const readTime = (value) => {
  if (!Number.isFinite(Date.parse(value || ""))) return "尚未读取";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
};
const property = (name, value) =>
  `<div><dt>${e(name)}</dt><dd>${value}</dd></div>`;
function sourceFile(snapshot, kind) {
  if (!snapshot) return "尚未读取";
  if (snapshot.mode === "demo") return "开发测试夹具";
  const source =
    kind === "config" ? snapshot.configSource : snapshot.rulesSource;
  return source === "configured"
    ? `healing-${kind}.json`
    : source === "example"
      ? `healing-${kind}.example.json`
      : "未提供";
}
const configureButton = (service, field) =>
  uiButton({
    label: "配置",
    icon: "ArrowUpRight",
    action: "monitoring-configure",
    variant: "ghost",
    className: "cs-configure",
    attrs: `aria-label="配置 ${e(service)}" data-field="${e(field)}"`,
  });

export function renderSessionForm(s) {
  return `<section class="ui-card cs-session" aria-label="管理服务登录"><h2>${icon("LockKeyhole", 18)}连接管理服务</h2><p>输入管理令牌建立当前浏览器会话。</p><form id="session-form"><label class="ui-field" for="session-token"><span class="ui-field-label">管理令牌</span><input class="ui-input" id="session-token" name="token" type="password" required autocomplete="off" spellcheck="false" ${s.authPending ? "disabled" : ""}></label>${s.authError ? `<p class="form-error" role="alert">${e(s.authError)}</p>` : ""}<div class="form-actions">${uiButton({ label: s.authPending ? "连接中…" : "登录", icon: "ArrowRight", type: "submit", variant: "primary", loading: s.authPending })}</div></form><p class="cs-contract-note">令牌不会保存到浏览器本地存储。</p></section>`;
}

export function renderConnectionSettings(s) {
  const demo = s.mode === "demo";
  const snapshot = !s.loading ? s.snapshot : null;
  const connected = Boolean(snapshot) && !demo && !s.authRequired;
  const monitoring = normalizeMonitoringConfig(
    s.monitoringConfig ?? snapshot?.monitoring,
  );
  const configured = monitoring.status === "ready";
  const grafanaChecked = s.monitoringCheck?.checks?.grafana;
  const datasourceChecked = s.monitoringCheck?.checks?.datasource;
  const monitoringSource =
    s.monitoringSource === "local"
      ? "本机草稿"
      : s.monitoringSource === "session"
        ? "会话草稿"
        : demo
          ? "开发测试配置"
          : "服务端配置";
  const monitoringLabel = configured
    ? monitoringSource
    : monitoring.status === "invalid"
      ? "待完善"
      : "未配置";
  const status = s.loading
    ? "检查中"
    : demo
      ? "开发预览"
      : connected
        ? "配置已读取"
        : "未连接";
  const lastRead = snapshot?.generatedAt;
  return `<section class="connection-settings" aria-label="工作空间连接">
    <section class="ui-card cs-connections" aria-label="服务连接">
      <header class="cs-list-heading"><h2>服务连接</h2><span>状态</span><span class="sr-only">连接操作</span></header>
      <div class="cs-service cs-management">
        <span class="cs-service-icon cs-icon-hub" aria-hidden="true">${icon("Plug", 21)}</span>
        <div class="cs-service-copy"><h3>管理服务</h3><p>${connected ? e(snapshot.project.repo) : "任务、审批与项目配置"}</p></div>
        <div class="cs-service-status">${uiStatus({ label: status, tone: connected ? "success" : "neutral", icon: s.loading ? "LoaderCircle" : undefined })}</div>
        ${uiButton({ label: s.loading ? "检查中" : "检查连接", icon: "RefreshCw", action: "refresh", variant: "default", loading: s.loading || s.refreshing, className: "cs-connect", attrs: 'aria-label="检查管理服务连接"' })}
      </div>
      <details class="cs-connection-details">
        <summary><span>${icon("SlidersHorizontal", 14)}连接详情</span>${icon("ChevronDown", 14)}</summary>
        <div class="cs-detail-content"><dl class="cs-info-grid">
          ${property("项目", e(snapshot?.project?.repo || "尚未读取"))}
          ${property("默认分支", `<code>${e(snapshot?.project?.defaultBranch || "尚未读取")}</code>`)}
          ${property("最近读取 · 北京时间", lastRead && Number.isFinite(Date.parse(lastRead)) ? `<time datetime="${e(lastRead)}">${readTime(lastRead)}</time>` : "尚未读取")}
          ${property("访问能力", connected ? (Object.values(snapshot.capabilities || {}).some(Boolean) ? `已登录 · ${e(snapshot.auth?.actor || "管理员")}` : "配置只读") : demo ? "开发预览 · 会话内模拟" : "等待管理服务")}
        </dl>${connected && snapshot.auth?.required ? uiButton({ label: "退出登录", action: "session-logout", variant: "ghost", disabled: Boolean(s.pendingAction) }) : ""}${s.error ? `<p class="cs-connection-message" role="status">${icon("Info", 14)}<span>${e(s.error)}</span></p>` : ""}</div>
      </details>
      <div class="cs-service">
        <span class="cs-service-icon cs-icon-grafana" aria-hidden="true">${icon("ChartNoAxesCombined", 21)}</span>
        <div class="cs-service-copy"><h3>Grafana</h3><p>${configured ? e(monitoring.grafana.baseUrl) : "仪表盘与监控视图"}</p></div>
        <div class="cs-service-status">${uiStatus({ label: monitoringLabel, tone: "neutral" })}${configured ? `<small>${grafanaChecked === "ok" ? "最近连接检查通过" : grafanaChecked === "error" ? "最近连接检查未通过" : "尚未验证连接"}</small>` : ""}</div>
        ${configureButton("Grafana", "monitor-baseUrl")}
      </div>
      <div class="cs-service">
        <span class="cs-service-icon cs-icon-prometheus" aria-hidden="true">${icon("Database", 21)}</span>
        <div class="cs-service-copy"><h3>Prometheus</h3><p>${configured ? `${e(monitoring.datasource.name || "Prometheus")}<span class="cs-meta-separator">·</span><span class="cs-datasource-uid">UID ${e(monitoring.datasource.uid)}</span>` : "指标数据源 · UID 与名称"}</p></div>
        <div class="cs-service-status">${uiStatus({ label: monitoringLabel, tone: "neutral" })}${configured ? `<small>${datasourceChecked === "ok" ? "数据源已核对 · 指标尚未查询" : datasourceChecked === "error" ? "数据源检查未通过" : "尚未验证指标"}</small>` : ""}</div>
        ${configureButton("Prometheus", "monitor-datasourceUid")}
      </div>
      <div class="cs-scope-row"><div>${icon("Boxes", 15)}<span>监控命名空间</span></div><p>${configured ? monitoring.namespaces.map((value) => `<span class="cs-namespace">${e(value)}</span>`).join("") : "尚未设置"}</p>${uiButton({ label: "设置范围", action: "monitoring-configure", variant: "ghost", attrs: 'data-field="monitor-namespaces"', className: "cs-scope-action" })}</div>
    </section>
    <details class="cs-guide">
      <summary><span>${icon("Terminal", 15)}接入说明</span>${icon("ChevronDown", 14)}</summary>
      <div class="cs-guide-content">
        <div class="cs-guide-start"><h3>管理服务</h3><p>在项目目录启动服务，再从服务地址打开工作台。</p><pre><code>npm run dev</code></pre><p>默认地址 <code>http://127.0.0.1:8787</code></p></div>
        <dl class="cs-technical">${property("读取接口", "<code>GET /api/healing/snapshot</code>")}${property("项目配置", `<code>${e(sourceFile(snapshot, "config"))}</code>`)}${property("路由规则", `<code>${e(sourceFile(snapshot, "rules"))}</code>`)}</dl>
        <p class="cs-contract-note">任务、审批与监控配置由管理服务保存。Agent 领取任务并回传执行证据；Grafana 连接需单独检查。</p>
        ${demo ? '<p class="cs-contract-note">当前通过开发者参数加载虚构测试数据，不代表真实任务与服务状态。</p>' : ""}
      </div>
    </details>
  </section>`;
}
