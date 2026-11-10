import { createApiClient } from "./api-client.js";
import { createDemoSnapshot, applyDemoAction } from "./data.js";
import { createTaskController } from "./task-controller.js";
import { createAdministrationController } from "./administration-controller.js";
import { renderActivityDetail } from "./administration-views.js";
import { createMonitoringController } from "./monitoring-controller.js";
import { installInteractionFeedback } from "./interaction.js";
import { uiStatus } from "./ui.js";
import { getApprovalFlow } from "./approvals.js";
import {
  pages,
  renderShell,
  renderTaskDetail,
  renderCreate,
  renderRuleDetail,
} from "./views.js";

const api = createApiClient();
const app = document.querySelector("#app");
const detailDialog = document.querySelector("#detail-dialog");
const createDialog = document.querySelector("#create-dialog");
const bulkDialog = document.querySelector("#bulk-dialog");
const mobileViewport = window.matchMedia("(max-width: 650px)");
const toastElement = document.querySelector("#toast");
const requestedMode =
  new URLSearchParams(location.search).get("demo") === "1"
    ? "demo"
    : document.querySelector('meta[name="console-default-mode"]').content;
const readTheme = () => {
  try {
    return localStorage.getItem("heal-theme") || "light";
  } catch {
    return "light";
  }
};
const readSidebar = () => {
  try {
    return localStorage.getItem("heal-sidebar-collapsed") === "1";
  } catch {
    return false;
  }
};
const state = {
  view: pages[location.hash.slice(1)] ? location.hash.slice(1) : "overview",
  mode: requestedMode === "demo" ? "demo" : "live",
  theme: readTheme() === "dark" ? "dark" : "light",
  snapshot: null,
  error: "",
  loading: true,
  refreshing: false,
  pendingAction: "",
  authRequired: false,
  authError: "",
  authPending: false,
  createDraft: null,
  createError: "",
  overviewTab: "focus",
  days: 7,
  expandedTask: "",
  selectedTask: "",
  detailTab: "trace",
  reconciliationDraft: null,
  reconciliationError: "",
  reconciliationSuccess: "",
  mobileNav: false,
  sidebarCollapsed: readSidebar(),
  approvalTaskId: "",
  approvalNodeId: "",
  approvalTab: "flow",
  approvalFilter: "pending",
  approvalError: "",
  approvalComment: "",
  flowZoom: 1,
};
let demoSnapshot = null;
let abortController = null;
let loadSequence = 0;
let toastTimer;
let lastFocus = null;
installInteractionFeedback();
const taskController = createTaskController({
  state,
  render,
  toast,
  bulkDialog,
  setSnapshot,
  api,
  runMutation,
});
const administrationController = createAdministrationController({
  state,
  render,
  toast,
  openRule,
  openActivity,
  setSnapshot,
  api,
  runMutation,
});
const monitoringController = createMonitoringController({
  state,
  render,
  toast,
  api,
  runMutation,
});
const flowResizeObserver = new ResizeObserver((entries) => {
  for (const { target } of entries) fitFlowCanvas(target);
});

function fitFlowCanvas(canvas) {
  const space = canvas.querySelector(".af-canvas-space");
  if (!space) return;
  // Fit desktop workflows to the available pane; retain readable nodes on phones.
  const fit = Math.min(1, Math.max(0.75, (canvas.clientWidth - 16) / 930));
  space.style.setProperty("--af-fit", String(fit));
}

