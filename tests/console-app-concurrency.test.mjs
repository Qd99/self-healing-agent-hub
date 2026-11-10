import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { createApiClient } from "../apps/console/public/api-client.js";
import {
  pages,
  renderCreate,
  renderTaskDetail,
} from "../apps/console/public/views.js";

const appSource = await readFile(
  new URL("../apps/console/public/app.js", import.meta.url),
  "utf8",
);
const deferred = () => {
  let resolve;
  const promise = new Promise((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const snapshot = (csrfToken = "current-session") => ({
  apiVersion: 1,
  mode: "live",
  revision: 4,
  csrfToken,
  project: { id: "test-project", repo: "owner/project", defaultBranch: "main" },
  capabilities: { trigger: true, cancel: true, retry: true, approve: true },
  safety: {},
  triggers: {},
  tasks: [],
  rules: [],
  engines: [],
  activity: [],
});

// Execute the application and its event listeners. Only browser rendering and
// network delivery are replaced so request ordering stays under test control.
function harness(fetch) {
  const listeners = new Map();
  let poll;
  const node = () => ({
    open: false,
    innerHTML: "",
    content: "live",
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {},
    querySelector() {
      return { focus() {} };
    },
    querySelectorAll() {
      return [];
    },
    contains() {
      return false;
    },
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
    },
    focus() {},
  });
  const nodes = new Map(
    ["#app", "#detail-dialog", "#create-dialog", "#bulk-dialog", "#toast"].map(
      (selector) => [selector, node()],
    ),
  );
  const controller = () => ({
    reconcile() {},
    reset() {},
    onNavigate() {},
    afterRender() {},
    handleInput() {
      return false;
    },
    handleSubmit() {
      return false;
    },
    handleChange() {
      return false;
    },
    handleClick() {
      return false;
    },
    handleCompositionEnd() {
      return false;
    },
    handleKeydown() {
      return false;
    },
  });
  const context = {
    toastMessages: [],
    createApiClient: () => createApiClient({ fetch }),
    createTaskController: controller,
    createAdministrationController: controller,
    createMonitoringController: controller,
    installInteractionFeedback() {},
    pages,
    renderCreate,
    renderTaskDetail,
    document: {
      activeElement: null,
      querySelector: (selector) => nodes.get(selector) || node(),
      getElementById: () => null,
      addEventListener(name, listener) {
        listeners.set(name, listener);
      },
    },
    window: {
      matchMedia: () => ({ matches: false, addEventListener() {} }),
      addEventListener() {},
      scrollTo() {},
    },
    location: { hash: "#overview", search: "" },
    history: { pushState() {} },
    localStorage: { getItem: () => null },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    FormData: class {
      constructor(form) {
        this.values = new Map(Object.entries(form.values));
      }
      get(key) {
        return this.values.get(key);
      }
      [Symbol.iterator]() {
        return this.values[Symbol.iterator]();
      }
    },
    URLSearchParams,
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval(callback) {
      poll = callback;
    },
  };
  const source = appSource
    .replace(/^import[\s\S]*?from ["'][^"']+["'];\n/gm, "")
    .replace(/\nrender\(\);\nloadData\(\);/, "");
  runInNewContext(
    `${source}\nrender = () => {}; refreshWorkspace = () => { refreshDetail(); refreshCreate(); }; toast = (...args) => toastMessages.push(args);
    globalThis.application = { state, api, loadData, authenticate, setSnapshot, openCreate, openTask, refreshDetail };`,
    context,
  );
  return {
    ...context.application,
    listeners,
    createDialog: nodes.get("#create-dialog"),
    detailDialog: nodes.get("#detail-dialog"),
    bulkDialog: nodes.get("#bulk-dialog"),
    document: context.document,
    poll: () => poll(),
    toastMessages: context.toastMessages,
  };
}

test("a refresh started before login cannot restore an unauthorized state", async () => {
  const oldRead = deferred();
  let readSignal;
  const app = harness((path, options) => {
    if (path.endsWith("/snapshot")) {
      readSignal = options.signal;
      return oldRead.promise;
    }
    assert.equal(path, "/api/healing/session");
    return Promise.resolve(
      json({ snapshot: snapshot(), message: "Signed in" }),
    );
  });
  app.state.authRequired = true;
  const refresh = app.loadData();
  await app.authenticate({ values: { token: "operator-token" } });
  oldRead.resolve(
    json({ error: { code: "AUTH_REQUIRED", message: "Old session" } }, 401),
  );
  await refresh;
  assert.equal(app.state.authRequired, false);
  assert.equal(app.state.snapshot.csrfToken, "current-session");
  assert.equal(app.state.refreshing, false);
  assert.equal(readSignal.aborted, true);
});

test("a prior session snapshot cannot replace the new session CSRF token", async () => {
  const oldRead = deferred();
  let sentCsrf;
  const app = harness((path, options) => {
    if (path.endsWith("/snapshot")) return oldRead.promise;
    if (path.endsWith("/session"))
      return Promise.resolve(json({ snapshot: snapshot() }));
    sentCsrf = options.headers["X-Heal-CSRF"];
    return Promise.resolve(
      json({ snapshot: snapshot(), message: "Cancelled" }),
    );
  });
  app.setSnapshot(snapshot("expired-session"));
  const refresh = app.loadData();
  app.state.authRequired = true;
  await app.authenticate({ values: { token: "operator-token" } });
  oldRead.resolve(json(snapshot("expired-session")));
  await refresh;
  await app.api.taskAction("task-id", "cancel", { expectedRevision: 1 });
  assert.equal(app.state.snapshot.csrfToken, "current-session");
  assert.equal(sentCsrf, "current-session");
});

test("snapshot refreshes cannot start while session exchange is pending", async () => {
  const login = deferred();
  let reads = 0;
  const app = harness((path) => {
    if (path.endsWith("/session")) return login.promise;
    reads += 1;
    return Promise.resolve(json(snapshot("old-session")));
  });
  app.state.authRequired = true;
  const authentication = app.authenticate({
    values: { token: "operator-token" },
  });
  await app.loadData();
  login.resolve(json({ snapshot: snapshot() }));
  await authentication;
  assert.equal(reads, 0);
  assert.equal(app.state.authRequired, false);
});

test("pending task creation protects its draft and restores editing after failure", async () => {
  const creation = deferred();
  let sent;
  const app = harness((path, options) => {
    assert.equal(path, "/api/healing/trigger");
    sent = JSON.parse(options.body);
    return creation.promise;
  });
  app.setSnapshot(snapshot());
  app.openCreate();
  const values = {
    title: "Submitted A",
    type: "lint-error",
    priority: "medium",
    branch: "main",
  };
  app.listeners.get("submit")({
    target: { id: "create-form", values },
    preventDefault() {},
  });
  const pendingHtml = renderCreate(app.state);
  for (const event of ["input", "change"])
    app.listeners.get(event)({
      target: { name: "title", value: "Unsubmitted B", closest: () => ({}) },
    });
  const pendingTitle = app.state.createDraft.title;
  creation.resolve(
    json({ error: { code: "REQUEST_FAILED", message: "Try again" } }, 503),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.title, "Submitted A");
  for (const name of ["title", "type", "priority", "branch"])
    assert.match(
      pendingHtml,
      new RegExp(`<[^>]+name="${name}"[^>]*\\bdisabled\\b`),
    );
  assert.equal(pendingTitle, "Submitted A");
  assert.equal(app.state.createDraft.title, "Submitted A");
  assert.equal(app.state.pendingAction, "");
  assert.equal(app.createDialog.open, true);
  assert.doesNotMatch(
    renderCreate(app.state),
    /<(?:input|select)[^>]*\bdisabled\b/,
  );
});

function reconciliationSnapshot(revision = 9) {
  const value = snapshot();
  value.capabilities.reconcile = true;
  value.tasks = [
    {
      task: {
        id: "task-a",
        payload: { repo: "owner/project", branch: "main" },
        metadata: { createdAt: "2026-11-10T00:00:00Z" },
      },
      revision,
      title: "Repair",
      status: { status: "failed" },
      trace: [],
      diff: [],
      reconciliation: {
        status: "required",
        reason: "执行中断",
        updatedAt: "2026-11-10T00:00:00Z",
      },
    },
  ];
  return value;
}

test("read-only task detail polling accepts new task facts while editing and confirmation workflows pause it", async () => {
  let reads = 0;
  const app = harness(async () => {
    reads += 1;
    const next = reconciliationSnapshot();
    next.revision = 5;
    next.tasks[0].status.message = "New task fact";
    return json(next);
  });
  app.setSnapshot(reconciliationSnapshot());
  app.state.loading = false;
  app.openTask("task-a", "logs");
  app.poll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1);
  assert.equal(app.state.detailTab, "logs");
  assert.equal(app.state.snapshot.tasks[0].status.message, "New task fact");
  assert.match(app.detailDialog.innerHTML, /New task fact/);
  for (const property of [
    "monitoringDirty",
    "approvalComment",
    "pendingAction",
    "reconciliationDraft",
  ]) {
    app.state[property] =
      property === "reconciliationDraft"
        ? { taskId: "task-a", note: "draft" }
        : "editing";
    app.poll();
    app.state[property] = "";
  }
  for (const dialog of [app.createDialog, app.bulkDialog]) {
    dialog.open = true;
    app.poll();
    dialog.open = false;
  }
  app.document.activeElement = { matches: () => true };
  app.poll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1);
});

