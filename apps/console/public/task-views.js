import { icon } from "./icons.js";
import { escapeHtml as e, formatDuration } from "./model.js";
import { uiButton, uiEmpty, uiStatus } from "./ui.js";
import {
  DEFAULT_TASK_FILTERS,
  getTaskDisplayStatus,
  getTaskFilterOptions,
  getTaskList,
  planBulkAction,
} from "./task-model.js";

const statusNames = {
  all: "全部状态",
  running: "运行中",
  review: "待审批",
  pending: "队列中",
  failed: "失败",
  completed: "已完成",
  cancelled: "已取消",
  skipped: "已跳过",
};
const typeNames = {
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
const typeIcons = {
  "lint-error": "Wrench",
  "format-error": "FileCode2",
  "type-error": "Code2",
  "unit-test-failure": "FlaskConical",
  "e2e-test-failure": "FlaskConical",
  "architecture-violation": "Workflow",
  "security-issue": "ShieldCheck",
  "ci-failure": "GitPullRequest",
  "doc-outdated": "FileCode2",
  "dependency-issue": "Box",
  "performance-regression": "Activity",
};
const statusIcons = {
  all: "ListChecks",
  running: "Activity",
  review: "GitPullRequestArrow",
  failed: "CircleAlert",
  completed: "CircleCheck",
};
const priorityNames = {
  urgent: "紧急",
  critical: "紧急",
  high: "高优先级",
  medium: "中优先级",
  low: "低优先级",
};
const sourceNames = {
  manual: "手动发起",
  webhook: "Webhook",
  cron: "定时巡检",
};
const filterNames = {
  query: "关键词",
  status: "状态",
  engine: "执行引擎",
  type: "任务类型",
  priority: "优先级",
  source: "触发来源",
  branch: "分支",
  days: "创建时间",
};
const timeOptions = [
  [0, "全部时间"],
  [1, "今天"],
  [7, "近 7 天"],
  [30, "近 30 天"],
  [90, "近 90 天"],
];
const sortOptions = [
  ["created-desc", "最新创建"],
  ["created-asc", "最早创建"],
  ["priority-desc", "优先级从高到低"],
  ["duration-desc", "耗时从长到短"],
];
const action = (name, attributes = "") => `data-action="${name}" ${attributes}`;
const taskAction = (name, id, attributes = "") =>
  action(name, `data-id="${e(id)}" ${attributes}`);
const engineName = (value) =>
  value === "fast"
    ? "Direct AI"
    : value === "complex"
      ? "ZCode Workflow"
      : String(value || "未分配");
const safeStatus = (entry) => {
  const value = getTaskDisplayStatus(entry);
  return Object.hasOwn(statusNames, value) && value !== "all"
    ? value
    : "pending";
};
const selectedIds = (state, tasks) => {
  const available = new Set(tasks.map((entry) => entry.task.id));
  return [...new Set(state.selectedTaskIds || [])].filter((id) =>
    available.has(id),
  );
};
const isFilterActive = (key, value) =>
  key === "query"
    ? Boolean(String(value || "").trim())
    : key === "days"
      ? Number(value) > 0
      : Boolean(value && value !== "all");
const filterValueLabel = (key, value) =>
  key === "engine"
    ? engineName(value)
    : key === "type"
      ? typeNames[value] || value
      : key === "priority"
        ? priorityNames[value] || value
        : key === "source"
          ? sourceNames[value] || value
          : key === "status"
            ? statusNames[value] || value
            : key === "days"
              ? timeOptions.find(([days]) => days === Number(value))?.[1] ||
                `近 ${value} 天`
              : value;

function selectOptions(options, selected) {
  return options
    .map(
      ([value, label]) =>
        `<option value="${e(value)}" ${String(value) === String(selected) ? "selected" : ""}>${e(label)}</option>`,
    )
    .join("");
}

function filterSelect(key, values, filters) {
  const selected = filters[key] || "all";
  const available = [...new Set(values || [])];
  if (selected !== "all" && !available.includes(selected))
    available.push(selected);
  return `<label class="tl-filter-field" for="task-filter-${key}"><span>${filterNames[key]}</span><select class="ui-select-input" id="task-filter-${key}" name="task-filter-${key}">${selectOptions([["all", `全部${key === "source" ? "来源" : key === "engine" ? "引擎" : key === "type" ? "类型" : filterNames[key]}`], ...available.map((value) => [value, filterValueLabel(key, value)])], selected)}</select></label>`;
}

function renderFilterPanel(filters, options) {
  return `<section class="tl-filters" id="task-filter-panel" aria-label="详细筛选"><div class="tl-filter-grid">${filterSelect(
    "status",
    Object.keys(statusNames).filter((value) => value !== "all"),
    filters,
  )}${filterSelect("engine", options.engines, filters)}${filterSelect("type", options.types, filters)}${filterSelect("priority", options.priorities, filters)}${filterSelect("source", options.sources, filters)}${filterSelect("branch", options.branches, filters)}<label class="tl-filter-field" for="task-filter-days"><span>创建时间</span><select class="ui-select-input" id="task-filter-days" name="task-filter-days">${selectOptions(timeOptions, filters.days)}</select></label></div><div class="tl-filter-foot"><button type="button" class="ui-button ui-button-ghost tl-text-button" ${action("task-filter-reset")}>重置筛选</button></div></section>`;
}

function renderDisplayPanel(state, columns) {
  const density = state.taskDensity === "compact" ? "compact" : "comfortable";
  return `<div class="tl-display-panel" id="task-display-panel" aria-label="任务显示设置"><div class="tl-popover-heading"><strong>显示选项</strong><button type="button" class="ui-icon-button tl-icon-button" ${action("task-display-toggle")} aria-label="关闭显示选项">${icon("X", 13)}</button></div><label class="tl-display-sort" for="task-sort"><span>排序</span><select class="ui-select-input" id="task-sort" name="task-sort">${selectOptions(sortOptions, state.taskSort || "created-desc")}</select></label><fieldset class="tl-density"><legend>行间距</legend><div class="tl-density-options">${[
    ["comfortable", "舒适"],
    ["compact", "紧凑"],
  ]
    .map(
      ([value, label]) =>
        `<label class="tl-density-choice ${density === value ? "is-active" : ""}"><input type="radio" name="task-density" value="${value}" ${action("task-density", `data-density="${value}"`)} ${density === value ? "checked" : ""}><span>${label}</span></label>`,
    )
    .join(
      "",
    )}</div></fieldset><fieldset class="tl-column-options"><legend>显示列</legend>${[
    ["engine", "执行引擎"],
    ["duration", "耗时"],
    ["created", "创建时间"],
  ]
    .map(
      ([key, label]) =>
        `<label><span>${label}</span><input class="tl-checkbox" type="checkbox" ${action("task-column", `data-column="${key}"`)} ${columns[key] ? "checked" : ""}></label>`,
    )
    .join("")}</fieldset></div>`;
}

function renderFilterChips(filters) {
  const active = Object.entries(filters).filter(
    ([key, value]) =>
      Object.hasOwn(filterNames, key) &&
      key !== "query" &&
      !(
        key === "status" &&
        ["all", "running", "review", "failed", "completed"].includes(value)
      ) &&
      isFilterActive(key, value),
  );
  if (!active.length) return "";
  return `<div class="tl-active-filters" aria-label="已应用筛选">${active.map(([key, value]) => `<button type="button" class="tl-filter-chip" ${action("task-filter-remove", `data-filter="${key}"`)} aria-label="移除${filterNames[key]}筛选：${e(filterValueLabel(key, value))}"><span class="tl-chip-key">${filterNames[key]}</span><span class="tl-chip-value">${e(filterValueLabel(key, value))}</span>${icon("X", 11)}</button>`).join("")}<button type="button" class="ui-button ui-button-ghost tl-text-button" ${action("task-filter-reset")}>清除全部</button></div>`;
}

function renderSelectionBar(state, list, ids) {
  if (!ids.length) return "";
  const selection = new Set(ids);
  const filteredSelected = list.filtered.filter((entry) =>
    selection.has(entry.task.id),
  ).length;
  const cancelPlan = planBulkAction(state.snapshot, { type: "cancel", ids });
  const retryPlan = planBulkAction(state.snapshot, { type: "retry", ids });
  const live = state.mode !== "demo" || state.snapshot?.mode !== "demo";
  return `<div class="tl-selection-bar" aria-label="已选任务的批量操作"><div class="tl-selection-main"><span class="tl-selection-count">${icon("CheckCheck", 16)}已选择 <strong>${ids.length}</strong> 项</span>${filteredSelected < list.total ? `<button type="button" class="tl-selection-all" ${action("task-select-filtered")}>选择全部 ${list.total} 项筛选结果</button>` : `<span class="tl-selection-all-done">已选择全部筛选结果</span>`}<button type="button" class="ui-button ui-button-ghost tl-text-button tl-clear-selection" ${action("task-clear-selection")}>清空选择</button></div><div class="tl-selection-actions"><button type="button" class="ui-button tl-button" ${action("bulk-open", 'data-type="cancel"')} ${cancelPlan.canExecute ? "" : `disabled title="${e(cancelPlan.reason || "所选任务没有可取消项")}"`}>${icon("Ban", 13)}取消任务<span class="tl-button-count">${cancelPlan.eligible.length}</span></button><button type="button" class="ui-button tl-button" ${action("bulk-open", 'data-type="retry"')} ${retryPlan.canExecute ? "" : `disabled title="${e(retryPlan.reason || "所选任务没有可重试项")}"`}>${icon("RotateCcw", 13)}重试<span class="tl-button-count">${retryPlan.eligible.length}</span></button><button type="button" class="ui-button tl-button tl-export-selection" ${action("task-export-selected")}>${icon("Download", 13)}导出选中</button></div>${live ? `<p class="tl-selection-note">${icon("LockKeyhole", 12)}当前连接为只读，批量取消与重试尚未接入。可以查看与导出所选记录。</p>` : ""}</div>`;
}

function renderStatus(entry) {
  const status = safeStatus(entry);
  const progress = Number(entry.status?.progress);
  const label =
    status === "running" &&
    Number.isFinite(progress) &&
    progress >= 0 &&
    progress <= 100
      ? `${statusNames[status]} · ${Math.round(progress)}%`
      : statusNames[status];
  const symbol =
    status === "completed"
      ? "CircleCheck"
      : status === "failed"
        ? "CircleAlert"
        : status === "review"
          ? "GitPullRequestArrow"
          : status === "cancelled"
            ? "Ban"
            : status === "skipped"
              ? "ArrowRight"
              : status === "running"
                ? "CircleDot"
                : "Clock3";
  return uiStatus({
    label: statusNames[status],
    tone:
      status === "completed"
        ? "success"
        : status === "failed"
          ? "error"
          : status === "review"
            ? "warning"
            : status === "running"
              ? "info"
              : "neutral",
    icon: symbol,
    className: `tl-state tl-state-${status}`,
    title: label,
  });
}

function renderDuration(entry) {
  if (safeStatus(entry) === "running")
    return `<span class="tl-running-duration">进行中</span>`;
  let duration = entry.result?.timings?.durationMs;
  if (
    duration == null &&
    entry.status?.startedAt &&
    entry.status?.completedAt
  ) {
    duration =
      Date.parse(entry.status.completedAt) - Date.parse(entry.status.startedAt);
  }
  return `<span class="tl-duration-value">${e(formatDuration(duration))}</span>`;
}

function renderCreated(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  const day = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
  })
    .format(date)
    .replace("月", "/")
    .replace("日", "");
  const time = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  const full = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    dateStyle: "medium",
    timeStyle: "short",
    hour12: false,
  }).format(date);
  return `<time class="tl-date" datetime="${e(value)}" title="${e(full)}（北京时间）">${e(day)} ${e(time)}</time>`;
}