function render() {
  const active = document.activeElement;
  const focusId = active?.id;
  const selection =
    active && typeof active.selectionStart === "number"
      ? [active.selectionStart, active.selectionEnd]
      : null;
  const flowScroll =
    document.querySelector(".af-canvas-scroll")?.scrollLeft || 0;
  taskController.reconcile();
  administrationController.reconcile();
  monitoringController.reconcile();
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.dataset.view = state.view;
  document.documentElement.dataset.sidebar =
    state.sidebarCollapsed && !mobileViewport.matches
      ? "collapsed"
      : "expanded";
  app.innerHTML = renderShell(state);
  taskController.afterRender();
  const mobileOpen = mobileViewport.matches && state.mobileNav;
  document.body.classList.toggle("nav-overlay-open", mobileOpen);
  const sidebar = document.querySelector(".sidebar"),
    shell = document.querySelector(".shell");
  sidebar.inert = mobileViewport.matches && !mobileOpen;
  shell.inert = mobileOpen;
  if (mobileOpen) {
    sidebar.setAttribute("role", "dialog");
    sidebar.setAttribute("aria-modal", "true");
  }

  const canvas = document.querySelector(".af-canvas-scroll");
  flowResizeObserver.disconnect();
  if (canvas) {
    fitFlowCanvas(canvas);
    canvas.scrollLeft = flowScroll;
    flowResizeObserver.observe(canvas);
  }
  if (focusId && !active?.isConnected) {
    const replacement = document.getElementById(focusId);
    replacement?.focus({ preventScroll: true });
    if (selection && replacement?.setSelectionRange)
      try {
        replacement.setSelectionRange(...selection);
      } catch {}
  }
}
function toast(message, tone = "neutral") {
  clearTimeout(toastTimer);
  toastElement.innerHTML = uiStatus({
    label: message,
    tone,
    icon:
      tone === "success"
        ? "CircleCheck"
        : tone === "error"
          ? "CircleAlert"
          : "Info",
  });
  toastElement.classList.add("show");
  toastTimer = setTimeout(() => toastElement.classList.remove("show"), 3500);
}
function currentTask() {
  return state.snapshot?.tasks.find((t) => t.task.id === state.selectedTask);
}
function refreshDetail() {
  if (!detailDialog.open) return;
  const active = document.activeElement;
  const focused = detailDialog.contains(active) ? active : null;
  const scrollSelector = ".detail-content, .diff-lines, .log-lines";
  const scroll = [...detailDialog.querySelectorAll(scrollSelector)].map(
    (element) => [element.scrollTop, element.scrollLeft],
  );
  const receiptOpen = detailDialog.querySelector(".task-receipts")?.open;
  const selection =
    focused && typeof focused.selectionStart === "number"
      ? [focused.selectionStart, focused.selectionEnd]
      : null;
  const item = currentTask();
  const rule = state.snapshot?.rules.find(
    (entry) => entry.id === state.selectedRule,
  );
  const activity = state.snapshot?.activity.find(
    (entry) => entry.id === state.selectedActivity,
  );
  if (item) detailDialog.innerHTML = renderTaskDetail(item, state);
  else if (rule) detailDialog.innerHTML = renderRuleDetail(rule, state);
  else if (activity)
    detailDialog.innerHTML = renderActivityDetail(activity, state);
  if (receiptOpen) {
    const receipts = detailDialog.querySelector(".task-receipts");
    if (receipts) receipts.open = true;
  }
  if (focused) {
    const replacement = [
      ...detailDialog.querySelectorAll(
        "[data-action],a[href],input,textarea,select,button,summary",
      ),
    ].find((element) =>
      focused.id
        ? element.id === focused.id
        : element.tagName === focused.tagName &&
          ["action", "tab", "command", "id"].every(
            (key) => element.dataset[key] === focused.dataset[key],
          ) &&
          element.getAttribute("href") === focused.getAttribute("href"),
    );
    replacement?.focus({ preventScroll: true });
    if (selection && replacement?.setSelectionRange)
      try {
        replacement.setSelectionRange(...selection);
      } catch {}
  }
  [...detailDialog.querySelectorAll(scrollSelector)].forEach(
    (element, index) => {
      if (!scroll[index]) return;
      [element.scrollTop, element.scrollLeft] = scroll[index];
    },
  );
}
function refreshCreate() {
  if (createDialog.open) createDialog.innerHTML = renderCreate(state);
}
function refreshWorkspace() {
  render();
  refreshDetail();
  refreshCreate();
}
function closeDetail() {
  if (detailDialog.open) detailDialog.close();
  state.selectedTask = "";
  state.selectedRule = "";
  state.selectedActivity = "";
  state.reconciliationDraft = null;
}
function closeCreate() {
  if (createDialog.open) createDialog.close();
}
function restoreFocus() {
  if (lastFocus?.isConnected) lastFocus.focus();
  else document.querySelector("#main-content")?.focus({ preventScroll: true });
}
detailDialog.addEventListener("close", () => {
  state.reconciliationDraft = null;
  restoreFocus();
});
createDialog.addEventListener("close", restoreFocus);
detailDialog.addEventListener("cancel", () => {
  state.selectedTask = "";
});

