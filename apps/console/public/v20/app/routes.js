/** The composition root alone registers pages and owns deep-link syntax. */
const page = (title, icon, group) => Object.freeze({ title, icon, group });
export const registry = Object.freeze({
  overview: page("工作台", "LayoutDashboard", "工作区"),
  tasks: page("任务", "ListChecks", "工作区"),
  requirements: page("需求与审批", "GitPullRequestArrow", "工作区"),
  trace: page("全链路", "GitBranch", "研发"),
  tests: page("测试", "FlaskConical", "研发"),
  delivery: page("交付", "PackageCheck", "研发"),
  jenkins: page("Jenkins", "Terminal", "研发"),
  monitor: page("性能监控", "Activity", "运维"),
  healing: page("自愈", "ShieldCheck", "运维"),
  workers: page("执行器", "Cpu", "运维"),
  audit: page("操作记录", "History", "运维"),
  knowledge: page("知识与评估", "FileText", "其他"),
  radar: page("技术雷达", "ScanSearch", "其他"),
  settings: page("设置", "Settings2", ""),
});
const aliases = Object.freeze({
  approvals: "requirements",
  engines: "workers",
  rules: "settings",
  safety: "settings",
  metrics: "monitor",
  monitoring: "monitor",
  activity: "audit",
});
const scopes = new Set(["all", "running", "attention", "queued", "ended"]);
const detailPages = new Set([
  "requirements",
  "trace",
  "tests",
  "monitor",
  "workers",
  "knowledge",
  "radar",
]);
export function parseRoute(hash = "") {
  const [candidate, search = ""] = hash.replace(/^#/, "").split("?", 2);
  const params = new URLSearchParams(search);
  const taskId = ["tasks", "approvals"].includes(candidate)
    ? params.get("task")
    : null;
  const target = taskId
    ? "tasks"
    : Object.hasOwn(aliases, candidate)
      ? aliases[candidate]
      : candidate;
  const selected = Object.hasOwn(registry, target) ? target : "overview";
  const record = detailPages.has(selected)
    ? params.get("record")?.slice(0, 180)
    : null;
  return {
    page: selected,
    taskId,
    scope:
      selected === "tasks" && scopes.has(params.get("scope"))
        ? params.get("scope")
        : "all",
    ...(record ? { record } : {}),
  };
}
export const isLegacyHash = (hash) =>
  Object.hasOwn(aliases, hash.replace(/^#/, "").split("?", 1)[0]);
export function routeHref({
  page = "overview",
  taskId,
  scope = "all",
  record,
} = {}) {
  const target = Object.hasOwn(registry, page) ? page : "overview";
  const params = new URLSearchParams();
  if (target === "tasks" && taskId) params.set("task", taskId);
  if (target === "tasks" && scope !== "all" && scopes.has(scope))
    params.set("scope", scope);
  if (detailPages.has(target) && record) params.set("record", record);
  return `#${target}${params.size ? `?${params}` : ""}`;
}
