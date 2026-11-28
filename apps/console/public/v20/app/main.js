import { createV20Client } from "../api/client.js";
import { taskPriorities, taskTypes } from "../api/contract.generated.js";
import { createSessionController } from "../session/controller.js";
import { e, renderSession } from "../shared/view.js";
import { listTable, panel, text } from "../shared/workspace.js";
import {
  overviewModel,
  renderCreateTask,
  renderOverview,
  renderTaskDetail,
  renderTaskOperations,
  renderTasks,
  taskDetail,
  taskListModel,
  taskOffers,
} from "../domains/tasks/index.js";
import {
  renderAudit,
  renderDelivery,
  renderHealing,
  renderJenkins,
  renderSettings,
  renderWorkers,
} from "../domains/operations/index.js";
import * as autoloopViews from "../domains/autoloop/index.js";
import {
  renderKnowledge,
  renderRadar,
  renderRequirements,
  renderTests,
  requirementRecord,
} from "../domains/analysis/index.js";
import { renderMonitor, renderTrace } from "../domains/observability/index.js";
import { isLegacyHash, parseRoute, routeHref } from "./routes.js";
import {
  advancedPage,
  createWorkspaceLoader,
  monitorSelection,
  requirementsSelection,
  workspaceRequests,
} from "./workspace-resources.js";
import { renderShell } from "./layout.js";
import { canOperate, commandFor } from "./commands.js";

