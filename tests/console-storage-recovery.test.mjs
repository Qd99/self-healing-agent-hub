import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHealingService } from "../apps/healing-hub/src/console-service.mjs";

const manager = { id: "admin", name: "Administrator" };
const worker = { id: "private-worker-identity", name: "Worker" };
const taskInput = {
  title: "Repair lint",
  type: "lint-error",
  priority: "high",
};
const monitoring = {
  grafana: { baseUrl: "https://grafana.example.com", dashboardUid: "healing" },
  datasource: { uid: "prometheus" },
  namespaces: ["default"],
};

async function fixture(t) {
  const rootDir = await mkdtemp(join(tmpdir(), "healing-storage-"));
  const dataDir = join(rootDir, "data");
  const filename = join(dataDir, "console-state.json");
  await mkdir(join(rootDir, "configs"));
  await writeFile(
    join(rootDir, "configs/healing-config.json"),
    JSON.stringify({
      project: {
        id: "storage-test",
        repo: "owner/repo",
        defaultBranch: "main",
      },
      engines: { fast: { type: "pull-worker" } },
      triggers: { manual: { enabled: true, requireAuth: true } },
    }),
  );
  await writeFile(
    join(rootDir, "configs/healing-rules.json"),
    JSON.stringify({
      version: "1.0.0",
      rules: [
        {
          id: "lint",
          name: "Lint",
          enabled: true,
          match: { taskType: "lint-error" },
          processor: { engine: "fast", action: "create-pr", priority: "high" },
        },
      ],
    }),
  );
  let time = Date.parse("2026-11-10T12:00:00.000Z");
  const services = [];
  const open = (options = {}) => {
    const service = createHealingService({
      rootDir,
      dataDir,
      clock: () => new Date(time),
      leaseMs: 1000,
      ...options,
    });
    services.push(service);
    return service;
  };
  t.after(async () => {
    await Promise.all(
      services.map((service) => service.close().catch(() => {})),
    );
    await rm(rootDir, { recursive: true, force: true });
  });
  return {
    service: open(),
    open,
    filename,
    advance: (ms) => {
      time += ms;
    },
  };
}

const errorCode = (code) => (error) => error.code === code;
const taskFor = (snapshot, id) =>
  snapshot.tasks.find((entry) => entry.task.id === id);

// Removing per-resource revisions would cause background Worker writes to reject this save.
test("Worker heartbeats and empty claims do not invalidate configuration edits", async (t) => {
  const { service } = await fixture(t);
  const initial = await service.snapshot();
  assert.deepEqual(initial.configRevisions, { rules: 0, monitoring: 0 });
  assert.equal(
    (await service.claim({ engineId: "fast", workerId: "worker-a" }, worker))
      .task,
    null,
  );
  const created = await service.trigger(taskInput, manager);
  const claim = await service.claim(
    { engineId: "fast", workerId: "worker-a" },
    worker,
  );
  await service.heartbeat(created.taskId, { leaseId: claim.lease.id }, worker);
  const saved = await service.saveMonitoring(
    {
      monitoring,
      expectedConfigRevision: 0,
      expectedRevision: initial.revision,
    },
    manager,
  );
  assert.deepEqual(saved.snapshot.configRevisions, { rules: 0, monitoring: 1 });
  const changed = await service.toggleRule(
    "lint",
    { enabled: false, expectedConfigRevision: 0 },
    manager,
  );
  assert.deepEqual(changed.snapshot.configRevisions, {
    rules: 1,
    monitoring: 1,
  });
  assert.equal(changed.snapshot.rules[0].enabled, false);
  assert.ok(changed.snapshot.revision > initial.revision);
});

