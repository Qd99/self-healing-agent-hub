import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createConsoleServer } from "../apps/healing-hub/src/console-server.mjs";
import {
  normalizeMonitoringConfig,
  buildGrafanaUrl,
  buildGrafanaDashboard,
  exportMonitoringConfig,
  DEMO_MONITORING_CONFIG,
  MONITORING_TIME_RANGES,
} from "../apps/console/public/monitoring-model.js";

const configured = {
  grafana: {
    baseUrl: "https://grafana.example.com/observability/",
    dashboardUid: "healing-monitoring",
    dashboardSlug: "namespace-scrapes",
    orgId: 2,
    namespaceVariable: "watched_namespace",
    datasourceVariable: "prometheus_source",
  },
  datasource: { uid: "prom-main_01", name: "Production Prometheus" },
  namespaces: ["healing-system", "applications"],
};

test("missing monitoring stays unconfigured and never manufactures a verified connection", () => {
  const result = normalizeMonitoringConfig();
  assert.equal(result.status, "unconfigured");
  assert.equal(result.configured, false);
  assert.equal(result.connectivity, "unverified");
  assert.equal(result.grafana, null);
  assert.equal(result.datasource, null);
  assert.deepEqual(result.namespaces, []);
  assert.deepEqual(result.errors, []);
  assert.equal(normalizeMonitoringConfig(result).status, "unconfigured");
  assert.equal(buildGrafanaUrl(), null);
  assert.equal(buildGrafanaUrl(result), null);
  assert.equal(buildGrafanaDashboard(result), null);
  assert.equal(exportMonitoringConfig(result), null);
});

test("configured monitoring uses a typed allowlist and does not accept claimed connectivity", () => {
  const input = structuredClone(configured);
  input.apiToken = "needle-token";
  input.connectivity = "verified";
  input.status = "healthy";
  input.grafana.headers = { Authorization: "needle-authorization" };
  input.grafana.iframeUrl = "https://needle-iframe.invalid";
  input.datasource.password = "needle-password";
  input.datasource.url = "https://needle-prometheus.invalid";
  input.namespaces.push("healing-system");
  const result = normalizeMonitoringConfig(input);
  assert.equal(result.status, "ready");
  assert.equal(result.configured, true);
  assert.equal(result.connectivity, "unverified");
  assert.equal(
    result.grafana.baseUrl,
    "https://grafana.example.com/observability",
  );
  assert.equal(result.datasource.type, "prometheus");
  assert.equal(result.datasource.uid, "prom-main_01");
  assert.deepEqual(result.namespaces, ["healing-system", "applications"]);
  assert.deepEqual(result.errors, []);
  assert.doesNotMatch(JSON.stringify(result), /needle-/);
  assert.deepEqual(normalizeMonitoringConfig(result), result);
  assert.equal(
    input.namespaces.length,
    3,
    "normalization does not mutate input",
  );
});

test("datasource name is optional display text and cannot replace a missing UID", () => {
  const unnamed = structuredClone(configured);
  delete unnamed.datasource.name;
  assert.equal(normalizeMonitoringConfig(unnamed).status, "ready");
  assert.equal(normalizeMonitoringConfig(unnamed).datasource.name, "");
  const withoutUid = structuredClone(configured);
  delete withoutUid.datasource.uid;
  const result = normalizeMonitoringConfig(withoutUid);
  assert.equal(result.status, "invalid");
  assert.equal(result.configured, false);
  assert.ok(result.errors.some((error) => error.field === "datasource.uid"));
  assert.equal(buildGrafanaUrl(withoutUid), null);
});

test("safe defaults are explicit and local HTTP is limited to loopback", () => {
  const input = {
    grafana: { baseUrl: "http://localhost:3000", dashboardUid: "local-demo" },
    datasource: { uid: "local-prometheus" },
    namespaces: ["default"],
  };
  const result = normalizeMonitoringConfig(input);
  assert.equal(result.status, "ready");
  assert.equal(result.grafana.namespaceVariable, "namespace");
  assert.equal(result.grafana.datasourceVariable, "datasource");
  assert.equal(result.grafana.dashboardSlug, "healing-overview");
  assert.equal(result.grafana.orgId, undefined);
  for (const baseUrl of ["http://127.0.0.1:3000", "http://[::1]:3000"])
    assert.equal(
      normalizeMonitoringConfig({
        ...input,
        grafana: { ...input.grafana, baseUrl },
      }).status,
      "ready",
    );
});

