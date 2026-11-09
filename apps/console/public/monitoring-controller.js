import {
  DEMO_MONITORING_CONFIG,
  MONITORING_TIME_RANGES,
  MONITORING_ALL_SCOPE,
  normalizeMonitoringConfig,
  exportMonitoringConfig,
  buildGrafanaDashboard,
} from "./monitoring-model.js";
import { downloadJSON } from "./ui.js";

function formValues(config) {
  const normalized = normalizeMonitoringConfig(config);
  const grafana = normalized.grafana || {};
  const datasource = normalized.datasource || {};
  return {
    baseUrl: grafana.baseUrl || "",
    dashboardUid: grafana.dashboardUid || "",
    dashboardSlug: grafana.dashboardSlug || "healing-overview",
    datasourceUid: datasource.uid || "",
    datasourceName: datasource.name || "",
    namespaces: normalized.namespaces.join(", "),
    namespaceVariable: grafana.namespaceVariable || "namespace",
    datasourceVariable: grafana.datasourceVariable || "datasource",
    orgId: grafana.orgId ?? "",
  };
}

export function monitoringDraftConfig(values) {
  const grafana = {
    baseUrl: String(values.baseUrl || "").trim(),
    dashboardUid: String(values.dashboardUid || "").trim(),
    dashboardSlug:
      String(values.dashboardSlug || "").trim() || "healing-overview",
    namespaceVariable:
      String(values.namespaceVariable || "").trim() || "namespace",
    datasourceVariable:
      String(values.datasourceVariable || "").trim() || "datasource",
  };
  if (String(values.orgId || "").trim()) grafana.orgId = Number(values.orgId);
  return {
    grafana,
    datasource: {
      type: "prometheus",
      uid: String(values.datasourceUid || "").trim(),
      name: String(values.datasourceName || "").trim(),
    },
    namespaces: [
      ...new Set(
        String(values.namespaces || "")
          .split(/[\s,;，；]+/)
          .filter(Boolean),
      ),
    ],
  };
}