function renderRowMenu(entry, state, index, selectedCount, opensUp) {
  const id = entry.task.id;
  const opened = state.taskRowMenu === id;
  const cancel = planBulkAction(state.snapshot, { type: "cancel", ids: [id] });
  const retry = planBulkAction(state.snapshot, { type: "retry", ids: [id] });
  const approval = entry.approvalFlow || entry.reviewState;
  const eligibleMutation =
    !selectedCount && (cancel.canExecute || retry.canExecute);
  return `<div class="tl-row-actions"><button type="button" class="ui-icon-button tl-icon-button tl-row-menu-trigger ${opened ? "is-active" : ""}" ${taskAction("task-row-menu", id)} aria-label="${e(entry.title)}的更多操作" aria-haspopup="menu" aria-expanded="${opened}" aria-controls="task-row-menu-${index}">${icon("Ellipsis", 17)}</button>${opened ? `<div class="tl-row-menu ${opensUp ? "tl-menu-up" : ""}" role="menu" id="task-row-menu-${index}" aria-label="${e(entry.title)}的操作"><button type="button" role="menuitem" ${taskAction("open-task", id)}>${icon("ArrowUpRight", 14)}查看任务详情</button>${approval ? `<button type="button" role="menuitem" ${taskAction("select-approval", id)}>${icon("GitPullRequestArrow", 14)}查看审批流程</button>` : ""}${entry.diff?.length ? `<button type="button" role="menuitem" ${taskAction("open-task", id, 'data-tab="diff"')}>${icon("FileDiff", 14)}查看代码变更</button>` : ""}<button type="button" role="menuitem" ${taskAction("task-copy-id", id)}>${icon("Copy", 14)}复制任务 ID</button>${eligibleMutation ? `<div class="tl-menu-divider" role="separator"></div>${cancel.canExecute ? `<button type="button" role="menuitem" class="tl-menu-danger" ${taskAction("bulk-open", id, 'data-type="cancel"')}>${icon("Ban", 14)}取消任务</button>` : ""}${retry.canExecute ? `<button type="button" role="menuitem" ${taskAction("bulk-open", id, 'data-type="retry"')}>${icon("RotateCcw", 14)}重试任务</button>` : ""}` : ""}</div>` : ""}</div>`;
}