for (const baseUrl of [
  "javascript:alert(1)",
  "data:text/html,needle-url-secret",
  "//grafana.example.com",
  "https://user:needle-url-secret@grafana.example.com",
  "https://grafana.example.com?api_key=needle-url-secret",
  "https://grafana.example.com/#needle-url-secret",
  "https://grafana.example.com/../private",
  "https://grafana.example.com/%2e%2e/private",
  "https://grafana.example.com\\@evil.example.com",
  "https://grafana.example.com/\nprivate",
  "http://grafana.example.com",
  "http://localhost.evil.example.com",
]) {
  test(`unsafe Grafana base URL is rejected: ${JSON.stringify(baseUrl)}`, () => {
    const input = structuredClone(configured);
    input.grafana.baseUrl = baseUrl;
    const result = normalizeMonitoringConfig(input);
    assert.equal(result.status, "invalid");
    assert.ok(result.errors.some((error) => error.field === "grafana.baseUrl"));
    assert.equal(buildGrafanaUrl(input), null);
    assert.equal(buildGrafanaUrl(result), null);
    assert.doesNotMatch(JSON.stringify(result), /needle-/);
  });
}

for (const [field, value] of [
  ["grafana.dashboardUid", "../../needle-uid"],
  ["grafana.dashboardUid", "a".repeat(41)],
  ["grafana.dashboardSlug", "slug?token=needle-slug"],
  ["grafana.orgId", -1],
  ["grafana.orgId", "2"],
  ["grafana.namespaceVariable", "namespace&var-admin"],
  ["grafana.namespaceVariable", "__all"],
  ["grafana.datasourceVariable", "../datasource"],
  ["datasource.uid", "Prometheus / Production"],
  ["datasource.uid", "a".repeat(41)],
  ["datasource.name", "needle-\nname"],
  ["datasource.type", "loki"],
]) {
  test(`invalid ${field} blocks URL and export without exposing rejected input`, () => {
    const input = structuredClone(configured);
    const [section, key] = field.split(".");
    input[section][key] = value;
    const result = normalizeMonitoringConfig(input);
    assert.equal(result.status, "invalid");
    assert.ok(result.errors.some((error) => error.field === field));
    assert.equal(normalizeMonitoringConfig(result).status, "invalid");
    assert.equal(buildGrafanaUrl(result), null);
    assert.equal(buildGrafanaDashboard(result), null);
    assert.equal(exportMonitoringConfig(result), null);
    assert.doesNotMatch(JSON.stringify(result), /needle-/);
  });
}

test("namespace and datasource variable names cannot collide", () => {
  const input = structuredClone(configured);
  input.grafana.datasourceVariable = input.grafana.namespaceVariable;
  assert.equal(normalizeMonitoringConfig(input).status, "invalid");
  assert.equal(buildGrafanaUrl(input), null);
});

for (const namespaces of [
  [],
  "healing-system",
  ["*"],
  ["$__all"],
  ["default", "namespace&var-datasource=needle-injection"],
  ["prod|staging"],
  ["prod.*"],
  ["Default"],
  ["-default"],
  ["default-"],
  ["a".repeat(64)],
  ["default", null],
]) {
  test(`invalid namespace scope cannot widen a generated query: ${JSON.stringify(namespaces)}`, () => {
    const input = { ...configured, namespaces };
    const result = normalizeMonitoringConfig(input);
    assert.equal(result.status, "invalid");
    assert.deepEqual(result.namespaces, []);
    assert.equal(buildGrafanaUrl(input), null);
    assert.doesNotMatch(JSON.stringify(result), /needle-/);
  });
}