function openTask(id, tab = "trace") {
  const item = state.snapshot?.tasks.find((t) => t.task.id === id);
  if (!item) {
    toast("这项任务已不存在。");
    return;
  }
  state.selectedTask = id;
  state.reconciliationDraft = null;
  state.reconciliationError = "";
  state.reconciliationSuccess = "";
  state.selectedRule = "";
  state.selectedActivity = "";
  state.detailTab = ["trace", "diff", "evidence", "logs"].includes(tab)
    ? tab
    : "trace";
  if (!detailDialog.open) lastFocus = document.activeElement;
  detailDialog.innerHTML = renderTaskDetail(item, state);
  if (!detailDialog.open) detailDialog.showModal();
  detailDialog.querySelector('[data-action="close-detail"]')?.focus();
}
function openRule(id) {
  const rule = state.snapshot?.rules.find((item) => item.id === id);
  if (!rule) return;
  state.selectedTask = "";
  state.selectedRule = id;
  state.selectedActivity = "";
  if (!detailDialog.open) lastFocus = document.activeElement;
  detailDialog.innerHTML = renderRuleDetail(rule, state);
  if (!detailDialog.open) detailDialog.showModal();
  detailDialog.querySelector('[data-action="close-detail"]')?.focus();
}
function openActivity(id) {
  const entries = state.snapshot?.activity;
  const entry = Array.isArray(entries)
    ? entries.find((item) => item?.id === id)
    : null;
  if (!entry) {
    toast("这条操作记录已不存在。");
    return;
  }
  state.selectedTask = "";
  state.selectedRule = "";
  state.selectedActivity = id;
  if (!detailDialog.open) lastFocus = document.activeElement;
  detailDialog.innerHTML = renderActivityDetail(entry, state);
  if (!detailDialog.open) detailDialog.showModal();
  detailDialog.querySelector('[data-action="close-detail"]')?.focus();
}
function openCreate() {
  if (
    !state.snapshot?.capabilities.trigger ||
    state.pendingAction ||
    state.authRequired
  ) {
    toast("当前会话没有创建任务的权限。");
    return;
  }
  lastFocus = document.activeElement;
  state.createDraft ||= {
    title: "",
    type: "type-error",
    priority: "medium",
    branch: state.snapshot.project.defaultBranch,
  };
  createDialog.innerHTML = renderCreate(state);
  createDialog.showModal();
  createDialog.querySelector("#task-title").focus();
}
function go(view) {
  if (!pages[view]) return;
  closeDetail();
  closeCreate();
  state.mobileNav = false;
  taskController.onNavigate();
  administrationController.onNavigate();
  if (location.hash !== `#${view}`) history.pushState(null, "", `#${view}`);
  state.view = view;
  render();
  window.scrollTo({ top: 0 });
  document.querySelector("#main-content")?.focus({ preventScroll: true });
}
function selectApproval(id, nodeId) {
  const item = state.snapshot?.tasks.find((t) => t.task.id === id);
  if (!item) {
    toast("这项审批请求已不存在。");
    return;
  }
  const flow = getApprovalFlow(item);
  if (state.approvalTaskId !== id) state.approvalComment = "";
  state.approvalTaskId = id;
  state.approvalNodeId = nodeId || flow.currentNodeId || "";
  state.approvalTab = "flow";
  state.approvalError = "";
  if (flow.status !== "pending") state.approvalFilter = "all";
  go("approvals");
  document
    .querySelector(".af-node.is-selected")
    ?.focus({ preventScroll: true });
}
window.addEventListener("hashchange", () => {
  state.view = pages[location.hash.slice(1)]
    ? location.hash.slice(1)
    : "overview";
  state.mobileNav = false;
  taskController.onNavigate();
  administrationController.onNavigate();
  closeDetail();
  closeCreate();
  render();
  window.scrollTo({ top: 0 });
});