export function createMonitoringController({ state, render, toast }) {
  let currentKey = "",
    lastSnapshot = null;
  const sourceConfig = () =>
    state.mode === "demo" ? DEMO_MONITORING_CONFIG : state.snapshot?.monitoring;
  function setConfig(config, source) {
    state.monitoringConfig = normalizeMonitoringConfig(config);
    state.monitoringDraft = formValues(config);
    state.monitoringErrors = [];
    state.monitoringDirty = false;
    state.monitoringSource = source;
    state.monitoringScope = MONITORING_ALL_SCOPE;
    state.monitoringRange ||= "6h";
  }
  function reconcile() {
    if (state.loading) return;
    const key = `heal-monitoring-v1:${state.mode}:${state.snapshot?.project?.id || "unavailable"}`;
    if (key !== currentKey) {
      currentKey = key;
      let local = null;
      try {
        local = JSON.parse(localStorage.getItem(currentKey) || "null");
      } catch {}
      if (normalizeMonitoringConfig(local).status === "ready")
        setConfig(local, "local");
      else
        setConfig(sourceConfig(), state.mode === "demo" ? "example" : "server");
      lastSnapshot = state.snapshot;
    } else if (lastSnapshot !== state.snapshot) {
      lastSnapshot = state.snapshot;
      if (
        !state.monitoringDirty &&
        !["local", "session"].includes(state.monitoringSource)
      ) {
        const previousScope = state.monitoringScope;
        setConfig(sourceConfig(), state.mode === "demo" ? "example" : "server");
        if (state.monitoringConfig.namespaces.includes(previousScope))
          state.monitoringScope = previousScope;
      }
    }
  }
  function redraw(focus) {
    render();
    if (focus) document.querySelector(focus)?.focus({ preventScroll: true });
  }
  function handleInput(event) {
    if (!event.target.closest?.("#monitoring-form") || !event.target.name)
      return false;
    state.monitoringDraft[event.target.name] = event.target.value;
    state.monitoringDirty = true;
    // Preserve the composing input. Update only the saved-state sentence and dependent export button.
    const label = document.querySelector(".mon-save-state span");
    if (label) label.textContent = "有未保存的修改";
    const exportButton = document.querySelector(
      '[data-action="monitoring-export-config"]',
    );
    if (exportButton) {
      exportButton.disabled = true;
      exportButton.title = "请先保存当前修改";
    }
    const resetButton = document.querySelector(
      '[data-action="monitoring-reset"]',
    );
    if (resetButton) resetButton.disabled = false;
    return true;
  }
  function handleChange(event) {
    if (event.target.id === "monitoring-scope") {
      const value = event.target.value;
      if (
        value === MONITORING_ALL_SCOPE ||
        state.monitoringConfig.namespaces.includes(value)
      )
        state.monitoringScope = value;
    } else if (event.target.id === "monitoring-range") {
      if (MONITORING_TIME_RANGES.some((item) => item.id === event.target.value))
        state.monitoringRange = event.target.value;
    } else return false;
    redraw(`#${event.target.id}`);
    return true;
  }
  function handleSubmit(event) {
    if (event.target.id !== "monitoring-form") return false;
    event.preventDefault();
    state.monitoringDraft = Object.fromEntries(new FormData(event.target));
    const config = normalizeMonitoringConfig(
      monitoringDraftConfig(state.monitoringDraft),
    );
    if (config.status !== "ready") {
      state.monitoringErrors = config.errors;
      state.monitoringDirty = true;
      redraw('#monitoring-form [aria-invalid="true"]');
      return true;
    }
    const exported = exportMonitoringConfig(config).monitoring;
    let persisted = true;
    try {
      localStorage.setItem(currentKey, JSON.stringify(exported));
    } catch {
      persisted = false;
    }
    setConfig(exported, persisted ? "local" : "session");
    redraw('#monitoring-form button[type="submit"]');
    toast(
      persisted
        ? "字段校验通过，已保存到本机。尚未验证连接或应用到服务端。"
        : "字段校验通过，但浏览器无法保存；当前配置仅在本次会话有效。",
    );
    return true;
  }
  function handleClick(event, button) {
    if (!button || button.disabled) return false;
    const action = button.dataset.action;
    if (action === "monitoring-tab") {
      state.monitoringTab =
        button.dataset.tab === "configuration" ? "configuration" : "dashboard";
      redraw(`.mon-page-tabs [data-tab="${state.monitoringTab}"]`);
    } else if (action === "monitoring-configure") {
      state.monitoringTab = "configuration";
      return false; // app navigation owns the route.
    } else if (action === "monitoring-reset") {
      let removed = true;
      try {
        localStorage.removeItem(currentKey);
      } catch {
        removed = false;
      }
      if (!removed && state.monitoringSource === "local") {
        toast("无法清除浏览器草稿，请检查浏览器存储设置。");
        return true;
      }
      setConfig(sourceConfig(), state.mode === "demo" ? "example" : "server");
      redraw("#monitor-baseUrl");
      toast("已恢复来源配置；服务端配置未改变。");
    } else if (
      action === "monitoring-export-config" ||
      action === "monitoring-export-dashboard"
    ) {
      if (state.monitoringDirty) {
        toast("请先保存接入配置中的修改。");
        return true;
      }
      const payload =
        action === "monitoring-export-config"
          ? exportMonitoringConfig(state.monitoringConfig)
          : buildGrafanaDashboard(state.monitoringConfig);
      if (!payload) {
        toast("请先补全接入配置。");
        return true;
      }
      downloadJSON(
        payload,
        action === "monitoring-export-config"
          ? "healing-monitoring.config.json"
          : "healing-grafana-dashboard.json",
      );
      toast(
        action === "monitoring-export-config"
          ? "配置已导出；合并到服务端配置后生效。"
          : "仪表盘模板已导出，可导入 Grafana 后验证数据源和指标。",
      );
    } else return false;
    event.preventDefault();
    return true;
  }
  return { reconcile, handleInput, handleChange, handleSubmit, handleClick };
}
