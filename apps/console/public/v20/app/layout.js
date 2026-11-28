import { e, icon, status } from "../shared/view.js";
import { registry, routeHref } from "./routes.js";

const groups = [
  ...new Set(
    Object.values(registry)
      .map((item) => item.group)
      .filter(Boolean),
  ),
];
const descriptions = {
  overview: "研发执行 · 当前工作空间",
  tasks: "当前动作、服务端进度与阻塞原因",
  requirements: "GitHub 需求、评论与任务审批",
  trace: "已采集执行事件与作业",
  tests: "独立 QA、测试用例与报告",
  delivery: "PR、CI 核验与待接入的发布证据",
  jenkins: "失败构建导入与已导入任务",
  monitor: "实测指标与活动告警",
  healing: "修复任务与外部结果",
  workers: "引擎在线状态与接单执行器",
  audit: "当前项目的操作记录",
  knowledge: "知识与评估账本",
  radar: "技术雷达账本",
  settings: "连接、规则与现有服务入口",
};
export function renderShell({
  route,
  snapshot,
  session,
  theme,
  collapsed,
  content,
  canCreate,
  feedback,
}) {
  const link = ([id, item]) =>
    `<a class="v-nav-item ${route.page === id ? "active" : ""}" href="${routeHref({ page: id })}" ${route.page === id ? 'aria-current="page"' : ""} aria-label="${e(item.title)}" title="${e(item.title)}">${icon(item.icon, 15)}<span>${e(item.title)}</span></a>`;
  const sections = groups
    .map(
      (group) =>
        `<div class="v-nav-group">${e(group)}</div><nav aria-label="${e(group)}">${Object.entries(
          registry,
        )
          .filter(([, item]) => item.group === group)
          .map(link)
          .join("")}</nav>`,
    )
    .join("");
  const controls = snapshot
    ? `<div class="v-actions">${canCreate ? '<button class="v-button primary" data-action="open-create">新建任务</button>' : ""}<button class="v-button" data-action="refresh" ${session.status === "loading" || session.writePending ? "disabled" : ""}>${icon("RefreshCw", 14)}刷新快照</button></div>`
    : "";
  const r = registry[route.page];
  return `<a class="v-skip" href="#v20-main" data-action="skip-main">跳至主要内容</a><div class="v-layout ${collapsed ? "is-collapsed" : ""}"><aside class="v-sidebar" aria-label="主导航"><a class="v-logo" href="#overview" aria-label="Heal 工作台">${icon("Layers", 22)}<span>heal.</span></a><div class="v-project"><span class="v-project-mark">H</span><span>${e(snapshot?.project.id || "Agent Hub")}</span></div><div class="v-nav-scroll">${sections}</div><div class="v-nav-footer">${link(["settings", registry.settings])}<a class="v-nav-item" href="../index.html" aria-label="打开旧版入口" title="打开旧版入口">${icon("ArrowUpRight", 15)}<span>旧版入口</span></a><button class="v-nav-item" data-action="collapse" aria-label="切换导航宽度" title="切换导航宽度" aria-expanded="${!collapsed}">${icon("PanelLeftClose", 15)}<span>收起导航</span></button></div></aside><div class="v-workspace"><header class="v-topbar"><div class="v-breadcrumb">${icon("Layers", 15)}<span>${e(snapshot?.project.repo || "Self-Healing Agent Hub")}</span><span>/</span><b>${e(r.title)}</b></div><div class="v-top-actions">${snapshot ? status(session.writePending ? "等待写入回执" : session.status === "stale" ? "数据陈旧" : session.status === "loading" ? "正在读取" : "真实快照", session.status === "stale" ? "warning" : "neutral") : ""}<button class="v-icon-button" data-action="theme" aria-label="${theme === "light" ? "切换深色主题" : "切换浅色主题"}">${icon(theme === "light" ? "Moon" : "Sun", 16)}</button>${snapshot ? `<button class="v-button" data-action="logout" ${session.writePending ? "disabled" : ""}>退出</button>` : ""}</div></header><main class="v-content" id="v20-main" tabindex="-1"><header class="v-page-head"><div><h1>${e(r.title)}</h1><p>${e(descriptions[route.page])}</p></div>${controls}</header>${snapshot && session.error ? `<div class="v-banner" role="status">${e(session.error.message)} 当前保留最近一次成功读取的快照，仅供查看。</div>` : ""}${feedback}${content}</main></div></div>`;
}
