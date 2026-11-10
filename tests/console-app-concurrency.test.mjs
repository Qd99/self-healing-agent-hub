import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { createApiClient } from "../apps/console/public/api-client.js";
import { pages, renderCreate } from "../apps/console/public/views.js";

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
  const node = () => ({
    open: false,
    innerHTML: "",
    content: "live",
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {},
    querySelector() {
      return { focus() {} };
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
    createApiClient: () => createApiClient({ fetch }),
    createTaskController: controller,
    createAdministrationController: controller,
    createMonitoringController: controller,
    installInteractionFeedback() {},
    pages,
    renderCreate,
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
    setInterval() {},
  };
  const source = appSource
    .replace(/^import[\s\S]*?from ["'][^"']+["'];\n/gm, "")
    .replace(/\nrender\(\);\nloadData\(\);/, "");
  runInNewContext(
    `${source}\nrender = () => {}; refreshWorkspace = () => {}; toast = () => {};
    globalThis.application = { state, api, loadData, authenticate, setSnapshot, openCreate };`,
    context,
  );
  return {
    ...context.application,
    listeners,
    createDialog: nodes.get("#create-dialog"),
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
