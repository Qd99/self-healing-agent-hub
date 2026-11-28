/** Authoritative, browser-safe P1 management operations. Existing v1 semantics remain intact. */
export const API_PREFIX = "/api/healing";
const operation = (method, route, response, auth) =>
  Object.freeze({ method, route, path: API_PREFIX + route, response, auth });
export const operations = Object.freeze({
  sessionCreate: operation(
    "POST",
    "/session",
    "session",
    "management-bearer-or-local",
  ),
  sessionDelete: operation(
    "DELETE",
    "/session",
    "message",
    "management-session-csrf-or-bearer-or-local",
  ),
  snapshotRead: operation(
    "GET",
    "/snapshot",
    "snapshot",
    "management-session-or-bearer-or-local",
  ),
});

const read = (route, response = "list") =>
  operation("GET", route, response, "management-session");
const write = (
  route,
  capability,
  { method = "POST", response = "mutation", idempotent = false } = {},
) =>
  Object.freeze({
    ...operation(method, route, response, "management-session-csrf"),
    capability,
    idempotent,
  });
const dashboardRead = (path, response) =>
  Object.freeze({ method: "GET", path, response, auth: "dashboard-basic" });

export const taskTypes = Object.freeze({
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
});
export const taskPriorities = Object.freeze({
  urgent: "紧急",
  high: "高",
  medium: "中",
  low: "低",
});

/** Existing human-facing operations only. No worker, telemetry or release endpoints. */
export const existingOperations = Object.freeze({
  taskCreate: write("/trigger", "trigger", {
    response: "task-created",
    idempotent: true,
  }),
  taskCancel: write("/tasks/:id/cancel", "cancel", { idempotent: true }),
  taskRetry: write("/tasks/:id/retry", "retry", {
    response: "task-created",
    idempotent: true,
  }),
  taskBulk: write("/tasks/bulk", "bulk", {
    response: "bulk",
    idempotent: true,
  }),
  approvalDecide: write("/approvals/:id/decision", "approve"),
  taskVerify: write("/tasks/:id/verification", "verifyResult"),
  taskReconcile: write("/tasks/:id/reconcile", "reconcile", {
    idempotent: true,
  }),
  jenkinsImport: write("/integrations/jenkins/builds", "importCi", {
    idempotent: true,
  }),
  ruleUpdate: write("/rules/:id", "updateRules", { method: "PATCH" }),
  monitoringUpdate: write("/monitoring", "updateMonitoring", { method: "PUT" }),
  monitoringCheck: write("/monitoring/check", "updateMonitoring", {
    response: "monitor-check",
  }),
  githubIssues: read("/workbench/github-issues"),
  githubIssue: read("/workbench/github-issue", "github-detail"),
  githubPrs: read("/workbench/github-prs"),
  githubPr: read("/workbench/github-pr", "github-detail"),
  zentaoRead: read("/workbench/zentao"),
  recordsRead: read("/workbench/records"),
  metricsRead: read("/workbench/metrics", "series"),
  alertsRead: read("/workbench/alerts"),
  profilesRead: read("/advanced/profiles", "profiles"),
  jobsRead: read("/advanced/jobs"),
  jobRead: read("/advanced/job", "job"),
  traceRead: read("/advanced/trace"),
  evidenceRead: read("/advanced/evidence"),
  effectsRead: read("/advanced/effects"),
  samplesRead: read("/advanced/samples"),
  runnerRead: dashboardRead("/api/console/runner", "runner"),
  feishuRead: dashboardRead("/api/feishu/channel", "feishu"),
  autoloopRead: read("/workbench/autoloop", "autoloop"),
});

export function existingPath(action, id) {
  if (!Object.hasOwn(existingOperations, action))
    throw new TypeError("Unsupported management operation");
  const { path } = existingOperations[action];
  if (path.includes(":id")) {
    if (
      typeof id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/.test(id)
    )
      throw new TypeError("Invalid management resource id");
    return path.replace(":id", encodeURIComponent(id));
  }
  if (id !== undefined)
    throw new TypeError("Unexpected management resource id");
  return path;
}
