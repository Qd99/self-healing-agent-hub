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

function configIdentity(config) {
  return JSON.stringify(normalizeMonitoringConfig(config));
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

export function createMonitoringController({
  state,
  render,
  toast,
  api,
  runMutation,
}) {
  let currentKey = "",
    lastSnapshot = null,
    checkGeneration = 0,
    draftEditGeneration = 0;
  const sourceConfig = () =>
    state.mode === "demo" ? DEMO_MONITORING_CONFIG : state.snapshot?.monitoring;
  function invalidateCheck() {
    checkGeneration += 1;
    state.monitoringCheck = null;
  }
  function setConfig(config, source) {
    const normalized = normalizeMonitoringConfig(config);
    if (configIdentity(state.monitoringConfig) !== configIdentity(normalized))
      invalidateCheck();
    state.monitoringConfig = normalized;
    state.monitoringDraft = formValues(config);
    state.monitoringErrors = [];
    state.monitoringDirty = false;
    state.monitoringSaveError = "";
    state.monitoringDraftRevision = state.snapshot?.revision;
    state.monitoringDraftConfigRevision =
      state.snapshot?.configRevisions?.monitoring;
    state.monitoringSource = source;
    state.monitoringScope = MONITORING_ALL_SCOPE;
    state.monitoringRange ||= "6h";
  }
  function reconcile() {
    if (state.loading) return;
    // A failed read is not a different project and must never erase its draft.
    if (!state.snapshot && currentKey) return;
    const key = `heal-monitoring-v1:${state.mode}:${state.snapshot?.project?.id || "unavailable"}`;
    if (key !== currentKey) {
      currentKey = key;
      invalidateCheck();
      let local = null;
      if (state.mode === "demo")
        try {
          local = JSON.parse(localStorage.getItem(currentKey) || "null");
        } catch {}
      if (normalizeMonitoringConfig(local).status === "ready")
        setConfig(local, "local");
      else
        setConfig(sourceConfig(), state.mode === "demo" ? "example" : "server");
      lastSnapshot = state.snapshot;
    } else if (lastSnapshot !== state.snapshot) {
      // A changed server config also invalidates checks while a draft is open.
      if (
        configIdentity(lastSnapshot?.monitoring) !==
        configIdentity(state.snapshot?.monitoring)
      )
        invalidateCheck();
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
    if (!state.monitoringDirty) {
      state.monitoringDraftRevision = state.snapshot?.revision;
      state.monitoringDraftConfigRevision =
        state.snapshot?.configRevisions?.monitoring;
    }
    state.monitoringDraft[event.target.name] = event.target.value;
    state.monitoringDirty = true;
    draftEditGeneration += 1;
    invalidateCheck();
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
    if (state.pendingAction || state.authRequired) return true;
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
    if (state.mode !== "demo") {
      if (
        !state.snapshot?.capabilities?.updateMonitoring ||
        !api ||
        !runMutation
      ) {
        state.monitoringSaveError = "当前会话没有修改监控配置的权限。";
        state.monitoringDirty = true;
        redraw();
        return true;
      }
      state.monitoringDirty = true;
      state.monitoringErrors = [];
      state.monitoringSaveError = "";
      const submitted = JSON.stringify(state.monitoringDraft);
      const submittedEdits = draftEditGeneration;
      const submittedRevision =
        state.monitoringDraftRevision ?? state.snapshot.revision;
      const submittedConfigRevision = state.monitoringDraftConfigRevision;
      invalidateCheck();
      void runMutation(
        "monitoring-save",
        () =>
          api.updateMonitoring({
            monitoring: exported,
            expectedRevision: submittedRevision,
            ...(Number.isSafeInteger(submittedConfigRevision)
              ? { expectedConfigRevision: submittedConfigRevision }
              : {}),
          }),
        {
          onSuccess() {
            const draft = state.monitoringDraft;
            const changed =
              draftEditGeneration !== submittedEdits &&
              JSON.stringify(draft) !== submitted;
            // The app may reject this response after accepting a newer snapshot.
            setConfig(state.snapshot.monitoring, "server");
            if (changed) {
              state.monitoringDraft = draft;
              state.monitoringDirty = true;
              // Do not silently rebase unsaved edits onto somebody else's config.
              if (
                configIdentity(state.snapshot.monitoring) !==
                configIdentity(exported)
              ) {
                state.monitoringDraftRevision = submittedRevision;
                state.monitoringDraftConfigRevision = submittedConfigRevision;
              }
            }
            lastSnapshot = state.snapshot;
            invalidateCheck();
          },
          onError(error) {
            state.monitoringSaveError = error.message;
            state.monitoringDirty = true;
            if (error.status === 409) state.monitoringDraftRevision = null;
            if (Array.isArray(error.fieldErrors))
              state.monitoringErrors = error.fieldErrors;
          },
        },
      );
      return true;
    }
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
    } else if (action === "monitoring-check") {
      if (
        state.mode === "demo" ||
        state.pendingAction ||
        state.authRequired ||
        state.monitoringDirty ||
        !api ||
        !runMutation
      )
        return true;
      invalidateCheck();
      const generation = checkGeneration;
      const config = configIdentity(state.monitoringConfig);
      const projectId = state.snapshot?.project?.id;
      const revision = state.snapshot?.revision;
      const isCurrent = () =>
        generation === checkGeneration &&
        state.mode === "live" &&
        state.snapshot?.project?.id === projectId &&
        !state.monitoringDirty &&
        configIdentity(state.monitoringConfig) === config &&
        configIdentity(state.snapshot?.monitoring) === config;
      void runMutation("monitoring-check", () => api.checkMonitoring(), {
        onSuccess(result) {
          if (!isCurrent()) return;
          // The server can check a newer saved config before this tab refreshes.
          if (
            !Object.hasOwn(result, "monitoring") ||
            !Number.isSafeInteger(result.revision) ||
            result.revision < revision ||
            configIdentity(result.monitoring) !== config
          ) {
            toast("检查结果与当前配置不一致，请刷新后重新检查连接。");
            return;
          }
          state.monitoringCheck = result.check;
        },
        onError(error) {
          if (!isCurrent()) return;
          state.monitoringCheck = {
            status: "error",
            checkedAt: new Date().toISOString(),
            message: error.message,
          };
        },
      });
    } else if (action === "monitoring-reset") {
      if (state.pendingAction) return true;
      let removed = true;
      if (state.mode === "demo")
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
          ? state.mode === "demo"
            ? "配置已导出；合并到服务端配置后生效。"
            : "已导出当前服务端监控配置。"
          : "仪表盘模板已导出，可导入 Grafana 后验证数据源和指标。",
      );
    } else return false;
    event.preventDefault();
    return true;
  }
  return { reconcile, handleInput, handleChange, handleSubmit, handleClick };
}
