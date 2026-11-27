import test from "node:test";
import assert from "node:assert/strict";
import { createSessionController } from "../public/v20/session/controller.js";
import { createV20Client } from "../public/v20/api/client.js";
import { createApiClient } from "../public/api-client.js";
import {
  deferred,
  json,
  memoryStorage,
  snapshot,
} from "./helpers/snapshot.mjs";

const error = (code, status = 0) =>
  Object.assign(new Error(code), { code, status });
function harness(overrides = {}, storage = memoryStorage()) {
  const events = [],
    calls = [];
  const api = {
    read: async () => {
      calls.push("read");
      return snapshot();
    },
    login: async () => snapshot(),
    logout: async () => ({ message: "Done" }),
    clear() {},
    invalidateReads() {},
    ...overrides,
  };
  const controller = createSessionController({
    api,
    storage,
    now: () => 1000,
    onChange: (s) => events.push(s),
  });
  return { controller, calls, events, storage };
}

test("real session data is adopted without CSRF and can be refreshed", async () => {
  const { controller } = harness();
  await controller.start();
  const state = controller.state();
  assert.equal(state.status, "ready");
  assert.equal(state.snapshot.csrfToken, undefined);
  assert.equal(state.loadedAt, 1000);
  state.snapshot.project.id = "modified";
  assert.equal(controller.state().snapshot.project.id, "test");
});

test("an old read, including a higher revision, cannot repopulate an exited session", async () => {
  const old = deferred();
  const { controller } = harness({ read: () => old.promise });
  const reading = controller.start();
  await controller.logout();
  old.resolve(snapshot({ revision: 999 }));
  await reading;
  assert.equal(controller.state().status, "signed-out");
  assert.equal(controller.state().snapshot, null);
});

test("a late read cannot replace the snapshot from a new login", async () => {
  const old = deferred();
  const { controller } = harness({
    read: () => old.promise,
    login: async () => snapshot({ revision: 2 }),
  });
  const reading = controller.start();
  await controller.login("test-only-token");
  old.resolve(snapshot({ revision: 999 }));
  await reading;
  assert.equal(controller.state().snapshot.revision, 2);
});

test("network failures retain same-scope data as stale, while 401 clears it", async () => {
  let problem;
  const { controller } = harness({
    read: async () => {
      if (problem) throw problem;
      return snapshot();
    },
  });
  await controller.start();
  problem = error("NETWORK_ERROR");
  await controller.refresh();
  assert.equal(controller.state().status, "stale");
  assert.ok(controller.state().snapshot);
  problem = error("AUTH_REQUIRED", 401);
  await controller.refresh();
  assert.equal(controller.state().status, "signed-out");
  assert.equal(controller.state().snapshot, null);
});

test("uncertain logout blocks reads and survives reload until an explicit recovery", async () => {
  let confirmation = false;
  const store = memoryStorage();
  const { controller } = harness(
    {
      logout: async () => {
        throw error("NETWORK_ERROR");
      },
    },
    store,
  );
  await controller.start();
  await controller.logout();
  assert.equal(controller.state().status, "blocked");
  assert.equal(controller.state().snapshot, null);
  const reopened = harness(
    {
      logout: async (opts) => {
        confirmation = opts.currentSession;
        return {};
      },
    },
    store,
  );
  await reopened.controller.start();
  await reopened.controller.refresh();
  await reopened.controller.login("must-not-send");
  assert.deepEqual(reopened.calls, []);
  assert.equal(reopened.controller.state().status, "blocked");
  await reopened.controller.logout({ currentSession: true });
  assert.equal(confirmation, true);
  assert.equal(reopened.controller.state().status, "signed-out");
  const after = harness({}, store);
  await after.controller.start();
  assert.equal(after.controller.state().status, "ready");
});

test("storage failure never silently resumes a Cookie session", async () => {
  const broken = {
    getItem() {
      throw Error("blocked storage");
    },
    setItem() {
      throw Error("blocked storage");
    },
    removeItem() {},
  };
  const { controller, calls } = harness({}, broken);
  await controller.start();
  assert.equal(controller.state().status, "signed-out");
  assert.deepEqual(calls, []);
  await controller.login("test-only-token");
  assert.equal(controller.state().status, "ready");
});

test("a storage read without write access also requires explicit sign-in", async () => {
  const readOnly = {
    getItem: () => null,
    setItem() {
      throw Error("read-only storage");
    },
    removeItem() {},
  };
  const { controller, calls } = harness({}, readOnly);
  await controller.start();
  await controller.refresh();
  assert.equal(controller.state().status, "signed-out");
  assert.deepEqual(calls, []);
});

test("tokenless mode is blocked, not presented as a logged-in local session", async () => {
  const { controller } = harness({
    read: async () => snapshot({ auth: { required: false, actor: "Local" } }),
  });
  await controller.start();
  assert.equal(controller.state().status, "blocked");
  assert.equal(controller.state().snapshot, null);
  assert.equal(controller.state().error.code, "AUTH_UNCONFIGURED");
});

test("authentication commands serialize and a disposed controller cannot render late data", async () => {
  const pending = deferred();
  let logouts = 0;
  const { controller, events } = harness({
    login: () => pending.promise,
    logout: async () => {
      logouts++;
    },
  });
  const loggingIn = controller.login("test-only-token");
  await controller.logout();
  assert.equal(logouts, 0);
  controller.dispose();
  const count = events.length;
  pending.resolve(snapshot());
  await loggingIn;
  assert.equal(events.length, count);
});

test("a changed project cannot relabel the previous project's cached records", async () => {
  let changed = false;
  const { controller } = harness({
    read: async () =>
      snapshot(
        changed
          ? {
              project: {
                id: "other",
                repo: "other/repo",
                defaultBranch: "main",
              },
            }
          : {},
      ),
  });
  await controller.start();
  changed = true;
  await controller.refresh();
  assert.equal(controller.state().snapshot, null);
  assert.equal(controller.state().status, "signed-out");
});

test("a switch to a new project with a lower revision invalidates the previous cache", async () => {
  let changed = false;
  const api = createV20Client({
    transport: (options) =>
      createApiClient({
        ...options,
        fetch: async () =>
          json(
            snapshot(
              changed
                ? {
                    revision: 1,
                    project: {
                      id: "other",
                      repo: "other/repo",
                      defaultBranch: "main",
                    },
                  }
                : { revision: 8 },
            ),
          ),
      }),
  });
  const controller = createSessionController({ api, storage: memoryStorage() });
  await controller.start();
  assert.equal(controller.state().snapshot.revision, 8);
  changed = true;
  await controller.refresh();
  assert.equal(controller.state().snapshot, null);
  assert.equal(controller.state().error.code, "PROJECT_CHANGED");
});
