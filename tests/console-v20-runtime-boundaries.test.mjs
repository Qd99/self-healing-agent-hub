import assert from "node:assert/strict";
import test from "node:test";
import { createConsoleAuth } from "../apps/healing-hub/src/console-auth.mjs";
import { workspaceExecution, workspacePageNumbers, activityPageSize } from "../apps/console/public/workspace-model.js";
import { getActivityPage, filterActivities, exportActivitiesJSON } from "../apps/console/public/administration-model.js";

const at = "2026-11-24T09:00:00Z";
const context = { presentation: "v20", mode: "live", snapshot: { generatedAt: at } };
const entry = (overrides = {}) => ({
  status: { status: "running", progress: 42, message: "执行中" },
  execution: { phase: "execute", workerId: "worker-01", leaseExpiresAt: "2026-11-24T09:02:00Z" },
  trace: [{ title: "历史诊断步骤", status: "running" }],
  ...overrides,
});
const request = (headers = {}, path = "/api/healing/snapshot") => ({
  headers: { host: "127.0.0.1:8787", ...headers },
  socket: { remoteAddress: "127.0.0.1" },
  url: path,
});
const authFixture = (options = {}) => createConsoleAuth({
  consoleToken: "test-only-console", workerToken: "test-only-worker", ...options,
});
const session = (auth) => {
  const login = auth.login(request({ authorization: "Bearer test-only-console" }));
  return { login, cookie: login.cookie.split(";")[0] };
};

test("execution projection preserves reported progress and rejects invalid values", () => {
  const source = entry();
  const before = structuredClone(source);
  const view = workspaceExecution(source, context);
  assert.equal(view.label, "执行已批准方案");
  assert.equal(view.progress, 42);
  assert.equal(view.lastStep.title, "历史诊断步骤");
  assert.deepEqual(source, before);
  for (const progress of [undefined, null, "42", -1, 101, NaN, Infinity]) {
    assert.equal(workspaceExecution(entry({ status: { status: "running", progress } }), context).progress, null);
  }
  for (const progress of [0, 100, 12.5]) {
    assert.equal(workspaceExecution(entry({ status: { status: "running", progress } }), context).progress, progress);
  }
});

test("execution projection handles stale, read-only, expired and reconciliation states", () => {
  assert.equal(workspaceExecution(entry(), { ...context, error: "offline" }).active, false);
  assert.equal(workspaceExecution(entry(), { ...context, snapshot: { generatedAt: at, storage: { status: "read-only" } } }).stale, true);
  const expired = workspaceExecution(entry({ execution: { phase: "execute", leaseExpiresAt: at } }), context);
  assert.equal(expired.active, false);
  assert.match(expired.label, /租约到期/);
  const reconcile = workspaceExecution(entry({ reconciliation: { status: "required", reason: "需核对" } }), context);
  assert.equal(reconcile.label, "待人工核对");
  assert.equal(reconcile.active, false);
  assert.equal(reconcile.attention, true);
});

test("cancellation, approval and terminal task labels are not overwritten by history", () => {
  assert.equal(workspaceExecution(entry({ execution: { cancelRequested: true } }), context).label, "等待取消确认");
  assert.equal(workspaceExecution(entry({ reviewState: "pending" }), context).label, "等待审批");
  const terminal = workspaceExecution(entry({ status: { status: "cancelled" }, reviewState: "pending", execution: { cancelRequested: true } }), context);
  assert.equal(terminal.label, "已取消");
  assert.equal(terminal.active, false);
});

