import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

export class HealingError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const failure = (code, message) => new HealingError(503, code, message);

/** One process owns the file until close(); every mutation commits as one document. */
export function createConsoleStore({
  dataDir,
  initialState,
  validate,
  maxBytes = 32 * 1024 * 1024,
}) {
  const directory = resolve(dataDir);
  const filename = join(directory, "console-state.json");
  const lockPath = join(directory, "console-state.lock");
  const owner = randomUUID();
  let lock;
  let state;
  let initialization;
  let queue = Promise.resolve();
  let closing = false;
  let closePromise;

  async function releaseLock() {
    if (!lock) return;
    const held = lock;
    lock = undefined;
    try {
      const metadata = JSON.parse(await readFile(lockPath, "utf8"));
      if (metadata.owner === owner) await unlink(lockPath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        await held.close();
        throw failure("STORE_CLOSE_ERROR", "无法释放状态文件锁。");
      }
    }
    await held.close();
  }

  async function initialize() {
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      try {
        lock = await open(lockPath, "wx", 0o600);
      } catch (error) {
        if (error.code === "EEXIST")
          throw failure(
            "STORE_LOCKED",
            "状态目录已被其他服务锁定。若上次进程异常退出，请确认其已停止后再移除锁文件。",
          );
        throw error;
      }
      await lock.writeFile(JSON.stringify({ owner, pid: process.pid }));
      await lock.sync();
      let contents;
      try {
        const info = await lstat(filename);
        if (!info.isFile() || info.size > maxBytes)
          throw failure("STORE_INVALID", "持久状态无效或超过大小限制。");
        contents = await readFile(filename, "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      try {
        state =
          contents === undefined
            ? structuredClone(initialState)
            : JSON.parse(contents);
        validate(state);
      } catch {
        throw failure(
          "STORE_INVALID",
          "持久状态无效，请恢复或修复后再启动服务。",
        );
      }
    } catch (error) {
      await releaseLock().catch(() => {});
      if (error instanceof HealingError) throw error;
      throw failure("STORE_READ_ERROR", "无法打开持久状态文件。");
    }
  }

  function ready() {
    initialization ||= initialize();
    return initialization;
  }

  async function persist(next) {
    let temporary;
    let file;
    try {
      validate(next);
      const body = JSON.stringify(next);
      if (Buffer.byteLength(body) > maxBytes)
        throw failure("STORE_FULL", "持久状态已达到大小上限。");
      temporary = join(directory, `.console-state-${randomUUID()}.tmp`);
      file = await open(temporary, "wx", 0o600);
      await file.writeFile(body, "utf8");
      await file.sync();
      await file.close();
      file = undefined;
      await rename(temporary, filename);
      temporary = undefined;
      // Rename is the commit point. A later directory-sync failure must never
      // make memory disagree with the document that was already committed.
      state = next;
      let directoryHandle;
      try {
        directoryHandle = await open(directory, "r");
        await directoryHandle.sync();
      } catch {
        // Some supported filesystems do not permit syncing directory handles.
      } finally {
        await directoryHandle?.close().catch(() => {});
      }
    } catch (error) {
      await file?.close().catch(() => {});
      if (temporary) await unlink(temporary).catch(() => {});
      if (error instanceof HealingError) throw error;
      throw failure("STORE_WRITE_ERROR", "无法保存此次变更，原有状态已保留。");
    }
  }

  function serialize(operation) {
    if (closing)
      return Promise.reject(failure("STORE_CLOSED", "管理服务已关闭。"));
    const pending = queue.then(async () => {
      await ready();
      return operation();
    });
    queue = pending.catch(() => {});
    return pending;
  }

  return {
    read: () => serialize(() => structuredClone(state)),
    transact: (operation) =>
      serialize(async () => {
        const next = structuredClone(state);
        const outcome = await operation(next);
        if (outcome?.changed) {
          next.revision = state.revision + 1;
          await persist(next);
        }
        return { state: structuredClone(state), value: outcome?.value };
      }),
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = queue.then(async () => {
        if (initialization) await initialization.catch(() => {});
        await releaseLock();
      });
      return closePromise;
    },
  };
}