/** Composition root: views only receive the current UI models and commands. */
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
    page = 1,
    auditQuery = "";
  let sessionState = { status: "loading", snapshot: null, error: null };
  let creating = false,
    disposed = false,
    readCycle = 0,
    busy = false,
    feedback = {},
    monitorReceipt = null;
  const drafts = new Map(),
    selected = new Map();
  const getPreference = (key) => {
    try {
      return host.localStorage?.getItem(key);
    } catch {
      return null;
    }
  };
  const setPreference = (key, value) => {
    try {
      host.localStorage?.setItem(key, value);
    } catch {
      /* Optional. */
    }
  };
  let theme =
    getPreference("heal-v20-theme") ||
    (host.matchMedia?.("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light");
  if (!["light", "dark"].includes(theme)) theme = "light";
  let collapsed = getPreference("heal-v20-sidebar") === "collapsed";
  const localTask = (taskId) =>
    routeHref({ page: "tasks", taskId, scope: route.scope });
  const can = (action, kind) => canOperate(sessionState, action, kind);
  const isTab = (name) => route.page === name;
  const taskList = () =>
    taskListModel(sessionState.snapshot, { query, page, scope: route.scope });
  const draft = (action, id) => drafts.get(`${action}:${id ?? ""}`) ?? {};
  const workspace = createWorkspaceLoader({
    api,
    onChange: () => render(),
    onUnauthorized: () => {
      void session.refresh();
    },
  });
  function syncWorkspace() {
    const { snapshot, status, writePending } = sessionState;
    if (!snapshot) {
      workspace.dispose();
      return;
    }
    if (status !== "ready" || writePending) return;
    workspace.change(
      JSON.stringify([
        snapshot.project.id,
        snapshot.project.repo,
        route.page,
        route.record,
        readCycle,
        snapshot.configRevisions?.monitoring,
      ]),
      workspaceRequests(route, snapshot),
    );
  }
  function onSession(next) {
    const previous = sessionState;
    sessionState = next;
    if (!next.snapshot) {
      creating = false;
      selected.clear();
      drafts.clear();
      monitorReceipt = null;
      feedback = {};
    }
    if (
      next.status === "ready" &&
      (previous.status !== "ready" ||
        next.loadedAt !== previous.loadedAt ||
        next.snapshot?.revision !== previous.snapshot?.revision)
    )
      readCycle++;
    syncWorkspace();
    render();
  }
  const session = createSessionController({
    api,
    storage,
    now,
    onChange: onSession,
  });
  function pageContent(s) {
    const ws = workspace.state(),
      context = { taskHref: localTask, can };
    switch (route.page) {
      case "overview":
        return (
          renderOverview(overviewModel(s), context) +
          autoloopViews.renderAutoloopOverview(ws.autoloop)
        );
      case "tasks":
        return renderTasks(taskList(), {
          ...context,
          selected,
          canBulkCancel: can("taskBulk", "cancel"),
          canBulkRetry: can("taskBulk", "retry"),
        });
      case "requirements":
        return renderRequirements(
          ws,
          requirementsSelection(route.record),
          s,
          localTask,
        );
      case "trace":
        return renderTrace(ws, { ...route, views: autoloopViews });
      case "tests":
        return renderTests(ws, advancedPage(route.record));
      case "delivery":
        return renderDelivery(s, context);
      case "jenkins":
        return renderJenkins(s, { ...context, draft: draft("jenkinsImport") });
      case "monitor":
        return renderMonitor(
          ws,
          monitorSelection(route.record, s.monitoring?.namespaces ?? []),
          s.monitoring?.namespaces,
        );
      case "healing":
        return renderHealing(s, { ...context, autoloop: ws.autoloop, views: autoloopViews });
      case "workers":
        return renderWorkers(s, ws, autoloopViews);
      case "audit":
        return renderAudit(s, { ...context, auditQuery, autoloop: ws.autoloop, views: autoloopViews });
      case "knowledge":
        return renderKnowledge(ws);
      case "radar":
        return renderRadar(ws);
      case "settings":
        return renderSettings(s, ws, {
          ...context,
          draft: draft("monitoringUpdate"),
          monitoringCheck:
            monitorReceipt?.config === JSON.stringify(s.monitoring)
              ? monitorReceipt.check
              : null,
        });
      default:
        return "";
    }
  }
  const note = () =>
    feedback.message
      ? `<div class="v-banner ${feedback.error ? "is-error" : ""}" role="${feedback.error ? "alert" : "status"}">${e(feedback.message)}</div>`
      : "";
  function bulkReport(report) {
    const rows = [
      ...report.applied.map((item) => [
        text(item.title),
        text(item.newId ? `已重试 · ${item.newId}` : "已受理"),
      ]),
      ...report.skipped.map((item) => [
        text(item.title),
        text(item.reason, "未受理"),
      ]),
    ];
    return panel("逐项回执", listTable(["任务", "结果"], rows));
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
    // Preserve an in-flight form's DOM while unrelated read panels finish loading.
    const form = active?.closest?.("form[data-command], form[data-local]");
    if (
      form &&
      root.contains(form) &&
      !busy &&
      snapshot &&
      s.status === "ready" &&
      !s.writePending &&
      form.dataset.command === "monitoringUpdate"
    )
      return;
    root.innerHTML = renderShell({
      route,
      snapshot,
      session: s,
      theme,
      collapsed,
      canCreate:
        ["overview", "tasks"].includes(route.page) &&
        can("taskCreate") &&
        !busy,
      feedback:
        !creating && !route.taskId
          ? note() + (feedback.report ? bulkReport(feedback.report) : "")
          : "",
      content: snapshot ? pageContent(snapshot) : renderSession(s),
    });
    if (restore) {
      const input = root.querySelector("#v20-task-query");
      input?.focus({ preventScroll: true });
      if (caret !== null) {
        try {
          input?.setSelectionRange(caret, caret);
        } catch {
          /* Search without selection API. */
        }
      }
    }
    let body = "";
    if (snapshot && creating)
      body = renderCreateTask(
        snapshot,
        taskTypes,
        taskPriorities,
        draft("taskCreate"),
        !can("taskCreate") || busy,
      );
    else if (snapshot && route.taskId) {
      const item = snapshot.tasks.find((x) => x.task.id === route.taskId);
      body =
        renderTaskDetail(taskDetail(snapshot, route.taskId)) +
        renderTaskOperations(
          item,
          taskOffers(item, (action) => !busy && can(action)),
          {
            ...draft("approvalDecide", route.taskId),
            ...draft("taskReconcile", route.taskId),
          },
        );
    }
    if (!body) {
      if (detailDialog.open) detailDialog.close();
      detailDialog.innerHTML = "";
      return;
    }
    detailDialog.innerHTML = note() + body;
    if (!detailDialog.open) detailDialog.showModal();
  }
  function setRoute(next, writeHash = true) {
    if (next.page !== route.page || next.scope !== route.scope) {
      page = 1;
      query = "";
      selected.clear();
    }
    if (
      next.page !== route.page ||
      next.taskId !== route.taskId ||
      next.record !== route.record
    ) {
      creating = false;
      feedback = {};
    }
    route = next;
    if (writeHash) host.location.hash = routeHref(next);
    syncWorkspace();
    render();
  }
  function closeDetail() {
    const id = route.taskId;
    creating = false;
    feedback = {};
    if (id) setRoute({ ...route, taskId: null });
    else render();
    const link =
      id &&
      [...root.querySelectorAll("a")].find(
        (a) => a.getAttribute("href") === localTask(id),
      );
    (link || doc.getElementById("v20-main"))?.focus({ preventScroll: true });
  }
  function values(form) {
    return Object.fromEntries(
      [...new FormData(form).entries()]
        .filter(([, v]) => typeof v === "string")
        .map(([key, v]) => [key, v.trim()]),
    );
  }
  function setDraft(form, value) {
    const key = `${form.dataset.command}:${form.dataset.id ?? ""}`;
    if (!drafts.has(key) && drafts.size >= 50)
      drafts.delete(drafts.keys().next().value);
    drafts.set(key, value);
    return key;
  }
  async function submit(event) {
    const form = event.target;
    event.preventDefault();
    if (form.id === "v20-login-form") {
      const input = form.elements.namedItem("token"),
        token = input.value;
      input.value = "";
      form.reset();
      return session.login(token);
    }
    if (form.dataset?.local && sessionState.snapshot) {
      const value = values(form);
      const local = form.dataset.local;
      if (local === "audit" && isTab("audit")) {
        auditQuery = String(value.query ?? "").slice(0, 200);
        return render();
      }
      if (local === "requirements" && isTab("requirements"))
        return setRoute({
          ...route,
          record: requirementRecord(
            requirementsSelection(`${value.mode}:${value.state}:${value.page}`),
          ),
        });
      if (local === "monitor" && isTab("monitor")) {
        const args = monitorSelection(
          `${value.metric}:${value.range}:${value.namespace ?? ""}`,
          sessionState.snapshot.monitoring?.namespaces ?? [],
        );
        return setRoute({
          ...route,
          record: `${args.metric}:${args.range}:${args.namespace ?? ""}`,
        });
      }
      if (local === "trace" && isTab("trace"))
        return setRoute({
          ...route,
          record: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(
            value.workflow || "",
          )
            ? `workflow:${value.workflow}`
            : undefined,
        });
      if (local === "advanced-page" && isTab("tests"))
        return setRoute({ ...route, record: String(advancedPage(value.page)) });
      return;
    }
    if (!form.dataset?.command || !sessionState.snapshot || busy) return;
    const action = form.dataset.command,
      id = form.dataset.id;
    const submitted = values(form),
      key = setDraft(form, submitted);
    if (action === "taskBulk")
      submitted.type = event.submitter?.value || submitted.type;
    let command;
    try {
      command = commandFor(sessionState, {
        action,
        id,
        values: submitted,
        selected: [...selected.values()],
      });
    } catch (error) {
      feedback = { message: error.message, error: true };
      return render();
    }
    if (command.confirmation && host.confirm?.(command.confirmation) !== true)
      return;
    busy = true;
    feedback = {};
    try {
      const result = await session.execute(command.action, command.options);
      if (!result || disposed) return;
      drafts.delete(key);
      if (result.check)
        monitorReceipt = {
          config: JSON.stringify(result.monitoring),
          check: result.check,
        };
      if (action === "monitoringUpdate") monitorReceipt = null;
      if (action === "taskBulk") selected.clear();
      if (action === "taskCreate" || action === "taskRetry")
        setRoute({ page: "tasks", scope: "all", taskId: result.taskId });
      feedback = {
        message: result.message || "已收到服务端回执。",
        report: result.report,
      };
    } catch (error) {
      feedback = {
        message:
          error.status >= 500
            ? "接口暂不可用，请刷新核对后再操作。"
            : error.message || "操作未完成，请核对后再操作。",
        error: true,
      };
    } finally {
      busy = false;
      render();
    }
  }
  async function click(event) {
    const btn = event.target.closest?.("[data-action]");
    if (btn && !btn.disabled) {
      const name = btn.dataset.action;
      if (name === "refresh") {
        readCycle++;
        return session.refresh();
      }
      if (["logout", "retry-logout"].includes(name)) return session.logout();
      if (name === "confirm-logout")
        return session.logout({ currentSession: true });
      if (name === "close-detail") return closeDetail();
      if (name === "open-create" && can("taskCreate")) {
        creating = true;
        feedback = {};
        return render();
      }
      if (name === "skip-main") {
        event.preventDefault();
        doc.getElementById("v20-main")?.focus();
        return;
      }
      if (name === "theme") {
        theme = theme === "light" ? "dark" : "light";
        setPreference("heal-v20-theme", theme);
        return render();
      }
      if (name === "collapse") {
        collapsed = !collapsed;
        setPreference("heal-v20-sidebar", collapsed ? "collapsed" : "expanded");
        return render();
      }
      if (name === "discard-monitor-draft") {
        if (host.confirm?.("确认放弃未保存的监控配置？") !== true) return;
        drafts.delete("monitoringUpdate:");
        feedback = {};
        readCycle++;
        return session.refresh();
      }
      if (name === "clear-selection") {
        selected.clear();
        return render();
      }
      if (name === "select-page" && isTab("tasks")) {
        for (const row of taskList().items)
          if (selected.size < 100)
            selected.set(row.id, { id: row.id, revision: row.revision });
        return render();
      }
    }
    const scope = event.target.closest?.("[data-scope]");
    if (scope)
      return setRoute({
        page: "tasks",
        taskId: null,
        scope: scope.dataset.scope,
      });
    const pager = event.target.closest?.("[data-page]");
    if (pager && !pager.disabled) {
      page = Number(pager.dataset.page);
      render();
    }
  }
  function input(event) {
    if (event.isComposing) return;
    const el = event.target;
    if (el.id === "v20-task-query") {
      const next = el.value.slice(0, 200);
      if (next !== query) {
        query = next;
        page = 1;
        selected.clear();
        render();
      }
      return;
    }
    const id = el.dataset?.selectTask;
    if (id && isTab("tasks") && sessionState.snapshot) {
      const row = taskList().items.find((x) => x.id === id);
      if (!el.checked) selected.delete(id);
      else if (row && selected.size < 100)
        selected.set(id, { id, revision: row.revision });
      return render();
    }
    const form = el.closest?.("form[data-command]");
    if (form) setDraft(form, values(form));
  }
  function normalizeHash() {
    const current = parseRoute(host.location.hash);
    if (isLegacyHash(host.location.hash) || !host.location.hash) {
      const url = routeHref(current);
      if (host.history?.replaceState) host.history.replaceState(null, "", url);
      else host.location.hash = url;
    }
    return current;
  }
  const changed = () => setRoute(normalizeHash(), false);
  const cancelled = (event) => {
    event.preventDefault();
    closeDetail();
  };
  const rootEvents = {
    click,
    submit,
    input,
    change: input,
    compositionend: input,
  };
  const dialogEvents = {
    click,
    submit,
    input,
    change: input,
    cancel: cancelled,
  };
  for (const [name, fn] of Object.entries(rootEvents))
    root.addEventListener(name, fn);
  for (const [name, fn] of Object.entries(dialogEvents))
    detailDialog.addEventListener(name, fn);
  host.addEventListener("hashchange", changed);
  route = normalizeHash();
  render();
  const ready = session.start();
  return {
    ready,
    dispose() {
      disposed = true;
      session.dispose();
      workspace.dispose();
      for (const [name, fn] of Object.entries(rootEvents))
        root.removeEventListener(name, fn);
      for (const [name, fn] of Object.entries(dialogEvents))
        detailDialog.removeEventListener(name, fn);
      host.removeEventListener("hashchange", changed);
      if (detailDialog.open) detailDialog.close();
      detailDialog.innerHTML = "";
      root.innerHTML = "";
    },
  };
}

if (typeof document !== "undefined" && document.getElementById("v20-app"))
  mountConsole({
    root: document.getElementById("v20-app"),
    detailDialog: document.getElementById("v20-task-detail"),
  });
