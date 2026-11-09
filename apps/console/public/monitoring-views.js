import { icon } from "./icons.js";
import { escapeHtml as e } from "./model.js";
import {
  uiButton,
  uiSelect,
  uiStatus,
  uiEmpty,
  uiTabs,
  uiField,
  uiMetric,
} from "./ui.js";
import {
  normalizeMonitoringConfig,
  buildGrafanaUrl,
  MONITORING_TIME_RANGES,
  MONITORING_ALL_SCOPE,
} from "./monitoring-model.js";

const fieldErrors = {
  "grafana.baseUrl": "填写有效的 HTTPS 基础地址，不包含账号、查询参数或锚点。",
  "grafana.dashboardUid":
    "填写仪表盘 UID，使用 1–40 位字母、数字、短横线或下划线。",
  "grafana.dashboardSlug": "使用字母、数字、短横线或下划线，最多 120 位。",
  "grafana.namespaceVariable":
    "填写变量名，不包含 var- 前缀，且不能以 __ 开头。",
  "grafana.datasourceVariable":
    "填写独立的数据源变量名，不能与命名空间变量同名。",
  "grafana.orgId": "组织 ID 需为正整数；不需要时留空。",
  "datasource.uid": "填写 Prometheus 数据源的 UID，名称不能替代 UID。",
  "datasource.name": "名称最多 160 个字符，不包含控制字符。",
  namespaces: "填写明确的命名空间，用逗号或换行分隔；不支持 * 或通配范围。",
};
const errorFor = (s, key) =>
  s.monitoringErrors?.some((item) => item.field === key)
    ? fieldErrors[key] || "请检查该字段。"
    : "";
const sourceLabel = (s) =>
  s.monitoringSource === "local"
    ? "本机草稿"
    : s.monitoringSource === "session"
      ? "会话草稿"
      : s.mode === "demo"
        ? "示例配置"
        : s.snapshot
          ? "服务端配置"
          : "未读取配置";

export function currentMonitoring(s) {
  return normalizeMonitoringConfig(
    s.monitoringConfig ?? s.snapshot?.monitoring,
  );
}

export function monitoringLink(s) {
  const config = currentMonitoring(s);
  const range =
    MONITORING_TIME_RANGES.find((item) => item.id === s.monitoringRange) ||
    MONITORING_TIME_RANGES[2];
  return buildGrafanaUrl(config, {
    namespaces:
      (s.monitoringScope || MONITORING_ALL_SCOPE) === MONITORING_ALL_SCOPE
        ? config.namespaces
        : [s.monitoringScope],
    from: range.from,
    to: range.to,
  });
}

function externalButton(s, className = "") {
  const url = monitoringLink(s);
  const placeholder = url && new URL(url).hostname.endsWith(".invalid");
  if (!url || placeholder)
    return uiButton({
      label: "打开 Grafana",
      icon: "ArrowUpRight",
      disabled: true,
      title: placeholder
        ? "当前为示例地址，请先填写你的 Grafana 配置。"
        : "完成接入配置后可打开仪表盘。",
      className,
    });
  return `<a class="ui-button ${e(className)}" href="${e(url)}" target="_blank" rel="noopener noreferrer" title="在新标签页打开 Grafana，需有相应访问权限">${icon("ArrowUpRight", 15)}打开 Grafana</a>`;
}

