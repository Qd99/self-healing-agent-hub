import test from "node:test";
import assert from "node:assert/strict";
import * as autoloopViews from "../public/v20/domains/autoloop/index.js";
import { renderAudit, renderHealing, renderWorkers } from "../public/v20/domains/operations/index.js";
import { renderTrace } from "../public/v20/domains/observability/index.js";

const ready = (value) => ({ state: "ready", value });

const snapshot = {
  project: { id: "hub-174", repo: "Qd99/self-healing-agent-hub" },
  generatedAt: "2026-11-28T03:00:00.000Z",
  storage: { status: "ready" },
  engines: [],
  tasks: [],
  activity: [],
  monitoring: { namespaces: [] },
};

const autoloop = {
  source: "autoloop",
  observedAt: "2026-11-28T03:00:00.000Z",
  seq: 12,
  totals: { done: 14293, doneToday: 552, attention: 3 },
  runs: [
    {
      id: 14324,
      rule: "Jenkins main 构建巡检",
      agent: "jenkins-watch",
      state: "done",
      summary: "最近构建 #1353 FAILURE",
      createdAt: "2026-11-28T02:59:00.000Z",
      finishedAt: "2026-11-28T02:59:04.000Z",
      events: [
        {
          source: "schedule",
          type: "schedule.tick",
          subject: "",
          summary: "",
          link: "",
        },
      ],
    },
  ],
  cards: [
    {
      id: 1,
      kind: "notice",
      state: "open",
      title: "集群 Jenkins main 构建失败 #1353",
      text: "小手机 · 构建失败",
      rule: "Jenkins main 失败告警",
      options: ["已处理"],
      createdAt: "2026-11-28T02:41:00.000Z",
    },
  ],
  agents: [
    {
      id: "claude",
      name: "[CC]",
      use: "claude",
      worker: "mac",
      online: true,
      seenAt: "2026-11-28T02:59:00.000Z",
      totals: { done: 3 },
    },
  ],
  lines: [
    {
      id: "巡检",
      name: "巡检测试站",
      agent: "site-test",
      source: "schedule",
      types: [],
      every: "*/5 * * * *",
      next: "2026-11-28T03:05:00.000Z",
      totals: { done: 228 },
    },
  ],
  channels: [
    { id: "feishu", name: "飞书私聊", online: true, seenAt: "2026-11-28T02:59:00.000Z" },
  ],
  pauses: [],
};

const workspace = () => ({
  autoloop: ready(autoloop),
  samples: ready({ items: [] }),
  runner: ready({ state: "ready" }),
});

test("every page that renders Autoloop data actually injects the view it calls", () => {
  // The composition root passes the whole module namespace; a mismatch between
  // the injected key and the real export silently blanked whole panels before.
  for (const [name, render] of [
    ["workers", () => renderWorkers(snapshot, workspace(), autoloopViews)],
    ["audit", () => renderAudit(snapshot, { taskHref: (id) => `#tasks?task=${id}`, auditQuery: "", autoloop: workspace().autoloop, views: autoloopViews })],
    ["healing", () => renderHealing(snapshot, { taskHref: (id) => `#tasks?task=${id}`, autoloop: workspace().autoloop, views: autoloopViews })],
    ["trace", () => renderTrace(workspace(), { record: null, views: autoloopViews })],
  ]) {
    const html = render();
    assert.equal(typeof html, "string", `${name} must render a string`);
    assert.ok(!html.includes("undefined"), `${name} rendered "undefined"`);
  }
});

test("the workers page shows real agent heartbeats from the Autoloop snapshot", () => {
  const html = renderWorkers(snapshot, workspace(), autoloopViews);
  assert.match(html, /\[CC\]/);
  assert.match(html, /在线/);
  assert.match(html, /巡检测试站/);
});

test("the audit page lists real Autoloop executions next to the Hub ledger", () => {
  const html = renderAudit(snapshot, {
    taskHref: (id) => `#tasks?task=${id}`,
    auditQuery: "",
    autoloop: workspace().autoloop,
    views: autoloopViews,
  });
  assert.match(html, /Jenkins main 构建巡检/);
  assert.match(html, /Hub 操作记录/);
});

test("the healing page lists open cards as human decisions, not approvals", () => {
  const html = renderHealing(snapshot, {
    taskHref: (id) => `#tasks?task=${id}`,
    autoloop: workspace().autoloop,
    views: autoloopViews,
  });
  assert.match(html, /集群 Jenkins main 构建失败 #1353/);
  assert.match(html, /不等于 Hub 审批/);
});

test("the trace page labels Autoloop events as not being OTLP spans", () => {
  const html = renderTrace(workspace(), { record: null, views: autoloopViews });
  assert.match(html, /Autoloop 已登记的执行事件/);
  assert.match(html, /不是 OTLP span/);
  assert.match(html, /schedule\.tick/);
});

test("an unconfigured Autoloop source renders a real state, never a blank panel", () => {
  const unset = { autoloop: { state: "unconfigured" } };
  for (const html of [
    renderWorkers(snapshot, unset, autoloopViews),
    renderAudit(snapshot, { taskHref: (id) => `#tasks?task=${id}`, auditQuery: "", autoloop: unset.autoloop, views: autoloopViews }),
    renderHealing(snapshot, { taskHref: (id) => `#tasks?task=${id}`, autoloop: unset.autoloop, views: autoloopViews }),
    renderTrace(unset, { record: null, views: autoloopViews }),
  ]) {
    assert.match(html, /尚未配置/);
    assert.ok(!html.includes("undefined"));
  }
});
