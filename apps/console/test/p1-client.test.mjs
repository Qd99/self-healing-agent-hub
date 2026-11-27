import test from "node:test";
import assert from "node:assert/strict";
import { createV20Client } from "../public/v20/api/client.js";
import { createApiClient } from "../public/api-client.js";
import { deferred, json, snapshot } from "./helpers/snapshot.mjs";

function client(fetch) {
  return createV20Client({
    transport: (options) => createApiClient({ ...options, fetch }),
  });
}

test("V20 tokens only enter login, Cookie/CSRF enter logout, and UI projections omit CSRF", async () => {
  const requests = [];
  const api = client(async (path, init) => {
    requests.push({ path, ...init });
    return init.method === "POST"
      ? json({ message: "Connected", snapshot: snapshot() })
      : init.method === "DELETE"
        ? json({ message: "Signed out" })
        : json(snapshot());
  });
  const value = await api.login("test-only-management-token");
  assert.equal(value.csrfToken, undefined);
  assert.equal((await api.read()).csrfToken, undefined);
  await api.logout();
  assert.equal(
    requests[0].headers.Authorization,
    "Bearer test-only-management-token",
  );
  assert.equal(requests[1].headers.Authorization, undefined);
  assert.equal(requests[2].headers["X-Heal-CSRF"], "test-only-csrf");
  assert.ok(requests.every((r) => r.credentials === "same-origin"));
});

test("a late high-revision read cannot overwrite the accepted read's CSRF", async () => {
  const old = deferred();
  let gets = 0;
  let logoutHeaders;
  const api = client(async (_path, init) => {
    if (init.method === "DELETE") {
      logoutHeaders = init.headers;
      return json({ message: "Done" });
    }
    if (++gets === 1) return old.promise;
    return json(snapshot({ revision: 2, csrfToken: "current-csrf" }));
  });
  const first = api.read();
  await api.read();
  old.resolve(json(snapshot({ revision: 99, csrfToken: "obsolete-csrf" })));
  await assert.rejects(first, { code: "STALE_RESPONSE" });
  await api.logout();
  assert.equal(logoutHeaders["X-Heal-CSRF"], "current-csrf");
});

test("read acceptance and invalidation are checked before transport changes CSRF", async () => {
  const pending = deferred();
  let gets = 0;
  let csrf;
  const api = client(async (_path, init) => {
    if (init.method === "DELETE") {
      csrf = init.headers["X-Heal-CSRF"];
      return json({ message: "Done" });
    }
    if (++gets === 1) return json(snapshot());
    return pending.promise;
  });
  await api.read();
  const reading = api.read({ acceptSnapshot: () => false });
  api.invalidateReads();
  pending.resolve(json(snapshot({ revision: 100, csrfToken: "wrong-csrf" })));
  await assert.rejects(reading, { code: "STALE_RESPONSE" });
  await api.logout();
  assert.equal(csrf, "test-only-csrf");
});

test("invalid JSON shape is INVALID_RESPONSE and does not replace a usable CSRF", async () => {
  let gets = 0;
  let csrf;
  const api = client(async (_path, init) => {
    if (init.method === "DELETE") {
      csrf = init.headers["X-Heal-CSRF"];
      return json({ message: "Done" });
    }
    return json(
      ++gets === 1
        ? snapshot()
        : snapshot({ tasks: {}, csrfToken: "do-not-adopt" }),
    );
  });
  await api.read();
  await assert.rejects(api.read(), { code: "INVALID_RESPONSE" });
  await api.logout();
  assert.equal(csrf, "test-only-csrf");
});

test("uncertain logout preserves its CSRF and a retry actually reaches the server", async () => {
  let deletes = 0;
  const api = client(async (_path, init) => {
    if (init.method === "GET") return json(snapshot());
    deletes++;
    assert.equal(init.headers["X-Heal-CSRF"], "test-only-csrf");
    if (deletes === 1) throw new Error("ACK lost");
    return json(
      { error: { code: "AUTH_REQUIRED", message: "No session" } },
      401,
    );
  });
  await api.read();
  await assert.rejects(api.logout(), { code: "NETWORK_ERROR" });
  await api.logout();
  assert.equal(deletes, 2);
});

test("HTML 401 is not an acknowledged logout; explicit current-session recovery stays inside transport", async () => {
  let gets = 0;
  let deletes = 0;
  const api = client(async (_path, init) => {
    if (init.method === "GET") {
      gets++;
      return json(snapshot());
    }
    if (++deletes === 1)
      return new Response("gateway auth", {
        status: 401,
        headers: { "Content-Type": "text/html" },
      });
    return json({ message: "Done" });
  });
  await api.read();
  await assert.rejects(api.logout(), { code: "INVALID_RESPONSE" });
  api.clear();
  await assert.rejects(api.logout(), {
    code: "CURRENT_SESSION_CONFIRMATION_REQUIRED",
  });
  const result = await api.logout({ currentSession: true });
  assert.equal(result.snapshot, undefined);
  assert.equal(gets, 2);
  assert.equal(deletes, 2);
});

test("tokenless local mode never becomes a V20 session or a false logout", async () => {
  let deletes = 0;
  const api = client(async (_path, init) => {
    if (init.method === "DELETE") {
      deletes++;
      return json({ message: "Done" });
    }
    return json(snapshot({ auth: { required: false, actor: "Local" } }));
  });
  await assert.rejects(api.read(), { code: "AUTH_UNCONFIGURED" });
  await assert.rejects(api.logout({ currentSession: true }), {
    code: "AUTH_UNCONFIGURED",
  });
  assert.equal(deletes, 0);
});

test("authentication commands cannot overlap or be cleared by a later read", async () => {
  const pending = deferred();
  const api = client(async () => pending.promise);
  const login = api.login("test-only-token");
  await assert.rejects(api.logout(), { code: "AUTH_BUSY" });
  await assert.rejects(api.read(), { code: "AUTH_BUSY" });
  pending.resolve(json({ message: "Connected", snapshot: snapshot() }));
  await login;
});
