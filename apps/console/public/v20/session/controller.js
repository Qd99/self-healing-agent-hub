const marker = "heal-v20-logout-pending";
const scope = (s) => JSON.stringify([s?.project?.id, s?.project?.repo]);
const messages = {
  AUTH_REQUIRED: "请使用管理令牌登录。",
  AUTH_UNCONFIGURED: "管理服务未配置会话鉴权，请先在服务端配置管理令牌。",
  NETWORK_ERROR: "连接中断，请检查网络后重试。",
  TIMEOUT: "请求超时，结果尚未确认。",
  INVALID_RESPONSE: "管理服务返回的数据格式不正确。",
  PROJECT_CHANGED: "项目发生变化，请重新登录后读取。",
  CSRF_REJECTED: "当前会话发生变化，请确认退出当前浏览器会话。",
  CURRENT_SESSION_CONFIRMATION_REQUIRED: "请确认退出当前浏览器会话。",
  LOGOUT_PENDING: "上一次退出结果未确认，暂不恢复工作区。",
  STORAGE_UNAVAILABLE: "浏览器存储不可用，请显式登录以建立会话。",
};
function displayError(error) {
  const code = error?.code || "REQUEST_FAILED";
  return { code, message: messages[code] || "请求未完成，请核对后重试。" };
}
function safeSnapshot(snapshot) {
  const value = structuredClone(snapshot);
  delete value.csrfToken;
  return value;
}
function browserStorage() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** Session lifecycle only. API capabilities are injected; views never enter this module. */
export function createSessionController({
  api,
  onChange = () => {},
  now = Date.now,
  storage = browserStorage(),
}) {
  let value = {
    status: "signed-out",
    snapshot: null,
    error: null,
    loadedAt: 0,
  };
  let generation = 0,
    sequence = 0,
    busy = false,
    disposed = false;
  const state = () => structuredClone(value);
  const emit = (change) => {
    if (disposed) return;
    value = { ...value, ...change };
    onChange(state());
  };
  const current = (g, n) => !disposed && generation === g && sequence === n;
  const invalidate = () => {
    generation++;
    sequence++;
    api.invalidateReads();
  };
  const clearMarker = () => {
    try {
      storage?.removeItem(marker);
    } catch {
      /* Server acknowledgement remains authoritative. */
    }
  };
  const adopt = (next) => {
    if (next.auth?.required !== true)
      throw Object.assign(new Error(), { code: "AUTH_UNCONFIGURED" });
    emit({
      status: "ready",
      snapshot: safeSnapshot(next),
      error: null,
      loadedAt: now(),
    });
  };
  const deny = (error) => {
    invalidate();
    api.clear();
    emit({
      status: error?.code === "AUTH_UNCONFIGURED" ? "blocked" : "signed-out",
      snapshot: null,
      error: displayError(error),
      loadedAt: 0,
    });
  };
  async function load() {
    if (disposed || busy || ["blocked", "logging-out"].includes(value.status))
      return;
    const g = generation,
      n = ++sequence,
      before = value.snapshot;
    let changedProject = false;
    emit({ status: "loading", error: null });
    const acceptable = (next) => {
      if (before && scope(next) !== scope(before)) changedProject = true;
      return (
        current(g, n) &&
        !changedProject &&
        (!before || next.revision >= before.revision)
      );
    };
    try {
      const next = await api.read({ acceptSnapshot: acceptable });
      if (!current(g, n)) return;
      if (before && scope(next) !== scope(before)) changedProject = true;
      if (changedProject) return deny({ code: "PROJECT_CHANGED" });
      if (!acceptable(next)) {
        emit({ status: before ? "ready" : "signed-out" });
        return;
      }
      adopt(next);
    } catch (error) {
      if (!current(g, n)) return;
      if (changedProject) return deny({ code: "PROJECT_CHANGED" });
      if (error.code === "STALE_RESPONSE") {
        emit({ status: before ? "ready" : "signed-out" });
        return;
      }
      if (
        [401, 403].includes(error.status) ||
        error.code === "AUTH_UNCONFIGURED"
      )
        return deny(error);
      emit({
        status: before ? "stale" : "signed-out",
        snapshot: before,
        error: displayError(error),
      });
    }
  }
  return {
    state,
    async execute(action, options) {
      if (
        disposed ||
        busy ||
        value.status !== "ready" ||
        !value.snapshot ||
        value.snapshot.storage.status !== "ready"
      )
        return null;
      busy = true;
      invalidate();
      const g = generation;
      const before = value.snapshot;
      emit({ writePending: true });
      try {
        const result = await api.mutateExisting(action, options);
        if (disposed || g !== generation) return null;
        if (result.snapshot) {
          if (scope(result.snapshot) !== scope(before))
            throw Object.assign(new Error(), { code: "PROJECT_CHANGED" });
          if (result.snapshot.revision < before.revision)
            throw Object.assign(new Error(), { code: "STALE_RESPONSE" });
          adopt(result.snapshot);
        }
        return result;
      } catch (error) {
        if (disposed || g !== generation) return null;
        if (
          error.status === 401 ||
          ["AUTH_REQUIRED", "AUTH_UNCONFIGURED", "PROJECT_CHANGED"].includes(
            error.code,
          )
        ) {
          deny(error);
        } else if (
          error.status === 409 ||
          error.status >= 500 ||
          [
            "CSRF_REJECTED",
            "CSRF_REQUIRED",
            "TIMEOUT",
            "NETWORK_ERROR",
            "INVALID_RESPONSE",
            "STALE_RESPONSE",
          ].includes(error.code)
        ) {
          emit({
            status: "stale",
            error: {
              code: error.code,
              message:
                error.status === 409
                  ? "任务或配置已变更，请刷新核对。"
                  : "上一次写入的状态需要核对，刷新后再决定是否重试。",
            },
          });
        }
        throw error;
      } finally {
        busy = false;
        emit({ writePending: false });
      }
    },
    async refresh() {
      if (value.snapshot) await load();
    },
    async start() {
      if (disposed || busy || value.status === "blocked") return;
      try {
        if (!storage) throw new Error("Storage unavailable");
        if (storage.getItem(marker)) {
          emit({
            status: "blocked",
            snapshot: null,
            error: displayError({ code: "LOGOUT_PENDING" }),
          });
          return;
        }
        // Reading storage alone does not establish that a future logout marker can be written.
        storage.setItem(`${marker}-probe`, "1");
        storage.removeItem(`${marker}-probe`);
      } catch {
        emit({
          status: "signed-out",
          snapshot: null,
          error: displayError({ code: "STORAGE_UNAVAILABLE" }),
        });
        return;
      }
      await load();
    },
    async login(token) {
      if (disposed || busy || value.status === "blocked") return;
      if (typeof token !== "string" || !token.trim()) {
        emit({
          status: "signed-out",
          error: displayError({ code: "AUTH_REQUIRED" }),
        });
        return;
      }
      busy = true;
      invalidate();
      const g = generation;
      emit({ status: "loading", snapshot: null, error: null, loadedAt: 0 });
      try {
        const next = await api.login(token);
        if (!disposed && g === generation) {
          clearMarker();
          adopt(next);
        }
      } catch (error) {
        if (!disposed && g === generation) deny(error);
      } finally {
        busy = false;
      }
    },
    async logout({ currentSession = false } = {}) {
      if (disposed || busy || value.error?.code === "AUTH_UNCONFIGURED") return;
      busy = true;
      invalidate();
      const g = generation;
      try {
        storage?.setItem(marker, "1");
      } catch {
        /* Keep the in-memory blocked state. */
      }
      emit({ status: "logging-out", snapshot: null, error: null, loadedAt: 0 });
      try {
        await api.logout({ currentSession });
        if (!disposed && g === generation) {
          api.clear();
          clearMarker();
          emit({
            status: "signed-out",
            snapshot: null,
            error: null,
            loadedAt: 0,
          });
        }
      } catch (error) {
        if (!disposed && g === generation)
          emit({
            status: "blocked",
            snapshot: null,
            error: displayError(error),
            loadedAt: 0,
          });
      } finally {
        busy = false;
      }
    },
    dispose() {
      if (!disposed) {
        invalidate();
        disposed = true;
      }
    },
  };
}