function verifySnapshot(s) {
  if (
    !s ||
    s.apiVersion !== 1 ||
    s.mode !== "live" ||
    !s.project ||
    typeof s.project.repo !== "string" ||
    typeof s.project.id !== "string" ||
    typeof s.project.defaultBranch !== "string" ||
    !s.capabilities ||
    !s.safety ||
    !s.triggers ||
    !Array.isArray(s.tasks) ||
    !Array.isArray(s.rules) ||
    !Array.isArray(s.engines) ||
    !Array.isArray(s.activity)
  )
    throw new Error("管理接口返回的格式不符合 v1 数据契约。");
  const known = [
    "pending",
    "running",
    "completed",
    "failed",
    "cancelled",
    "skipped",
  ];
  for (const t of s.tasks) {
    if (
      !t.task?.id ||
      !t.task.payload ||
      !t.task.metadata ||
      !known.includes(t.status?.status) ||
      typeof t.title !== "string" ||
      !Array.isArray(t.trace) ||
      !Array.isArray(t.diff)
    )
      throw new Error("任务数据缺少必要字段，请检查接口契约。");
  }
  for (const r of s.rules) {
    if (!r.id || typeof r.name !== "string" || !r.match || !r.processor)
      throw new Error("路由规则格式不完整。");
  }
  return s;
}
function setSnapshot(next) {
  if (!next || next.mode !== state.mode) return false;
  if (next.mode === "live") {
    verifySnapshot(next);
    if (
      state.snapshot?.mode === "live" &&
      state.snapshot.project.id === next.project.id &&
      Number.isSafeInteger(state.snapshot.revision) &&
      Number.isSafeInteger(next.revision) &&
      next.revision < state.snapshot.revision
    )
      return false;
    api.setSnapshot(next);
    state.authRequired = false;
    state.authError = "";
  } else demoSnapshot = next;
  const projectChanged =
    state.snapshot && state.snapshot.project.id !== next.project.id;
  if (projectChanged) {
    taskController.reset(true);
    administrationController.reset();
    closeDetail();
    closeCreate();
    state.createDraft = null;
    state.approvalComment = "";
  }
  state.snapshot = next;
  state.error = "";
  return true;
}
function requireAuthentication(error) {
  state.authRequired = true;
  state.authError = error?.message || "登录已过期，请重新输入管理令牌。";
  state.resumeCreate = createDialog.open || state.resumeCreate;
  if (detailDialog.open) detailDialog.close();
  closeCreate();
  if (bulkDialog.open) bulkDialog.close();
}
async function loadData(mode = state.mode, { background = false } = {}) {
  if (state.authPending) return;
  if (state.pendingAction && mode !== state.mode) return;
  const seq = ++loadSequence;
  abortController?.abort();
  const controller = new AbortController();
  abortController = controller;
  const changed = mode !== state.mode;
  if (changed) {
    closeDetail();
    closeCreate();
    taskController.reset(true);
    administrationController.reset();
    state.snapshot = null;
    state.authRequired = false;
    state.approvalComment = "";
    state.createDraft = null;
  }
  state.mode = mode;
  state.loading = !state.snapshot;
  state.refreshing = Boolean(state.snapshot);
  if (!background) state.error = "";
  if (!background) render();
  if (mode === "demo") {
    demoSnapshot ||= createDemoSnapshot();
    setSnapshot(demoSnapshot);
    state.loading = false;
    state.refreshing = false;
    refreshWorkspace();
    return;
  }
  try {
    const snapshot = await api.getSnapshot({ signal: controller.signal });
    if (seq !== loadSequence) return;
    setSnapshot(snapshot);
  } catch (error) {
    if (seq !== loadSequence || error.name === "AbortError") return;
    state.error = error.message;
    if (error.status === 401) requireAuthentication(error);
  } finally {
    if (seq === loadSequence) {
      state.loading = false;
      state.refreshing = false;
      refreshWorkspace();
    }
  }
}
async function runMutation(key, request, { onSuccess, onError } = {}) {
  if (state.pendingAction || state.authRequired || state.mode !== "live")
    return null;
  const mode = state.mode;
  const projectId = state.snapshot?.project.id;
  state.pendingAction = key;
  state.error = "";
  refreshWorkspace();
  try {
    const result = await request();
    if (state.mode !== mode || state.snapshot?.project.id !== projectId)
      return null;
    if (result.snapshot) setSnapshot(result.snapshot);
    const showSuccess = onSuccess?.(result) !== false;
    if (showSuccess && result.message) toast(result.message, "success");
    return result;
  } catch (error) {
    onError?.(error);
    if (error.status === 401) requireAuthentication(error);
    if (error.status === 409) await loadData(state.mode, { background: true });
    toast(error.message, "error");
    return null;
  } finally {
    state.pendingAction = "";
    refreshWorkspace();
  }
}
async function authenticate(form) {
  if (state.authPending) return;
  const token = String(new FormData(form).get("token") || "").trim();
  if (!token) return;
  loadSequence += 1;
  abortController?.abort();
  abortController = null;
  state.loading = false;
  state.refreshing = false;
  state.authPending = true;
  state.authError = "";
  render();
  try {
    const result = await api.createSession(token);
    setSnapshot(result.snapshot);
    state.loading = false;
    if (state.resumeCreate) {
      state.resumeCreate = false;
      openCreate();
    }
    toast(result.message || "已连接管理服务", "success");
  } catch (error) {
    state.authRequired = true;
    state.authError = error.message;
  } finally {
    state.authPending = false;
    refreshWorkspace();
    if (state.authRequired) document.getElementById("session-token")?.focus();
  }
}

function runDemoAction(command, id, payload) {
  try {
    if (state.mode !== "demo") throw new Error("演示操作只能在演示模式运行。");
    const next = applyDemoAction(state.snapshot, {
      type: command,
      id,
      payload,
    });
    setSnapshot(next);
    render();
    refreshDetail();
    if (detailDialog.open)
      detailDialog.querySelector('[data-action="close-detail"]')?.focus();
    toast(state.snapshot.activity[0].message);
    return state.snapshot;
  } catch (error) {
    toast(error.message);
    return null;
  }
}

