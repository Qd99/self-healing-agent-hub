import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAutoloopConnector,
  projectAutoloopState,
} from "../apps/healing-hub/src/autoloop-connector.mjs";

const state = () => ({
  seq: 42,
  now: "2026-11-28T02:44:16.515Z",
  timezone: "Asia/Shanghai",
  spending: {
    today: { input: 10, output: 5, cost: 0.1 },
    week: { input: 100, output: 50, cost: 1 },
  },
  totals: {
    running: 1,
    queued: 2,
    retrying: 0,
    unknown: 0,
    done: 14249,
    doneToday: 529,
    nothing: 1,
    usage: { input: 2495864, output: 315078, cost: 1.03 },
    attention: 3,
  },
  cards: [
    {
      id: 2560,
      kind: "notice",
      state: "open",
      title: "集群告警",
      text: "memory 告警",
      options: ["已处理"],
      rule: "Prometheus 告警通知",
      lane: "memory/1",
      createdAt: "2026-11-28T01:49:01.910Z",
    },
  ],
  recentCards: [],
  agents: [
    {
      id: "claude",
      name: "Claude Code",
      use: "claude",
      worker: "mac",
      online: true,
      seenAt: "2026-11-28T02:37:00.483Z",
      totals: { done: 3, doneToday: 0, usage: { input: 1, output: 2, cost: 0.3 } },
    },
  ],
  channels: [
    { id: "feishu", name: "飞书私聊", online: true, seenAt: "2026-11-28T02:44:54.778Z" },
  ],
  lines: [
    {
      id: "GitHub 双入口巡检",
      name: "GitHub 双入口巡检",
      agent: "github-watch",
      source: "schedule",
      types: [],
      every: "*/10 * * * *",
      next: "2026-11-28T02:40:00.000Z",
      totals: { done: 1167, doneToday: 37 },
    },
  ],
  pauses: [],
  runs: [
    {
      id: 14292,
      rule: "Jenkins main 构建巡检",
      agent: "jenkins-watch",
      state: "done",
      attempts: 0,
      createdAt: "2026-11-28T02:37:00.000Z",
      claimedAt: "2026-11-28T02:37:00.052Z",
      finishedAt: "2026-11-28T02:37:06.199Z",
      summary: "最近构建 #1353 FAILURE",
      error: "",
      link: "",
      events: [{ source: "schedule", type: "schedule.tick", subject: "", summary: "", link: "" }],
    },
  ],
  hasMore: true,
});

test("projects the live Autoloop ledger into bounded console shapes", () => {
  const projected = projectAutoloopState(state());
  assert.equal(projected.source, "autoloop");
  assert.equal(projected.seq, 42);
  assert.equal(projected.observedAt, "2026-11-28T02:44:16.515Z");
  assert.equal(projected.totals.done, 14249);
  assert.equal(projected.totals.attention, 3);
  assert.equal(projected.runs.length, 1);
  assert.equal(projected.runs[0].rule, "Jenkins main 构建巡检");
  assert.equal(projected.runs[0].events.length, 1);
  assert.equal(projected.cards[0].title, "集群告警");
  assert.equal(projected.agents[0].online, true);
  assert.equal(projected.channels[0].id, "feishu");
  assert.equal(projected.lines[0].every, "*/10 * * * *");
  assert.equal(projected.hasMore, true);
});

test("rejects an upstream snapshot that is not the Autoloop shape", () => {
  assert.throws(() => projectAutoloopState(null), /Autoloop 快照格式无效/);
  assert.throws(() => projectAutoloopState({ seq: 1 }), /Autoloop 快照格式无效/);
  assert.throws(
    () => projectAutoloopState({ seq: "x", agents: [], channels: [] }),
    /Autoloop 快照格式无效/,
  );
});

test("caps every list so one snapshot cannot blow up the browser payload", () => {
  const huge = state();
  huge.runs = Array.from({ length: 500 }, (x, i) => ({ ...huge.runs[0], id: i }));
  huge.cards = Array.from({ length: 900 }, (x, i) => ({ ...huge.cards[0], id: i }));
  huge.agents = Array.from({ length: 200 }, (x, i) => ({ ...huge.agents[0], id: `a${i}` }));
  huge.lines = Array.from({ length: 200 }, (x, i) => ({ ...huge.lines[0], id: `l${i}` }));
  const projected = projectAutoloopState(huge);
  assert.equal(projected.runs.length, 120);
  assert.equal(projected.cards.length, 200);
  assert.equal(projected.agents.length, 60);
  assert.equal(projected.lines.length, 60);
});

test("reports the connector as unconfigured unless it is explicitly enabled", async () => {
  const connector = createAutoloopConnector({ env: {} });
  assert.equal(connector.enabled, false);
  await assert.rejects(() => connector.read(), /尚未配置或未启用/);
});

test("refuses a non-loopback Autoloop URL even when the connector is enabled", async () => {
  for (const url of [
    "http://example.com/",
    "https://127.0.0.1/",
    "http://127.0.0.1:3399/api/state",
    "http://user:pass@127.0.0.1:3399/",
  ]) {
    const connector = createAutoloopConnector({
      env: { HUB_AUTOLOOP_READ_ENABLED: "1", HUB_AUTOLOOP_STATE_URL: url },
      fetchImpl: async () => {
        throw new Error("must not fetch");
      },
    });
    await assert.rejects(() => connector.read(), /尚未配置或未启用/);
  }
});

test("reads the live Autoloop state through the bounded fetch path", async () => {
  let requested;
  const connector = createAutoloopConnector({
    env: {
      HUB_AUTOLOOP_READ_ENABLED: "1",
      HUB_AUTOLOOP_STATE_URL: "http://127.0.0.1:3399/",
    },
    fetchImpl: async (url) => {
      requested = url;
      return {
        ok: true,
        redirected: false,
        json: async () => state(),
      };
    },
  });
  const value = await connector.read();
  assert.equal(requested, "http://127.0.0.1:3399/api/state");
  assert.equal(value.runs.length, 1);
  assert.equal(typeof value.digest, "string");
});

test("turns an upstream failure into an upstream error rather than empty data", async () => {
  const connector = createAutoloopConnector({
    env: {
      HUB_AUTOLOOP_READ_ENABLED: "1",
      HUB_AUTOLOOP_STATE_URL: "http://127.0.0.1:3399/",
    },
    fetchImpl: async () => ({
      ok: false,
      redirected: false,
      json: async () => ({}),
    }),
  });
  await assert.rejects(() => connector.read(), /Autoloop 状态读取失败/);
});
