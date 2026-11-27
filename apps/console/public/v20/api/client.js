import { createApiClient, ConsoleApiError } from "../../api-client.js";
import { operations, validateResponse } from "./contract.generated.js";

const failure = (code, message) => new ConsoleApiError(message, { code });
function projection(snapshot) {
  const value = { ...snapshot };
  delete value.csrfToken;
  return value;
}

/** Restricted adapter: it never exposes management credentials or mutation methods to views. */
export function createV20Client({ transport = createApiClient } = {}) {
  const legacy = transport({
    validateResponse({ method, path, data }) {
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
      csrfAvailable = true;
      return accepted;
    },
    login(token) {
      return withAuthentication(async () => {
        revision = -1;
        csrfAvailable = false;
        const result = await legacy.createSession(token);
        revision = result.snapshot.revision;
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