document.addEventListener("click", (event) => {
  if (event.target.closest(".skip-link")) {
    event.preventDefault();
    document.querySelector("#main-content")?.focus();
    return;
  }
  const navLink = event.target.closest('.sidebar a[href^="#"]');
  if (navLink) {
    event.preventDefault();
    go(navLink.getAttribute("href").slice(1));
    document.querySelector("#main-content")?.focus({ preventScroll: true });
    return;
  }
  const button = event.target.closest("[data-action]");
  if (taskController.handleClick(event, button)) return;
  if (administrationController.handleClick(event, button)) return;
  if (monitoringController.handleClick(event, button)) return;
  if (!button || button.disabled) return;
  const { action, id, tab, view, mode, command, theme } = button.dataset;
  if (action === "sidebar-toggle") {
    state.sidebarCollapsed = !state.sidebarCollapsed;
    try {
      localStorage.setItem(
        "heal-sidebar-collapsed",
        state.sidebarCollapsed ? "1" : "0",
      );
    } catch {}
    render();
    document
      .querySelector('[data-action="sidebar-toggle"]')
      ?.focus({ preventScroll: true });
  } else if (action === "theme") {
    state.theme = theme === "dark" ? "dark" : "light";
    try {
      localStorage.setItem("heal-theme", state.theme);
    } catch {}
    render();
    refreshDetail();
    document.querySelector(".sidebar-theme")?.focus({ preventScroll: true });
  } else if (action === "open-nav") {
    state.mobileNav = true;
    render();
    document.querySelector(".sidebar-close")?.focus();
  } else if (action === "close-nav") {
    event.preventDefault();
    state.mobileNav = false;
    render();
    document.querySelector(".mobile-menu")?.focus();
  } else if (action === "navigate") go(view);
  else if (action === "dashboard-filter") {
    if (
      taskController.applyReportFilter({
        dimension: button.dataset.dimension,
        value: button.dataset.value,
        days: state.days,
      })
    )
      go("tasks");
  } else if (action === "monitoring-configure") {
    go("monitoring");
    const field = [
      "monitor-baseUrl",
      "monitor-datasourceUid",
      "monitor-namespaces",
    ].includes(button.dataset.field)
      ? button.dataset.field
      : "monitor-baseUrl";
    document.getElementById(field)?.focus({ preventScroll: true });
  } else if (action === "select-approval") selectApproval(id);
  else if (action === "flow-node") {
    const nodeId = button.dataset.nodeId;
    if (state.view !== "approvals" || state.approvalTaskId !== id)
      selectApproval(id, nodeId);
    else {
      state.approvalNodeId = nodeId;
      state.approvalError = "";
      render();
      document
        .querySelector(".af-node.is-selected")
        ?.focus({ preventScroll: true });
    }
  } else if (action === "approval-tab") {
    state.approvalTab = ["flow", "diff", "history"].includes(tab)
      ? tab
      : "flow";
    render();
    document
      .querySelector(
        `[data-action="approval-tab"][data-tab="${state.approvalTab}"]`,
      )
      ?.focus({ preventScroll: true });
  } else if (action === "approval-filter") {
    state.approvalFilter = button.dataset.filter === "all" ? "all" : "pending";
    if (state.approvalFilter === "pending") {
      const first = state.snapshot?.tasks.find(
        (t) => getApprovalFlow(t).status === "pending",
      );
      state.approvalTaskId = first?.task.id || "";
      state.approvalNodeId = "";
      state.approvalComment = "";
    }
    state.approvalError = "";
    render();
    document
      .querySelector(
        `[data-action="approval-filter"][data-filter="${state.approvalFilter}"]`,
      )
      ?.focus({ preventScroll: true });
  } else if (action === "flow-zoom") {
    const direction = button.dataset.direction;
    state.flowZoom =
      direction === "reset"
        ? 1
        : Math.max(
            0.75,
            Math.min(
              1.25,
              Math.round(
                (state.flowZoom + (direction === "in" ? 0.1 : -0.1)) * 100,
              ) / 100,
            ),
          );
    render();
    document
      .querySelector(`[data-action="flow-zoom"][data-direction="${direction}"]`)
      ?.focus({ preventScroll: true });
  } else if (action === "overview-tab") {
    state.overviewTab = tab;
    render();
    document
      .querySelector(`[data-action="overview-tab"][data-tab="${tab}"]`)
      ?.focus();
  } else if (action === "expand-task") {
    state.expandedTask = state.expandedTask === id ? "" : id;
    render();
    document
      .querySelector(`[data-action="expand-task"][data-id="${CSS.escape(id)}"]`)
      ?.focus();
  } else if (action === "open-task") openTask(id, tab);
  else if (action === "close-detail") closeDetail();
  else if (action === "detail-tab") {
    state.detailTab = tab;
    refreshDetail();
    detailDialog
      .querySelector(`[data-action="detail-tab"][data-tab="${tab}"]`)
      ?.focus();
  } else if (action === "new-task") openCreate();
  else if (action === "close-create") closeCreate();
  else if (action === "mode") loadData(mode === "demo" ? "demo" : "live");
  else if (action === "refresh") {
    const expectedSequence = loadSequence + 1;
    loadData().then(() => {
      if (loadSequence !== expectedSequence) return;
      toast(
        state.error
          ? `刷新失败：${state.error}`
          : state.mode === "demo"
            ? "已刷新演示工作空间"
            : "已刷新任务与管理服务数据",
        state.error ? "error" : "success",
      );
      document
        .querySelector('[data-action="refresh"]')
        ?.focus({ preventScroll: true });
    });
  } else if (action === "session-logout") {
    void runMutation("session-logout", () => api.deleteSession(), {
      onSuccess() {
        loadSequence += 1;
        abortController?.abort();
        state.snapshot = null;
        state.authRequired = true;
        state.authError = "";
        state.createDraft = null;
        state.approvalComment = "";
        state.monitoringDirty = false;
        closeDetail();
        closeCreate();
        taskController.reset(true);
      },
    });
  } else if (action === "task-action") {
    if (
      state.pendingAction ||
      state.authRequired ||
      !state.snapshot?.capabilities[command]
    )
      return;
    const entry = state.snapshot.tasks.find((item) => item.task.id === id);
    if (!entry || !["retry", "cancel"].includes(command)) return;
    if (command === "retry" && entry.reconciliation?.status === "required") {
      toast("任务待核对，请先记录核对结论。", "error");
      return;
    }
    if (state.mode === "live") {
      void runMutation(
        `task:${command}:${id}`,
        () => api.taskAction(id, command, { expectedRevision: entry.revision }),
        {
          onSuccess(result) {
            if (command === "retry" && result.taskId) openTask(result.taskId);
          },
        },
      );
    } else {
      const next = runDemoAction(command, id);
      if (next && command === "retry") openTask(next.tasks[0].task.id);
    }
  } else if (action === "search") {
    go("tasks");
    requestAnimationFrame(() =>
      document.querySelector("#task-search")?.focus(),
    );
  }
});

