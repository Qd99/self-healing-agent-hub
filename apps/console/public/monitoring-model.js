export const MONITORING_ALL_SCOPE = "__configured__";

// Shared browser/server contract. This module validates public configuration and
// builds local artifacts only: it never fetches Grafana, Prometheus, or Kubernetes.
const UID = /^[A-Za-z0-9_-]{1,40}$/;
const VARIABLE = /^(?!__)[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const NAMESPACE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SLUG = /^[A-Za-z0-9_-]{1,120}$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const MONITORING_TIME_RANGES = Object.freeze(
  [
    ["15m", "最近 15 分钟"],
    ["1h", "最近 1 小时"],
    ["6h", "最近 6 小时"],
    ["24h", "最近 24 小时"],
    ["7d", "最近 7 天"],
  ].map(([id, label]) =>
    Object.freeze({ id, label, from: `now-${id}`, to: "now" }),
  ),
);

// Reserved .invalid host and explicit demo labels are intentional placeholders.
// Do not automatically open this URL or interpret this object as observed data.
export const DEMO_MONITORING_CONFIG = Object.freeze({
  grafana: Object.freeze({
    baseUrl: "https://grafana.example.invalid",
    dashboardUid: "healing-demo",
    dashboardSlug: "namespace-scrapes",
    namespaceVariable: "namespace",
    datasourceVariable: "datasource",
  }),
  datasource: Object.freeze({
    type: "prometheus",
    uid: "prometheus-demo",
    name: "Prometheus · 示例",
  }),
  namespaces: Object.freeze(["healing-system", "demo-app"]),
});

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validString(value, pattern) {
  return typeof value === "string" && pattern.test(value);
}

function checked(errors, field, value, valid, message) {
  if (valid(value)) return value;
  errors.push({ field, message });
  // Never include rejected values in errors or the browser-facing projection.
  // null also keeps invalid optional fields invalid on a second normalization.
  return null;
}

function baseUrl(value) {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (
    !candidate ||
    /[\s\\%?#]/.test(candidate) ||
    !/^https?:\/\//.test(candidate)
  )
    return null;
  try {
    const url = new URL(candidate);
    const rawPath = candidate.replace(/^https?:\/\/[^/]+/, "");
    const authority = candidate.match(/^https?:\/\/([^/]+)/)?.[1] ?? "";
    if (
      !url.hostname ||
      url.username ||
      url.password ||
      authority.includes("@") ||
      !["https:", "http:"].includes(url.protocol) ||
      (url.protocol === "http:" && !LOOPBACK.has(url.hostname)) ||
      (rawPath && !/^\/(?:[A-Za-z0-9._~-]+\/?)*$/.test(rawPath)) ||
      rawPath.split("/").some((part) => part === "." || part === "..")
    )
      return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

function absentConfiguration(input) {
  return (
    input === undefined ||
    (record(input) &&
      input.status === "unconfigured" &&
      input.configured === false &&
      input.grafana === null &&
      input.datasource === null &&
      Array.isArray(input.namespaces) &&
      input.namespaces.length === 0)
  );
}

/**
 * Return a safe, explicit projection of optional config.monitoring.
 * `ready` means structurally valid configuration, never a connectivity result.
 * Unknown fields (including tokens, headers, endpoints and claimed health) are
 * omitted at every level. A malformed optional section does not break the rest
 * of the management snapshot.
 */
export function normalizeMonitoringConfig(input) {
  if (absentConfiguration(input)) {
    return {
      status: "unconfigured",
      configured: false,
      connectivity: "unverified",
      message:
        "Add monitoring configuration to choose Grafana, a Prometheus datasource UID, and watched namespaces.",
      errors: [],
      grafana: null,
      datasource: null,
      namespaces: [],
    };
  }

  const errors = [];
  if (!record(input)) {
    return {
      status: "invalid",
      configured: false,
      connectivity: "unverified",
      message:
        "Monitoring configuration is invalid; no dashboard link can be generated.",
      errors: [
        { field: "monitoring", message: "Monitoring must be an object." },
      ],
      grafana: null,
      datasource: null,
      namespaces: [],
    };
  }

  const sourceGrafana = record(input.grafana) ? input.grafana : {};
  const sourceDatasource = record(input.datasource) ? input.datasource : {};
  const normalizedUrl = baseUrl(sourceGrafana.baseUrl);
  const grafana = {
    baseUrl: checked(
      errors,
      "grafana.baseUrl",
      normalizedUrl,
      (value) => value !== null,
      "Use an HTTPS Grafana base URL without credentials, query parameters, or fragments; loopback HTTP is also supported.",
    ),
    dashboardUid: checked(
      errors,
      "grafana.dashboardUid",
      sourceGrafana.dashboardUid,
      (value) => validString(value, UID),
      "Dashboard UID must contain 1–40 letters, digits, underscores, or hyphens.",
    ),
    dashboardSlug: checked(
      errors,
      "grafana.dashboardSlug",
      sourceGrafana.dashboardSlug === undefined
        ? "healing-overview"
        : sourceGrafana.dashboardSlug,
      (value) => validString(value, SLUG),
      "Dashboard slug must contain 1–120 letters, digits, underscores, or hyphens.",
    ),
    namespaceVariable: checked(
      errors,
      "grafana.namespaceVariable",
      sourceGrafana.namespaceVariable === undefined
        ? "namespace"
        : sourceGrafana.namespaceVariable,
      (value) => validString(value, VARIABLE),
      "Namespace variable must be a simple identifier, without a var- prefix or reserved __ prefix.",
    ),
    datasourceVariable: checked(
      errors,
      "grafana.datasourceVariable",
      sourceGrafana.datasourceVariable === undefined
        ? "datasource"
        : sourceGrafana.datasourceVariable,
      (value) => validString(value, VARIABLE),
      "Datasource variable must be a simple identifier, without a var- prefix or reserved __ prefix.",
    ),
  };
  if (Object.hasOwn(sourceGrafana, "orgId")) {
    grafana.orgId = checked(
      errors,
      "grafana.orgId",
      sourceGrafana.orgId,
      (value) => Number.isSafeInteger(value) && value > 0,
      "Grafana organization ID must be a positive integer when provided.",
    );
  }
  if (
    grafana.namespaceVariable &&
    grafana.namespaceVariable === grafana.datasourceVariable
  ) {
    errors.push({
      field: "grafana.datasourceVariable",
      message: "Datasource and namespace variables must have different names.",
    });
  }

  const datasource = {
    type: checked(
      errors,
      "datasource.type",
      sourceDatasource.type === undefined
        ? "prometheus"
        : sourceDatasource.type,
      (value) => value === "prometheus",
      "Only a Prometheus datasource is supported.",
    ),
    uid: checked(
      errors,
      "datasource.uid",
      sourceDatasource.uid,
      (value) => validString(value, UID),
      "A Prometheus datasource UID is required: 1–40 letters, digits, underscores, or hyphens. A display name cannot replace it.",
    ),
    name: checked(
      errors,
      "datasource.name",
      sourceDatasource.name === undefined ? "" : sourceDatasource.name,
      (value) =>
        typeof value === "string" &&
        value.length <= 160 &&
        // Reject control characters in public datasource names used in links and exports.
        // eslint-disable-next-line no-control-regex
        !/[\u0000-\u001f\u007f]/.test(value),
      "Datasource display name must be plain text of at most 160 characters, or empty if unknown.",
    ),
  };
  if (datasource.name !== null) datasource.name = datasource.name.trim();

  const validNamespaces =
    Array.isArray(input.namespaces) &&
    input.namespaces.length > 0 &&
    input.namespaces.length <= 100 &&
    input.namespaces.every((value) => validString(value, NAMESPACE));
  const namespaces = validNamespaces ? [...new Set(input.namespaces)] : [];
  if (!validNamespaces) {
    errors.push({
      field: "namespaces",
      message:
        "List 1–100 explicit Kubernetes namespace names, each at most 63 lowercase letters, digits, or hyphens, starting and ending with a letter or digit. Wildcards and all-cluster values are not supported.",
    });
  }

  return {
    status: errors.length ? "invalid" : "ready",
    configured: errors.length === 0,
    connectivity: "unverified",
    message: errors.length
      ? "Monitoring configuration is invalid; correct the indicated fields before opening Grafana."
      : "Configuration is ready to open. Grafana access, datasource identity, namespace labels, and metrics have not been verified.",
    errors,
    grafana,
    datasource,
    namespaces,
  };
}

/** Build a Grafana URL without performing a request. Omitted scope means all
 * explicitly watched namespaces, never Grafana's wildcard/All selection. */
export function buildGrafanaUrl(input, options = {}) {
  const monitoring = normalizeMonitoringConfig(input);
  if (monitoring.status !== "ready" || !record(options)) return null;
  const selected =
    options.namespaces === undefined
      ? monitoring.namespaces
      : options.namespaces;
  if (
    !Array.isArray(selected) ||
    !selected.length ||
    !selected.every((namespace) => monitoring.namespaces.includes(namespace))
  )
    return null;
  const from = options.from === undefined ? "now-6h" : options.from;
  const to = options.to === undefined ? "now" : options.to;
  if (
    !MONITORING_TIME_RANGES.some(
      (range) => range.from === from && range.to === to,
    )
  )
    return null;

  const { grafana, datasource } = monitoring;
  const url = new URL(
    `${grafana.baseUrl}/d/${encodeURIComponent(grafana.dashboardUid)}/${encodeURIComponent(grafana.dashboardSlug)}`,
  );
  if (grafana.orgId !== undefined)
    url.searchParams.set("orgId", String(grafana.orgId));
  url.searchParams.set("from", from);
  url.searchParams.set("to", to);
  url.searchParams.set(`var-${grafana.datasourceVariable}`, datasource.uid);
  for (const namespace of new Set(selected))
    url.searchParams.append(`var-${grafana.namespaceVariable}`, namespace);
  return url.toString();
}

/** Export a draft block for merging into configs/healing-config.json. This does
 * not save to the gateway and contains no credentials or derived health state. */
export function exportMonitoringConfig(input) {
  const monitoring = normalizeMonitoringConfig(input);
  if (monitoring.status !== "ready") return null;
  const { grafana, datasource, namespaces } = monitoring;
  const exportedGrafana = {
    baseUrl: grafana.baseUrl,
    dashboardUid: grafana.dashboardUid,
    dashboardSlug: grafana.dashboardSlug,
    namespaceVariable: grafana.namespaceVariable,
    datasourceVariable: grafana.datasourceVariable,
  };
  if (grafana.orgId !== undefined) exportedGrafana.orgId = grafana.orgId;
  return {
    monitoring: {
      grafana: exportedGrafana,
      datasource: {
        type: "prometheus",
        uid: datasource.uid,
        name: datasource.name,
      },
      namespaces: [...namespaces],
    },
  };
}

/** Produce an importable Classic Grafana dashboard template. Queries are real
 * Prometheus scrape-status expressions, not observations or healing metrics.
 * The target's namespace label must be preserved by scrape relabeling. */
export function buildGrafanaDashboard(input) {
  const monitoring = normalizeMonitoringConfig(input);
  if (monitoring.status !== "ready") return null;
  const { grafana, datasource, namespaces } = monitoring;
  const datasourceReference = {
    type: "prometheus",
    uid: `\${${grafana.datasourceVariable}}`,
  };
  const selector = `namespace=~"\${${grafana.namespaceVariable}:regex}"`;
  const prerequisite =
    "Requires a namespace label on Prometheus scrape targets. This reports scrape health, not workload readiness or healing-task health. Missing labels or series produce no data; they are not replaced with zero.";
  const panel = (id, title, expr, type, gridPos) => ({
    id,
    title,
    description: prerequisite,
    type,
    datasource: { ...datasourceReference },
    gridPos,
    fieldConfig: { defaults: { unit: "short", min: 0 }, overrides: [] },
    options:
      type === "stat"
        ? {
            colorMode: "value",
            graphMode: "none",
            reduceOptions: {
              calcs: ["lastNotNull"],
              fields: "",
              values: false,
            },
          }
        : {
            legend: { displayMode: "list", placement: "bottom" },
            tooltip: { mode: "single" },
          },
    targets: [
      {
        refId: "A",
        datasource: { ...datasourceReference },
        expr,
        format: "time_series",
        instant: type === "stat",
        range: type !== "stat",
        legendFormat:
          type === "stat"
            ? "{{namespace}}"
            : "{{namespace}} · {{job}} · {{instance}}",
      },
    ],
  });
  return {
    id: null,
    uid: grafana.dashboardUid,
    title: "Healing Hub · Namespace scrape monitoring",
    description:
      "Template only; no live connection was verified by Healing Hub. Namespace labels identify scrape targets, which may differ from workload namespaces. Shared multi-cluster datasources require an additional cluster selector before use.",
    tags: ["healing-hub", "prometheus", "namespace-scrapes"],
    timezone: "browser",
    schemaVersion: 39,
    version: 1,
    editable: true,
    refresh: "30s",
    time: { from: "now-6h", to: "now" },
    templating: {
      list: [
        {
          name: grafana.datasourceVariable,
          label: "Prometheus datasource",
          type: "datasource",
          query: "prometheus",
          current: {
            text: datasource.name || datasource.uid,
            value: datasource.uid,
          },
          refresh: 1,
          multi: false,
          includeAll: false,
          skipUrlSync: false,
          options: [],
        },
        {
          name: grafana.namespaceVariable,
          label: "Watched namespaces",
          description:
            "Explicit watched scope; all selected values are enumerated. This is a dashboard filter, not an access-control boundary.",
          type: "custom",
          query: namespaces.join(","),
          current: { text: [...namespaces], value: [...namespaces] },
          options: namespaces.map((namespace) => ({
            text: namespace,
            value: namespace,
            selected: true,
          })),
          multi: true,
          includeAll: false,
          allowCustomValue: false,
          skipUrlSync: false,
          hide: 0,
        },
      ],
    },
    panels: [
      panel(
        1,
        "Targets scraping successfully",
        `sum by (namespace) (up{${selector}})`,
        "stat",
        { h: 5, w: 12, x: 0, y: 0 },
      ),
      panel(
        2,
        "Targets failing to scrape",
        `sum by (namespace) (1 - up{${selector}})`,
        "stat",
        { h: 5, w: 12, x: 12, y: 0 },
      ),
      panel(
        3,
        "Scrape state by target · 1 up / 0 down",
        `up{${selector}}`,
        "timeseries",
        { h: 10, w: 24, x: 0, y: 5 },
      ),
    ],
  };
}