test("dashboard link preserves Grafana subpath, uses datasource UID, and repeats namespace variables", () => {
  const url = new URL(buildGrafanaUrl(configured));
  assert.equal(url.origin, "https://grafana.example.com");
  assert.equal(
    url.pathname,
    "/observability/d/healing-monitoring/namespace-scrapes",
  );
  assert.equal(url.searchParams.get("orgId"), "2");
  assert.equal(url.searchParams.get("from"), "now-6h");
  assert.equal(url.searchParams.get("to"), "now");
  assert.equal(url.searchParams.get("var-prometheus_source"), "prom-main_01");
  assert.deepEqual(
    url.searchParams.getAll("var-watched_namespace"),
    configured.namespaces,
  );
  assert.ok(
    !url.toString().includes("Production"),
    "display name is not the datasource reference",
  );
});

test("selected namespace subsets never silently widen to every namespace", () => {
  const url = new URL(
    buildGrafanaUrl(configured, {
      namespaces: ["applications", "applications"],
    }),
  );
  assert.deepEqual(url.searchParams.getAll("var-watched_namespace"), [
    "applications",
  ]);
  for (const namespaces of [
    [],
    ["kube-system"],
    ["applications", "*"],
    "applications",
    null,
  ])
    assert.equal(buildGrafanaUrl(configured, { namespaces }), null);
  assert.equal(buildGrafanaUrl(configured, null), null);
});

test("time windows are supported presets and cannot inject arbitrary query parameters", () => {
  for (const { from, to } of MONITORING_TIME_RANGES) {
    const url = new URL(buildGrafanaUrl(configured, { from, to }));
    assert.equal(url.searchParams.get("from"), from);
    assert.equal(url.searchParams.get("to"), to);
  }
  assert.equal(
    buildGrafanaUrl(configured, { from: "now-1h&var-watched_namespace=*" }),
    null,
  );
  assert.equal(buildGrafanaUrl(configured, { from: "now-99y" }), null);
  assert.equal(buildGrafanaUrl(configured, { to: "now+1d" }), null);
});

test("export contains only an importable monitoring configuration block", () => {
  const input = structuredClone(configured);
  input.datasource.apiToken = "needle-export-secret";
  const exported = exportMonitoringConfig(input);
  assert.deepEqual(Object.keys(exported), ["monitoring"]);
  assert.deepEqual(Object.keys(exported.monitoring).sort(), [
    "datasource",
    "grafana",
    "namespaces",
  ]);
  assert.equal(exported.monitoring.datasource.uid, "prom-main_01");
  assert.equal(normalizeMonitoringConfig(exported.monitoring).status, "ready");
  assert.doesNotMatch(
    JSON.stringify(exported),
    /needle-|connectivity|configured|status|errors/,
  );
  exported.monitoring.namespaces.push("new-namespace");
  assert.equal(input.namespaces.length, 2);
});

test("dashboard template binds the selected datasource and scopes every real Prometheus query", () => {
  const dashboard = buildGrafanaDashboard(configured);
  assert.equal(dashboard.uid, configured.grafana.dashboardUid);
  assert.equal(dashboard.id, null);
  const variables = dashboard.templating.list;
  const datasource = variables.find(
    (variable) => variable.name === "prometheus_source",
  );
  assert.equal(datasource.type, "datasource");
  assert.equal(datasource.query, "prometheus");
  assert.equal(datasource.current.value, "prom-main_01");
  assert.equal(datasource.current.text, "Production Prometheus");
  const namespace = variables.find(
    (variable) => variable.name === "watched_namespace",
  );
  assert.equal(namespace.multi, true);
  assert.equal(namespace.includeAll, false);
  assert.equal(namespace.allowCustomValue, false);
  assert.deepEqual(namespace.current.value, configured.namespaces);
  assert.deepEqual(
    namespace.options.map((option) => option.value),
    configured.namespaces,
  );
  assert.equal(dashboard.panels.length, 3);
  for (const panel of dashboard.panels) {
    assert.deepEqual(panel.datasource, {
      type: "prometheus",
      uid: "${prometheus_source}",
    });
    assert.match(panel.description, /namespace.*scrape|scrape.*namespace/i);
    assert.match(panel.description, /not.*workload|not.*task/i);
    for (const target of panel.targets) {
      assert.equal(target.datasource.uid, "${prometheus_source}");
      assert.ok(
        target.expr.includes('up{namespace=~"${watched_namespace:regex}"}'),
      );
      assert.doesNotMatch(target.expr, /healing_|or vector\(0\)/);
    }
  }
});