function captureReconciliationDraft(target) {
  const form = target.closest?.("#reconciliation-form");
  if (!form || !["outcome", "note"].includes(target.name)) return false;
  if (state.pendingAction) return true;
  const entry = currentTask();
  if (!entry || entry.task.id !== form.dataset.taskId) return true;
  state.reconciliationDraft ||= {
    taskId: entry.task.id,
    expectedRevision: entry.revision,
    outcome: "",
    note: "",
  };
  state.reconciliationDraft[target.name] = target.value;
  state.reconciliationError = "";
  state.reconciliationSuccess = "";
  return true;
}

document.addEventListener("input", (event) => {
  if (captureReconciliationDraft(event.target)) return;
  if (event.target.closest?.("#create-form") && event.target.name) {
    if (state.pendingAction === "trigger") return;
    state.createDraft ||= {};
    state.createDraft[event.target.name] = event.target.value;
    return;
  }
  if (administrationController.handleInput(event)) return;
  if (monitoringController.handleInput(event)) return;
  if (["approval-comment", "resubmit-comment"].includes(event.target.id)) {
    state.approvalComment = event.target.value;
    return;
  }
  taskController.handleInput(event);
});
document.addEventListener("compositionend", (event) => {
  if (administrationController.handleCompositionEnd(event)) return;
  if (event.target.id === "task-search") taskController.handleInput(event);
});
document.addEventListener("change", (event) => {
  if (captureReconciliationDraft(event.target)) return;
  if (event.target.closest?.("#create-form") && event.target.name) {
    if (state.pendingAction === "trigger") return;
    state.createDraft ||= {};
    state.createDraft[event.target.name] = event.target.value;
    return;
  }
  if (administrationController.handleChange(event)) return;
  if (monitoringController.handleChange(event)) return;
  if (taskController.handleChange(event)) return;
  if (event.target.id === "period") {
    state.days = [1, 7, 30].includes(Number(event.target.value))
      ? Number(event.target.value)
      : 7;
    render();
    document.querySelector("#period")?.focus({ preventScroll: true });
  }
});

