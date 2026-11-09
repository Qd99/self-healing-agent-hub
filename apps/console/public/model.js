/** Pure, browser-safe presentation helpers for the console snapshot contract. */

const DAY_MS = 86_400_000;
const shanghaiDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const htmlEntities = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) => htmlEntities[character],
  );
}

export function formatDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms === 0) return "0s";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}h${minutes ? ` ${minutes}m` : ""}`;
  if (minutes) return `${minutes}m${seconds ? ` ${seconds}s` : ""}`;
  return `${seconds}s`;
}

function dateOrdinal(timestamp) {
  if (!Number.isFinite(timestamp)) return NaN;
  const parts = Object.fromEntries(
    shanghaiDate
      .formatToParts(timestamp)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return (
    Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) /
    DAY_MS
  );
}

function createdTimestamp(item) {
  return Date.parse(item.task?.metadata?.createdAt ?? "");
}

function searchableText(item) {
  const task = item.task ?? {};
  const payload = task.payload ?? {};
  const error = payload.errorDetails ?? {};
  return [
    item.title,
    task.id,
    task.type,
    payload.repo,
    payload.branch,
    ...(payload.files ?? []),
    error.code,
    error.message,
  ]
    .filter((value) => value != null)
    .join(" ")
    .toLowerCase();
}

/** Recent N Shanghai calendar days, including today. days <= 0 means all dates. */
export function filterTasks(
  tasks,
  { query = "", status = "all", days = 7, now = Date.now() } = {},
) {
  const needle = String(query).trim().toLowerCase();
  const nowTimestamp = new Date(now).getTime();
  const count = Number(days);
  const lowerDate =
    count > 0 ? dateOrdinal(nowTimestamp) - Math.ceil(count) + 1 : -Infinity;
  return tasks.filter((item) => {
    const timestamp = createdTimestamp(item);
    if (
      !Number.isFinite(timestamp) ||
      timestamp > nowTimestamp ||
      dateOrdinal(timestamp) < lowerDate
    )
      return false;
    if (
      status === "review"
        ? item.reviewState !== "pending"
        : status !== "all" && item.status?.status !== status
    )
      return false;
    return !needle || searchableText(item).includes(needle);
  });
}

/** Pending review is an independent UI state; it never replaces TaskStatus. */
export function getMetrics(tasks) {
  const metrics = {
    total: tasks.length,
    completed: 0,
    failed: 0,
    running: 0,
    pending: 0,
    review: 0,
    successRate: null,
    averageDurationMs: null,
  };
  const durations = [];
  for (const item of tasks) {
    const status = item.status?.status;
    if (["completed", "failed", "running", "pending"].includes(status))
      metrics[status] += 1;
    if (item.reviewState === "pending") metrics.review += 1;
    if (status !== "completed" && status !== "failed") continue;
    let duration = item.result?.timings?.durationMs;
    if (
      duration == null &&
      item.status?.startedAt &&
      item.status?.completedAt
    ) {
      duration =
        Date.parse(item.status.completedAt) - Date.parse(item.status.startedAt);
    }
    if (
      typeof duration === "number" &&
      Number.isFinite(duration) &&
      duration >= 0
    )
      durations.push(duration);
  }
  const terminalCount = metrics.completed + metrics.failed;
  if (terminalCount > 0)
    metrics.successRate = (metrics.completed * 100) / terminalCount;
  if (durations.length > 0)
    metrics.averageDurationMs =
      durations.reduce((sum, ms) => sum + ms, 0) / durations.length;
  return metrics;
}

/** Counts terminal outcomes by the same creation date used by the task filter. */
export function getTrend(tasks, { days = 7, now = Date.now() } = {}) {
  const count = Number.isFinite(Number(days))
    ? Math.max(0, Math.floor(Number(days)))
    : 7;
  const nowTimestamp = new Date(now).getTime();
  const lastDate = dateOrdinal(nowTimestamp);
  if (!Number.isFinite(lastDate)) return [];
  const firstDate = lastDate - count + 1;
  const trend = Array.from({ length: count }, (_, index) => {
    const date = new Date((firstDate + index) * DAY_MS)
      .toISOString()
      .slice(0, 10);
    return {
      date,
      label: `${date.slice(5, 7)}/${date.slice(8, 10)}`,
      completed: 0,
      failed: 0,
    };
  });
  for (const item of tasks) {
    const status = item.status?.status;
    if (status !== "completed" && status !== "failed") continue;
    const timestamp = createdTimestamp(item);
    if (!Number.isFinite(timestamp) || timestamp > nowTimestamp) continue;
    const index = dateOrdinal(timestamp) - firstDate;
    if (index >= 0 && index < count) trend[index][status] += 1;
  }
  return trend;
}
