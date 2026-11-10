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
  overviewTab: "focus",
  days: 7,
  expandedTask: "",
  selectedTask: "",
  detailTab: "trace",
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
  setSnapshot(next) {
    state.snapshot = next;
    demoSnapshot = next;
  },
});
const administrationController = createAdministrationController({
  state,
  render,
  toast,
  openRule,
  openActivity,
  setSnapshot(next) {
    state.snapshot = next;
    demoSnapshot = next;
  },
});
const monitoringController = createMonitoringController({
  state,
  render,
  toast,
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
  const item = currentTask();
  if (item && detailDialog.open)
    detailDialog.innerHTML = renderTaskDetail(item, state);
}
function closeDetail() {
  if (detailDialog.open) detailDialog.close();
  state.selectedTask = "";
}
function closeCreate() {
  if (createDialog.open) createDialog.close();
}
function restoreFocus() {
  if (lastFocus?.isConnected) lastFocus.focus();
  else document.querySelector("#main-content")?.focus({ preventScroll: true });
}
detailDialog.addEventListener("close", restoreFocus);
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
  if (!detailDialog.open) lastFocus = document.activeElement;
  detailDialog.innerHTML = renderActivityDetail(entry, state);
  if (!detailDialog.open) detailDialog.showModal();
  detailDialog.querySelector('[data-action="close-detail"]')?.focus();
}
function openCreate() {
  if (state.mode !== "demo" || !state.snapshot?.capabilities.trigger) {
    toast("真实执行器尚未接入。");
    return;
  }
  lastFocus = document.activeElement;
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
async function loadData(mode = state.mode) {
  const seq = ++loadSequence;
  abortController?.abort();
  abortController = new AbortController();
  closeDetail();
  closeCreate();
  taskController.reset(mode !== state.mode);
  if (mode !== state.mode) administrationController.reset();
  state.mode = mode;
  state.error = "";
  state.loading = true;
  state.snapshot = null;
  render();
  if (mode === "demo") {
    demoSnapshot ||= createDemoSnapshot();
    state.snapshot = demoSnapshot;
    state.loading = false;
    state.expandedTask =
      state.snapshot.tasks.find((t) => t.reviewState === "pending")?.task.id ||
      "";
    render();
    return;
  }
  const timeout = setTimeout(() => abortController?.abort(), 10000);
  try {
    const response = await fetch("/api/healing/snapshot", {
      headers: { Accept: "application/json" },
      cache: "no-store",
      credentials: "same-origin",
      signal: abortController.signal,
    });
    const isJson = response.headers
      .get("content-type")
      ?.includes("application/json");
    if (!isJson)
      throw new Error(
        "当前站点尚未提供管理接口，请启动管理服务后，从服务地址打开工作台。",
      );
    const data = await response.json();
    if (!response.ok)
      throw new Error(
        data?.error?.message || `管理服务返回 ${response.status}`,
      );
    const snapshot = verifySnapshot(data);
    if (seq !== loadSequence) return;
    state.snapshot = snapshot;
    state.expandedTask = "";
  } catch (error) {
    if (seq !== loadSequence) return;
    state.error =
      error.name === "AbortError"
        ? "连接超过 10 秒，请检查管理服务是否可访问。"
        : error.message;
  } finally {
    clearTimeout(timeout);
    if (seq === loadSequence) {
      state.loading = false;
      render();
    }
  }
}

function runDemoAction(command, id, payload) {
  try {
    if (state.mode !== "demo") throw new Error("真实写操作尚未接入。");
    state.snapshot = applyDemoAction(state.snapshot, {
      type: command,
      id,
      payload,
    });
    demoSnapshot = state.snapshot;
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
            : "已刷新管理服务配置",
        state.error ? "error" : "success",
      );
      document
        .querySelector('[data-action="refresh"]')
        ?.focus({ preventScroll: true });
    });
  } else if (action === "task-action") {
    const next = runDemoAction(command, id);
    if (next && command === "retry") openTask(next.tasks[0].task.id);
  } else if (action === "search") {
    go("tasks");
    requestAnimationFrame(() =>
      document.querySelector("#task-search")?.focus(),
    );
  }
});

document.addEventListener("input", (event) => {
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
    try {
      if (state.mode !== "demo" || !state.snapshot?.capabilities.approve)
        throw new Error("真实审批写接口尚未接入。");
      const next = applyDemoAction(state.snapshot, {
        type: command,
        id: form.dataset.taskId,
        payload: {
          nodeId: form.dataset.nodeId,
          round: Number(values.round || form.dataset.round),
          comment: state.approvalComment,
        },
      });
      state.snapshot = next;
      demoSnapshot = next;
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
  const next = runDemoAction("trigger", undefined, payload);
  if (next) {
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