document.addEventListener("submit", (event) => {
  if (event.target.id === "reconciliation-form") {
    event.preventDefault();
    const id = event.target.dataset.taskId;
    const entry = currentTask();
    if (
      !entry ||
      entry.task.id !== id ||
      state.mode !== "live" ||
      state.pendingAction ||
      state.authRequired ||
      !state.snapshot?.capabilities.reconcile ||
      entry.reconciliation?.status !== "required"
    )
      return;
    const values = Object.fromEntries(new FormData(event.target));
    const expectedRevision =
      state.reconciliationDraft?.expectedRevision ?? entry.revision;
    state.reconciliationDraft = {
      taskId: id,
      expectedRevision,
      outcome: String(values.outcome || ""),
      note: String(values.note || ""),
    };
    const { outcome } = state.reconciliationDraft;
    const note = state.reconciliationDraft.note.trim();
    state.reconciliationSuccess = "";
    if (
      !["no-changes", "changes-recorded"].includes(outcome) ||
      !note ||
      Array.from(note).length > 1000
    ) {
      state.reconciliationError =
        "请选择核对结论，并填写 1–1000 字的核对说明。";
      refreshDetail();
      return;
    }
    state.reconciliationError = "";
    void runMutation(
      `reconcile:${id}`,
      () => api.reconcileTask(id, { expectedRevision, outcome, note }),
      {
        onSuccess() {
          const required =
            state.snapshot?.tasks.find((item) => item.task.id === id)
              ?.reconciliation?.status === "required";
          const message = required
            ? "任务已有新证据，请核对最新记录后再次提交结论。"
            : "";
          if (required) toast(message, "warning");
          if (state.selectedTask !== id) return !required;
          state.reconciliationDraft = null;
          state.reconciliationError = message;
          state.reconciliationSuccess = required
            ? ""
            : "核对结论已保存，可根据任务当前状态决定是否重试。";
          return !required;
        },
        onError(error) {
          if (state.selectedTask === id)
            state.reconciliationError =
              error.message +
              (error.status === 409
                ? " 请关闭并重新打开详情，核对最新证据后再提交。"
                : "");
        },
      },
    );
    return;
  }
  if (event.target.id === "session-form") {
    event.preventDefault();
    void authenticate(event.target);
    return;
  }
  if (monitoringController.handleSubmit(event)) return;
  if (
    ["approval-decision-form", "approval-resubmit-form"].includes(
      event.target.id,
    )
  ) {
    event.preventDefault();
    const form = event.target;
    const values = Object.fromEntries(new FormData(form));
    const command =
      form.id === "approval-resubmit-form"
        ? "resubmit-approval"
        : event.submitter?.value;
    if (!["approve-gate", "reject-gate", "resubmit-approval"].includes(command))
      return;
    state.approvalComment = String(values.comment || "");
    if (
      state.pendingAction ||
      state.authRequired ||
      !state.snapshot?.capabilities.approve
    )
      return;
    if (state.mode === "live") {
      const id = form.dataset.taskId;
      const entry = state.snapshot.tasks.find((item) => item.task.id === id);
      if (!entry) return;
      state.approvalError = "";
      const decision = {
        "approve-gate": "approve",
        "reject-gate": "reject",
        "resubmit-approval": "resubmit",
      }[command];
      const comment = state.approvalComment.trim();
      if (
        (decision !== "approve" && !comment) ||
        Array.from(comment).length > 500
      ) {
        state.approvalError = "请填写 1–500 字的原因或说明";
        render();
        return;
      }
      void runMutation(
        `approval:${id}`,
        () =>
          api.decideApproval(id, {
            decision,
            nodeId: form.dataset.nodeId,
            round: Number(values.round || form.dataset.round),
            comment,
            expectedRevision: entry.revision,
          }),
        {
          onSuccess() {
            const flow = getApprovalFlow(
              state.snapshot.tasks.find((item) => item.task.id === id),
            );
            state.approvalTaskId = id;
            state.approvalNodeId =
              flow.currentNodeId ||
              (decision === "reject" ? form.dataset.nodeId : "execute");
            if (flow.status !== "pending") state.approvalFilter = "all";
            state.approvalComment = "";
            state.approvalError = "";
          },
          onError(error) {
            state.approvalError = error.message;
          },
        },
      );
      return;
    }
    try {
      if (state.mode !== "demo" || !state.snapshot?.capabilities.approve)
        throw new Error("当前没有演示审批权限。");
      const next = applyDemoAction(state.snapshot, {
        type: command,
        id: form.dataset.taskId,
        payload: {
          nodeId: form.dataset.nodeId,
          round: Number(values.round || form.dataset.round),
          comment: state.approvalComment,
        },
      });
      setSnapshot(next);
      state.approvalTaskId = form.dataset.taskId;
      const flow = getApprovalFlow(
        next.tasks.find((t) => t.task.id === state.approvalTaskId),
      );
      state.approvalNodeId =
        flow.currentNodeId ||
        (command === "reject-gate" ? form.dataset.nodeId : "execute");
      if (flow.status !== "pending") state.approvalFilter = "all";
      state.approvalError = "";
      state.approvalComment = "";
      render();
      document
        .querySelector(".af-node.is-selected")
        ?.focus({ preventScroll: true });
      toast(next.activity[0].message);
    } catch (error) {
      state.approvalError = error.message;
      render();
      document
        .querySelector("#approval-comment, #resubmit-comment")
        ?.focus({ preventScroll: true });
    }
    return;
  }
  if (event.target.id !== "create-form") return;
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(event.target));
  state.createDraft = payload;
  if (
    state.pendingAction ||
    state.authRequired ||
    !state.snapshot?.capabilities.trigger
  )
    return;
  state.createError = "";
  if (state.mode === "live") {
    void runMutation("trigger", () => api.triggerTask(payload), {
      onSuccess(result) {
        state.createDraft = null;
        closeCreate();
        go("tasks");
        if (result.taskId) openTask(result.taskId);
      },
      onError(error) {
        state.createError = error.message;
      },
    });
    return;
  }
  const next = runDemoAction("trigger", undefined, payload);
  if (next) {
    state.createDraft = null;
    closeCreate();
    state.overviewTab = "running";
    go("overview");
    openTask(next.tasks[0].task.id);
  } else {
    const field = document.querySelector("#form-error");
    if (field) field.textContent = "任务未创建，请检查必填字段。";
  }
});
document.addEventListener("keydown", (event) => {
  if (state.mobileNav && mobileViewport.matches) {
    if (event.key === "Escape") {
      event.preventDefault();
      state.mobileNav = false;
      render();
      document.querySelector(".mobile-menu")?.focus();
      return;
    }
    if (event.key === "Tab") {
      const focusables = [
        ...document.querySelectorAll(
          ".sidebar a, .sidebar button:not([disabled])",
        ),
      ].filter((el) => el.getClientRects().length);
      const first = focusables[0],
        last = focusables.at(-1);
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !document.activeElement.closest(".sidebar"))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !document.activeElement.closest(".sidebar"))
      ) {
        event.preventDefault();
        first?.focus();
      }
    }
    if (event.ctrlKey || event.metaKey) return;
  }
  if (taskController.handleKeydown(event)) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    if (detailDialog.open || createDialog.open || bulkDialog.open) return;
    event.preventDefault();
    go("tasks");
    requestAnimationFrame(() =>
      document.querySelector("#task-search")?.focus(),
    );
  }
  if (event.key === "Escape" && state.mobileNav) {
    state.mobileNav = false;
    render();
    document.querySelector(".mobile-menu")?.focus();
  }
  const focused = event.target.closest(
    '[role="tab"], [data-action="overview-tab"]',
  );
  if (
    focused &&
    ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
  ) {
    event.preventDefault();
    const tabs = [
      ...focused
        .closest('[role="tablist"], [role="group"]')
        .querySelectorAll('[role="tab"], [data-action="overview-tab"]'),
    ];
    const index = tabs.indexOf(focused);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
            tabs.length;
    tabs[next].click();
  }
});
for (const dialog of [detailDialog, createDialog, bulkDialog])
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      dialog.close();
  });
mobileViewport.addEventListener("change", () => {
  if (!mobileViewport.matches) state.mobileNav = false;
  render();
});
render();
loadData();
// Poll only when it cannot interrupt input or a confirmation workflow.
setInterval(() => {
  const active = document.activeElement;
  if (
    state.mode !== "live" ||
    document.hidden ||
    state.authRequired ||
    state.loading ||
    state.refreshing ||
    state.pendingAction ||
    state.monitoringDirty ||
    state.approvalComment ||
    state.reconciliationDraft ||
    createDialog.open ||
    bulkDialog.open ||
    (detailDialog.open && !state.selectedTask) ||
    active?.matches?.("input,textarea,select,[contenteditable='true']")
  )
    return;
  void loadData("live", { background: true });
}, 15000);
