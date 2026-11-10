import test from "node:test";
import assert from "node:assert/strict";
import { renderShell } from "../apps/console/public/views.js";
import { createDemoSnapshot } from "../apps/console/public/data.js";
import { DEMO_MONITORING_CONFIG } from "../apps/console/public/monitoring-model.js";

const state = (extra = {}) => ({
  view: "settings",
  mode: "live",
  theme: "light",
  snapshot: null,
  error: "当前站点尚未提供管理接口。",
  loading: false,
  mobileNav: false,
  sidebarCollapsed: false,
  ...extra,
});

test("unconnected settings has no global search or demo selection and does not invent loaded data", () => {
  const html = renderShell(state());
  assert.doesNotMatch(
    html,
    /data-action="search"|data-mode="demo"|搜索任务|交互演示/,
  );
  assert.match(html, /管理服务/);
  assert.match(html, /未连接/);
  assert.match(html, /Grafana/);
  assert.match(html, /Prometheus/);
  assert.doesNotMatch(html, /<time |AGT-2048|已连接|演示可用/);
  assert.match(html, /data-action="refresh"/);
  assert.match(html, /data-action="monitoring-configure"/);
});

test("monitoring drafts stay distinct from a verified service connection", () => {
  const html = renderShell(
    state({
      monitoringConfig: DEMO_MONITORING_CONFIG,
      monitoringSource: "local",
    }),
  );
  assert.match(html, /本机草稿/);
  assert.match(html, /尚未验证/);
  assert.doesNotMatch(html, /已连接/);
});

test("loaded project and technical source values retain provenance and escape external text", () => {
  const snapshot = createDemoSnapshot();
  snapshot.mode = "live";
  snapshot.project.repo = '<img src=x onerror="boom">';
  snapshot.configSource = "example";
  snapshot.rulesSource = "configured";
  const html = renderShell(state({ snapshot, error: "" }));
  assert.match(html, /配置已读取/);
  assert.match(html, /healing-config\.example\.json/);
  assert.match(html, /healing-rules\.json/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img/);
});

test("disconnected task pages offer connection setup without a demo fallback", () => {
  const html = renderShell(state({ view: "tasks" }));
  assert.match(html, /连接设置/);
  assert.doesNotMatch(html, /查看演示|data-mode="demo"|AGT-2048/);
  assert.match(html, /尚未连接管理服务/);
});