function renderDashboard(s) {
  const config = currentMonitoring(s);
  const configured = config.status === "ready";
  const placeholder =
    configured && new URL(config.grafana.baseUrl).hostname.endsWith(".invalid");
  const scope = config.namespaces.includes(s.monitoringScope)
    ? s.monitoringScope
    : MONITORING_ALL_SCOPE;
  const namespaces =
    scope === MONITORING_ALL_SCOPE ? config.namespaces : [scope];
  const datasourceName =
    config.datasource?.name ||
    (config.datasource?.uid ? "Prometheus" : "未配置数据源");
  const previewTitle = placeholder
    ? "示例预览 · 尚未查询指标"
    : config.status === "invalid"
      ? "接入配置需要修正"
      : configured
        ? "连接与指标尚未验证"
        : "尚未接入监控";
  const previewDescription = placeholder
    ? "替换示例配置后，在 Grafana 中验证连接与指标。"
    : config.status === "invalid"
      ? "当前未查询指标，请检查 Grafana 地址、数据源 UID 与命名空间。"
      : configured
        ? "此处不查询实时数据，请在 Grafana 中查看所选范围的指标。"
        : "绑定 Grafana、数据源 UID 与命名空间；当前未查询指标。";
  return `<div class="mon-dashboard">
    <section class="ui-card mon-overview" aria-label="Grafana 面板布局预览，未查询指标">
      <div class="mon-toolbar">
        <div class="mon-control"><span class="mon-control-label">${icon("Boxes", 14)}命名空间</span>${uiSelect({ id: "monitoring-scope", value: scope, label: "监控命名空间", disabled: !configured, options: [{ value: MONITORING_ALL_SCOPE, label: configured ? `全部已配置 · ${config.namespaces.length}` : "尚未配置命名空间" }, ...config.namespaces.map((value) => ({ value, label: value }))] })}</div>
        <div class="mon-control"><span class="mon-control-label">${icon("Clock3", 14)}时间范围</span>${uiSelect({ id: "monitoring-range", value: s.monitoringRange || "6h", label: "监控时间范围", disabled: !configured, options: MONITORING_TIME_RANGES.map(({ id, label }) => ({ value: id, label })) })}</div>
        <div class="mon-source"><span class="mon-control-label">${icon("Database", 14)}Prometheus 数据源</span><div class="mon-source-value"><strong title="${e(datasourceName)}">${e(datasourceName)}</strong><code title="${e(config.datasource?.uid || "尚未绑定 UID")}">${e(config.datasource?.uid ? `UID · ${config.datasource.uid}` : "尚未绑定 UID")}</code></div></div>
        ${externalButton(s, "mon-open-grafana")}
      </div>
      <div class="mon-summary" aria-label="抓取指标与已配置范围">
        ${uiMetric({ label: "可抓取目标", value: "—", unit: "个", icon: "Activity" })}
        ${uiMetric({ label: "抓取异常", value: "—", unit: "个", icon: "CircleAlert" })}
        ${uiMetric({ label: "已配置命名空间", value: configured ? config.namespaces.length : 0, unit: "个", icon: "Boxes", detail: configured ? `当前范围 · ${namespaces.length} 个` : "配置后可按范围筛选" })}
      </div>
      <section class="mon-chart-panel">
        <header><h2>${icon("ChartNoAxesCombined", 16)}目标抓取状态</h2><span class="mon-panel-caption">Grafana 布局预览</span></header>
        <div class="mon-chart-empty"><div class="mon-chart-grid" aria-hidden="true"><i></i><i></i><i></i><i></i></div>${uiEmpty(
          {
            icon: placeholder
              ? "FlaskConical"
              : config.status === "invalid"
                ? "CircleAlert"
                : "Plug",
            title: previewTitle,
            description: previewDescription,
            className: "mon-chart-message",
            action: `${uiButton({ label: "配置接入", icon: "Settings2", action: "monitoring-tab", attrs: 'data-tab="configuration"', variant: "primary" })}${uiButton({ label: "导出仪表盘模板", icon: "Download", action: "monitoring-export-dashboard", variant: "ghost", disabled: !configured || s.monitoringDirty, title: s.monitoringDirty ? "请先保存接入配置中的修改" : !configured ? "完成接入配置后可导出模板" : "导入 Grafana 后验证数据源与指标" })}`,
          },
        )}</div>
        <footer class="mon-scope-footer"><div class="mon-namespace-tags"><span class="mon-footer-label">当前范围</span>${namespaces.length ? namespaces.map((namespace) => `<span class="mon-namespace">${icon("Box", 12)}${e(namespace)}</span>`).join("") : '<span class="mon-no-scope">尚未配置</span>'}</div><span class="mon-config-source">${icon(s.mode === "demo" && s.monitoringSource === "example" ? "FlaskConical" : s.monitoringSource === "local" || s.monitoringSource === "session" ? "Laptop" : "Database", 13)}${e(sourceLabel(s))}</span></footer>
      </section>
    </section>
    <details class="mon-integration-note"><summary>${icon("CircleHelp", 14)}指标与范围说明${icon("ChevronDown", 13)}</summary><p>抓取指标使用带 namespace 标签的 Prometheus up 数据；抓取成功不代表 Agent 健康。范围筛选仅影响仪表盘，不改变 Agent 的监听范围。</p></details>
  </div>`;
}

