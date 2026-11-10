/** Pure presentation and export helpers for operation records and routing rules. */
const DAY_MS = 86_400_000;
const SHANGHAI_OFFSET = 8 * 60 * 60 * 1000;

export const DEFAULT_ACTIVITY_FILTERS = Object.freeze({
  query: "",
  category: "all",
  level: "all",
  days: 0,
});
export const DEFAULT_RULE_FILTERS = Object.freeze({
  query: "",
  status: "all",
  engine: "all",
});
export const ACTIVITY_CATEGORIES = Object.freeze([
  { value: "all", label: "全部操作" },
  { value: "tasks", label: "任务操作" },
  { value: "approvals", label: "审批操作" },
  { value: "rules", label: "规则变更" },
  { value: "other", label: "其他操作" },
]);
export const ACTIVITY_LEVELS = Object.freeze([
  { value: "all", label: "全部级别" },
  { value: "info", label: "信息" },
  { value: "success", label: "成功" },
  { value: "warning", label: "警告" },
  { value: "error", label: "错误" },
  { value: "unknown", label: "未知级别" },
]);
const ACTIVITY_PAGE_SIZE = 15;

const activityActions = {
  trigger: ["发起巡检", "tasks", "Plus"],
  retry: ["重试任务", "tasks", "RotateCcw"],
  cancel: ["取消任务", "tasks", "Square"],
  running: ["任务开始执行", "tasks", "Play"],
  pending: ["任务进入队列", "tasks", "Clock3"],
  completed: ["任务已完成", "tasks", "Check"],
  failed: ["任务执行失败", "tasks", "CircleAlert"],
  cancelled: ["任务已取消", "tasks", "Square"],
  skipped: ["任务已跳过", "tasks", "ArrowRight"],
  "review-requested": ["提交审批", "approvals", "GitPullRequestArrow"],
  approve: ["通过审批", "approvals", "CheckCheck"],
  reject: ["拒绝审批", "approvals", "X"],
  "approve-gate": ["通过审批节点", "approvals", "CheckCheck"],
  "reject-gate": ["拒绝审批节点", "approvals", "X"],
  "resubmit-approval": ["重新提交审批", "approvals", "GitPullRequestArrow"],
  "toggle-rule": ["变更路由规则", "rules", "Workflow"],
};
const taskTypes = {
  "lint-error": "Lint 错误",
  "format-error": "代码格式",
  "type-error": "类型错误",
  "unit-test-failure": "单元测试失败",
  "e2e-test-failure": "端到端测试失败",
  "architecture-violation": "架构违规",
  "security-issue": "安全问题",
  "ci-failure": "CI 失败",
  "doc-outdated": "文档过期",
  "dependency-issue": "依赖问题",
  "performance-regression": "性能回归",
};
const actions = {
  "auto-commit": "自动提交修复",
  "create-issue": "创建 Issue",
  "create-pr": "创建 Pull Request",
  retry: "重试任务",
};
const priorities = { urgent: "紧急", high: "高", medium: "中", low: "低" };
const workflows = {
  "diagnose-and-fix": "诊断并修复",
  "analyze-and-suggest": "分析并提出建议",
  "security-audit": "安全审计",
  "dependency-audit": "依赖审计",
};
const comparisonOperators = {
  $lt: "小于",
  $lte: "小于或等于",
  $gt: "大于",
  $gte: "大于或等于",
  $eq: "等于",
};
const printable = (value) =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? "未提供");
const lookup = (map, value, fallback = "未配置") =>
  Object.hasOwn(map, value) ? map[value] : String(value || fallback);

export function administrationEngineName(id) {
  return lookup({ fast: "Direct AI", complex: "ZCode Workflow" }, id);
}

/** Labels come only from structured action values; free text is never interpreted. */
export function describeActivity(entry = {}) {
  const known = Object.hasOwn(activityActions, entry.action)
    ? activityActions[entry.action]
    : null;
  return {
    label:
      known?.[0] ||
      (typeof entry.action === "string" && entry.action) ||
      "操作记录",
    category: known?.[1] || "other",
    icon: known?.[2] || "History",
    actor:
      typeof entry.actor === "string" && entry.actor.trim()
        ? entry.actor
        : "未提供操作者",
    message: typeof entry.message === "string" ? entry.message : "",
    level: describeActivityLevel(entry.level),
  };
}

/** A log level describes evidence severity, not whether an operation succeeded. */
export function describeActivityLevel(value) {
  const labels = {
    info: "信息",
    success: "成功",
    warning: "警告",
    error: "错误",
  };
  if (typeof value === "string" && Object.hasOwn(labels, value))
    return {
      value,
      label: labels[value],
      tone: value === "info" ? "neutral" : value,
      raw: value,
    };
  const raw = typeof value === "string" ? value : "";
  return {
    value: "unknown",
    label: raw.trim() ? "未识别" : "未提供",
    tone: "neutral",
    raw,
  };
}

export function activityDateKey(value) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp)
    ? new Date(timestamp + SHANGHAI_OFFSET).toISOString().slice(0, 10)
    : "unknown";
}

