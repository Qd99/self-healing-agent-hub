import { createDemoSnapshot, applyDemoAction } from "./data.js";
import { filterTasks } from "./model.js";
import { getApprovalFlow } from "./approvals.js";
import {
  pages,
  renderShell,
  renderTaskDetail,
  renderCreate,
  renderRuleDetail,
  taskTable,
} from "./views.js";

const app = document.querySelector("#app");
const detailDialog = document.querySelector("#detail-dialog");
const createDialog = document.querySelector("#create-dialog");
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
const state = {
  view: pages[location.hash.slice(1)] ? location.hash.slice(1) : "overview",
  mode: requestedMode === "demo" ? "demo" : "live",
  theme: readTheme() === "dark" ? "dark" : "light",
  snapshot: null,
  error: "",
  loading: true,
  overviewTab: "focus",
  days: 7,
  query: "",
  status: "all",
  expandedTask: "",
  selectedTask: "",
  detailTab: "trace",
  mobileNav: false,
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
  document.documentElement.dataset.theme = state.theme;
  app.innerHTML = renderShell(state);
  const canvas = document.querySelector(".af-canvas-scroll");
  flowResizeObserver.disconnect();
  if (canvas) {
    fitFlowCanvas(canvas);
    canvas.scrollLeft = flowScroll;
    flowResizeObserver.observe(canvas);
  }
}
function toast(message) {
  clearTimeout(toastTimer);
  toastElement.textContent = message;
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
  if (location.hash !== `#${view}`) history.pushState(null, "", `#${view}`);
  state.view = view;
  render();
  window.scrollTo({ top: 0 });
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
        "此地址没有提供管理 API。请在仓库运行 npm run dev，或选择交互演示。",
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
  const button = event.target.closest("[data-action]");
  if (!button || button.disabled) return;
  const { action, id, tab, view, mode, command, theme } = button.dataset;
  if (action === "theme") {
    state.theme = theme === "dark" ? "dark" : "light";
    try {
      localStorage.setItem("heal-theme", state.theme);
    } catch {}
    render();
    refreshDetail();
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
  else if (action === "select-approval") selectApproval(id);
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
  else if (action === "refresh") loadData();
  else if (action === "task-action") {
    const next = runDemoAction(command, id);
    if (next && command === "retry") openTask(next.tasks[0].task.id);
  } else if (action === "toggle-rule") runDemoAction("toggle-rule", id);
  else if (action === "rule-detail") {
    const rule = state.snapshot?.rules.find((r) => r.id === id);
    if (!rule) return;
    state.selectedTask = "";
    lastFocus = document.activeElement;
    detailDialog.innerHTML = renderRuleDetail(rule);
    detailDialog.showModal();
    detailDialog.querySelector(".icon-button")?.focus();
  } else if (action === "search") {
    go("tasks");
    requestAnimationFrame(() =>
      document.querySelector("#task-search")?.focus(),
    );
  } else if (action === "export") {
    if (!state.snapshot) return;
    const blob = new Blob(
      [
        JSON.stringify(
          {
            mode: state.mode,
            exportedAt: new Date().toISOString(),
            activity: state.snapshot.activity,
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `heal-activity-${state.mode}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("活动记录已导出。");
  }
});

document.addEventListener("input", (event) => {
  if (["approval-comment", "resubmit-comment"].includes(event.target.id)) {
    state.approvalComment = event.target.value;
    return;
  }
  if (event.target.id !== "task-search") return;
  state.query = event.target.value;
  const results = document.querySelector("#task-results");
  if (results && state.snapshot) {
    const tasks = filterTasks(state.snapshot.tasks, {
      query: state.query,
      status: state.status,
      days: state.days,
    });
    results.innerHTML =
      taskTable(tasks) +
      `<p class="table-total" role="status">${tasks.length} 项任务 · 按创建时间筛选 · Asia/Shanghai</p>`;
  }
});
document.addEventListener("change", (event) => {
  if (event.target.id === "period") {
    state.days = [1, 7, 30].includes(Number(event.target.value))
      ? Number(event.target.value)
      : 7;
    render();
    document.querySelector("#period")?.focus();
  }
  if (event.target.id === "status-filter") {
    state.status = event.target.value;
    render();
    document.querySelector("#status-filter")?.focus();
  }
});
document.addEventListener("submit", (event) => {
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
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    if (detailDialog.open || createDialog.open) return;
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
  const focused = event.target.closest('[role="tab"]');
  if (
    focused &&
    ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
  ) {
    event.preventDefault();
    const tabs = [
      ...focused.closest('[role="tablist"]').querySelectorAll('[role="tab"]'),
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
for (const dialog of [detailDialog, createDialog])
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
render();
loadData();