test("audit paging clamps page and retains the legacy default", () => {
  assert.deepEqual(workspacePageNumbers(5, 20), [1, "gap", 4, 5, 6, "gap", 20]);
  assert.deepEqual(workspacePageNumbers(0, 0), [1]);
  assert.equal(activityPageSize(999), 15);
  const records = Array.from({ length: 61 }, (_, i) => ({ id: String(i), action: "trigger", actor: "operator", level: "info", at }));
  assert.equal(getActivityPage(records).pageSize, 15);
  for (const pageSize of [10, 15, 20, 50]) {
    const last = getActivityPage(records, { page: 999, pageSize });
    assert.equal(last.pageCount, Math.ceil(61 / pageSize));
    assert.equal(last.page, last.pageCount);
    assert.equal(last.end, 61);
    assert.equal(last.total, 61);
  }
});

test("audit filter and export do not depend on page size or leak extra fields", () => {
  const records = Array.from({ length: 61 }, (_, i) => ({
    id: String(i), action: i % 2 ? "trigger" : "approve", actor: "operator", level: i % 2 ? "info" : "success", at, privateToken: "must-not-export",
  }));
  const filters = { category: "tasks", level: "info", query: "operator" };
  const filtered = filterActivities(records, filters);
  assert.equal(filtered.length, 30);
  const page = getActivityPage(records, { filters, pageSize: 10, page: 2 });
  assert.equal(page.items.length, 10);
  assert.equal(page.total, 30);
  const exported = JSON.parse(exportActivitiesJSON({ mode: "live", activity: records }, filters, { now: Date.parse(at) }));
  assert.equal(exported.count, 30);
  assert.ok(exported.activity.every((record) => !Object.hasOwn(record, "privateToken")));
  assert.equal(getActivityPage(records, { filters: { query: "no match" }, page: 99 }).start, 0);
});

test("actual auth shares a session across old and V20 entry referrers and enforces CSRF", () => {
  const auth = authFixture();
  assert.throws(() => auth.authenticate(request()), { status: 401, code: "AUTH_REQUIRED" });
  const { login, cookie } = session(auth);
  assert.match(login.cookie, /Path=\/api\/healing; HttpOnly; SameSite=Strict/);
  assert.doesNotMatch(login.cookie, /test-only-console|test-only-worker/);
  for (const page of ["/", "/console-v20.html"]) {
    const ref = { cookie, referer: `http://127.0.0.1:8787${page}` };
    const identity = auth.authenticate(request(ref));
    assert.equal(identity.csrfToken, login.identity.csrfToken);
    assert.throws(() => auth.assertWrite(request({ ...ref, "x-heal-csrf": "wrong" }), identity), { status: 403, code: "CSRF_REJECTED" });
    auth.assertWrite(request({ ...ref, "x-heal-csrf": identity.csrfToken }), identity);
  }
});

test("actual auth rejects cross-origin requests and separates manager from Worker credentials", () => {
  const auth = authFixture();
  const { cookie } = session(auth);
  assert.throws(() => auth.authenticate(request({ cookie, origin: "https://other.invalid" })), { status: 403, code: "ORIGIN_REJECTED" });
  assert.throws(() => auth.authenticate(request({ cookie, "sec-fetch-site": "cross-site" })), { status: 403, code: "ORIGIN_REJECTED" });
  assert.throws(() => auth.authenticateWorker(request({ authorization: "Bearer test-only-console" })), { status: 401, code: "WORKER_AUTH_REQUIRED" });
  assert.throws(() => auth.authenticate(request({ authorization: "Bearer test-only-worker" })), { status: 401, code: "AUTH_REQUIRED" });
  assert.equal(auth.authenticateWorker(request({ authorization: "Bearer test-only-worker" })).id, "agent");
});

test("actual auth revokes session on logout and expires an old session", () => {
  let now = Date.parse(at);
  const auth = authFixture({ clock: () => now, sessionTtlMs: 1000 });
  const { cookie, login } = session(auth);
  assert.match(auth.logout(request({ cookie, "x-heal-csrf": login.identity.csrfToken })), /Max-Age=0/);
  assert.throws(() => auth.authenticate(request({ cookie })), { status: 401 });
  const second = session(auth);
  now += 1000;
  assert.throws(() => auth.authenticate(request({ cookie: second.cookie })), { status: 401 });
});
