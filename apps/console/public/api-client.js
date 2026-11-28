import { existingOperations, existingPath, operations } from "./v20/api/contract.generated.js";

/** Same-origin management transport. Management tokens never leave a session request. */
export class ConsoleApiError extends Error {
  constructor(
    message,
    { status = 0, code = "REQUEST_FAILED", fieldErrors } = {},
  ) {
    super(message);
    this.name = "ConsoleApiError";
    this.status = status;
    this.code = code;
    if (fieldErrors) this.fieldErrors = fieldErrors;
  }
}

export function createApiClient({
  fetch: fetchRequest = globalThis.fetch,
  timeoutMs = 10000,
  validateResponse = () => {},
} = {}) {
  let csrfToken = "";
  let revision = -1;
  let sessionGeneration = 0;
  const uncertainRequests = new Map();
  function setSnapshot(snapshot) {
    if (!snapshot || snapshot.mode !== "live") return;
    const nextRevision = Number.isSafeInteger(snapshot.revision)
      ? snapshot.revision
      : -1;
    if (nextRevision < revision) return;
    revision = nextRevision;
    if (typeof snapshot.csrfToken === "string") csrfToken = snapshot.csrfToken;
  }
  function clearSession() {
    csrfToken = "";
    revision = -1;
    sessionGeneration += 1;
    uncertainRequests.clear();
  }
  function invalidateReads() { sessionGeneration += 1; }
  async function request(path, { method = "GET", body, token, signal, acceptSnapshot, operationId } = {}) {
    if (method !== "GET" && token === undefined && !csrfToken)
      throw new ConsoleApiError("请先连接管理服务，再执行此操作。", {
        code: "CSRF_REQUIRED",
      });
    const generation = sessionGeneration;
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const headers = { Accept: "application/json" };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (token !== undefined) headers.Authorization = `Bearer ${token}`;
      else if (method !== "GET") headers["X-Heal-CSRF"] = csrfToken;
      const response = await fetchRequest(path, {
        method,
        headers,
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
        ...(operationId === undefined ? {} : { redirect: "error" }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.headers.get("content-type")?.includes("application/json"))
        throw new ConsoleApiError(
          "当前站点尚未提供管理接口，请从管理服务地址打开工作台。",
          { status: response.status, code: "INVALID_RESPONSE" },
        );
      let data;
      try {
        data = await response.json();
      } catch {
        throw new ConsoleApiError("管理服务返回了无效的 JSON 数据。", {
          status: response.status,
          code: "INVALID_RESPONSE",
        });
      }
      if (!response.ok)
        throw new ConsoleApiError(
          typeof data?.error?.message === "string"
            ? data.error.message
            : `管理服务返回 ${response.status}`,
          {
            status: response.status,
            code: data?.error?.code || "REQUEST_FAILED",
            fieldErrors: data?.error?.fieldErrors,
          },
        );
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new ConsoleApiError("管理服务返回的数据格式不正确。", {
          code: "INVALID_RESPONSE",
        });
      validateResponse({ method, path, data, operationId });
      if (generation === sessionGeneration && (!acceptSnapshot || acceptSnapshot(data.snapshot || data))) {
        setSnapshot(data.snapshot || data);
      }
      return data;
    } catch (error) {
      if (error instanceof ConsoleApiError) throw error;
      if (error?.name === "AbortError") {
        if (!timedOut) throw error;
        throw new ConsoleApiError(
          method === "GET"
            ? "连接超过 10 秒，请检查管理服务。"
            : "请求结果尚未确认，请刷新后核对。",
          { code: "TIMEOUT" },
        );
      }
      throw new ConsoleApiError(
        method === "GET"
          ? "无法连接管理服务，请检查网络后重试。"
          : "请求结果尚未确认，请刷新后核对。",
        { code: "NETWORK_ERROR" },
      );
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }
  async function idempotentRequest(path, body, options = {}) {
    const generation = sessionGeneration;
    const signature = JSON.stringify([path, body]);
    const requestId =
      body.requestId ||
      uncertainRequests.get(signature) ||
      globalThis.crypto.randomUUID?.() ||
      Array.from(
        globalThis.crypto.getRandomValues(new Uint8Array(16)),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
    try {
      const result = await request(path, {
        ...options,
        method: "POST",
        body: { ...body, requestId },
      });
      if (generation === sessionGeneration) uncertainRequests.delete(signature);
      return result;
    } catch (error) {
      if (generation === sessionGeneration) {
        if (["NETWORK_ERROR", "TIMEOUT", "INVALID_RESPONSE", "STALE_RESPONSE"].includes(error.code) || error.status >= 500)
          uncertainRequests.set(signature, requestId);
        else uncertainRequests.delete(signature);
      }
      throw error;
    }
  }
  const taskPath = (id) => `/api/healing/tasks/${encodeURIComponent(id)}`;
  return {
    setSnapshot,
    clearSession,
    invalidateReads,
    async callExisting(action, { id, query, body, signal, acceptSnapshot } = {}) {
      if (!Object.hasOwn(existingOperations, action))
        throw new ConsoleApiError("不支持的管理操作。", { code: "INVALID_ACTION" });
      let path;
      try {
        path = existingPath(action, id);
      } catch {
        throw new ConsoleApiError("管理操作的目标无效。", { code: "INVALID_ACTION" });
      }
      const op = existingOperations[action];
      if (query && op.method !== "GET")
        throw new ConsoleApiError("不支持的写入参数。", { code: "INVALID_ACTION" });
      const params = new URLSearchParams(Object.entries(query ?? {}).filter(([, value]) => ["string", "number"].includes(typeof value)));
      if (params.size) path += "?" + params;
      const options = { signal, acceptSnapshot, operationId: action };
      return op.idempotent
        ? idempotentRequest(path, body ?? {}, options)
        : request(path, { ...options, method: op.method, ...(op.method === "GET" ? {} : { body: body ?? {} }) });
    },
    getSnapshot: (options = {}) => request(operations.snapshotRead.path, options),
    readWorkbench(kind, params={}, options={}) {
      if(!["github-issues","github-prs","github-issue","github-pr","zentao","metrics","alerts","records"].includes(kind))
        return Promise.reject(new ConsoleApiError("不支持的工作区查询。",{code:"INVALID_ACTION"}));
      const query=new URLSearchParams(Object.entries(params).filter(([,v])=>v!==undefined&&v!==null).map(([k,v])=>[k,String(v)]));
      return request("/api/healing/workbench/"+kind+"?"+query.toString(),options);
    },
    saveWorkbenchRecord: body=>request("/api/healing/workbench/records",{method:"POST",body}),
    readAdvanced(kind,params={},options={}){
      if(!["profiles","trace","jobs","job","evidence","effects","samples","alerts"].includes(kind))return Promise.reject(new ConsoleApiError("不支持的高级查询。",{code:"INVALID_ACTION"}));
      return request("/api/healing/advanced/"+kind+"?"+new URLSearchParams(Object.entries(params).filter(([,v])=>v!==undefined&&v!==null).map(([k,v])=>[k,String(v)])).toString(),options);
    },
    writeAdvanced(kind,body){
      if(!["enqueue","zentao-sync","zentao-bug","zentao-retest","radar-register","reconcile-job","cancel-job","reconcile-effect"].includes(kind))return Promise.reject(new ConsoleApiError("不支持的高级操作。",{code:"INVALID_ACTION"}));
      return request("/api/healing/advanced/"+kind,{method:"POST",body});
    },
    async createSession(token) {
      clearSession();
      return request(operations.sessionCreate.path, { method: operations.sessionCreate.method, token });
    },
    async deleteSession() {
      const result = await request(operations.sessionDelete.path, {
        method: operations.sessionDelete.method,
      });
      clearSession();
      return result;
    },
    triggerTask: (body) => idempotentRequest("/api/healing/trigger", body),
    importCiBuild: (body) =>
      idempotentRequest("/api/healing/integrations/jenkins/builds", body),
    verifyTask: (id, body) =>
      request(`${taskPath(id)}/verification`, { method: "POST", body }),
    taskAction(id, action, body) {
      if (!["cancel", "retry"].includes(action))
        return Promise.reject(
          new ConsoleApiError("不支持的任务操作。", { code: "INVALID_ACTION" }),
        );
      return action === "retry"
        ? idempotentRequest(`${taskPath(id)}/${action}`, body)
        : request(`${taskPath(id)}/${action}`, { method: "POST", body });
    },
    bulkTaskAction: (body) =>
      idempotentRequest("/api/healing/tasks/bulk", body),
    reconcileTask: (id, body) =>
      idempotentRequest(`${taskPath(id)}/reconcile`, body),
    decideApproval: (id, body) =>
      request(`/api/healing/approvals/${encodeURIComponent(id)}/decision`, {
        method: "POST",
        body,
      }),
    updateRule: (id, body) =>
      request(`/api/healing/rules/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body,
      }),
    updateMonitoring: (body) =>
      request("/api/healing/monitoring", { method: "PUT", body }),
    checkMonitoring: () =>
      request("/api/healing/monitoring/check", { method: "POST", body: {} }),
  };
}