test("detail refresh preserves the active tab focus and content and horizontal code scroll", () => {
  const app = harness(async () => json(reconciliationSnapshot()));
  app.setSnapshot(reconciliationSnapshot());
  app.openTask("task-a", "logs");
  const active = {
    tagName: "BUTTON",
    dataset: { action: "detail-tab", tab: "logs" },
    getAttribute: () => null,
  };
  app.document.activeElement = active;
  app.detailDialog.contains = (element) => element === active;
  const oldScroll = [
    { scrollTop: 240, scrollLeft: 0 },
    { scrollTop: 0, scrollLeft: 95 },
  ];
  const newScroll = [
    { scrollTop: 0, scrollLeft: 0 },
    { scrollTop: 0, scrollLeft: 0 },
  ];
  let replaced = false,
    focused = false;
  const replacement = {
    ...active,
    focus(options) {
      focused = options.preventScroll;
    },
  };
  Object.defineProperty(app.detailDialog, "innerHTML", {
    get: () => "",
    set() {
      replaced = true;
    },
  });
  app.detailDialog.querySelectorAll = (selector) =>
    selector.includes("data-action")
      ? [replacement]
      : replaced
        ? newScroll
        : oldScroll;
  app.refreshDetail();
  assert.equal(app.state.detailTab, "logs");
  assert.equal(newScroll[0].scrollTop, 240);
  assert.equal(newScroll[1].scrollLeft, 95);
  assert.equal(focused, true);
});