function renderTaskRow(entry, state, index, list, selected, columns) {
  const id = entry.task.id;
  const priority = entry.task.priority;
  const priorityLabel = priorityNames[priority] || priority || "未设置优先级";
  const elevated = ["high", "urgent", "critical"].includes(priority);
  const type = entry.task.type;
  const isSelected = selected.has(id);
  const context = [
    entry.task.payload?.repo,
    entry.task.payload?.branch,
    priorityLabel,
  ]
    .filter(Boolean)
    .join(" · ");
  return `<tr class="tl-task-row ${isSelected ? "is-selected" : ""} ${state.taskRowMenu === id ? "has-open-menu" : ""}" data-task-id="${e(id)}"><td class="tl-col-check"><input class="tl-checkbox" type="checkbox" ${taskAction("task-select", id)} aria-label="选择任务 ${e(id)}：${e(entry.title)}" ${isSelected ? "checked" : ""}></td><td class="tl-col-task"><div class="tl-task-cell"><span class="tl-task-icon" aria-hidden="true">${icon(typeIcons[type] || "ListChecks", 17)}</span><div class="tl-task-copy"><button type="button" class="tl-task-title" ${taskAction("open-task", id)} title="${e(entry.title)}
${e(context)}"><span class="tl-task-title-text">${e(entry.title)}</span>${icon("ArrowUpRight", 13)}</button><div class="tl-task-meta" title="${e(context)}"><span class="tl-task-id">${e(id)}</span><span class="tl-meta-dot" aria-hidden="true">·</span><span class="tl-task-type">${e(typeNames[type] || type)}</span>${elevated ? `<span class="tl-priority tl-priority-${priority}" role="img" aria-label="${e(priorityLabel)}" title="${e(priorityLabel)}">${icon("ArrowUp", 10)}</span>` : ""}</div></div></div></td><td class="tl-col-status">${renderStatus(entry)}</td>${columns.engine ? `<td class="tl-col-engine"><span class="tl-engine">${e(engineName(entry.engineId))}</span></td>` : ""}${columns.duration ? `<td class="tl-col-duration">${renderDuration(entry)}</td>` : ""}${columns.created ? `<td class="tl-col-created">${renderCreated(entry.task.metadata?.createdAt)}</td>` : ""}<td class="tl-col-actions">${renderRowMenu(entry, state, index, selected.size, index >= list.items.length - 2)}</td></tr>`;
}

