import test from "node:test";
import assert from "node:assert/strict";
import { createV20Hub } from "./helpers/v20-hub.mjs";
import { createV20Client } from "../apps/console/public/v20/api/client.js";
import { existingPath } from "../packages/contract/src/console-p1.mjs";

function browser(hub) {
  let cookie;
  const requests = [];
  const api = createV20Client({
    fetch: async (path, init) => {
      const headers = new Headers(init.headers);
      headers.set("Origin", hub.base);
      if (cookie) headers.set("Cookie", cookie);
      requests.push({ path, method: init.method });
      const res = await fetch(hub.base + path, { ...init, headers });
      const next = res.headers.get("set-cookie");
      if (next) cookie = next.split(";")[0];
      return res;
    },
  });
  return { api, requests };
}

test("the Autoloop read operation is a declared management contract entry", () => {
  assert.equal(
    existingPath("autoloopRead"),
    "/api/healing/workbench/autoloop",
  );
  assert.throws(() => existingPath("autoloopRead", "x"), TypeError);
});

test("an unconfigured Autoloop connector is reported as unconfigured, not empty data", async (t) => {
  const hub = await createV20Hub(t);
  const { api } = browser(hub);
  await api.login(hub.token);
  await assert.rejects(api.readExisting("autoloopRead", {}), {
    status: 422,
    code: "WORKBENCH_UNCONFIGURED",
  });
});

test("the Autoloop read endpoint requires an authenticated session", async (t) => {
  const hub = await createV20Hub(t);
  const response = await hub.request("/api/healing/workbench/autoloop");
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error.code, "AUTH_REQUIRED");
});

test("the Autoloop read endpoint rejects a write method", async (t) => {
  const hub = await createV20Hub(t);
  const { cookie } = await hub.login();
  const response = await hub.request("/api/healing/workbench/autoloop", {
    method: "POST",
    headers: { Cookie: cookie, Origin: hub.base },
  });
  assert.equal(response.status, 405);
});

test("a configured Autoloop connector serves the live projection through the browser contract", async (t) => {
  const upstream = {
    seq: 7,
    now: "2026-11-28T02:44:16.515Z",
    timezone: "Asia/Shanghai",
    spending: { today: {}, week: {} },
    totals: { done: 14249, doneToday: 529, attention: 1, running: 0, queued: 0 },
    cards: [
      {
        id: 1,
        kind: "notice",
        state: "open",
        title: "集群 Jenkins main 构建失败 #1353",
        text: "小手机 · 构建失败",
        options: ["已处理"],
        rule: "Jenkins main 失败告警",
        createdAt: "2026-11-28T01:41:11.140Z",
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
        totals: { done: 3 },
      },
    ],
    channels: [{ id: "feishu", name: "飞书私聊", online: true, seenAt: "2026-11-28T02:44:54.778Z" }],
    lines: [],
    pauses: [],
    runs: [
      {
        id: 14292,
        rule: "Jenkins main 构建巡检",
        agent: "jenkins-watch",
        state: "done",
        createdAt: "2026-11-28T02:37:00.000Z",
        finishedAt: "2026-11-28T02:37:06.199Z",
        summary: "最近构建 #1353 FAILURE",
        events: [{ source: "schedule", type: "schedule.tick", subject: "", summary: "", link: "" }],
      },
    ],
    hasMore: false,
  };
  // Serve the upstream from a real loopback HTTP server so the connector's
  // fetch, timeout and shape checks all run for real.
  const { createServer } = await import("node:http");
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(upstream));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const hubWithAutoloop = await createV20Hub(t, {
    integrationsEnv: {
      HUB_AUTOLOOP_READ_ENABLED: "1",
      HUB_AUTOLOOP_STATE_URL: origin + "/",
    },
  });
  const { api } = browser(hubWithAutoloop);
  await api.login(hubWithAutoloop.token);
  const value = await api.readExisting("autoloopRead", {});
  assert.equal(value.source, "autoloop");
  assert.equal(value.totals.done, 14249);
  assert.equal(value.runs[0].rule, "Jenkins main 构建巡检");
  assert.equal(value.cards[0].title, "集群 Jenkins main 构建失败 #1353");
  assert.equal(value.agents[0].online, true);
});