test("receipt disclosure keeps its keyboard focus and open state through detail refresh", () => {
  const app = harness(async () => json(reconciliationSnapshot()));
  const value = reconciliationSnapshot();
  value.tasks[0].resultReceipts = [
    { kind: "cancelled", receivedAt: "2026-11-10T01:00:00Z" },
  ];
  app.setSnapshot(value);
  app.openTask("task-a");
  assert.match(
    app.detailDialog.innerHTML,
    /<summary id="task-receipts-summary">/,
  );
  const active = {
    id: "task-receipts-summary",
    tagName: "SUMMARY",
    dataset: {},
    getAttribute: () => null,
  };
  app.document.activeElement = active;
  app.detailDialog.contains = (element) => element === active;
  for (const open of [true, false]) {
    let replaced = false,
      focused = false;
    const oldDisclosure = { open },
      newDisclosure = { open: false };
    const replacement = {
      ...active,
      focus(options) {
        focused = options.preventScroll;
      },
    };
    Object.defineProperty(app.detailDialog, "innerHTML", {
      configurable: true,
      get: () => "",
      set() {
        replaced = true;
      },
    });
    app.detailDialog.querySelector = (selector) =>
      selector === ".task-receipts"
        ? replaced
          ? newDisclosure
          : oldDisclosure
        : null;
    app.detailDialog.querySelectorAll = (selector) =>
      selector.includes("summary") ? [replacement] : [];
    app.refreshDetail();
    assert.equal(newDisclosure.open, open);
    assert.equal(focused, true);
  }
});

