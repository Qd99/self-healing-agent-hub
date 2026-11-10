import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { normalizeMonitoringConfig } from "../apps/console/public/monitoring-model.js";
import { checkGrafanaConnection } from "../apps/healing-hub/src/grafana-connection.mjs";

const ORIGIN = "https://grafana.example.invalid";
const TOKEN = "test-only-server-token-needle";
const HEALTH = { database: "ok", version: "12.0.0", commit: "test-commit" };
const DATASOURCE = {
  id: 1,
  uid: "prom-main",
  orgId: 2,
  name: "Prometheus Main",
  type: "prometheus",
  typeLogoUrl:
    "public/app/plugins/datasource/prometheus/img/prometheus_logo.svg",
  access: "proxy",
  url: "http://prometheus.internal:9090",
  password: "needle-upstream-password",
  user: "needle-upstream-user",
  database: "",
  basicAuth: true,
  basicAuthUser: "needle-basic-auth-user",
  basicAuthPassword: "needle-basic-auth-password",
  withCredentials: false,
  isDefault: true,
  jsonData: { httpMethod: "POST", secret: "needle-json-data-secret" },
  secureJsonFields: { basicAuthPassword: true },
  version: 1,
  readOnly: false,
};

function configuration(baseUrl = `${ORIGIN}/grafana/`) {
  return {
    grafana: { baseUrl, dashboardUid: "healing-main", orgId: 2 },
    datasource: {
      type: "prometheus",
      uid: "prom-main",
      name: "Prometheus Main",
    },
    namespaces: ["healing-system"],
  };
}

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function responses(values, calls = []) {
  let index = 0;
  return async (url, options) => {
    calls.push({ url: String(url), options });
    assert.ok(index < values.length, "No unexpected endpoint may be fetched.");
    const next = values[index++];
    if (next instanceof Error) throw next;
    return next;
  };
}

function options(fetchImpl, extras = {}) {
  return { allowedOrigins: [ORIGIN], token: TOKEN, fetchImpl, ...extras };
}

function checkedAtIsRecent(result) {
  assert.equal(new Date(result.checkedAt).toISOString(), result.checkedAt);
  assert.ok(Date.now() - Date.parse(result.checkedAt) < 5000);
}