// Weakening config conflicts or dropping legacy global checks would allow these stale writes.
test("configuration versions reject real stale edits and preserve legacy revision checks", async (t) => {
  const { service } = await fixture(t);
  await service.toggleRule(
    "lint",
    { enabled: false, expectedConfigRevision: 0 },
    manager,
  );
  await assert.rejects(
    service.toggleRule(
      "lint",
      { enabled: true, expectedConfigRevision: 0 },
      manager,
    ),
    errorCode("STATE_CONFLICT"),
  );
  await service.saveMonitoring(
    { monitoring, expectedConfigRevision: 0 },
    manager,
  );
  await assert.rejects(
    service.saveMonitoring({ monitoring, expectedConfigRevision: 0 }, manager),
    errorCode("STATE_CONFLICT"),
  );
  const beforeWorker = await service.snapshot();
  await service.claim({ engineId: "fast", workerId: "worker-a" }, worker);
  await assert.rejects(
    service.toggleRule(
      "lint",
      { enabled: true, expectedRevision: beforeWorker.revision },
      manager,
    ),
    errorCode("STATE_CONFLICT"),
  );
  const current = await service.snapshot();
  const saved = await service.toggleRule(
    "lint",
    { enabled: true, expectedRevision: current.revision },
    manager,
  );
  assert.deepEqual(saved.snapshot.configRevisions, { rules: 2, monitoring: 1 });
  await assert.rejects(
    service.saveMonitoring(
      {
        monitoring,
        expectedConfigRevision: null,
        expectedRevision: saved.snapshot.revision,
      },
      manager,
    ),
    errorCode("INVALID_REQUEST"),
  );
});

// Losing the additive migration would make valid old documents unreadable or reset their history.
test("legacy state gets configuration versions without rewriting or discarding persisted history", async (t) => {
  const { service, open, filename } = await fixture(t);
  const created = await service.trigger(taskInput, manager);
  await service.close();
  const legacy = JSON.parse(await readFile(filename, "utf8"));
  delete legacy.configRevisions;
  await writeFile(filename, JSON.stringify(legacy));
  const before = await readFile(filename, "utf8");
  const reopened = open();
  const migrated = await reopened.snapshot();
  assert.deepEqual(migrated.configRevisions, {
    rules: legacy.revision,
    monitoring: legacy.revision,
  });
  assert.equal(migrated.revision, legacy.revision);
  assert.deepEqual(migrated.tasks, created.snapshot.tasks);
  assert.deepEqual(migrated.activity, legacy.activity);
  assert.equal(await readFile(filename, "utf8"), before);
  await reopened.saveMonitoring(
    { monitoring, expectedConfigRevision: legacy.revision },
    manager,
  );
  await reopened.close();
  assert.deepEqual((await open().snapshot()).configRevisions, {
    rules: legacy.revision,
    monitoring: legacy.revision + 1,
  });
});

// Returning the attempted expiry transaction would invent a committed failure and leak the private lease.
test("full audit history keeps expired tasks readable at their last committed revision", async (t) => {
  const { service, open, filename, advance } = await fixture(t);
  const created = await service.trigger(taskInput, manager);
  const claim = await service.claim(
    { engineId: "fast", workerId: "worker-a" },
    worker,
  );
  const before = await service.snapshot();
  await service.close();
  const stored = JSON.parse(await readFile(filename, "utf8"));
  while (stored.activity.length < 50000)
    stored.activity.push({
      id: randomUUID(),
      at: "2026-11-10T11:00:00.000Z",
      action: "history",
      message: "Retained audit",
      actor: "Administrator",
    });
  await writeFile(filename, JSON.stringify(stored));
  const committed = await readFile(filename, "utf8");
  advance(1001);
  const reopened = open();
  const snapshot = await reopened.snapshot();
  assert.equal(snapshot.storage.status, "read-only");
  assert.equal(snapshot.storage.reason, "STORE_FULL");
  assert.deepEqual(snapshot.storage.usage.activity, {
    used: 50000,
    limit: 50000,
  });
  assert.equal(snapshot.storage.usage.bytes.used, Buffer.byteLength(committed));
  assert.equal(snapshot.revision, stored.revision);
  assert.deepEqual(
    taskFor(snapshot, created.taskId),
    taskFor(before, created.taskId),
  );
  assert.deepEqual(snapshot.activity, stored.activity);
  assert.ok(
    Object.values(snapshot.capabilities).every((value) => value === false),
  );
  assert.equal(JSON.stringify(snapshot).includes(claim.lease.id), false);
  assert.equal(JSON.stringify(snapshot).includes(worker.id), false);
  await assert.rejects(
    reopened.trigger(taskInput, manager),
    errorCode("STORE_FULL"),
  );
  assert.equal((await reopened.snapshot()).revision, stored.revision);
  assert.equal(await readFile(filename, "utf8"), committed);
});