test("demo monitoring has an explicit placeholder host and no claimed measurements", () => {
  assert.ok(
    new URL(DEMO_MONITORING_CONFIG.grafana.baseUrl).hostname.endsWith(
      ".invalid",
    ),
  );
  assert.match(DEMO_MONITORING_CONFIG.datasource.name, /demo|示例/i);
  assert.equal(
    normalizeMonitoringConfig(DEMO_MONITORING_CONFIG).connectivity,
    "unverified",
  );
  assert.equal(DEMO_MONITORING_CONFIG.metrics, undefined);
});

async function fixture(t, monitoring) {
  const rootDir = await mkdtemp(join(tmpdir(), "healing-monitoring-"));
  await mkdir(join(rootDir, "configs"), { recursive: true });
  const config = {
    project: { id: "test", repo: "owner/test", defaultBranch: "main" },
    engines: {},
    triggers: {},
    safety: {},
    ...(monitoring === undefined ? {} : { monitoring }),
  };
  await Promise.all([
    writeFile(
      join(rootDir, "configs/healing-config.json"),
      JSON.stringify(config),
    ),
    writeFile(
      join(rootDir, "configs/healing-rules.json"),
      JSON.stringify({ version: "1", rules: [] }),
    ),
  ]);
  const server = createConsoleServer({ rootDir });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(rootDir, { recursive: true, force: true });
  });
  return new Promise((resolve, reject) => {
    const req = request(
      `http://127.0.0.1:${server.address().port}/api/healing/snapshot`,
      { agent: false },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () =>
          resolve({ status: res.statusCode, body, snapshot: JSON.parse(body) }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("gateway projects missing optional monitoring as unconfigured", async (t) => {
  const { status, snapshot } = await fixture(t);
  assert.equal(status, 200);
  assert.equal(snapshot.monitoring.status, "unconfigured");
  assert.equal(snapshot.monitoring.connectivity, "unverified");
  assert.ok(
    Object.values(snapshot.capabilities).every((value) => value === false),
  );
});

test("gateway strips monitoring secrets and never marks configuration as connected", async (t) => {
  const input = structuredClone(configured);
  input.token = "needle-monitoring-token";
  input.connected = true;
  input.grafana.token = "needle-grafana-token";
  input.datasource.password = "needle-datasource-secret";
  input.datasource.headers = { Authorization: "needle-headers" };
  const { status, body, snapshot } = await fixture(t, input);
  assert.equal(status, 200);
  assert.equal(snapshot.configSource, "configured");
  assert.equal(snapshot.monitoring.status, "ready");
  assert.equal(snapshot.monitoring.connectivity, "unverified");
  assert.deepEqual(snapshot.monitoring.namespaces, configured.namespaces);
  assert.doesNotMatch(body, /needle-|connected/);
  assert.deepEqual(snapshot.tasks, []);
  assert.ok(
    Object.values(snapshot.capabilities).every((value) => value === false),
  );
});

for (const input of [
  null,
  [],
  {
    ...configured,
    grafana: {
      ...configured.grafana,
      baseUrl: "https://user:needle-password@grafana.example.com",
    },
  },
]) {
  test("invalid optional monitoring remains explicit without breaking the read-only snapshot", async (t) => {
    const { status, body, snapshot } = await fixture(t, input);
    assert.equal(status, 200);
    assert.equal(snapshot.monitoring.status, "invalid");
    assert.equal(snapshot.monitoring.connectivity, "unverified");
    assert.ok(snapshot.monitoring.errors.length > 0);
    assert.doesNotMatch(body, /needle-/);
    assert.equal(snapshot.project.id, "test");
  });
}