async function serverFixture(t, handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("absent and normalized unconfigured monitoring performs no network request", async () => {
  const calls = [];
  for (const config of [undefined, normalizeMonitoringConfig(undefined)]) {
    const result = await checkGrafanaConnection(
      config,
      options(responses([], calls)),
    );
    assert.equal(result.status, "unconfigured");
    assert.deepEqual(result.checks, {
      grafana: "unknown",
      datasource: "unknown",
    });
    checkedAtIsRecent(result);
  }
  assert.equal(calls.length, 0);
});

test("invalid saved configuration cannot be made valid by claimed readiness", async () => {
  const calls = [];
  for (const config of [
    null,
    {},
    { ...configuration(), namespaces: ["*"] },
    {
      ...configuration(),
      status: "ready",
      configured: true,
      datasource: { type: "prometheus", uid: "../needle-secret" },
    },
  ]) {
    const result = await checkGrafanaConnection(
      config,
      options(responses([], calls)),
    );
    assert.equal(result.status, "error");
    assert.deepEqual(result.checks, {
      grafana: "unknown",
      datasource: "unknown",
    });
    assert.doesNotMatch(JSON.stringify(result), /needle-secret/);
  }
  assert.equal(calls.length, 0);
});

test("unsafe URL forms are rejected before any token or request can leave the server", async () => {
  const calls = [];
  for (const baseUrl of [
    "http://grafana.example.invalid",
    "https://user:needle-password@grafana.example.invalid",
    "https://grafana.example.invalid?token=needle-query",
    "https://grafana.example.invalid/#needle-fragment",
    "https://grafana.example.invalid/%2e%2e/internal",
    "https://grafana.example.invalid/grafana/../internal",
    "file:///etc/passwd",
  ]) {
    const result = await checkGrafanaConnection(
      configuration(baseUrl),
      options(responses([], calls)),
    );
    assert.equal(result.status, "error", baseUrl);
    assert.doesNotMatch(JSON.stringify(result), /needle-|passwd/);
  }
  assert.equal(calls.length, 0);
});

test("an origin must exactly match an administrator allowlist entry", async () => {
  const calls = [];
  for (const allowedOrigins of [
    [],
    ["*"],
    ["https://*.example.invalid"],
    ["https://grafana.example.invalid.attacker.invalid"],
    ["https://grafana.example.invalid:444"],
    ["http://grafana.example.invalid"],
    [`${ORIGIN}/`],
    [`${ORIGIN}/grafana`],
    ORIGIN,
  ]) {
    const result = await checkGrafanaConnection(
      configuration(),
      options(responses([], calls), { allowedOrigins }),
    );
    assert.equal(result.status, "error");
    assert.match(result.message, /允许列表/);
    assert.deepEqual(result.checks, {
      grafana: "unknown",
      datasource: "unknown",
    });
  }
  assert.equal(calls.length, 0);
});

test("real HTTP checks preserve a base path and verify health then datasource identity", async (t) => {
  const requests = [];
  const origin = await serverFixture(t, (request, response) => {
    requests.push({
      url: request.url,
      method: request.method,
      headers: request.headers,
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify(request.url.endsWith("/api/health") ? HEALTH : DATASOURCE),
    );
  });
  const stored = normalizeMonitoringConfig(
    configuration(`${origin}/observability/grafana/`),
  );
  const result = await checkGrafanaConnection(stored, {
    allowedOrigins: [origin],
    token: TOKEN,
  });
  assert.equal(result.status, "connected");
  assert.deepEqual(result.checks, { grafana: "ok", datasource: "ok" });
  assert.deepEqual(result.datasource, {
    uid: "prom-main",
    name: "Prometheus Main",
    type: "prometheus",
  });
  assert.deepEqual(
    requests.map(({ url }) => url),
    [
      "/observability/grafana/api/health",
      "/observability/grafana/api/datasources/uid/prom-main",
    ],
  );
  for (const request of requests) {
    assert.equal(request.method, "GET");
    assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(request.headers["x-grafana-org-id"], "2");
  }
  assert.match(result.message, /未检查/);
  assert.doesNotMatch(
    JSON.stringify(result),
    /needle-|prometheus\.internal|test-commit/,
  );
  checkedAtIsRecent(result);
});

test("only the server token is used and redirects are disabled on both requests", async () => {
  const stored = configuration();
  stored.token = "needle-browser-token";
  stored.grafana.headers = { Authorization: "needle-browser-header" };
  const calls = [];
  const result = await checkGrafanaConnection(stored, {
    allowedOrigins: [ORIGIN],
    fetchImpl: responses([json(HEALTH), json(DATASOURCE)], calls),
  });
  assert.equal(result.status, "connected");
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(new Headers(call.options.headers).has("authorization"), false);
    assert.equal(call.options.redirect, "error");
    assert.equal(call.options.credentials, "omit");
    assert.ok(call.options.signal instanceof AbortSignal);
    assert.equal(new URL(call.url).origin, ORIGIN);
  }
  assert.doesNotMatch(JSON.stringify(result), /needle-/);
});

test("an omitted optional datasource name allows discovery of the real display name", async () => {
  const stored = configuration();
  delete stored.datasource.name;
  const result = await checkGrafanaConnection(
    stored,
    options(
      responses([
        json(HEALTH),
        json({ ...DATASOURCE, name: "Production Metrics" }),
      ]),
    ),
  );
  assert.equal(result.status, "connected");
  assert.equal(result.datasource.name, "Production Metrics");
});

for (const [label, value, message] of [
  ["UID mismatch", { uid: "different-prom" }, /UID.*不匹配/],
  ["display name mismatch", { name: "Different Name" }, /名称.*不匹配/],
  ["non-Prometheus datasource", { type: "loki" }, /Prometheus/i],
]) {
  test(`${label} cannot be reported as connected`, async () => {
    const result = await checkGrafanaConnection(
      configuration(),
      options(responses([json(HEALTH), json({ ...DATASOURCE, ...value })])),
    );
    assert.equal(result.status, "error");
    assert.deepEqual(result.checks, { grafana: "ok", datasource: "error" });
    assert.match(result.message, message);
    assert.equal(result.datasource, undefined);
  });
}

test("unhealthy or malformed health responses stop before datasource lookup", async () => {
  for (const response of [
    json({ database: "failed", message: "needle-database-error" }),
    json({ version: "12.0.0" }),
    json(null),
    json([]),
    new Response("{broken needle-json", {
      headers: { "content-type": "application/json" },
    }),
    new Response("<html>Login needle-session</html>", {
      headers: { "content-type": "text/html" },
    }),
  ]) {
    const calls = [];
    const result = await checkGrafanaConnection(
      configuration(),
      options(responses([response], calls)),
    );
    assert.equal(result.status, "error");
    assert.deepEqual(result.checks, {
      grafana: "error",
      datasource: "unknown",
    });
    assert.equal(calls.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /needle-/);
  }
});

test("malformed datasource metadata never passes identity verification", async () => {
  for (const value of [
    null,
    [],
    {},
    { ...DATASOURCE, uid: null },
    { ...DATASOURCE, name: 42 },
    { ...DATASOURCE, name: "line\nbreak" },
    { ...DATASOURCE, name: "" },
    { ...DATASOURCE, name: "x".repeat(161) },
  ]) {
    const result = await checkGrafanaConnection(
      configuration(),
      options(responses([json(HEALTH), json(value)])),
    );
    assert.equal(result.status, "error");
    assert.deepEqual(result.checks, { grafana: "ok", datasource: "error" });
    assert.equal(result.datasource, undefined);
  }
});

test("authorization failures identify the failed check without echoing response details", async () => {
  for (const status of [401, 403]) {
    for (const phase of ["grafana", "datasource"]) {
      const forbidden = json(
        { message: `needle-private-body ${TOKEN}` },
        status,
      );
      const upstream =
        phase === "grafana" ? [forbidden] : [json(HEALTH), forbidden];
      const result = await checkGrafanaConnection(
        configuration(),
        options(responses(upstream)),
      );
      assert.equal(result.status, "error");
      assert.deepEqual(
        result.checks,
        phase === "grafana"
          ? { grafana: "error", datasource: "unknown" }
          : { grafana: "ok", datasource: "error" },
      );
      assert.match(result.message, /令牌|权限/);
      assert.doesNotMatch(JSON.stringify(result), /needle-|private-body/);
    }
  }
});

test("a missing datasource is distinct from a successful Grafana health check", async () => {
  const result = await checkGrafanaConnection(
    configuration(),
    options(
      responses([
        json(HEALTH),
        json({ message: "needle-private-not-found" }, 404),
      ]),
    ),
  );
  assert.equal(result.status, "error");
  assert.deepEqual(result.checks, { grafana: "ok", datasource: "error" });
  assert.match(result.message, /未找到.*UID/);
  assert.doesNotMatch(JSON.stringify(result), /needle-/);
});

test("upstream HTTP and network errors cannot leak credentials or private response bodies", async () => {
  for (const response of [
    json({ message: `needle-private-response ${TOKEN}` }, 500),
    new Error(`https://user:needle-password@private.invalid?token=${TOKEN}`, {
      cause: new Error("needle-private-cause"),
    }),
  ]) {
    const result = await checkGrafanaConnection(
      configuration(),
      options(responses([response])),
    );
    assert.equal(result.status, "error");
    assert.deepEqual(result.checks, {
      grafana: "error",
      datasource: "unknown",
    });
    assert.doesNotMatch(
      JSON.stringify(result),
      /needle-|private\.invalid|user:/,
    );
  }
});

test("a reflected server token in public datasource fields is never returned", async () => {
  const stored = configuration();
  stored.datasource.name = "";
  const result = await checkGrafanaConnection(
    stored,
    options(
      responses([
        json(HEALTH),
        json({ ...DATASOURCE, name: `Datasource ${TOKEN}` }),
      ]),
    ),
  );
  assert.equal(result.status, "error");
  assert.deepEqual(result.checks, { grafana: "ok", datasource: "error" });
  assert.doesNotMatch(JSON.stringify(result), /needle/);
});

test("declared oversized responses are refused and their body is cancelled", async () => {
  for (const phase of ["grafana", "datasource"]) {
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      {
        headers: {
          "content-type": "application/json",
          "content-length": "1048576",
        },
      },
    );
    const result = await checkGrafanaConnection(
      configuration(),
      options(
        responses(phase === "grafana" ? [response] : [json(HEALTH), response]),
      ),
    );
    assert.equal(result.status, "error");
    assert.equal(result.checks[phase], "error");
    assert.match(result.message, /大小限制/);
    assert.equal(cancelled, true);
  }
});