// Rejecting oversized files on startup would prevent recovery/export even though the state is valid.
test("a valid document exceeding the byte capacity remains readable and blocks writes", async (t) => {
  const { service, open, filename } = await fixture(t);
  const created = await service.trigger(taskInput, manager);
  await service.close();
  const committed = await readFile(filename, "utf8");
  const reopened = open({ maxBytes: Buffer.byteLength(committed) - 1 });
  const snapshot = await reopened.snapshot();
  assert.equal(snapshot.storage.status, "read-only");
  assert.equal(snapshot.storage.reason, "STORE_FULL");
  assert.deepEqual(snapshot.tasks, created.snapshot.tasks);
  assert.ok(
    Object.values(snapshot.capabilities).every((value) => value === false),
  );
  await assert.rejects(
    reopened.toggleRule(
      "lint",
      {
        enabled: false,
        expectedConfigRevision: snapshot.configRevisions.rules,
      },
      manager,
    ),
    errorCode("STORE_FULL"),
  );
  assert.equal(await readFile(filename, "utf8"), committed);
});

// A failed rename must not hide the snapshot or expose an uncommitted expired result.
test("expiry persistence errors expose committed data and recover after storage is repaired", async (t) => {
  const { service, filename, advance } = await fixture(t);
  const created = await service.trigger(taskInput, manager);
  const claim = await service.claim(
    { engineId: "fast", workerId: "worker-a" },
    worker,
  );
  const before = await service.snapshot();
  const committed = await readFile(filename, "utf8");
  await rename(filename, `${filename}.backup`);
  await mkdir(filename);
  advance(1001);
  const blocked = await service.snapshot();
  assert.equal(blocked.storage.status, "read-only");
  assert.equal(blocked.storage.reason, "STORE_WRITE_ERROR");
  assert.equal(blocked.revision, before.revision);
  assert.deepEqual(blocked.tasks, before.tasks);
  assert.deepEqual(blocked.activity, before.activity);
  assert.ok(
    Object.values(blocked.capabilities).every((value) => value === false),
  );
  assert.equal(JSON.stringify(blocked).includes(claim.lease.id), false);
  assert.equal(await readFile(`${filename}.backup`, "utf8"), committed);
  await rm(filename, { recursive: true });
  await rename(`${filename}.backup`, filename);
  const recovered = await service.snapshot();
  assert.equal(recovered.storage.status, "ready");
  assert.equal(recovered.storage.reason, null);
  assert.equal(recovered.revision, before.revision + 1);
  assert.equal(taskFor(recovered, created.taskId).status.status, "failed");
  assert.equal(
    taskFor(recovered, created.taskId).result.error.code,
    "LEASE_EXPIRED",
  );
  assert.equal((await service.snapshot()).revision, recovered.revision);
});

// Every advertised capacity limit must also block expiry commits, not just UI controls.
test("full Worker registry blocks background expiry without dropping registry entries", async (t) => {
  const { service, open, filename, advance } = await fixture(t);
  await service.trigger(taskInput, manager);
  await service.claim({ engineId: "fast", workerId: "worker-a" }, worker);
  const before = await service.snapshot();
  await service.close();
  const stored = JSON.parse(await readFile(filename, "utf8"));
  while (stored.workers.length < 1000)
    stored.workers.push({
      workerId: `worker-${stored.workers.length}`,
      engineId: "fast",
      actorId: "registry-owner",
      lastSeenAt: "2026-11-10T11:00:00.000Z",
    });
  await writeFile(filename, JSON.stringify(stored));
  const committed = await readFile(filename, "utf8");
  advance(1001);
  const snapshot = await open().snapshot();
  assert.equal(snapshot.storage.status, "read-only");
  assert.deepEqual(snapshot.storage.usage.workers, { used: 1000, limit: 1000 });
  assert.equal(snapshot.revision, before.revision);
  assert.deepEqual(snapshot.tasks, before.tasks);
  assert.equal(await readFile(filename, "utf8"), committed);
});