function renderTable(state, list, ids, columns) {
  const selected = new Set(ids);
  const countOnPage = list.items.filter((entry) =>
    selected.has(entry.task.id),
  ).length;
  const allOnPage = list.items.length > 0 && countOnPage === list.items.length;
  const mixed = countOnPage > 0 && !allOnPage;
  const ascending = state.taskSort === "created-asc";
  const createdSort = ["created-desc", "created-asc"].includes(
    state.taskSort || "created-desc",
  );
  return `<div class="tl-table-region"><table class="ui-table tl-table" aria-label="任务列表"><colgroup><col class="tl-col-check"><col class="tl-col-task"><col class="tl-col-status">${columns.engine ? '<col class="tl-col-engine">' : ""}${columns.duration ? '<col class="tl-col-duration">' : ""}${columns.created ? '<col class="tl-col-created">' : ""}<col class="tl-col-actions"></colgroup><thead><tr><th scope="col" class="tl-col-check"><input type="checkbox" id="task-select-page" class="tl-checkbox" ${action("task-select-page")} data-indeterminate="${mixed}" aria-checked="${mixed ? "mixed" : allOnPage}" aria-label="选择当前页的 ${list.items.length} 项任务" ${allOnPage ? "checked" : ""}></th><th scope="col" class="tl-col-task">任务</th><th scope="col" class="tl-col-status">状态</th>${columns.engine ? '<th scope="col" class="tl-col-engine">执行引擎</th>' : ""}${columns.duration ? '<th scope="col" class="tl-col-duration">耗时</th>' : ""}${columns.created ? `<th scope="col" class="tl-col-created" aria-sort="${createdSort ? (ascending ? "ascending" : "descending") : "none"}"><button type="button" class="tl-sort-heading ${createdSort ? "is-active" : ""}" ${action("task-sort", `data-sort="${ascending ? "created-desc" : "created-asc"}"`)} aria-label="按创建时间${ascending ? "从新到旧" : "从旧到新"}排序">创建时间<span class="${ascending ? "" : "tl-sort-down"}">${icon("ArrowUp", 12)}</span></button></th>` : ""}<th scope="col" class="tl-col-actions"><span class="sr-only">操作</span></th></tr></thead><tbody>${list.items.map((entry, index) => renderTaskRow(entry, state, index, list, selected, columns)).join("")}</tbody></table></div>`;
}

