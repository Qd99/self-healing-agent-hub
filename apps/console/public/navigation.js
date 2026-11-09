import { icon } from "./icons.js";
import { escapeHtml as e } from "./model.js";

export function connectionState(s) {
  if (s.loading)
    return {
      tone: "loading",
      title: "正在连接",
      detail: "读取工作空间配置",
      icon: "LoaderCircle",
    };
  if (s.mode === "demo")
    return {
      tone: "demo",
      title: "演示工作空间",
      detail: "本次会话内模拟操作",
      icon: "FlaskConical",
    };
  if (s.error || !s.snapshot)
    return {
      tone: "error",
      title: "连接异常",
      detail: "查看连接设置",
      icon: "WifiOff",
    };
  return {
    tone: "readonly",
    title: "配置已连接",
    detail: "只读模式 · 执行器未接入",
    icon: "ShieldCheck",
  };
}

export function renderSidebar(s, pages) {
  const review =
    s.snapshot?.tasks.filter((t) => t.reviewState === "pending").length || 0;
  const navItem = (id) => {
    const page = pages[id],
      count = id === "approvals" ? review : null;
    return `<a href="#${id}" class="nav-item ${s.view === id ? "active" : ""}" aria-label="${e(page.title)}" ${s.view === id ? 'aria-current="page"' : ""} data-nav="${id}">${icon(page.icon, 18)}<span class="nav-copy">${e(page.title)}</span>${count ? `<span class="nav-count">${count}</span>` : ""}<span class="nav-tooltip" aria-hidden="true">${e(page.title)}${count ? ` · ${count}` : ""}</span></a>`;
  };
  return `<aside id="primary-navigation" class="sidebar ${s.mobileNav ? "mobile-open" : ""}" aria-label="主导航">
    <div class="brand"><a href="#overview" aria-label="heal 工作台"><span class="brand-mark">${icon("Layers", 19)}</span><span class="brand-copy">heal</span></a><button class="ui-icon-button icon-button sidebar-close" data-action="close-nav" aria-label="关闭导航">${icon("X", 18)}</button></div>
    <div class="sidebar-scroll"><nav class="nav-list" aria-label="工作空间">${["overview", "tasks", "approvals", "monitoring", "activity"].map(navItem).join("")}</nav><div class="nav-divider" aria-hidden="true"></div><nav class="nav-list" aria-label="管理配置">${["engines", "rules", "safety"].map(navItem).join("")}</nav></div>
    <div class="sidebar-bottom"><nav class="nav-list sidebar-utilities" aria-label="设置">${navItem("settings")}</nav><div class="sidebar-tools"><button class="ui-icon-button icon-button sidebar-theme" data-action="theme" data-theme="${s.theme === "dark" ? "light" : "dark"}" aria-label="切换${s.theme === "dark" ? "浅色" : "深色"}主题" title="切换${s.theme === "dark" ? "浅色" : "深色"}主题">${icon(s.theme === "dark" ? "Moon" : "Sun", 17)}</button><button class="sidebar-collapse ui-icon-button icon-button" data-action="sidebar-toggle" aria-label="${s.sidebarCollapsed ? "展开" : "收起"}侧边栏" aria-expanded="${!s.sidebarCollapsed}" aria-controls="primary-navigation" title="${s.sidebarCollapsed ? "展开" : "收起"}侧边栏">${icon(s.sidebarCollapsed ? "PanelLeftOpen" : "PanelLeftClose", 17)}</button></div></div>
  </aside><div class="sidebar-backdrop ${s.mobileNav ? "open" : ""}" data-action="close-nav" aria-hidden="true"></div>`;
}

export function renderTopbar(s, pages) {
  const project =
    s.snapshot?.project?.repo?.split("/").at(-1) || "self-healing-agent-hub";
  const connection = connectionState(s);
  return `<header class="topbar"><div class="row grow"><button class="ui-icon-button icon-button mobile-menu" data-action="open-nav" aria-label="打开导航" aria-expanded="${s.mobileNav}" aria-controls="primary-navigation">${icon("Menu", 19)}</button><div class="breadcrumb"><span class="project-name truncate">${e(project)}</span><span class="breadcrumb-current">${pages[s.view].title}</span></div></div><div class="topbar-actions">${s.view !== "tasks" ? `<button class="ui-icon-button icon-button search-trigger" data-action="search" aria-label="搜索任务" title="搜索任务 · ⌘K / Ctrl K">${icon("Search", 17)}</button>` : ""}<button class="mode-badge connection-${connection.tone}" data-action="navigate" data-view="settings" title="${e(connection.detail)}" aria-label="${e(connection.title)}，${e(connection.detail)}。打开连接设置">${connection.tone === "loading" ? "连接中" : connection.tone === "demo" ? "演示" : connection.tone === "readonly" ? "只读" : "连接异常"}</button></div></header>`;
}
