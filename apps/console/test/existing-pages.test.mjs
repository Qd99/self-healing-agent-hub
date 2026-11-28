import test from "node:test";
import assert from "node:assert/strict";
import { mountConsole } from "../public/v20/app/main.js";
import { createV20Hub } from "../../../tests/helpers/v20-hub.mjs";
import { createV20Client } from "../public/v20/api/client.js";
import { setTimeout as delay } from "node:timers/promises";
import { memoryStorage } from "./helpers/snapshot.mjs";

function harness() {
  const listeners = () => {
    const events = new Map();
    return {
      events,
      addEventListener(type, fn) {
        events.set(type, fn);
      },
      removeEventListener(type) {
        events.delete(type);
      },
      fire(type, target, extra = {}) {
        return events.get(type)?.({ target, preventDefault() {}, ...extra });
      },
    };
  };
  const doc = {
    activeElement: null,
    documentElement: { dataset: {} },
    getElementById: () => null,
  };
  const root = {
    ...listeners(),
    innerHTML: "",
    ownerDocument: doc,
    contains: () => false,
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  const dialog = {
    ...listeners(),
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
    ...listeners(),
    location: { hash: "#overview" },
    localStorage: memoryStorage(),
    matchMedia: () => ({ matches: false }),
    confirm: () => true,
    history: {
      replaceState(_state, _title, url) {
        host.location.hash = url;
      },
    },
  };
  return { root, dialog, host };
}

function live(hub) {
  let cookie;
  return createV20Client({
    fetch: async (path, init) => {
      const headers = new Headers(init.headers);
      headers.set("Origin", hub.base);
      if (cookie) headers.set("Cookie", cookie);
      const response = await fetch(hub.base + path, { ...init, headers });
      const next = response.headers.get("set-cookie");
      if (next) cookie = next.split(";")[0];
      return response;
    },
  });
}

test("every prototype page renders explicit content against the isolated Hub and old links resolve", async (t) => {
  const { root, dialog, host } = harness();
  const hub = await createV20Hub(t);
  const api = live(hub);
  await api.login(hub.token);
  const app = mountConsole({
    root,
    detailDialog: dialog,
    host,
    api,
    storage: memoryStorage(),
  });
  t.after(() => app.dispose());
  await app.ready;
  assert.ok(root.innerHTML.includes("真实快照"));
  const pages = {
    overview: "最近执行",
    tasks: "当前快照 ·",
    requirements: "GitHub 需求与 Pull Requests",
    trace: "已采集的执行事件",
    tests: "独立 QA 作业",
    delivery: "PR 与 CI 核验记录",
    jenkins: "Jenkins 来源未配置",
    monitor: "Prometheus 实测指标",
    healing: "故障指纹",
    workers: "Hub 执行引擎",
    audit: "搜索当前快照",
    knowledge: "评估记录",
    radar: "技术雷达记录",
    settings: 'href="/models"',
  };
  for (const [page, label] of Object.entries(pages)) {
    host.location.hash = `#${page}`;
    await host.fire("hashchange");
    assert.ok(root.innerHTML.includes(label), `${page} lacks ${label}`);
  }
  assert.ok(!root.innerHTML.includes(hub.token));
  host.location.hash = "#approvals";
  await host.fire("hashchange");
  assert.match(root.innerHTML, /任务审批/);
  assert.equal(host.location.hash, "#requirements");
  host.location.hash = "#requirements?record=issues:open:1";
  await host.fire("hashchange");
  assert.match(root.innerHTML, /GitHub 需求与 Pull Requests/);
  for (let i = 0; i < 30 && !root.innerHTML.includes("尚未配置"); i++)
    await delay(10);
  assert.ok(
    root.innerHTML.includes("尚未配置"),
    "unconfigured connector did not render explicitly",
  );
  app.dispose();
  assert.equal(root.events.size, 0);
});