function pageItems(page, count) {
  const pages = new Set([1, count, page - 1, page, page + 1]);
  const ordered = [...pages]
    .filter((value) => value >= 1 && value <= count)
    .sort((a, b) => a - b);
  return ordered.flatMap((value, index) =>
    index && value - ordered[index - 1] > 1 ? ["gap", value] : [value],
  );
}

function renderPagination(list) {
  return `<footer class="tl-pagination"><div class="tl-pagination-summary" role="status" aria-live="polite"><span><strong>${list.start}–${list.end}</strong> / ${list.total} 项</span></div><div class="tl-pagination-controls"><label class="tl-page-size" for="task-page-size"><span>每页</span><select class="ui-select-input" id="task-page-size" name="task-page-size">${selectOptions(
    [
      [10, "10 项"],
      [20, "20 项"],
      [50, "50 项"],
    ],
    list.pageSize,
  )}</select></label><nav class="tl-page-buttons" aria-label="任务分页"><button type="button" class="ui-icon-button tl-icon-button" ${action("task-page", `data-page="${Math.max(1, list.page - 1)}"`)} aria-label="上一页" ${list.page <= 1 ? "disabled" : ""}>${icon("ArrowLeft", 13)}</button>${pageItems(
    list.page,
    list.pageCount,
  )
    .map((page) =>
      page === "gap"
        ? `<span class="tl-page-gap" aria-hidden="true">…</span>`
        : `<button type="button" class="ui-icon-button tl-page-button ${page === list.page ? "is-current" : ""}" ${action("task-page", `data-page="${page}"`)} aria-label="第 ${page} 页" ${page === list.page ? 'aria-current="page"' : ""}>${page}</button>`,
    )
    .join(
      "",
    )}<button type="button" class="ui-icon-button tl-icon-button" ${action("task-page", `data-page="${Math.min(list.pageCount, list.page + 1)}"`)} aria-label="下一页" ${list.page >= list.pageCount ? "disabled" : ""}>${icon("ChevronRight", 15)}</button></nav></div></footer>`;
}

