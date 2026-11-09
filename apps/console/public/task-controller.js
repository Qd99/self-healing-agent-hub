import {
  DEFAULT_TASK_FILTERS,
  getTaskList,
  planBulkAction,
  applyDemoBulkAction,
  exportTasksCSV,
} from "./task-model.js";
import { renderBulkDialog } from "./task-views.js";

const PREF_KEY = "heal-task-display-v1";
const rowMenuSelector = (id) =>
  `[data-action="task-row-menu"][data-id="${CSS.escape(id)}"]`;
const selectorFor = (el) => {
  if (!(el instanceof Element)) return "";
  if (el.id) return `#${CSS.escape(el.id)}`;
  if (!el.dataset.action) return "";
  return (
    el.tagName.toLowerCase() +
    ["action", "id", "column", "density", "status", "type", "sort", "page"]
      .filter((k) => el.dataset[k] !== undefined)
      .map((k) => `[data-${k}="${CSS.escape(el.dataset[k])}"]`)
      .join("")
  );
};

export function createTaskController({
  state,
  render,
  toast,
  bulkDialog,
  setSnapshot,
}) {
  let preferences = {};
  try {
    preferences = JSON.parse(localStorage.getItem(PREF_KEY) || "{}") || {};
  } catch {}
  Object.assign(state, {
    taskFilters: { ...DEFAULT_TASK_FILTERS },
    taskSort: "created-desc",
    taskPage: 1,
    taskPageSize: [10, 20, 50].includes(preferences.pageSize)
      ? preferences.pageSize
      : 10,
    selectedTaskIds: [],
    taskFilterOpen: false,
    taskDisplayOpen: false,
    taskDensity: preferences.density === "compact" ? "compact" : "comfortable",
    taskColumns: Object.fromEntries(
      ["engine", "duration", "created"].map((k) => [
        k,
        preferences.columns?.[k] !== false,
      ]),
    ),
    taskRowMenu: "",
    bulkType: "",
    bulkPlan: null,
    bulkResult: null,
  });
  let bulkReturnSelector = "";
  const list = () =>
    getTaskList(state.snapshot?.tasks || [], {
      filters: state.taskFilters,
      sort: state.taskSort,
      page: state.taskPage,
      pageSize: state.taskPageSize,
    });
  const focus = (selector) =>
    document.querySelector(selector)?.focus({ preventScroll: true });
  function redraw(preferred = "") {
    const active = document.activeElement,
      selector = preferred || selectorFor(active);
    const searchInput =
      active instanceof HTMLInputElement &&
      active.id === "task-search" &&
      active.closest(".tl-workspace")
        ? active
        : null;
    const selection =
      active instanceof HTMLInputElement &&
      ["search", "text"].includes(active.type)
        ? [active.selectionStart, active.selectionEnd]
        : null;
    render();
    if (searchInput) {
      const replacement = document.querySelector(".tl-workspace #task-search");
      if (replacement instanceof HTMLInputElement) {
        const query = String(state.taskFilters.query ?? "");
        if (searchInput.value !== query) searchInput.value = query;
        replacement.replaceWith(searchInput);
      }
    }
    if (selector) {
      const next = document.querySelector(selector);
      next?.focus({ preventScroll: true });
      if (selection && next instanceof HTMLInputElement)
        try {
          next.setSelectionRange(...selection);
        } catch {}
    }
  }
  function persist() {
    try {
      localStorage.setItem(
        PREF_KEY,
        JSON.stringify({
          density: state.taskDensity,
          columns: state.taskColumns,
          pageSize: state.taskPageSize,
        }),
      );
    } catch {}
  }
  function updateFilters(patch, preferred = "") {
    if (
      Object.entries(patch).every(
        ([key, value]) => state.taskFilters[key] === value,
      )
    ) {
      redraw(preferred);
      return;
    }
    const hadSelection = state.selectedTaskIds.length > 0;
    state.taskFilters = { ...state.taskFilters, ...patch };
    state.taskPage = 1;
    state.selectedTaskIds = [];
    state.taskRowMenu = "";
    state.bulkResult = null;
    redraw(preferred);
    if (hadSelection) toast("筛选条件已改变，已清空原选择。");
  }
  function closeBulk() {
    if (bulkDialog.open) bulkDialog.close();
  }
  bulkDialog.addEventListener("close", () => {
    state.bulkType = "";
    state.bulkPlan = null;
    const target =
      bulkReturnSelector && document.querySelector(bulkReturnSelector);
    (
      target ||
      document.querySelector("#task-search") ||
      document.querySelector("#main-content")
    )?.focus({ preventScroll: true });
  });
  function openBulk(type, ids, returnSelector = "") {
    if (!state.snapshot) return;
    const plan = planBulkAction(state.snapshot, { type, ids });
    if (!plan.canExecute) {
      toast(plan.reason || plan.skipped[0]?.reason || "没有可操作的任务。");
      return;
    }
    bulkReturnSelector = returnSelector || selectorFor(document.activeElement);
    state.taskRowMenu = "";
    state.taskDisplayOpen = false;
    redraw(bulkReturnSelector);
    state.bulkType = type;
    state.bulkPlan = plan;
    bulkDialog.innerHTML = renderBulkDialog(state);
    bulkDialog.showModal();
    bulkDialog.querySelector('[data-action="bulk-close"]')?.focus();
  }
  function confirmBulk() {
    if (!state.snapshot || !state.bulkPlan) return;
    const previous = state.bulkPlan;
    const latest = planBulkAction(state.snapshot, {
      type: state.bulkType,
      ids: previous.requestedIds,
    });
    const signature = (p) =>
      JSON.stringify([
        p.canExecute,
        p.eligible.map((x) => x.id),
        p.skipped.map((x) => [x.id, x.reason]),
      ]);
    if (signature(latest) !== signature(previous)) {
      state.bulkPlan = latest;
      bulkDialog.innerHTML = renderBulkDialog(state);
      bulkDialog.querySelector('[data-action="bulk-close"]')?.focus();
      toast("任务状态已变化，请重新确认当前操作范围。");
      return;
    }
    if (!latest.canExecute) return;
    try {
      const result = applyDemoBulkAction(state.snapshot, {
        type: state.bulkType,
        ids: latest.requestedIds,
      });
      setSnapshot(result.snapshot);
      state.bulkResult = result.report;
      state.selectedTaskIds = [];
      state.taskRowMenu = "";
      closeBulk();
      render();
      toast(
        `${result.report.type === "retry" ? "已创建重试任务" : "已取消任务"} ${result.report.applied.length} 项${result.report.skipped.length ? `，跳过 ${result.report.skipped.length} 项` : ""}。`,
      );
    } catch (error) {
      toast(error.message);
    }
  }
  function download(selectedOnly) {
    const ids = new Set(state.selectedTaskIds);
    const tasks = selectedOnly
      ? (state.snapshot?.tasks || []).filter((t) => ids.has(t.task.id))
      : list().filtered;
    if (!tasks.length) {
      toast("当前没有可导出的任务。");
      return;
    }
    const blob = new Blob(
      [exportTasksCSV(tasks, { mode: state.mode, now: new Date() })],
      { type: "text/csv;charset=utf-8" },
    );
    const url = URL.createObjectURL(blob),
      link = document.createElement("a");
    link.href = url;
    link.download = `heal-tasks-${state.mode}-${selectedOnly ? "selected" : "filtered"}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(
      `已导出${selectedOnly ? "所选" : "筛选结果"} ${tasks.length} 项任务。`,
    );
  }
  function closeFloating(target) {
    let changed = false;
    if (
      state.taskDisplayOpen &&
      !target.closest('#task-display-panel,[data-action="task-display-toggle"]')
    ) {
      state.taskDisplayOpen = false;
      changed = true;
    }
    if (
      state.taskRowMenu &&
      !target.closest('[role="menu"],[data-action="task-row-menu"]')
    ) {
      state.taskRowMenu = "";
      changed = true;
    }
    return changed;
  }
  function handleClick(event, button) {
    const action = button?.dataset.action,
      id = button?.dataset.id;
    const closed = closeFloating(event.target);
    if (!button || button.disabled) {
      if (closed) redraw();
      return closed;
    }
    if (
      [
        "task-select",
        "task-select-page",
        "task-column",
        "task-density",
      ].includes(action)
    )
      return false;
    if (!action.startsWith("task-") && !action.startsWith("bulk-")) {
      if (action === "open-task" && button.closest('[role="menu"]')) {
        state.taskRowMenu = "";
        redraw(rowMenuSelector(id));
      } else if (closed) redraw();
      return false;
    }
    if (action === "task-action") {
      if (closed) redraw();
      return false;
    }
    switch (action) {
      case "task-filter-toggle":
        state.taskFilterOpen = !state.taskFilterOpen;
        redraw();
        break;
      case "task-filter-reset":
        updateFilters(
          { ...DEFAULT_TASK_FILTERS },
          '[data-action="task-filter-toggle"]',
        );
        break;
      case "task-filter-remove": {
        const key = button.dataset.filter;
        if (Object.hasOwn(DEFAULT_TASK_FILTERS, key))
          updateFilters({ [key]: DEFAULT_TASK_FILTERS[key] }, "#task-search");
        break;
      }
      case "task-status-tab":
        updateFilters(
          { status: button.dataset.status },
          `[data-action="task-status-tab"][data-status="${CSS.escape(button.dataset.status)}"]`,
        );
        break;
      case "task-page":
        state.taskPage = Number(button.dataset.page) || 1;
        state.taskRowMenu = "";
        redraw('.tl-page-button[aria-current="page"]');
        break;
      case "task-sort":
        state.taskSort = [
          "created-desc",
          "created-asc",
          "priority-desc",
          "duration-desc",
        ].includes(button.dataset.sort)
          ? button.dataset.sort
          : "created-desc";
        state.taskPage = 1;
        redraw(".tl-sort-heading");
        break;
      case "task-display-toggle":
        state.taskDisplayOpen = !state.taskDisplayOpen;
        state.taskRowMenu = "";
        redraw();
        if (state.taskDisplayOpen) focus("#task-display-panel input");
        break;
      case "task-select-filtered":
        state.selectedTaskIds = list().filtered.map((t) => t.task.id);
        redraw('[data-action="task-clear-selection"]');
        break;
      case "task-clear-selection":
        state.selectedTaskIds = [];
        redraw('[data-action="task-select-page"]');
        break;
      case "task-row-menu":
        state.taskRowMenu = state.taskRowMenu === id ? "" : id;
        state.taskDisplayOpen = false;
        redraw();
        if (state.taskRowMenu)
          focus('[role="menu"] [role="menuitem"]:not([disabled])');
        break;
      case "task-copy-id": {
        state.taskRowMenu = "";
        redraw(rowMenuSelector(id));
        if (navigator.clipboard?.writeText)
          navigator.clipboard.writeText(id).then(
            () => toast("任务 ID 已复制。"),
            () => toast(`无法访问剪贴板，任务 ID：${id}`),
          );
        else toast(`任务 ID：${id}`);
        break;
      }
      case "task-export":
        download(false);
        if (closed) redraw();
        break;
      case "task-export-selected":
        download(true);
        break;
      case "bulk-open":
        openBulk(
          button.dataset.type,
          id ? [id] : state.selectedTaskIds,
          id ? rowMenuSelector(id) : selectorFor(button),
        );
        break;
      case "bulk-close":
        closeBulk();
        break;
      case "bulk-confirm":
        confirmBulk();
        break;
      case "bulk-result-dismiss":
        state.bulkResult = null;
        redraw("#task-search");
        break;
      default:
        return false;
    }
    return true;
  }
  function handleChange(event) {
    const el = event.target;
    if (!(el instanceof Element) || !el.closest(".tl-workspace")) return false;
    const action = el.dataset.action;
    if (action === "task-select") {
      const ids = new Set(state.selectedTaskIds);
      if (
        el.checked &&
        state.snapshot?.tasks.some((t) => t.task.id === el.dataset.id)
      )
        ids.add(el.dataset.id);
      else ids.delete(el.dataset.id);
      state.selectedTaskIds = [...ids];
      state.taskRowMenu = "";
      redraw();
      return true;
    }
    if (action === "task-select-page") {
      const ids = new Set(state.selectedTaskIds);
      for (const task of list().items)
        el.checked ? ids.add(task.task.id) : ids.delete(task.task.id);
      state.selectedTaskIds = [...ids];
      state.taskRowMenu = "";
      redraw();
      return true;
    }
    if (action === "task-density") {
      state.taskDensity =
        el.dataset.density === "compact" ? "compact" : "comfortable";
      persist();
      redraw();
      return true;
    }
    if (action === "task-column") {
      if (Object.hasOwn(state.taskColumns, el.dataset.column))
        state.taskColumns[el.dataset.column] = el.checked;
      persist();
      redraw();
      return true;
    }
    if (el.id === "task-page-size") {
      state.taskPageSize = [10, 20, 50].includes(Number(el.value))
        ? Number(el.value)
        : 10;
      state.taskPage = 1;
      persist();
      redraw();
      return true;
    }
    if (el.id === "task-sort") {
      state.taskSort = [
        "created-desc",
        "created-asc",
        "priority-desc",
        "duration-desc",
      ].includes(el.value)
        ? el.value
        : "created-desc";
      state.taskPage = 1;
      redraw();
      return true;
    }
    const field = el.id.startsWith("task-filter-") ? el.id.slice(12) : "";
    if (Object.hasOwn(DEFAULT_TASK_FILTERS, field) && field !== "query") {
      updateFilters({
        [field]: field === "days" ? Number(el.value) : el.value,
      });
      return true;
    }
    return false;
  }
  function handleInput(event) {
    if (
      !(event.target instanceof Element) ||
      !event.target.closest(".tl-workspace") ||
      event.target.id !== "task-search"
    )
      return false;
    if (!event.isComposing) updateFilters({ query: event.target.value });
    return true;
  }
  function handleKeydown(event) {
    if (document.querySelector("dialog[open]")) return false;
    const menu = event.target.closest('[role="menu"]');
    if (menu && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      const items = [
        ...menu.querySelectorAll('[role="menuitem"]:not([disabled])'),
      ];
      if (!items.length) return false;
      event.preventDefault();
      const index = items.indexOf(document.activeElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
              items.length;
      items[next].focus();
      return true;
    }
    if (
      event.key === "ArrowDown" &&
      event.target.matches('[data-action="task-row-menu"]')
    ) {
      event.preventDefault();
      event.target.click();
      return true;
    }
    if ((event.key === "Escape" || event.key === "Tab") && state.taskRowMenu) {
      const id = state.taskRowMenu;
      state.taskRowMenu = "";
      if (event.key === "Escape") event.preventDefault();
      redraw(rowMenuSelector(id));
      return true;
    }
    if (event.key === "Escape" && state.taskDisplayOpen) {
      event.preventDefault();
      state.taskDisplayOpen = false;
      redraw('[data-action="task-display-toggle"]');
      return true;
    }
    if (
      event.key === "Escape" &&
      state.taskFilterOpen &&
      event.target.closest("#task-filter-panel")
    ) {
      event.preventDefault();
      state.taskFilterOpen = false;
      redraw('[data-action="task-filter-toggle"]');
      return true;
    }
    return false;
  }
  return {
    handleClick,
    handleChange,
    handleInput,
    handleKeydown,
    redraw,
    reconcile() {
      const ids = new Set(state.snapshot?.tasks.map((t) => t.task.id) || []);
      state.selectedTaskIds = state.selectedTaskIds.filter((id) => ids.has(id));
      if (state.snapshot && state.view === "tasks")
        state.taskPage = list().page;
    },
    afterRender() {
      for (const el of document.querySelectorAll("input[data-indeterminate]"))
        el.indeterminate = el.dataset.indeterminate === "true";
    },
    reset(sourceChanged = false) {
      closeBulk();
      state.selectedTaskIds = [];
      state.taskRowMenu = "";
      state.taskDisplayOpen = false;
      state.bulkResult = null;
      state.taskPage = 1;
      if (sourceChanged) state.taskFilters = { ...DEFAULT_TASK_FILTERS };
    },
    onNavigate() {
      state.taskRowMenu = "";
      state.taskDisplayOpen = false;
      closeBulk();
    },
  };
}
