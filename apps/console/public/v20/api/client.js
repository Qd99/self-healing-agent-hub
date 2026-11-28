import { createApiClient, ConsoleApiError } from "../../api-client.js";
import {
  existingOperations,
  operations,
  validateExisting,
  validateResponse,
} from "./contract.generated.js";

const failure = (code, message) => new ConsoleApiError(message, { code });
function projection(snapshot) {
  const value = { ...snapshot };
  delete value.csrfToken;
  return value;
}

const scope = (snapshot) =>
  JSON.stringify([snapshot.project.id, snapshot.project.repo]);

/** Only allowlisted management operations; credentials remain inside the transport. */
export function createV20Client({ transport = createApiClient, fetch } = {}) {
  let activeScope = null;
  const legacy = transport({
    ...(fetch ? { fetch } : {}),
    validateResponse({ method, path, data, operationId }) {
      if (operationId !== undefined) {
        try {
          validateExisting(operationId, data);
        } catch {
          throw failure("INVALID_RESPONSE", "管理服务返回的数据格式不正确。");
        }
        if (existingOperations[operationId].method !== "GET" && data.snapshot) {
          if (
            data.snapshot.auth.required !== true ||
            scope(data.snapshot) !== activeScope
          )
            throw failure(
              "PROJECT_CHANGED",
              "会话或项目已变化，请重新登录后核对写入结果。",
            );
          if (data.snapshot.revision < revision)
            throw failure(
              "STALE_RESPONSE",
              "已忽略较旧的写入快照，请刷新核对。",
            );
        }
        return;
      }
      const id = Object.keys(operations).find(
        (key) =>
          operations[key].method === method && operations[key].path === path,
      );
      if (!id) throw failure("INVALID_RESPONSE", "不支持的管理接口。");
      try {
        validateResponse(id, data);
      } catch {
        throw failure("INVALID_RESPONSE", "管理服务返回的数据格式不正确。");
      }
      if (
        id !== "sessionDelete" &&
        (data.snapshot ?? data).auth.required !== true
      ) {
        throw failure(
          "AUTH_UNCONFIGURED",
          "管理服务未配置会话鉴权，请先在服务端配置管理令牌。",
        );
      }
    },
  });
  let generation = 0,
    readSequence = 0,
    revision = -1;
  let csrfAvailable = false,
    authenticating = false;
  const invalidateReads = () => {
    generation++;
    readSequence++;
    legacy.invalidateReads();
  };
  const clear = () => {
    invalidateReads();
    csrfAvailable = false;
    revision = -1;
    activeScope = null;
    legacy.clearSession();
  };
  const assertIdle = () => {
    if (authenticating)
      throw failure("AUTH_BUSY", "正在处理登录或退出，请稍候。");
  };
  const withAuthentication = async (operation) => {
    assertIdle();
    authenticating = true;
    invalidateReads();
    try {
      return await operation();
    } finally {
      authenticating = false;
    }
  };
  return {
    invalidateReads,
    clear,
    async readExisting(action, options) {
      if (
        !Object.hasOwn(existingOperations, action) ||
        existingOperations[action].method !== "GET"
      )
        throw failure("INVALID_ACTION", "不支持的读取操作。");
      assertIdle();
      if (!activeScope) throw failure("AUTH_REQUIRED", "请先连接管理服务。");
      const started = generation;
      const value = await legacy.callExisting(action, {
        ...options,
        acceptSnapshot: () => false,
      });
      if (started !== generation)
        throw failure("STALE_RESPONSE", "已忽略上一次会话的读取结果。");
      return value;
    },
    async mutateExisting(action, options) {
      if (
        !Object.hasOwn(existingOperations, action) ||
        existingOperations[action].method === "GET"
      )
        throw failure("INVALID_ACTION", "不支持的写入操作。");
      if (!activeScope || !csrfAvailable)
        throw failure("CSRF_REQUIRED", "请先连接管理服务，再执行此操作。");
      return withAuthentication(async () => {
        const started = generation;
        const value = await legacy.callExisting(action, options);
        if (started !== generation)
          throw failure("STALE_RESPONSE", "会话已变化，请刷新核对写入结果。");
        if (value.snapshot) {
          revision = value.snapshot.revision;
          return { ...value, snapshot: projection(value.snapshot) };
        }
        return value;
      });
    },
    async read({ signal, acceptSnapshot = () => true } = {}) {
      assertIdle();
      const g = generation,
        sequence = ++readSequence;
      let accepted;
      const pending = await legacy.getSnapshot({
        signal,
        acceptSnapshot(raw) {
          if (g !== generation || sequence !== readSequence) return false;
          const view = projection(raw);
          // Revisions order results within a project, not across projects.
          if (!acceptSnapshot(view) || raw.revision < revision) return false;
          accepted = view;
          return true;
        },
      });
      if (g !== generation || sequence !== readSequence || !accepted)
        throw failure("STALE_RESPONSE", "已忽略过期的读取结果。");
      revision = pending.revision;
      activeScope = scope(pending);
      csrfAvailable = true;
      return accepted;
    },
    login(token) {
      return withAuthentication(async () => {
        revision = -1;
        csrfAvailable = false;
        activeScope = null;
        const result = await legacy.createSession(token);
        revision = result.snapshot.revision;
        activeScope = scope(result.snapshot);
        csrfAvailable = true;
        return projection(result.snapshot);
      });
    },
    logout({ currentSession = false } = {}) {
      return withAuthentication(async () => {
        try {
          if (currentSession) {
            legacy.clearSession();
            csrfAvailable = false;
            revision = -1;
            await legacy.getSnapshot();
            csrfAvailable = true;
          }
          if (!csrfAvailable)
            throw failure(
              "CURRENT_SESSION_CONFIRMATION_REQUIRED",
              "请确认退出当前浏览器会话。",
            );
          const value = await legacy.deleteSession();
          clear();
          return value;
        } catch (error) {
          if (error.status === 401 && error.code === "AUTH_REQUIRED") {
            clear();
            return { message: "当前管理会话已失效。" };
          }
          if (
            ["CSRF_REJECTED", "CSRF_REQUIRED", "AUTH_UNCONFIGURED"].includes(
              error.code,
            )
          )
            csrfAvailable = false;
          throw error;
        }
      });
    },
  };
}