function renderEmpty(state, hasTasks) {
  const canCreate =
    state.mode === "demo" && state.snapshot?.capabilities?.trigger;
  return uiEmpty({
    icon: hasTasks ? "Search" : "ListChecks",
    title: hasTasks ? "没有符合条件的任务" : "还没有任务记录",
    description: hasTasks
      ? "试试更宽的筛选范围，或移除几个条件。"
      : state.mode === "demo"
        ? "发起一次巡检，任务和后续记录会出现在这里。"
        : "执行引擎尚未接入。连接真实任务服务后，这里会显示诊断、修复和验证记录。",
    action: hasTasks
      ? uiButton({
          label: "清除筛选",
          icon: "RotateCcw",
          action: "task-filter-reset",
          className: "tl-button",
        })
      : canCreate
        ? uiButton({
            label: "发起巡检",
            icon: "Plus",
            action: "new-task",
            variant: "primary",
            className: "tl-button tl-button-primary",
          })
        : uiButton({
            label: "查看连接设置",
            icon: "Plug",
            action: "navigate",
            attrs: 'data-view="settings"',
            className: "tl-button",
          }),
    className: "tl-empty",
  });
}

function renderBulkResult(result) {
  if (!result) return "";
  const report = result.report || result;
  const applied = report.applied || [];
  const skipped = report.skipped || [];
  const retry = report.type === "retry";
  return `<section class="tl-bulk-result ${applied.length ? "is-success" : "is-warning"}" aria-label="批量操作结果"><div class="tl-result-heading"><span class="tl-result-icon">${icon(applied.length ? "CircleCheck" : "CircleAlert", 18)}</span><div class="tl-result-copy" role="status"><strong>${applied.length ? (retry ? `已创建 ${applied.length} 项模拟重试` : `已取消 ${applied.length} 项演示任务`) : "没有任务被修改"}</strong><p>${retry && applied.length ? "原任务记录已保留。" : applied.length ? "取消记录已写入活动日志。" : "所选任务的状态可能已发生变化。"}${skipped.length ? ` ${skipped.length} 项已跳过，可查看具体原因。` : ""}</p></div><button type="button" class="ui-icon-button tl-icon-button" ${action("bulk-result-dismiss")} aria-label="关闭批量操作结果">${icon("X", 15)}</button></div>${applied.length || skipped.length ? `<details class="tl-result-details"><summary>查看处理明细<span>${applied.length + skipped.length} 项</span>${icon("ChevronDown", 12)}</summary><div class="tl-result-list">${applied.map((entry) => `<div class="tl-result-item">${icon("Check", 13)}<span><strong>${e(entry.title || entry.id)}</strong><small>${e(entry.id)}${entry.newId ? ` → ${e(entry.newId)}` : ""}</small></span><button type="button" class="ui-button ui-button-ghost tl-text-button" ${taskAction("open-task", entry.newId || entry.id)}>查看${icon("ArrowUpRight", 11)}</button></div>`).join("")}${skipped.map((entry) => `<div class="tl-result-item is-skipped">${icon("Info", 13)}<span><strong>${e(entry.title || entry.id)}</strong><small>${e(entry.id)} · ${e(entry.reason)}</small></span><span class="tl-skipped-label">已跳过</span></div>`).join("")}</div></details>` : ""}</section>`;
}

