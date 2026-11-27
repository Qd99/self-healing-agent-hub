/** The composition root alone registers pages and owns deep-link syntax. */
export const registry = Object.freeze({
  overview: Object.freeze({ title: "工作台", icon: "LayoutDashboard" }),
  tasks: Object.freeze({ title: "任务", icon: "ListChecks" }),
});
const scopes = new Set(["all", "running", "attention", "queued", "ended"]);
export function parseRoute(hash = "") {
  const [candidate, search = ""] = hash.replace(/^#/, "").split("?", 2);
  const page = Object.hasOwn(registry, candidate) ? candidate : "overview";
  const params = new URLSearchParams(search);
  const taskId = page === "tasks" ? params.get("task") : null;
  return {
    page,
    taskId,
    scope: scopes.has(params.get("scope")) ? params.get("scope") : "all",
  };
}
export function routeHref({ page = "overview", taskId, scope = "all" } = {}) {
  const target = Object.hasOwn(registry, page) ? page : "overview";
  const params = new URLSearchParams();
  if (target === "tasks" && taskId) params.set("task", taskId);
  if (target === "tasks" && scope !== "all" && scopes.has(scope))
    params.set("scope", scope);
  return `#${target}${params.size ? `?${params}` : ""}`;
}