/** All dates retains undated evidence; recent ranges require valid, non-future timestamps. */
export function filterActivities(
  entries = [],
  {
    query = "",
    category = "all",
    level = "all",
    days = 0,
    now = Date.now(),
  } = {},
) {
  const needle = String(query).trim().toLowerCase();
  const timestamp = new Date(now).getTime();
  const dayCount = Number(days);
  const start =
    (Math.floor((timestamp + SHANGHAI_OFFSET) / DAY_MS) -
      Math.ceil(dayCount) +
      1) *
      DAY_MS -
    SHANGHAI_OFFSET;
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        return false;
      const description = describeActivity(entry);
      if (category !== "all" && category !== description.category) return false;
      if (level !== "all" && level !== description.level.value) return false;
      const at = Date.parse(entry.at || "");
      if (
        dayCount > 0 &&
        (!Number.isFinite(at) || at < start || at > timestamp)
      )
        return false;
      const searchable = [
        entry.id,
        entry.action,
        entry.actor,
        entry.message,
        entry.taskId,
        entry.ruleId,
        description.label,
      ]
        .filter((value) => typeof value === "string")
        .join(" ")
        .toLowerCase();
      return !needle || searchable.includes(needle);
    })
    .sort((left, right) => {
      const a = Date.parse(left.at || ""),
        b = Date.parse(right.at || "");
      if (!Number.isFinite(a)) return Number.isFinite(b) ? 1 : 0;
      if (!Number.isFinite(b)) return -1;
      return b - a;
    });
}

/** Keep the full filtered result separate from the 15 records currently displayed. */
export function getActivityPage(
  entries = [],
  { filters = {}, page = 1, now = Date.now() } = {},
) {
  const filtered = filterActivities(entries, { ...filters, now });
  const total = filtered.length;
  const pageCount = Math.max(1, Math.ceil(total / ACTIVITY_PAGE_SIZE));
  const requested = Number(page);
  const current = Math.min(
    pageCount,
    Number.isInteger(requested) && requested > 0 ? requested : 1,
  );
  const offset = (current - 1) * ACTIVITY_PAGE_SIZE;
  return {
    items: filtered.slice(offset, offset + ACTIVITY_PAGE_SIZE),
    total,
    page: current,
    pageCount,
    pageSize: ACTIVITY_PAGE_SIZE,
    start: total ? offset + 1 : 0,
    end: Math.min(offset + ACTIVITY_PAGE_SIZE, total),
  };
}

export function groupActivities(entries = []) {
  const groups = new Map();
  for (const entry of entries) {
    const date = activityDateKey(entry.at);
    if (!groups.has(date)) groups.set(date, { date, items: [] });
    groups.get(date).items.push(entry);
  }
  return [...groups.values()];
}

/** Export all filtered records, never the current page, tasks, or the whole snapshot. */
export function exportActivitiesJSON(
  snapshot,
  filters = {},
  { now = Date.now() } = {},
) {
  const fields = [
    "id",
    "at",
    "action",
    "actor",
    "message",
    "taskId",
    "ruleId",
    "level",
  ];
  const activity = filterActivities(snapshot?.activity || [], {
    ...filters,
    now,
  }).map((entry) =>
    Object.fromEntries(
      fields
        .filter((key) => typeof entry[key] === "string")
        .map((key) => [key, entry[key]]),
    ),
  );
  return JSON.stringify(
    {
      schemaVersion: 1,
      mode: snapshot?.mode === "demo" ? "demo" : "live",
      exportedAt: new Date(now).toISOString(),
      count: activity.length,
      activity,
    },
    null,
    2,
  );
}

/** Every match clause is retained. Unknown shapes remain literal configuration. */
export function describeRuleConditions(rule = {}) {
  const match = rule.match;
  if (!match || typeof match !== "object" || Array.isArray(match))
    return ["未设置匹配条件"];
  const conditions = Object.entries(match).flatMap(([path, value]) => {
    if (path === "taskType" && typeof value === "string")
      return [`任务类型为 ${lookup(taskTypes, value)}`];
    if (
      path === "context.retryCount" &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      const entries = Object.entries(value);
      if (entries.length)
        return entries.map(([operator, operand]) =>
          Object.hasOwn(comparisonOperators, operator) &&
          typeof operand === "number"
            ? `重试次数${comparisonOperators[operator]} ${operand}`
            : `${path} 条件 ${JSON.stringify({ [operator]: operand })}`,
        );
    }
    return [`${path} 条件 ${printable(value)}`];
  });
  return conditions.length ? conditions : ["未设置匹配条件"];
}

export function describeRuleProcessor(rule = {}) {
  const processor = rule.processor || {};
  return {
    engine: administrationEngineName(processor.engine),
    action: lookup(actions, processor.action),
    priority: lookup(priorities, processor.priority),
    workflow: processor.workflow
      ? lookup(workflows, processor.workflow)
      : "未指定工作流",
  };
}

/** Keep source order; configured task priority is not a rule ranking. */
export function filterRules(
  rules = [],
  { query = "", status = "all", engine = "all" } = {},
) {
  const needle = String(query).trim().toLowerCase();
  return rules.filter((rule) => {
    if (status === "enabled" && rule.enabled !== true) return false;
    if (status === "disabled" && rule.enabled === true) return false;
    if (engine !== "all" && rule.processor?.engine !== engine) return false;
    const processor = describeRuleProcessor(rule);
    const searchable = [
      rule.id,
      rule.name,
      ...describeRuleConditions(rule),
      ...Object.values(processor),
      JSON.stringify(rule.match),
      JSON.stringify(rule.processor),
    ]
      .join(" ")
      .toLowerCase();
    return !needle || searchable.includes(needle);
  });
}

export function canUpdateRules(state = {}) {
  return (
    state.mode === "demo" &&
    state.snapshot?.mode === "demo" &&
    state.snapshot.capabilities?.updateRules === true
  );
}