test("streamed response limits count bytes even with absent or understated content length", async () => {
  for (const length of [undefined, "2"]) {
    let cancelled = false;
    const bytes = new TextEncoder().encode(
      JSON.stringify({ database: "ok", padding: "🙂".repeat(20000) }),
    );
    let offset = 0;
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          if (offset >= bytes.length) return controller.close();
          controller.enqueue(bytes.slice(offset, offset + 4096));
          offset += 4096;
        },
        cancel() {
          cancelled = true;
        },
      }),
      {
        headers: {
          "content-type": "application/json",
          ...(length ? { "content-length": length } : {}),
        },
      },
    );
    const result = await checkGrafanaConnection(
      configuration(),
      options(responses([response])),
    );
    assert.equal(result.status, "error");
    assert.match(result.message, /大小限制/);
    assert.equal(cancelled, true);
  }
});

test(
  "the deadline aborts even an injected fetch that never settles",
  { timeout: 1500 },
  async () => {
    let signal;
    const started = Date.now();
    const result = await checkGrafanaConnection(
      configuration(),
      options(
        (_url, init) => {
          signal = init.signal;
          return new Promise(() => {});
        },
        { timeoutMs: 30 },
      ),
    );
    assert.equal(result.status, "error");
    assert.deepEqual(result.checks, {
      grafana: "error",
      datasource: "unknown",
    });
    assert.match(result.message, /超时/);
    assert.equal(signal.aborted, true);
    assert.ok(Date.now() - started < 1000);
  },
);