test("reconciliation rejects blank notes, keeps failed drafts, and records only the selected outcome", async () => {
  const response = deferred();
  let sent;
  const app = harness((path, options) => {
    assert.equal(path, "/api/healing/tasks/task-a/reconcile");
    sent = JSON.parse(options.body);
    return response.promise;
  });
  app.setSnapshot(reconciliationSnapshot());
  app.state.loading = false;
  app.openTask("task-a");
  const submit = (values) =>
    app.listeners.get("submit")({
      target: {
        id: "reconciliation-form",
        dataset: { taskId: "task-a" },
        values,
      },
      preventDefault() {},
    });
  submit({ outcome: "no-changes", note: "   " });
  assert.equal(sent, undefined);
  assert.match(app.state.reconciliationError, /说明/);
  submit({ outcome: "changes-recorded", note: " 已检查提交 abcdef0 " });
  assert.equal(sent.outcome, "changes-recorded");
  assert.equal(sent.note, "已检查提交 abcdef0");
  assert.equal(sent.expectedRevision, 9);
  assert.ok(sent.requestId);
  assert.equal(app.state.pendingAction, "reconcile:task-a");
  response.resolve(
    json({ error: { code: "STORE_FULL", message: "存储容量不足" } }, 503),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(app.state.reconciliationError, /存储容量不足/);
  assert.equal(app.state.reconciliationDraft.note, " 已检查提交 abcdef0 ");
  assert.equal(app.state.pendingAction, "");
});

test("successful reconciliation clears its draft and reports completion", async () => {
  const response = deferred();
  const app = harness(() => response.promise);
  app.setSnapshot(reconciliationSnapshot());
  app.openTask("task-a");
  app.listeners.get("submit")({
    target: {
      id: "reconciliation-form",
      dataset: { taskId: "task-a" },
      values: { outcome: "no-changes", note: "仓库未发生变更" },
    },
    preventDefault() {},
  });
  const next = reconciliationSnapshot(10);
  next.revision = 5;
  next.tasks[0].reconciliation = {
    status: "resolved",
    reason: "执行中断",
    resolution: {
      outcome: "no-changes",
      note: "仓库未发生变更",
      actor: "Operator",
      at: "2026-11-10T01:00:00Z",
    },
  };
  response.resolve(json({ snapshot: next, message: "核对完成" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.state.reconciliationDraft, null);
  assert.match(app.state.reconciliationSuccess, /核对/);
  assert.equal(app.state.snapshot.tasks[0].reconciliation.status, "resolved");
  assert.equal(app.toastMessages.at(-1)[0], "核对完成");
  assert.equal(app.toastMessages.at(-1)[1], "success");
});

test("retry clicks cannot bypass a newly required reconciliation", () => {
  let writes = 0;
  const app = harness(() => {
    writes += 1;
    return Promise.resolve(json({}));
  });
  app.setSnapshot(reconciliationSnapshot());
  const button = {
    disabled: false,
    dataset: { action: "task-action", command: "retry", id: "task-a" },
  };
  app.listeners.get("click")({
    target: {
      closest: (selector) => (selector === "[data-action]" ? button : null),
    },
  });
  assert.equal(writes, 0);
  assert.equal(app.state.pendingAction, "");
});

test("a stale reconciliation completion cannot mark newly arrived evidence resolved", async () => {
  const response = deferred();
  const app = harness(() => response.promise);
  app.setSnapshot(reconciliationSnapshot());
  app.openTask("task-a");
  app.listeners.get("submit")({
    target: {
      id: "reconciliation-form",
      dataset: { taskId: "task-a" },
      values: { outcome: "no-changes", note: "仓库未发生变更" },
    },
    preventDefault() {},
  });
  const newer = reconciliationSnapshot(11);
  newer.revision = 6;
  newer.tasks[0].reconciliation.reason = "新收到的提交证据";
  app.setSnapshot(newer);
  const older = reconciliationSnapshot(10);
  older.revision = 5;
  older.tasks[0].reconciliation = { status: "resolved", reason: "执行中断" };
  response.resolve(json({ snapshot: older, message: "核对完成" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.state.snapshot.tasks[0].reconciliation.status, "required");
  assert.equal(app.state.reconciliationSuccess, "");
  assert.match(app.state.reconciliationError, /新证据/);
  assert.match(app.toastMessages.at(-1)[0], /新证据/);
  assert.equal(app.toastMessages.at(-1)[1], "warning");
});
