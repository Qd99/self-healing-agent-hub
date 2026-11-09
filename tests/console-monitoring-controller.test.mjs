import test from "node:test";
import assert from "node:assert/strict";
import {
  createMonitoringController,
  monitoringDraftConfig,
} from "../apps/console/public/monitoring-controller.js";
import {
  MONITORING_ALL_SCOPE,
  normalizeMonitoringConfig,
} from "../apps/console/public/monitoring-model.js";
import {
  monitoringLink,
  renderMonitoringPage,
} from "../apps/console/public/monitoring-views.js";

const configured = {
  grafana: {
    baseUrl: "https://grafana.example.com/observability",
    dashboardUid: "healing-monitoring",
    dashboardSlug: "namespace-scrapes",
    namespaceVariable: "namespace",
    datasourceVariable: "datasource",
  },
  datasource: { type: "prometheus", uid: "prom-main", name: "Production" },
  namespaces: ["healing-system", "applications"],
};

function installBrowser(
  t,
  { entries = {}, failWrite = false, failRemove = false } = {},
) {
  const stored = new Map(Object.entries(entries));
  const writes = [];
  const focus = [];
  const originals = new Map();
  const globals = {
    localStorage: {
      getItem(key) {
        return stored.get(key) ?? null;
      },
      setItem(key, value) {
        if (failWrite) throw new Error("Storage unavailable");
        stored.set(key, value);
        writes.push([key, value]);
      },
      removeItem(key) {
        if (failRemove) throw new Error("Storage unavailable");
        stored.delete(key);
      },
    },
    document: {
      querySelector(selector) {
        return {
          focus() {
            focus.push(selector);
          },
        };
      },
    },
    FormData: class {
      constructor(form) {
        this.values = Object.entries(form.values || {});
      }
      [Symbol.iterator]() {
        return this.values[Symbol.iterator]();
      }
    },
  };
  for (const [key, value] of Object.entries(globals)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  t.after(() => {
    for (const [key, descriptor] of originals)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
  });
  return { stored, writes, focus };
}

function snapshot(id = "project-a", monitoring = configured) {
  return { project: { id }, monitoring: structuredClone(monitoring) };
}

function harness(initial = {}) {
  const state = {
    mode: "live",
    loading: false,
    snapshot: snapshot(),
    ...initial,
  };
  const messages = [];
  let renders = 0;
  let controller;
  controller = createMonitoringController({
    state,
    render() {
      renders += 1;
      controller.reconcile();
    },
    toast(message) {
      messages.push(message);
    },
  });
  controller.reconcile();
  return { state, controller, messages, renders: () => renders };
}

function submit(controller, values) {
  let prevented = false;
  const handled = controller.handleSubmit({
    target: { id: "monitoring-form", values },
    preventDefault() {
      prevented = true;
    },
  });
  assert.equal(handled, true);
  assert.equal(prevented, true);
}

function click(controller, action) {
  return controller.handleClick(
    { preventDefault() {} },
    { dataset: { action }, disabled: false },
  );
}

test("monitoring form parsing trims fields and preserves explicit namespace names", () => {
  const result = monitoringDraftConfig({
    baseUrl: " https://grafana.example.com ",
    dashboardUid: " healing ",
    datasourceUid: " prom-main ",
    datasourceName: " Production ",
    namespaces: "all，production\nhealing-system;production；staging",
    orgId: " 2 ",
  });
  assert.deepEqual(result.namespaces, [
    "all",
    "production",
    "healing-system",
    "staging",
  ]);
  assert.equal(result.grafana.baseUrl, "https://grafana.example.com");
  assert.equal(result.grafana.dashboardUid, "healing");
  assert.equal(result.grafana.namespaceVariable, "namespace");
  assert.equal(result.grafana.datasourceVariable, "datasource");
  assert.equal(result.grafana.orgId, 2);
  assert.deepEqual(result.datasource, {
    type: "prometheus",
    uid: "prom-main",
    name: "Production",
  });
  assert.equal(normalizeMonitoringConfig(result).status, "ready");
});

test("local monitoring drafts are isolated by mode and project and cannot assert connectivity", (t) => {
  const local = structuredClone(configured);
  local.grafana.dashboardUid = "local-a";
  local.connectivity = "verified";
  local.token = "needle-secret";
  const demo = structuredClone(configured);
  demo.grafana.dashboardUid = "demo-a";
  installBrowser(t, {
    entries: {
      "heal-monitoring-v1:live:project-a": JSON.stringify(local),
      "heal-monitoring-v1:demo:project-a": JSON.stringify(demo),
    },
  });
  const { state, controller } = harness();
  assert.equal(state.monitoringSource, "local");
  assert.equal(state.monitoringConfig.grafana.dashboardUid, "local-a");
  assert.equal(state.monitoringConfig.connectivity, "unverified");
  assert.doesNotMatch(JSON.stringify(state.monitoringConfig), /needle-secret/);
  state.mode = "demo";
  controller.reconcile();
  assert.equal(state.monitoringConfig.grafana.dashboardUid, "demo-a");
  state.mode = "live";
  state.snapshot = snapshot("project-b");
  controller.reconcile();
  assert.equal(state.monitoringSource, "server");
  assert.equal(
    state.monitoringConfig.grafana.dashboardUid,
    "healing-monitoring",
  );
  state.snapshot = snapshot("project-a");
  controller.reconcile();
  assert.equal(state.monitoringConfig.grafana.dashboardUid, "local-a");
});

test("malformed or credential-bearing saved drafts fall back to safe source configuration", (t) => {
  const invalid = structuredClone(configured);
  invalid.grafana.baseUrl = "https://user:needle-password@grafana.example.com";
  installBrowser(t, {
    entries: {
      "heal-monitoring-v1:live:project-a": JSON.stringify(invalid),
      "heal-monitoring-v1:live:project-b": "{broken-json",
    },
  });
  const { state, controller } = harness();
  assert.equal(state.monitoringSource, "server");
  assert.equal(
    state.monitoringConfig.grafana.baseUrl,
    configured.grafana.baseUrl,
  );
  assert.doesNotMatch(JSON.stringify(state.monitoringDraft), /needle-password/);
  state.snapshot = snapshot("project-b");
  controller.reconcile();
  assert.equal(state.monitoringSource, "server");
  assert.equal(state.monitoringConfig.status, "ready");
});

test("same-project refreshes update clean source config without replacing unfinished edits", (t) => {
  installBrowser(t);
  const { state, controller } = harness();
  const changed = structuredClone(configured);
  changed.grafana.dashboardUid = "new-server-dashboard";
  state.snapshot = snapshot("project-a", changed);
  controller.reconcile();
  assert.equal(state.monitoringDraft.dashboardUid, "new-server-dashboard");
  controller.handleInput({
    target: {
      name: "dashboardUid",
      value: "unsaved-dashboard",
      closest: () => ({}),
    },
  });
  assert.equal(state.monitoringDirty, true);
  state.snapshot = snapshot();
  controller.reconcile();
  assert.equal(state.monitoringDraft.dashboardUid, "unsaved-dashboard");
  assert.equal(
    state.monitoringConfig.grafana.dashboardUid,
    "new-server-dashboard",
  );
});

test("submission revalidates form values before writing and never persists a secret URL", (t) => {
  const browser = installBrowser(t);
  const { state, controller, messages } = harness();
  const original = structuredClone(state.monitoringConfig);
  submit(controller, {
    ...state.monitoringDraft,
    baseUrl: "https://user:needle-password@grafana.example.com",
  });
  assert.equal(browser.writes.length, 0);
  assert.deepEqual(state.monitoringConfig, original);
  assert.equal(state.monitoringDirty, true);
  assert.ok(
    state.monitoringErrors.some((item) => item.field === "grafana.baseUrl"),
  );
  assert.doesNotMatch(
    JSON.stringify(state.monitoringErrors),
    /needle-password/,
  );
  assert.equal(messages.length, 0);
  assert.equal(browser.focus.at(-1), '#monitoring-form [aria-invalid="true"]');
});

test("successful submission stores only validated public config and leaves the snapshot unchanged", (t) => {
  const browser = installBrowser(t);
  const { state, controller, messages } = harness();
  const originalSnapshot = structuredClone(state.snapshot);
  submit(controller, {
    ...state.monitoringDraft,
    dashboardUid: "saved-dashboard",
    apiToken: "needle-unsupported-field",
  });
  assert.equal(browser.writes.length, 1);
  const [key, raw] = browser.writes[0];
  assert.equal(key, "heal-monitoring-v1:live:project-a");
  assert.doesNotMatch(raw, /needle-|connectivity|errors|configured/);
  assert.equal(JSON.parse(raw).grafana.dashboardUid, "saved-dashboard");
  assert.equal(state.monitoringSource, "local");
  assert.equal(state.monitoringDirty, false);
  assert.equal(state.monitoringConfig.connectivity, "unverified");
  assert.deepEqual(state.snapshot, originalSnapshot);
  assert.match(messages.at(-1), /尚未验证连接或应用到服务端/);
});

test("storage failure retains a truthful session draft that can still be discarded", (t) => {
  const browser = installBrowser(t, { failWrite: true, failRemove: true });
  const { state, controller, messages } = harness();
  submit(controller, {
    ...state.monitoringDraft,
    dashboardUid: "session-dashboard",
  });
  assert.equal(browser.writes.length, 0);
  assert.equal(state.monitoringSource, "session");
  assert.equal(
    state.monitoringConfig.grafana.dashboardUid,
    "session-dashboard",
  );
  assert.match(messages.at(-1), /本次会话/);
  assert.equal(click(controller, "monitoring-reset"), true);
  assert.equal(
    state.monitoringConfig.grafana.dashboardUid,
    configured.grafana.dashboardUid,
  );
  assert.equal(state.monitoringDirty, false);
});

test("a namespace literally named all stays distinct from the configured-scope option", (t) => {
  installBrowser(t);
  const config = {
    ...structuredClone(configured),
    namespaces: ["all", "production"],
  };
  const { state, controller } = harness({
    snapshot: snapshot("project-a", config),
  });
  assert.equal(state.monitoringScope, MONITORING_ALL_SCOPE);
  const initialUrl = new URL(monitoringLink(state));
  assert.deepEqual(initialUrl.searchParams.getAll("var-namespace"), [
    "all",
    "production",
  ]);
  controller.handleChange({ target: { id: "monitoring-scope", value: "all" } });
  assert.equal(state.monitoringScope, "all");
  const scopedUrl = new URL(monitoringLink(state));
  assert.deepEqual(scopedUrl.searchParams.getAll("var-namespace"), ["all"]);
  const html = renderMonitoringPage(state);
  assert.equal([...html.matchAll(/<option value="all"/g)].length, 1);
  assert.ok(html.includes(`<option value="${MONITORING_ALL_SCOPE}"`));
});

test("unsaved edits block both exports before any download is attempted", (t) => {
  installBrowser(t);
  const { state, controller, messages } = harness();
  state.monitoringDirty = true;
  assert.equal(click(controller, "monitoring-export-config"), true);
  assert.equal(click(controller, "monitoring-export-dashboard"), true);
  assert.equal(messages.length, 2);
  assert.ok(messages.every((message) => /请先保存/.test(message)));
});
