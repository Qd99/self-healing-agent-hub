import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mountConsole } from "../public/v20/app/main.js";
import { createV20Hub } from "../../../tests/helpers/v20-hub.mjs";
import { memoryStorage, snapshot } from "./helpers/snapshot.mjs";

function eventTarget() {
  const events = new Map();
  return {
    events,
    addEventListener(type, handler) {
      events.set(type, handler);
    },
    removeEventListener(type) {
      events.delete(type);
    },
    fire(type, target, properties = {}) {
      return events.get(type)?.({ target, preventDefault() {}, ...properties });
    },
  };
}
function dom() {
  const doc = {
    activeElement: null,
    documentElement: { dataset: {} },
    getElementById: () => null,
  };
  const root = {
    ...eventTarget(),
    innerHTML: "",
    ownerDocument: doc,
    contains: () => false,
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  const dialog = {
    ...eventTarget(),
    innerHTML: "",
    open: false,
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
      this.fire("close", this);
    },
  };
  const host = {
    ...eventTarget(),
    location: { hash: "#overview" },
    localStorage: memoryStorage(),
    matchMedia: () => ({ matches: false }),
  };
  return { root, dialog, host };
}

test("the composition root mounts once, clears the password, renders live data and disposes listeners", async () => {
  const { root, dialog, host } = dom();
  const calls = [];
  const api = {
    read: async () => {
      throw Object.assign(new Error(), { code: "AUTH_REQUIRED", status: 401 });
    },
    login: async (token) => {
      calls.push(token);
      return snapshot();
    },
    logout: async () => {},
    clear() {},
    invalidateReads() {},
  };
  const app = mountConsole({
    root,
    detailDialog: dialog,
    host,
    api,
    storage: memoryStorage(),
  });
  await app.ready;
  assert.match(root.innerHTML, /连接管理服务/);
  const field = { value: "test-only-token" };
  await root.fire("submit", {
    id: "v20-login-form",
    elements: { namedItem: () => field },
    reset() {
      field.value = "";
    },
  });
  assert.deepEqual(calls, ["test-only-token"]);
  assert.equal(field.value, "");
  assert.match(root.innerHTML, /最近执行/);
  assert.doesNotMatch(root.innerHTML, /test-only-token|test-only-csrf/);
  host.location.hash = "#tasks";
  await host.fire("hashchange");
  assert.match(root.innerHTML, /没有任务/);
  const search = { id: "v20-task-query", value: "中文任务" };
  root.fire("input", search, { isComposing: true });
  assert.doesNotMatch(root.innerHTML, /value="中文任务"/);
  root.fire("compositionend", search);
  assert.match(root.innerHTML, /value="中文任务"/);
  app.dispose();
  assert.equal(root.events.size, 0);
  assert.equal(host.events.size, 0);
  assert.equal(dialog.events.size, 0);
});

test("losing a session clears the dialog without discarding the task deep link", async () => {
  const { root, dialog, host } = dom();
  host.location.hash = "#tasks?task=current-task";
  let expired = false;
  const api = {
    read: async () => {
      if (expired)
        throw Object.assign(new Error(), {
          status: 401,
          code: "AUTH_REQUIRED",
        });
      return snapshot();
    },
    login: async () => snapshot(),
    logout: async () => {},
    clear() {},
    invalidateReads() {},
  };
  const app = mountConsole({
    root,
    detailDialog: dialog,
    host,
    api,
    storage: memoryStorage(),
  });
  await app.ready;
  assert.ok(dialog.open);
  expired = true;
  await root.fire("click", {
    closest: () => ({ dataset: { action: "refresh" } }),
  });
  assert.equal(dialog.open, false);
  assert.equal(dialog.innerHTML, "");
  assert.equal(host.location.hash, "#tasks?task=current-task");
  const form = {
    id: "v20-login-form",
    elements: { namedItem: () => ({ value: "test-only-token" }) },
    reset() {},
  };
  await root.fire("submit", form);
  assert.ok(dialog.open);
  app.dispose();
});

test("all entry modules and styles are real same-origin assets under the proxy prefix", async (t) => {
  const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
  const hub = await createV20Hub(t, { publicDir });
  const entry = await hub.request("/v20/");
  assert.equal(entry.status, 200);
  const html = await entry.text();
  const origin = "https://site.invalid";
  const externalBase = new URL("/healing/v20/", origin);
  const pending = [...html.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)].map(
    (m) => new URL(m[1], externalBase),
  );
  const seen = new Set();
  while (pending.length) {
    const url = pending.shift();
    assert.equal(url.origin, origin);
    assert.ok(url.pathname.startsWith("/healing/"));
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    const response = await hub.request(url.pathname.slice("/healing".length));
    assert.equal(response.status, 200, url.href);
    if (url.pathname.endsWith(".js")) {
      assert.match(response.headers.get("content-type"), /javascript/);
      const code = await response.text();
      for (const match of code.matchAll(
        /(?:from\s+|import\s*)["'](\.[^"']+)["']/g,
      ))
        pending.push(new URL(match[1], url));
    } else assert.match(response.headers.get("content-type"), /css|svg/);
  }
  assert.ok(seen.size >= 10, "entry must load the actual module graph");
});
