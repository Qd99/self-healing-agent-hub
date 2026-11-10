/** Pure snapshot analytics; no executor, metric query or historical estimates. */
import { filterTasks, getMetrics, getTrend } from "./model.js";

const STATUS_ORDER = [
  "completed",
  "failed",
  "running",
  "review",
  "pending",
  "cancelled",
  "skipped",
  "unknown",
];
const shanghaiDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function dateKey(value) {
  const parts = Object.fromEntries(
    shanghaiDate
      .formatToParts(Date.parse(value))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function groupId(value) {
  return typeof value === "string" && value.trim() ? value : "unknown";
}

function percent(count, total) {
  return total > 0 ? (count * 100) / total : null;
}

function compareGroups(left, right) {
  return (
    right.count - left.count ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  );
}

/**
 * Reports use one creation-date cohort and one clock across every breakdown.
 * Review is an exclusive display state; outcomes still use framework status.
 * Missing IDs share the non-drillable "unknown" group with that literal ID.
 */
export function getDashboardAnalytics(
  tasks = [],
  { days = 7, now = Date.now() } = {},
) {
  const requestedDays =
    typeof days === "number" || typeof days === "string" ? Number(days) : NaN;
  const period = [1, 7, 30].includes(requestedDays) ? requestedDays : 7;
  const timestamp = new Date(now).getTime();
  const source = Array.isArray(tasks)
    ? tasks.filter((item) => item && typeof item === "object")
    : [];
  const filtered = Number.isFinite(timestamp)
    ? filterTasks(source, { days: period, now: timestamp })
    : [];
  const metrics = getMetrics(filtered);
  const daily = getTrend(filtered, { days: period, now: timestamp }).map(
    (day) => ({ ...day, total: 0, other: 0 }),
  );
  const daysByDate = new Map(daily.map((day) => [day.date, day]));
  const stateCounts = new Map(STATUS_ORDER.map((id) => [id, 0]));
  const typeCounts = new Map();
  const engineTasks = new Map();

  for (const item of filtered) {
    const day = daysByDate.get(dateKey(item.task.metadata.createdAt));
    if (day) day.total += 1;

    const displayState =
      item.reviewState === "pending" ? "review" : item.status?.status;
    const state = stateCounts.has(displayState) ? displayState : "unknown";
    stateCounts.set(state, stateCounts.get(state) + 1);

    const type = groupId(item.task?.type);
    typeCounts.set(type, (typeCounts.get(type) || 0) + 1);
    const engine = groupId(item.engineId);
    if (!engineTasks.has(engine)) engineTasks.set(engine, []);
    engineTasks.get(engine).push(item);
  }

  for (const day of daily) {
    day.other = day.total - day.completed - day.failed;
  }
  const statuses = [...stateCounts].map(([id, count]) => ({
    id,
    count,
    percent: percent(count, metrics.total),
  }));
  const types = [...typeCounts]
    .map(([id, count]) => ({
      id,
      count,
      percent: percent(count, metrics.total),
    }))
    .sort(compareGroups);
  const engines = [...engineTasks]
    .map(([id, entries]) => {
      const outcome = getMetrics(entries);
      return {
        id,
        count: entries.length,
        percent: percent(entries.length, metrics.total),
        completed: outcome.completed,
        failed: outcome.failed,
        successRate: outcome.successRate,
        averageDurationMs: outcome.averageDurationMs,
      };
    })
    .sort(compareGroups);

  return {
    days: period,
    tasks: filtered,
    metrics,
    daily,
    statuses,
    types,
    engines,
  };
}
