import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  chmod,
  lstat,
} from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
function safe(value) {
  if (value && typeof value === "object")
    for (const [key, v] of Object.entries(value)) {
      if (/^(token|authorization|password|secret)$/i.test(key))
        throw Error("Journal refuses secret fields");
      safe(v);
    }
}
async function writeAtomic(dir, path, value) {
  const tmp = join(dir, `.journal-${randomUUID()}.tmp`);
  const file = await open(tmp, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(tmp, path);
    const d = await open(dir, "r");
    try {
      await d.sync();
    } finally {
      await d.close();
    }
  } finally {
    await unlink(tmp).catch(() => {});
  }
}
export async function openJournal(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if ((await lstat(dir)).isSymbolicLink())
    throw Error("Journal directory cannot be a symlink");
  await chmod(dir, 0o700);
  const lockPath = join(dir, "worker.lock"),
    path = join(dir, "journal.json");
  let lock;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      lock = await open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let old;
      try {
        old = JSON.parse(await readFile(lockPath, "utf8"));
      } catch {
        throw Error("Worker data directory locked");
      }
      if (old.host !== hostname() || !Number.isInteger(old.pid) || old.pid <= 0)
        throw Error("Worker data directory locked");
      try {
        process.kill(old.pid, 0);
        throw Error("Worker data directory locked");
      } catch (e) {
        if (e.code !== "ESRCH") throw Error("Worker data directory locked");
      }
      // Keep a per-incarnation tombstone so a delayed contender cannot unlink a new owner's lock.
      const incarnation = /^[a-f0-9-]{36}$/.test(old.id ?? "")
        ? old.id
        : `legacy-${old.pid}`;
      let reclamation;
      try {
        reclamation = await open(
          join(dir, `.reclaimed-${incarnation}`),
          "wx",
          0o600,
        );
      } catch {
        throw Error("Worker data directory locked during recovery");
      }
      try {
        const current = JSON.parse(await readFile(lockPath, "utf8"));
        if (
          current.pid !== old.pid ||
          current.id !== old.id ||
          current.host !== old.host
        )
          throw Error("Worker data directory locked");
        await unlink(lockPath);
      } finally {
        await reclamation.close();
      }
    }
  }
  if (!lock) throw Error("Worker data directory locked");
  await lock.writeFile(
    JSON.stringify({ pid: process.pid, host: hostname(), id: randomUUID() }),
  );
  await lock.sync();
  let state = { version: 1, records: {} };
  try {
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw Error("Unsafe journal");
      state = JSON.parse(await readFile(path, "utf8"));
      if (
        state.version !== 1 ||
        !state.records ||
        typeof state.records !== "object" ||
        Array.isArray(state.records)
      )
        throw Error("Invalid journal");
      await chmod(path, 0o600);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  } catch (e) {
    await lock.close();
    await unlink(lockPath);
    throw e;
  }
  let closed = false,
    queue = Promise.resolve();
  return {
    get: (id) => structuredClone(state.records[id]),
    list: () =>
      Object.entries(state.records).map(([id, r]) => ({
        id,
        ...structuredClone(r),
      })),
    put(id, value) {
      const action = queue.then(async () => {
        if (closed) throw Error("Journal closed");
        safe(value);
        if (
          typeof id !== "string" ||
          !id ||
          ["__proto__", "constructor", "prototype"].includes(id)
        )
          throw Error("Invalid journal key");
        const next = structuredClone(state);
        next.records[id] = structuredClone(value);
        await writeAtomic(dir, path, next);
        state = next;
      });
      queue = action.catch(() => {});
      return action;
    },
    async close() {
      await queue;
      if (closed) return;
      closed = true;
      await lock.close();
      await unlink(lockPath);
    },
  };
}
