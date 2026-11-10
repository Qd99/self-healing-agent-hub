/** Pure task-list selection and capability planning; demo commands stay local. */

import { filterTasks } from "./model.js";
import { applyDemoAction } from "./data.js";

export const DEFAULT_TASK_FILTERS = Object.freeze({
  query: "",
  status: "all",
  engine: "all",
  type: "all",
  priority: "all",
  source: "all",
  branch: "all",
  days: 0,
});

const PRIORITY_RANK = { urgent: 4, high: 3, medium: 2, low: 1 };
const STATUS_KEYS = [
  "review",
  "running",
  "pending",
  "failed",
  "completed",
  "cancelled",
  "skipped",
];
const facets = {
  engine: (item) => item.engineId,
  type: (item) => item.task?.type,
  priority: (item) => item.task?.priority,
  // TriggerSource is webhook / cron / manual; metadata.source is event detail.
  source: (item) => item.task?.metadata?.triggeredBy,
  branch: (item) => item.task?.payload?.branch,
};

function text(value) {
  return typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
    ? String(value)
    : "";
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function durationMs(item) {
  const duration = item.result?.timings?.durationMs;
  if (
    typeof duration === "number" &&
    Number.isFinite(duration) &&
    duration >= 0
  )
    return duration;
  const elapsed =
    Date.parse(item.status?.completedAt ?? "") -
    Date.parse(item.status?.startedAt ?? "");
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
}

function searchableText(item) {
  const payload = item.task?.payload;
  return [
    item.title,
    item.task?.id,
    payload?.repo,
    payload?.branch,
    ...(Array.isArray(payload?.files) ? payload.files : []),
  ]
    .map(text)
    .join(" ")
    .toLowerCase();
}

/** Review is a list projection; the underlying TaskStatus stays unchanged. */
export function getTaskDisplayStatus(item) {
  return item?.reviewState === "pending"
    ? "review"
    : item?.status?.status || "unknown";
}

/** Status tab counts share every active filter except the selected status. */
export function getTaskList(
  tasks,
  {
    filters = {},
    sort = "created-desc",
    page = 1,
    pageSize = 10,
    now = Date.now(),
  } = {},
) {
  const active = { ...DEFAULT_TASK_FILTERS, ...filters };
  const needle = text(active.query).trim().toLowerCase();
  const timestamp = new Date(now).getTime();
  const nonStatus = Number.isFinite(timestamp)
    ? filterTasks(tasks, { days: active.days, now: timestamp }).filter(
        (item) =>
          (!needle || searchableText(item).includes(needle)) &&
          Object.entries(facets).every(
            ([key, value]) =>
              active[key] === "all" || value(item) === active[key],
          ),
      )
    : [];
  const counts = Object.fromEntries([
    ["all", nonStatus.length],
    ...STATUS_KEYS.map((status) => [status, 0]),
  ]);
  for (const item of nonStatus) {
    const status = getTaskDisplayStatus(item);
    if (STATUS_KEYS.includes(status)) counts[status] += 1;
  }

  const filtered = nonStatus.filter(
    (item) =>
      active.status === "all" || getTaskDisplayStatus(item) === active.status,
  );
  filtered.sort((left, right) => {
    let comparison;
    if (sort === "priority-desc") {
      comparison =
        (PRIORITY_RANK[right.task?.priority] ?? 0) -
        (PRIORITY_RANK[left.task?.priority] ?? 0);
    } else if (sort === "duration-desc") {
      comparison = (durationMs(right) ?? -1) - (durationMs(left) ?? -1);
    } else {
      comparison =
        Date.parse(right.task.metadata.createdAt) -
        Date.parse(left.task.metadata.createdAt);
      if (sort === "created-asc") comparison *= -1;
    }
    return comparison || compareText(text(left.task?.id), text(right.task?.id));
  });

  const size = [10, 20, 50].includes(Number(pageSize)) ? Number(pageSize) : 10;
  const pageCount = Math.max(1, Math.ceil(filtered.length / size));
  const current = Math.min(
    pageCount,
    Math.max(1, Number.isFinite(Number(page)) ? Math.floor(Number(page)) : 1),
  );
  const offset = (current - 1) * size;
  return {
    filtered,
    items: filtered.slice(offset, offset + size),
    total: filtered.length,
    page: current,
    pageSize: size,
    pageCount,
    start: filtered.length ? offset + 1 : 0,
    end: Math.min(offset + size, filtered.length),
    counts,
  };
}

export function getTaskFilterOptions(tasks) {
  const values = (key) =>
    [
      ...new Set(
        tasks
          .map(facets[key])
          .filter((value) => typeof value === "string" && value.trim()),
      ),
    ].sort(compareText);
  return {
    engines: values("engine"),
    types: values("type"),
    priorities: values("priority").sort(
      (left, right) =>
        (PRIORITY_RANK[right] ?? 0) - (PRIORITY_RANK[left] ?? 0) ||
        compareText(left, right),
    ),
    sources: values("source"),
    branches: values("branch"),
  };
}

/** A plan contains explicit IDs only and cannot authorize approval decisions. */
export function planBulkAction(snapshot, { type, ids } = {}) {
  if (type !== "cancel" && type !== "retry")
    throw new TypeError("批量操作仅支持取消或重试");
  const requestedIds = Array.isArray(ids)
    ? [...new Set(ids.filter((id) => typeof id === "string" && id.trim()))]
    : [];
  const label = type === "cancel" ? "取消" : "重试";
  const blocked = !["demo", "live"].includes(snapshot?.mode)
    ? "尚未读取任务数据"
    : requestedIds.length > 100
      ? "一次最多处理 100 项任务，请减少选择"
      : snapshot.capabilities?.[type] !== true
        ? `当前数据源未开放${label}能力`
        : "";
  const allowedStatuses =
    type === "cancel" ? ["pending", "running"] : ["failed", "cancelled"];
  const statusReason =
    type === "cancel"
      ? "只有等待中、待审阅或执行中的任务可以取消"
      : "只有失败或已取消的任务可以重试";
  const eligible = [];
  const skipped = [];
  for (const id of requestedIds) {
    const item = snapshot?.tasks?.find(
      (candidate) => candidate.task?.id === id,
    );
    const title = text(item?.title) || id;
    const reason = !item
      ? "任务不存在或已被移除"
      : blocked ||
        (type === "cancel" && item.execution?.cancelRequested
          ? "取消请求已提交，等待 Agent 确认"
          : "") ||
        (type === "retry" && item.reconciliation?.status === "required"
          ? "任务待核对，请先记录核对结论"
          : "") ||
        (allowedStatuses.includes(item.status?.status) ? "" : statusReason);
    if (reason) skipped.push({ id, title, reason });
    else
      eligible.push({
        id,
        title,
        ...(Number.isSafeInteger(item.revision)
          ? { revision: item.revision }
          : {}),
      });
  }
  return {
    type,
    requestedIds,
    eligible,
    skipped,
    canExecute: eligible.length > 0,
    reason:
      blocked ||
      (!requestedIds.length
        ? "请先选择任务"
        : !eligible.length
          ? skipped[0]?.reason || statusReason
          : ""),
  };
}

/** Rebuild eligibility at execution time; each reducer call retains its audit. */
export function applyDemoBulkAction(snapshot, action, now = Date.now()) {
  const plan = planBulkAction(snapshot, action);
  const report = {
    type: plan.type,
    requested: plan.requestedIds.length,
    applied: [],
    skipped: [...plan.skipped],
  };
  if (snapshot?.mode !== "demo") {
    report.skipped.push(
      ...plan.eligible.map((entry) => ({
        ...entry,
        reason: "模拟操作仅适用于演示模式",
      })),
    );
    return { snapshot, report };
  }
  if (!plan.canExecute) return { snapshot, report };
  const timestamp = new Date(now).getTime();
  if (!Number.isFinite(timestamp)) throw new TypeError("操作需要有效时间");
  let next = snapshot;
  for (const target of plan.eligible) {
    const current = planBulkAction(next, { type: plan.type, ids: [target.id] });
    if (!current.canExecute) {
      report.skipped.push(...current.skipped);
      continue;
    }
    try {
      const updated = applyDemoAction(
        next,
        { type: plan.type, id: target.id },
        timestamp,
      );
      report.applied.push({
        ...target,
        ...(plan.type === "retry" ? { newId: updated.tasks[0].task.id } : {}),
      });
      next = updated;
    } catch (error) {
      report.skipped.push({
        ...target,
        reason: error instanceof Error ? error.message : "该任务未能完成操作",
      });
    }
  }
  return { snapshot: next, report };
}

// Deliberately do not serialize payload, context, logs, evidence or raw snapshots.
function exportSummary(item) {
  return {
    id: text(item.task?.id),
    title: text(item.title),
    type: text(item.task?.type),
    status: text(getTaskDisplayStatus(item)),
    priority: text(item.task?.priority),
    engine: text(item.engineId),
    source: text(item.task?.metadata?.triggeredBy),
    repo: text(item.task?.payload?.repo),
    branch: text(item.task?.payload?.branch),
    createdAt: text(item.task?.metadata?.createdAt),
    duration: durationMs(item),
  };
}

function csvCell(value) {
  const cell = text(value);
  const safe = /^[\s\p{Cc}\p{Cf}]*[=+\-@]/u.test(cell) ? `'${cell}` : cell;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** UTF-8 BOM and CRLF rows; a Chinese header keeps the data a regular CSV table. */
export function exportTasksCSV(tasks) {
  const headers = [
    "任务 ID",
    "任务标题",
    "任务类型",
    "状态",
    "优先级",
    "执行引擎",
    "触发来源",
    "仓库",
    "分支",
    "创建时间",
    "耗时（毫秒）",
  ];
  const rows = [
    headers,
    ...tasks.map((item) => Object.values(exportSummary(item))),
  ];
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export function exportTasksJSON(
  tasks,
  { mode = "unknown", now = Date.now() } = {},
) {
  return JSON.stringify(
    {
      mode: ["demo", "live"].includes(mode) ? mode : "unknown",
      exportedAt: new Date(now).toISOString(),
      tasks: tasks.map(exportSummary),
    },
    null,
    2,
  );
}