/** Presentation only: filtering and mutation eligibility come from the shared model. */
export function renderTaskPage(state) {
  const tasks = state.snapshot?.tasks || [];
  const filters = { ...DEFAULT_TASK_FILTERS, ...state.taskFilters };
  const list = getTaskList(tasks, {
    filters,
    sort: state.taskSort || "created-desc",
    page: state.taskPage || 1,
    pageSize: state.taskPageSize || 10,
  });
  const options = getTaskFilterOptions(tasks);
  const ids = selectedIds(state, tasks);
  const columns = {
    engine: true,
    duration: true,
    created: true,
    ...state.taskColumns,
  };
  const detailFilterCount =
    ["engine", "type", "priority", "source", "branch", "days"].filter((key) =>
      isFilterActive(key, filters[key]),
    ).length +
    (["pending", "cancelled", "skipped"].includes(filters.status) ? 1 : 0);
  const tabs = [
    ["all", "全部"],
    ["running", "运行中"],
    ["review", "待审批"],
    ["failed", "失败"],
    ["completed", "已完成"],
  ];
  return `<section class="tl-workspace" aria-label="任务工作区">${renderBulkResult(state.bulkResult)}<div class="ui-card tl-panel ${state.taskDensity === "compact" ? "tl-density-compact" : ""}"><div class="tl-topline"><div class="ui-tabs tl-status-tabs" role="group" aria-label="按任务状态筛选">${tabs.map(([value, label]) => `<button type="button" class="ui-tab tl-status-tab ${filters.status === value ? "is-active" : ""}" ${action("task-status-tab", `data-status="${value}"`)} aria-pressed="${filters.status === value}">${icon(statusIcons[value], 14)}<span>${label}</span><span class="tl-tab-count">${list.counts[value] || 0}</span></button>`).join("")}</div></div><div class="tl-toolbar"><label class="tl-search ui-search" for="task-search">${icon("Search", 15)}<input class="ui-input" type="search" id="task-search" name="task-search" placeholder="搜索任务…" aria-label="搜索任务、ID、文件或分支" value="${e(filters.query || "")}" autocomplete="off">${filters.query ? `<button type="button" class="ui-icon-button tl-search-clear" ${action("task-filter-remove", 'data-filter="query"')} aria-label="清空任务搜索">${icon("X", 12)}</button>` : ""}</label><div class="tl-toolbar-actions"><button type="button" class="ui-button tl-button ${state.taskFilterOpen ? "is-active" : ""}" ${action("task-filter-toggle")} aria-expanded="${Boolean(state.taskFilterOpen)}" aria-controls="task-filter-panel" aria-label="筛选任务">${icon("SlidersHorizontal", 14)}<span>筛选</span>${detailFilterCount ? `<span class="tl-button-count">${detailFilterCount}</span>` : ""}</button><div class="tl-display-wrap"><button type="button" class="ui-button tl-button ${state.taskDisplayOpen ? "is-active" : ""}" ${action("task-display-toggle")} aria-expanded="${Boolean(state.taskDisplayOpen)}" aria-controls="task-display-panel" aria-label="显示选项">${icon("PanelTop", 14)}<span>显示</span></button>${state.taskDisplayOpen ? renderDisplayPanel(state, columns) : ""}</div><button type="button" class="ui-button tl-button tl-export-button" aria-label="导出筛选结果" ${action("task-export")} ${list.total ? "" : "disabled"} title="导出全部 ${list.total} 项筛选结果为 CSV">${icon("Download", 14)}<span>导出</span></button></div></div>${state.taskFilterOpen ? renderFilterPanel(filters, options) : ""}${renderFilterChips(filters)}${renderSelectionBar(state, list, ids)}${list.items.length ? renderTable(state, list, ids, columns) : renderEmpty(state, tasks.length > 0)}${renderPagination(list)}</div></section>`;
}

