import { createV20Client } from "../api/client.js";
import { createSessionController } from "../session/controller.js";
import { e, icon, renderSession, status } from "../shared/view.js";
import {
  overviewModel,
  taskListModel,
  taskDetail,
  renderOverview,
  renderTasks,
  renderTaskDetail,
} from "../domains/tasks/index.js";
import { registry, parseRoute, routeHref } from "./routes.js";

/** Composition root; all DOM and lifecycle work stops here. */
export function mountConsole({
  root,
  detailDialog,
  host = globalThis.window,
  api = createV20Client(),
  storage,
  now,
}) {
  const doc = root.ownerDocument;
  let route = parseRoute(host.location.hash),
    query = "",
    page = 1;
  let sessionState = { status: "loading", snapshot: null, error: null };
  let collapsed = false,
    disposed = false;
  const preference = (key) => {
    try {
      return host.localStorage?.getItem(key);
    } catch {
      return null;
    }
  };
  const remember = (key, value) => {
    try {
      host.localStorage?.setItem(key, value);
    } catch {
      /* Preference is optional. */
    }
  };
  let theme =
    preference("heal-v20-theme") ||
    (host.matchMedia?.("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light");
  if (!["light", "dark"].includes(theme)) theme = "light";
  collapsed = preference("heal-v20-sidebar") === "collapsed";
  const taskHref = (taskId) =>
    routeHref({ page: "tasks", taskId, scope: route.scope });
  function focusTaskLink(id) {
    const link = [...root.querySelectorAll("a")].find(
      (a) => a.getAttribute("href") === taskHref(id),
    );
    (link ?? doc.getElementById("v20-main"))?.focus({ preventScroll: true });
  }
  function closeDetail() {
    const id = route.taskId;
    route = { ...route, taskId: null };
    host.location.hash = routeHref(route);
    if (detailDialog.open) detailDialog.close();
    if (id) focusTaskLink(id);
  }
  function render() {
    if (disposed) return;
    const active = doc.activeElement;
    const restore =
      active && root.contains(active) && active.id === "v20-task-query";
    const caret = restore ? active.selectionStart : null;
    const s = sessionState,
      snapshot = s.snapshot;
    doc.documentElement.dataset.theme = theme;
    const main = snapshot
      ? route.page === "overview"
        ? renderOverview(overviewModel(snapshot), { taskHref })
        : renderTasks(
            taskListModel(snapshot, { query, page, scope: route.scope }),
            { taskHref },
          )
      : renderSession(s);
    root.innerHTML = `<a class="v-skip" href="#v20-main" data-action="skip-main">跳至主要内容</a><div class="v-layout ${collapsed ? "is-collapsed" : ""}"><aside class="v-sidebar" aria-label="主导航"><a class="v-logo" href="#overview">${icon("Layers", 22)}<span>heal.</span></a><div class="v-project"><span class="v-project-mark">H</span><span>${e(snapshot?.project.id || "Agent Hub")}</span></div><div class="v-nav-group">工作区</div><nav aria-label="工作区">${Object.entries(
      registry,
    )
      .map(
        ([id, item]) =>
          `<a class="v-nav-item ${route.page === id ? "active" : ""}" href="${routeHref({ page: id })}" ${route.page === id ? 'aria-current="page"' : ""} title="${e(item.title)}">${icon(item.icon, 15)}<span>${e(item.title)}</span></a>`,
      )
      .join(
        "",
      )}</nav><div class="v-nav-footer"><a class="v-nav-item" href="../index.html" title="打开旧版入口">${icon("ArrowUpRight", 15)}<span>旧版入口</span></a><button class="v-nav-item" data-action="collapse" title="切换导航宽度" aria-expanded="${!collapsed}">${icon("PanelLeftClose", 15)}<span>收起导航</span></button></div></aside><div class="v-workspace"><header class="v-topbar"><div class="v-breadcrumb">${icon("Layers", 15)}<span>${e(snapshot?.project.repo || "Self-Healing Agent Hub")}</span><span>/</span><b>${e(registry[route.page].title)}</b></div><div class="v-top-actions">${snapshot ? status(s.status === "stale" ? "数据陈旧" : s.status === "loading" ? "正在读取" : "真实快照", s.status === "stale" ? "warning" : "neutral") : ""}<button class="v-icon-button" data-action="theme" aria-label="${theme === "light" ? "切换深色主题" : "切换浅色主题"}">${icon(theme === "light" ? "Moon" : "Sun", 16)}</button>${snapshot ? '<button class="v-button" data-action="logout">退出</button>' : ""}</div></header><main class="v-content" id="v20-main" tabindex="-1"><header class="v-page-head"><div><h1>${e(registry[route.page].title)}</h1><p>${route.page === "overview" ? "研发执行 · 当前工作空间" : "当前动作、服务端进度与阻塞原因"}</p></div>${snapshot ? `<button class="v-button" data-action="refresh" ${s.status === "loading" ? "disabled" : ""}>${icon("RefreshCw", 14)}刷新快照</button>` : ""}</header>${snapshot && s.error ? `<div class="v-banner" role="status">${e(s.error.message)} 当前保留最近一次成功读取的快照，仅供查看。</div>` : ""}${main}</main></div></div>`;
    if (restore) {
      const input = root.querySelector("#v20-task-query");
      input?.focus({ preventScroll: true });
      if (caret !== null) {
        try {
          input?.setSelectionRange(caret, caret);
        } catch {
          /* Some search inputs do not support selection. */
        }
      }
    }
    if (snapshot && route.taskId) {
      detailDialog.innerHTML = renderTaskDetail(
        taskDetail(snapshot, route.taskId),
      );
      if (!detailDialog.open) detailDialog.showModal();
    } else {
      if (detailDialog.open) detailDialog.close();
      detailDialog.innerHTML = "";
    }
  }
  const session = createSessionController({
    api,
    storage,
    now,
    onChange(next) {
      sessionState = next;
      render();
    },
  });
  function navigate(next) {
    route = next;
    host.location.hash = routeHref(next);
    render();
  }
  async function click(event) {
    const button = event.target.closest?.("[data-action]");
    if (button && !button.disabled) {
      if (button.dataset.action === "refresh") return session.refresh();
      if (["logout", "retry-logout"].includes(button.dataset.action))
        return session.logout();
      if (button.dataset.action === "confirm-logout")
        return session.logout({ currentSession: true });
      if (button.dataset.action === "close-detail") return closeDetail();
      if (button.dataset.action === "skip-main") {
        event.preventDefault();
        doc.getElementById("v20-main")?.focus();
        return;
      }
      if (button.dataset.action === "theme") {
        theme = theme === "light" ? "dark" : "light";
        remember("heal-v20-theme", theme);
        render();
        return;
      }
      if (button.dataset.action === "collapse") {
        collapsed = !collapsed;
        remember("heal-v20-sidebar", collapsed ? "collapsed" : "expanded");
        render();
        return;
      }
    }
    const scope = event.target.closest?.("[data-scope]");
    if (scope) {
      page = 1;
      query = "";
      navigate({ page: "tasks", taskId: null, scope: scope.dataset.scope });
      return;
    }
    const pager = event.target.closest?.("[data-page]");
    if (pager && !pager.disabled) {
      page = Number(pager.dataset.page);
      render();
    }
  }
  async function submit(event) {
    if (event.target.id !== "v20-login-form") return;
    event.preventDefault();
    const field = event.target.elements.namedItem("token");
    const token = field.value;
    field.value = "";
    event.target.reset();
    await session.login(token);
  }
  function input(event) {
    if (event.target.id === "v20-task-query" && !event.isComposing) {
      const next = event.target.value.slice(0, 200);
      if (next !== query) {
        query = next;
        page = 1;
        render();
      }
    }
  }
  function changed() {
    const next = parseRoute(host.location.hash);
    if (next.page !== route.page || next.scope !== route.scope) {
      page = 1;
      query = "";
    }
    route = next;
    render();
  }
  function cancelled(event) {
    event.preventDefault();
    closeDetail();
  }
  root.addEventListener("click", click);
  root.addEventListener("submit", submit);
  root.addEventListener("input", input);
  root.addEventListener("compositionend", input);
  detailDialog.addEventListener("click", click);
  detailDialog.addEventListener("cancel", cancelled);
  host.addEventListener("hashchange", changed);
  render();
  const ready = session.start();
  return {
    ready,
    dispose() {
      session.dispose();
      disposed = true;
      root.removeEventListener("click", click);
      root.removeEventListener("submit", submit);
      root.removeEventListener("input", input);
      root.removeEventListener("compositionend", input);
      detailDialog.removeEventListener("click", click);
      detailDialog.removeEventListener("cancel", cancelled);
      host.removeEventListener("hashchange", changed);
      if (detailDialog.open) detailDialog.close();
      detailDialog.innerHTML = "";
      root.innerHTML = "";
    },
  };
}

if (typeof document !== "undefined" && document.getElementById("v20-app")) {
  mountConsole({
    root: document.getElementById("v20-app"),
    detailDialog: document.getElementById("v20-task-detail"),
  });
}