test(
  "the deadline includes a stalled real HTTP response body",
  { timeout: 2000 },
  async (t) => {
    const requests = [];
    const origin = await serverFixture(t, (request, response) => {
      requests.push(request.url);
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"database":');
    });
    const result = await checkGrafanaConnection(configuration(origin), {
      allowedOrigins: [origin],
      timeoutMs: 100,
    });
    assert.equal(result.status, "error");
    assert.deepEqual(result.checks, {
      grafana: "error",
      datasource: "unknown",
    });
    assert.match(result.message, /超时/);
    assert.deepEqual(requests, ["/api/health"]);
  },
);

test(
  "a stalled datasource lookup preserves the successful Grafana health result",
  { timeout: 1500 },
  async () => {
    const result = await checkGrafanaConnection(
      configuration(),
      options(
        async (url) =>
          String(url).endsWith("/api/health")
            ? json(HEALTH)
            : new Promise(() => {}),
        { timeoutMs: 30 },
      ),
    );
    assert.equal(result.status, "error");
    assert.deepEqual(result.checks, { grafana: "ok", datasource: "error" });
    assert.match(result.message, /数据源.*超时/);
  },
);

test("real redirects are rejected without contacting their target or forwarding the token", async (t) => {
  const targetRequests = [];
  const target = await serverFixture(t, (request, response) => {
    targetRequests.push(request.headers.authorization);
    response.end(JSON.stringify(HEALTH));
  });
  const requests = [];
  const origin = await serverFixture(t, (request, response) => {
    requests.push(request.url);
    response.writeHead(302, { location: `${target}/needle-redirect-target` });
    response.end("needle-redirect-body");
  });
  const result = await checkGrafanaConnection(configuration(origin), {
    allowedOrigins: [origin],
    token: TOKEN,
  });
  assert.equal(result.status, "error");
  assert.deepEqual(result.checks, { grafana: "error", datasource: "unknown" });
  assert.deepEqual(requests, ["/api/health"]);
  assert.deepEqual(targetRequests, []);
  assert.doesNotMatch(JSON.stringify(result), /needle-/);
});

test("a returned redirect status is never interpreted as a successful datasource response", async () => {
  const result = await checkGrafanaConnection(
    configuration(),
    options(
      responses([
        json(HEALTH),
        new Response(null, {
          status: 307,
          headers: { location: "https://private.invalid/needle-secret" },
        }),
      ]),
    ),
  );
  assert.equal(result.status, "error");
  assert.deepEqual(result.checks, { grafana: "ok", datasource: "error" });
  assert.match(result.message, /重定向/);
  assert.doesNotMatch(JSON.stringify(result), /private\.invalid|needle/);
});

test("invalid server token header values fail before a request is sent", async () => {
  const calls = [];
  const result = await checkGrafanaConnection(
    configuration(),
    options(responses([], calls), {
      token: "needle-token\r\nX-Injected: secret",
    }),
  );
  assert.equal(result.status, "error");
  assert.equal(calls.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /needle|Injected/);
});
