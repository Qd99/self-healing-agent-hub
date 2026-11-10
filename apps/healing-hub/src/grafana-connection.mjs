import { normalizeMonitoringConfig } from "../../console/public/monitoring-model.js";

const MAX_RESPONSE_BYTES = 64 * 1024;
const UID = /^[A-Za-z0-9_-]{1,40}$/;

// Only locally constructed messages are exposed. Fetch errors and upstream
// bodies may contain credentials, internal addresses, or proxy diagnostics.
class CheckFailure extends Error {}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cancelBody(body) {
  try {
    // Cancellation itself must not extend the request deadline.
    Promise.resolve(body?.cancel()).catch(() => {});
  } catch {
    // A body that is already closed or locked needs no further processing.
  }
}

async function boundedJson(response, signal, label) {
  const length = response.headers.get("content-length");
  if (
    length !== null &&
    (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)
  ) {
    cancelBody(response.body);
    throw new CheckFailure(`${label}响应超过大小限制。`);
  }
  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (
    contentType &&
    contentType !== "application/json" &&
    !/^application\/[a-z0-9.+_-]+\+json$/.test(contentType)
  ) {
    cancelBody(response.body);
    throw new CheckFailure(`${label}未返回 JSON。`);
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    throw new CheckFailure(`${label}返回了空响应或无效 JSON。`);
  }

  const reader = response.body.getReader();
  const cancel = () => {
    Promise.resolve(reader.cancel()).catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const chunks = [];
    let bytes = 0;
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new CheckFailure(`${label}返回了无效响应内容。`);
      }
      bytes += value.byteLength;
      // Count actual decoded response bytes too: Content-Length may be missing,
      // dishonest, or describe compressed data rather than the fetched stream.
      if (bytes > MAX_RESPONSE_BYTES) {
        throw new CheckFailure(`${label}响应超过大小限制。`);
      }
      if (value.byteLength) chunks.push(value);
    }
    const body = Buffer.concat(chunks, bytes);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch (error) {
    cancel();
    if (error instanceof CheckFailure || signal.aborted) throw error;
    throw new CheckFailure(`${label}返回的 JSON 格式错误或不完整。`);
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

async function requestJson(url, { fetchImpl, headers, signal, phase }) {
  const label =
    phase === "grafana" ? "Grafana 健康检查" : "Prometheus 数据源检查";
  const response = await fetchImpl(url, {
    method: "GET",
    headers,
    redirect: "error",
    credentials: "omit",
    cache: "no-store",
    signal,
  });
  if (signal.aborted) {
    cancelBody(response?.body);
    signal.throwIfAborted();
  }
  const status = response?.status;
  if (response?.redirected || (status >= 300 && status < 400)) {
    cancelBody(response?.body);
    throw new CheckFailure(
      `${label}拒绝了重定向，请填写 Grafana 最终服务地址。`,
    );
  }
  if (!Number.isInteger(status) || status < 200 || status >= 300) {
    cancelBody(response?.body);
    if (status === 401 || status === 403) {
      throw new CheckFailure(
        `${label}被拒绝（HTTP ${status}），请检查服务端令牌及其读取权限。`,
      );
    }
    if (phase === "datasource" && status === 404) {
      throw new CheckFailure("Grafana 中未找到配置的 Prometheus 数据源 UID。");
    }
    const code =
      Number.isInteger(status) && status >= 100 && status <= 599
        ? ` (HTTP ${status})`
        : "";
    throw new CheckFailure(`${label}失败${code}。`);
  }
  return boundedJson(response, signal, label);
}

/**
 * Check server-saved configuration, never request-supplied URLs or credentials.
 * The deployment allowlist contains exact origins, without paths or wildcards.
 * The one deadline covers both requests and their bounded response bodies.
 *
 * These Grafana API calls establish service health and datasource identity only;
 * they do not test Prometheus queries, namespace labels, or Kubernetes access.
 */
export async function checkGrafanaConnection(
  monitoringConfig,
  { allowedOrigins = [], token = "", fetchImpl = fetch, timeoutMs = 5000 } = {},
) {
  const checks = { grafana: "unknown", datasource: "unknown" };
  const result = (status, message, datasource) => ({
    status,
    checkedAt: new Date().toISOString(),
    message,
    checks: { ...checks },
    ...(datasource ? { datasource } : {}),
  });
  const monitoring = normalizeMonitoringConfig(monitoringConfig);
  if (monitoring.status === "unconfigured") {
    return result(
      "unconfigured",
      "请先保存 Grafana 和 Prometheus 数据源配置，再检查连接。",
    );
  }
  if (monitoring.status !== "ready") {
    return result("error", "已保存的监控配置无效，请修正后重新检查。");
  }

  const origin = new URL(monitoring.grafana.baseUrl).origin;
  if (!Array.isArray(allowedOrigins) || !allowedOrigins.includes(origin)) {
    return result(
      "error",
      "该 Grafana 地址未加入服务端允许列表，请联系管理员配置。",
    );
  }
  if (
    typeof token !== "string" ||
    (token !== "" && !/^[\x21-\x7e]{1,8192}$/.test(token))
  ) {
    return result("error", "服务端 Grafana 认证令牌无效，请联系管理员修正。");
  }

  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (monitoring.grafana.orgId !== undefined) {
    headers["X-Grafana-Org-Id"] = String(monitoring.grafana.orgId);
  }
  const controller = new AbortController();
  const deadlineMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.min(timeoutMs, 60_000)
      : 5000;
  let timer;
  let timedOut = false;
  let phase = "grafana";
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new CheckFailure("连接检查超时。"));
    }, deadlineMs);
  });

  const verify = async () => {
    const requestOptions = { fetchImpl, headers, signal: controller.signal };
    // Joining fixed suffixes retains a configured reverse-proxy base path.
    const health = await requestJson(
      `${monitoring.grafana.baseUrl}/api/health`,
      {
        ...requestOptions,
        phase,
      },
    );
    if (!record(health) || typeof health.database !== "string") {
      throw new CheckFailure("Grafana 返回的健康检查响应无效。");
    }
    if (health.database !== "ok") {
      throw new CheckFailure("Grafana 报告其数据库状态异常。");
    }
    checks.grafana = "ok";
    phase = "datasource";

    const datasource = await requestJson(
      `${monitoring.grafana.baseUrl}/api/datasources/uid/${encodeURIComponent(monitoring.datasource.uid)}`,
      { ...requestOptions, phase },
    );
    if (
      !record(datasource) ||
      typeof datasource.uid !== "string" ||
      !UID.test(datasource.uid) ||
      typeof datasource.type !== "string" ||
      typeof datasource.name !== "string" ||
      !datasource.name.trim() ||
      datasource.name.length > 160 ||
      /[\u0000-\u001f\u007f]/.test(datasource.name)
    ) {
      throw new CheckFailure("Grafana 返回的数据源身份信息无效。");
    }
    if (datasource.uid !== monitoring.datasource.uid) {
      throw new CheckFailure("返回的数据源 UID 与已保存的 UID 不匹配。");
    }
    if (datasource.type !== "prometheus") {
      throw new CheckFailure("配置的数据源不是 Prometheus 类型。");
    }
    if (
      monitoring.datasource.name &&
      datasource.name !== monitoring.datasource.name
    ) {
      throw new CheckFailure(
        "数据源名称与已保存的名称不匹配，请核对 UID 和名称。",
      );
    }
    const identity = {
      uid: datasource.uid,
      name: datasource.name,
      type: datasource.type,
    };
    if (
      token &&
      Object.values(identity).some((value) => value.includes(token))
    ) {
      throw new CheckFailure("Grafana 返回的数据源身份信息不安全。");
    }
    checks.datasource = "ok";
    return identity;
  };

  try {
    // The race also bounds injected fetch implementations that ignore AbortSignal.
    const datasource = await Promise.race([verify(), deadline]);
    return result(
      "connected",
      "Grafana 健康状态与 Prometheus 数据源身份已核验；未检查指标、命名空间标签或 Kubernetes 连接。",
      datasource,
    );
  } catch (error) {
    checks[phase] = "error";
    const label =
      phase === "grafana" ? "Grafana 健康检查" : "Prometheus 数据源检查";
    const message = timedOut
      ? `${label}超时，请检查服务端连接后重试。`
      : error instanceof CheckFailure
        ? error.message
        : `${label}未能完成，请检查网络、TLS 和重定向设置。`;
    return result("error", message);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