/** Contents of the native #bulk-dialog. No action runs before confirmation. */
export function renderBulkDialog(state) {
  const plan = state.bulkPlan;
  if (!plan) return "";
  const retry = plan.type === "retry";
  const eligible = plan.eligible || [];
  const skipped = plan.skipped || [];
  const demo = state.mode === "demo" && state.snapshot?.mode === "demo";
  const enabled = plan.canExecute && demo;
  return `<div class="tl-dialog-head"><span class="tl-dialog-symbol ${retry ? "is-retry" : ""}">${icon(retry ? "RotateCcw" : "Ban", 22)}</span><button type="button" class="ui-icon-button tl-icon-button" ${action("bulk-close")} aria-label="关闭批量操作确认">${icon("X", 17)}</button></div><div class="tl-dialog-intro"><span class="tl-dialog-eyebrow">${retry ? "重新尝试" : "停止执行"} · ${demo ? "演示工作区" : "只读连接"}</span><h2 id="bulk-dialog-title">${retry ? "确认批量重试" : "确认取消任务"}</h2><p id="bulk-dialog-description">${retry ? "为符合条件的任务创建新的模拟重试。原任务与历史记录会完整保留。" : "取消符合条件的运行中或排队任务。已有诊断、变更证据和审批记录会保留。"}</p></div><div class="tl-dialog-summary"><span><strong>${eligible.length}</strong> 项将${retry ? "重试" : "取消"}</span><span><strong>${skipped.length}</strong> 项跳过</span><span>选中 ${plan.requestedIds?.length || eligible.length + skipped.length} 项</span></div><div class="tl-dialog-body" tabindex="0" aria-label="将处理和跳过的任务">${eligible.length ? `<section class="tl-dialog-group"><h3>${icon("Check", 13)}将${retry ? "创建新重试" : "取消"}<span>${eligible.length}</span></h3><ul class="tl-dialog-task-list">${eligible.map((entry) => `<li><span class="tl-dialog-task-check">${icon("Check", 11)}</span><span><strong>${e(entry.title || entry.id)}</strong><small>${e(entry.id)}</small></span></li>`).join("")}</ul></section>` : `<div class="tl-dialog-no-eligible">${icon("CircleAlert", 20)}<strong>没有符合条件的任务</strong><p>${e(plan.reason || "所选任务当前不支持此操作。")}</p></div>`}${skipped.length ? `<section class="tl-dialog-group tl-dialog-skipped"><h3>${icon("Info", 13)}这些任务将跳过<span>${skipped.length}</span></h3><ul class="tl-dialog-task-list">${skipped.map((entry) => `<li><span class="tl-dialog-task-check">${icon("ArrowRight", 11)}</span><span><strong>${e(entry.title || entry.id)}</strong><small>${e(entry.id)} · ${e(entry.reason)}</small></span></li>`).join("")}</ul></section>` : ""}</div><p class="tl-dialog-note">${icon("LockKeyhole", 13)}${demo ? "仅更新当前演示会话，不调用真实执行器。审批仍需逐关处理。" : "真实连接当前只读，批量写入接口尚未接入。"}</p><div class="tl-dialog-actions"><button type="button" class="ui-button tl-button" ${action("bulk-close")}>返回列表</button><button type="button" class="ui-button tl-button ${retry ? "ui-button-primary tl-button-primary" : "ui-button-danger tl-button-danger"}" ${action("bulk-confirm")} ${enabled ? "" : "disabled"}>${icon(retry ? "RotateCcw" : "Ban", 14)}${retry ? `创建 ${eligible.length} 项重试` : `取消 ${eligible.length} 项任务`}</button></div>`;
}