function renderConfiguration(s) {
  const draft = s.monitoringDraft || {};
  const value = (key) => draft[key] ?? "";
  const fields = (key, options) =>
    uiField({
      id: `monitor-${key}`,
      name: key,
      value: value(key),
      error: errorFor(s, options.path || key),
      ...options,
      attrs: 'autocomplete="off" spellcheck="false"',
    });
  const configured = currentMonitoring(s).status === "ready";
  return `<form id="monitoring-form" class="ui-card mon-config" novalidate>
    <header class="mon-config-header"><div class="mon-config-title"><span class="mon-config-mark">${icon("Plug", 20)}</span><div><h2>Grafana 接入</h2><p>绑定范围与数据源，保存为本机配置草稿。</p></div></div>${uiStatus({ label: sourceLabel(s), icon: s.monitoringSource === "local" ? "Laptop" : s.mode === "demo" ? "FlaskConical" : "Database", tone: "neutral" })}</header>
    ${s.mode === "demo" && s.monitoringSource === "example" ? '<div class="mon-demo-note">当前字段为示例，请替换成你环境中的实际值。</div>' : ""}
    <section class="mon-config-section"><div class="mon-section-label">${icon("ChartNoAxesCombined", 17)}<h3>Grafana</h3></div><div class="mon-fields">
      ${fields("baseUrl", { label: "服务地址", placeholder: "https://grafana.your-domain.com", required: true, path: "grafana.baseUrl", className: "mon-field-wide" })}
      ${fields("dashboardUid", { label: "仪表盘 UID", placeholder: "例如 healing-overview", required: true, path: "grafana.dashboardUid", hint: "仪表盘地址中 /d/ 后的标识。" })}
      ${fields("dashboardSlug", { label: "仪表盘路径名称", placeholder: "healing-overview", path: "grafana.dashboardSlug", hint: "仪表盘地址中 UID 后的名称。" })}
    </div></section>
    <section class="mon-config-section"><div class="mon-section-label">${icon("Database", 17)}<h3>Prometheus 数据源</h3></div><div class="mon-fields">
      ${fields("datasourceUid", { label: "数据源 UID", placeholder: "Grafana 中的数据源 UID", required: true, path: "datasource.uid", hint: "用于面板查询与变量绑定。" })}
      ${fields("datasourceName", { label: "数据源名称", placeholder: "例如 Prometheus", path: "datasource.name", hint: "用于展示，请与 Grafana 中的名称保持一致。" })}
    </div></section>
    <section class="mon-config-section"><div class="mon-section-label">${icon("Boxes", 17)}<h3>监控命名空间</h3></div><div class="mon-fields"><label class="ui-field mon-field-wide" for="monitor-namespaces"><span class="ui-field-label">命名空间<span class="ui-required" aria-hidden="true">*</span></span><textarea class="ui-textarea" id="monitor-namespaces" name="namespaces" rows="2" required autocomplete="off" spellcheck="false" placeholder="healing-system, production" aria-describedby="monitor-namespaces-hint" ${errorFor(s, "namespaces") ? 'aria-invalid="true"' : ""}>${e(value("namespaces"))}</textarea><span class="ui-field-hint ${errorFor(s, "namespaces") ? "is-error" : ""}" id="monitor-namespaces-hint">${e(errorFor(s, "namespaces") || "多个命名空间用逗号或换行分隔，仅在已配置范围内筛选。")}</span></label></div></section>
    <details class="mon-advanced" ${s.monitoringErrors?.some((item) => ["grafana.orgId", "grafana.namespaceVariable", "grafana.datasourceVariable"].includes(item.field)) ? "open" : ""}><summary>高级配置<span>变量映射与组织</span>${icon("ChevronDown", 14)}</summary><div class="mon-fields">
      ${fields("namespaceVariable", { label: "命名空间变量", placeholder: "namespace", path: "grafana.namespaceVariable", hint: "对应仪表盘变量名，不包含 var-。" })}
      ${fields("datasourceVariable", { label: "数据源变量", placeholder: "datasource", path: "grafana.datasourceVariable", hint: "使用 Prometheus 类型的数据源变量。" })}
      ${fields("orgId", { label: "组织 ID（可选）", type: "number", placeholder: "使用 Grafana 当前组织", path: "grafana.orgId" })}
    </div></details>
    <footer class="mon-config-footer"><div role="status" class="mon-save-state">${s.monitoringErrors?.length ? `${icon("CircleAlert", 14)}<span>请检查标记的字段</span>` : `${icon(s.monitoringDirty ? "CircleDashed" : "Laptop", 14)}<span>${s.monitoringDirty ? "有未保存的修改" : s.monitoringSource === "local" ? "已保存到本机，未应用到服务端" : s.monitoringSource === "session" ? "仅本次会话可用，未应用到服务端" : "保存为本机配置草稿"}</span>`}</div><div class="ui-toolbar-actions">${uiButton({ label: "恢复来源配置", action: "monitoring-reset", variant: "ghost", disabled: !s.monitoringDirty && !["local", "session"].includes(s.monitoringSource) })}${uiButton({ label: "导出配置", icon: "Download", action: "monitoring-export-config", disabled: !configured || s.monitoringDirty, title: s.monitoringDirty ? "请先保存当前修改" : "下载配置片段，合并到服务端配置后生效" })}${uiButton({ label: "保存到本机", icon: "Check", type: "submit", variant: "primary" })}</div></footer>
  </form>`;
}

export function renderMonitoringPage(s) {
  return `<section class="mon-workspace" aria-label="监控面板"><div class="mon-page-tabs">${uiTabs(
    {
      items: [
        { id: "dashboard", label: "面板预览" },
        { id: "configuration", label: "接入配置" },
      ],
      value: s.monitoringTab || "dashboard",
      action: "monitoring-tab",
      label: "监控视图",
    },
  )}</div>${s.monitoringTab === "configuration" ? renderConfiguration(s) : renderDashboard(s)}</section>`;
}
