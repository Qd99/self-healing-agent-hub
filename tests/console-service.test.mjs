import assert from "node:assert/strict";
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

const manager = { id: "local-admin", name: "Local administrator" };
const worker = { id: "worker-key-a", name: "Build worker" };
const config = {
  project: {
    id: "service-test",
    repo: "owner/service-test",
    defaultBranch: "main",
  },
  engines: { fast: { type: "pull-worker" }, complex: { type: "pull-worker" } },
  safety: {
    maxFilesPerFix: 3,
    protectedPaths: ["deploy/", "*.env", ".github/workflows/"],
    requiredChecks: ["npm test"],
  },
  triggers: { manual: { enabled: true, requireAuth: true } },
};
const rules = {
  version: "1.0.0",
  rules: [
    {
      id: "lint",
      name: "Lint repair",
      enabled: true,
      match: { taskType: "lint-error", "context.retryCount": { $lt: 3 } },
      processor: { engine: "fast", action: "create-pr", priority: "high" },
    },
    {
      id: "tests",
      name: "Test repair",
      enabled: true,
      match: { taskType: "unit-test-failure" },
      processor: { engine: "complex", action: "create-pr", priority: "medium" },
    },
  ],
};
const input = {
  title: "Repair a lint failure",
  type: "lint-error",
  priority: "high",
  description: "Observed actual check failure",
  branch: "main",
};
const evidence = {
  testsRun: ["npm test"],
  checksPass: ["npm test"],
  checksFail: [],
  beforeState: { commitSha: "a".repeat(40) },
  afterState: { summary: "Candidate passed required checks" },
};
const proposed = {
  summary: "Correct the observed lint failure",
  diff: [
    {
      path: "src/example.js",
      additions: 1,
      deletions: 1,
      lines: [
        { type: "remove", content: "const old = 1;" },
        { type: "add", content: "const current = 1;" },
      ],
    },
  ],
  evidence,
};
const completed = {
  success: true,
  action: "pr-created",
  changes: { files: ["src/example.js"], pr: 42 },
  logs: ["Created review pull request"],
  evidence,
};

async function factory() {
  const module =
    await import("../apps/healing-hub/src/console-service.mjs").catch(
      () => null,
    );
  assert.equal(
    typeof module?.createHealingService,
    "function",
    "the durable service factory must be implemented",
  );
  return module.createHealingService;
}

async function fixture(t) {
  const createHealingService = await factory();
  const rootDir = await mkdtemp(join(tmpdir(), "healing-service-"));
  const dataDir = join(rootDir, "data");
  await mkdir(join(rootDir, "configs"));
  await writeFile(
    join(rootDir, "configs/healing-config.json"),
    JSON.stringify(config),
  );
  await writeFile(
    join(rootDir, "configs/healing-rules.json"),
    JSON.stringify(rules),
  );
  let time = Date.parse("2026-11-10T12:00:00.000Z");
  const services = [];
  const open = () => {
    const service = createHealingService({
      rootDir,
      dataDir,
      clock: () => new Date(time),
      leaseMs: 1000,
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
    rootDir,
    dataDir,
    advance: (ms) => {
      time += ms;
    },
  };
}

const entry = (snapshot, id) =>
  snapshot.tasks.find((item) => item.task.id === id);
const errorCode = (code) => (error) => error.code === code;

async function createAndClaim(service) {
  const created = await service.trigger(input, manager);
  const claim = await service.claim(
    { engineId: "fast", workerId: "worker-a" },
    worker,
  );
  assert.equal(claim.task.task.id, created.taskId);
  assert.equal(claim.lease.phase, "diagnose");
  return { id: created.taskId, claim };
}

async function approveBoth(service, id) {
  for (const nodeId of ["code-review", "execution-auth"]) {
    const task = entry(await service.snapshot(), id);
    await service.decide(
      id,
      {
        decision: "approve",
        nodeId,
        round: task.approvalFlow.round,
        expectedRevision: task.revision,
        comment: "Reviewed candidate and evidence",
      },
      manager,
    );
  }
}

test("created tasks and server-authored audit survive a service restart", async (t) => {
  const { service, open } = await fixture(t);
  const initial = await service.snapshot();
  assert.deepEqual(initial.tasks, []);
  assert.deepEqual(initial.activity, []);
  const response = await service.trigger(
    { ...input, actor: "spoofed", demo: true },
    manager,
  );
  assert.equal(response.snapshot.mode, "live");
  assert.equal(response.snapshot.revision, initial.revision + 1);
  const task = entry(response.snapshot, response.taskId);
  assert.match(task.task.id, /^[0-9a-f-]{36}$/);
  assert.equal(task.revision, 1);
  assert.equal(task.status.status, "pending");
  assert.equal(task.task.payload.repo, "owner/service-test");
  assert.equal(task.task.payload.context.demo, undefined);
  assert.equal(response.snapshot.activity[0].actor, "Local administrator");
  await service.close();
  const restored = await open().snapshot();
  assert.deepEqual(restored.tasks, response.snapshot.tasks);
  assert.deepEqual(restored.activity, response.snapshot.activity);
  assert.equal(restored.revision, response.snapshot.revision);
  assert.equal(
    (
      await open()
        .snapshot()
        .catch((error) => error)
    ).code,
    "STORE_LOCKED",
  );
});

test("concurrent claims grant one lease and browser snapshots never disclose its secret", async (t) => {
  const { service } = await fixture(t);
  const created = await service.trigger(input, manager);
  const claims = await Promise.all(
    ["worker-a", "worker-b"].map((workerId) =>
      service.claim({ engineId: "fast", workerId }, worker),
    ),
  );
  const granted = claims.filter((claim) => claim.task);
  assert.equal(granted.length, 1);
  assert.equal(granted[0].task.task.id, created.taskId);
  const snapshot = await service.snapshot();
  assert.equal(entry(snapshot, created.taskId).status.status, "running");
  assert.ok(!JSON.stringify(snapshot).includes(granted[0].lease.id));
  const revision = snapshot.revision;
  assert.equal((await service.snapshot()).revision, revision);
});

test("task revision conflicts serialize simultaneous cancellation without duplicate audit", async (t) => {
  const { service } = await fixture(t);
  const created = await service.trigger(input, manager);
  const attempts = await Promise.allSettled(
    [1, 2].map(() =>
      service.taskAction(
        created.taskId,
        "cancel",
        { expectedRevision: 1 },
        manager,
      ),
    ),
  );
  assert.equal(
    attempts.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const failure = attempts.find(
    (result) => result.status === "rejected",
  ).reason;
  assert.equal(failure.status, 409);
  const snapshot = await service.snapshot();
  assert.equal(
    snapshot.activity.filter((event) => event.action === "cancel").length,
    1,
  );
  assert.equal(entry(snapshot, created.taskId).status.status, "cancelled");
});

test("a real proposal requires evidence and unprotected paths before two ordered approvals permit execution", async (t) => {
  const { service } = await fixture(t);
  const { id, claim } = await createAndClaim(service);
  for (const invalid of [
    { ...proposed, evidence: { testsRun: [], checksPass: [], checksFail: [] } },
    {
      ...proposed,
      diff: [{ ...proposed.diff[0], path: "deploy/production.yml" }],
    },
    { ...proposed, diff: [{ ...proposed.diff[0], path: "nested/secret.env" }] },
    { ...proposed, diff: [{ ...proposed.diff[0], path: "../outside.js" }] },
  ]) {
    await assert.rejects(
      service.proposal(id, { leaseId: claim.lease.id, ...invalid }, worker),
      (error) => error.status === 400 || error.status === 422,
    );
  }
  assert.equal(entry(await service.snapshot(), id).revision, 2);
  const proposal = await service.proposal(
    id,
    { leaseId: claim.lease.id, ...proposed },
    worker,
  );
  let task = entry(proposal.snapshot, id);
  assert.equal(task.reviewState, "pending");
  assert.equal(task.approvalFlow.source, "server");
  assert.equal(task.result, undefined);
  assert.deepEqual(task.evidence.checksPass, ["npm test"]);
  await assert.rejects(
    service.decide(
      id,
      {
        decision: "approve",
        nodeId: "execution-auth",
        round: 1,
        expectedRevision: task.revision,
      },
      manager,
    ),
    (error) => error.status === 409,
  );
  assert.equal(
    (await service.claim({ engineId: "fast", workerId: "worker-a" }, worker))
      .task,
    null,
  );
  await approveBoth(service, id);
  const execute = await service.claim(
    { engineId: "fast", workerId: "worker-a" },
    worker,
  );
  assert.equal(execute.lease.phase, "execute");
  assert.deepEqual(execute.task.diff, proposed.diff);
  const done = await service.complete(
    id,
    { leaseId: execute.lease.id, result: completed },
    worker,
  );
  task = entry(done.snapshot, id);
  assert.equal(task.status.status, "completed");
  assert.equal(task.result.changes.pr, 42);
  assert.equal(task.execution.phase, "done");
  await assert.rejects(
    service.complete(
      id,
      { leaseId: execute.lease.id, result: completed },
      worker,
    ),
    (error) => error.status === 409,
  );
});

test("diagnosis cannot report a successful code change and unauthorized workers cannot report", async (t) => {
  const { service } = await fixture(t);
  const { id, claim } = await createAndClaim(service);
  await assert.rejects(
    service.complete(
      id,
      { leaseId: claim.lease.id, result: completed },
      worker,
    ),
    (error) => error.status === 409,
  );
  await assert.rejects(
    service.proposal(
      id,
      { leaseId: claim.lease.id, ...proposed },
      { id: "other-key", name: "Other worker" },
    ),
    (error) => error.status === 409,
  );
  assert.equal(entry(await service.snapshot(), id).status.status, "running");
});

test("cancellation of running work is a request until worker acknowledgement and rejects late completion", async (t) => {
  const { service } = await fixture(t);
  const { id, claim } = await createAndClaim(service);
  const response = await service.taskAction(
    id,
    "cancel",
    { expectedRevision: 2 },
    manager,
  );
  assert.equal(entry(response.snapshot, id).status.status, "running");
  assert.equal(entry(response.snapshot, id).execution.cancelRequested, true);
  const heartbeat = await service.heartbeat(
    id,
    { leaseId: claim.lease.id },
    worker,
  );
  assert.equal(heartbeat.cancelRequested, true);
  await assert.rejects(
    service.complete(
      id,
      {
        leaseId: claim.lease.id,
        result: { success: false, action: "failed", logs: [], evidence },
      },
      worker,
    ),
    (error) => error.status === 409,
  );
  const acknowledged = await service.acknowledgeCancellation(
    id,
    { leaseId: claim.lease.id },
    worker,
  );
  assert.equal(entry(acknowledged.snapshot, id).status.status, "cancelled");
  await assert.rejects(
    service.proposal(id, { leaseId: claim.lease.id, ...proposed }, worker),
    (error) => error.status === 409,
  );
});

test("expired leases become failed once and cannot be reclaimed or completed", async (t) => {
  const { service, advance } = await fixture(t);
  const { id, claim } = await createAndClaim(service);
  advance(1001);
  const expired = await service.snapshot();
  assert.equal(entry(expired, id).status.status, "failed");
  assert.equal(entry(expired, id).result.error.code, "LEASE_EXPIRED");
  assert.equal((await service.snapshot()).revision, expired.revision);
  assert.equal(
    (await service.claim({ engineId: "fast", workerId: "worker-a" }, worker))
      .task,
    null,
  );
  await assert.rejects(
    service.heartbeat(id, { leaseId: claim.lease.id }, worker),
    (error) => error.status === 409,
  );
  const retried = await service.taskAction(
    id,
    "retry",
    { expectedRevision: entry(await service.snapshot(), id).revision },
    manager,
  );
  assert.notEqual(retried.taskId, id);
  assert.equal(
    entry(retried.snapshot, retried.taskId).task.payload.context.retryOf,
    id,
  );
  assert.equal(entry(retried.snapshot, id).status.status, "failed");
});

test("rule overrides persist and disabled rules are not used by trigger or retry", async (t) => {
  const { service, open } = await fixture(t);
  const created = await service.trigger(input, manager);
  const cancelled = await service.taskAction(
    created.taskId,
    "cancel",
    { expectedRevision: 1 },
    manager,
  );
  const updated = await service.toggleRule(
    "lint",
    { enabled: false, expectedRevision: cancelled.snapshot.revision },
    manager,
  );
  assert.equal(
    updated.snapshot.rules.find((rule) => rule.id === "lint").enabled,
    false,
  );
  await assert.rejects(
    service.trigger(input, manager),
    errorCode("NO_MATCHING_RULE"),
  );
  await assert.rejects(
    service.taskAction(
      created.taskId,
      "retry",
      { expectedRevision: 2 },
      manager,
    ),
    errorCode("NO_MATCHING_RULE"),
  );
  await service.close();
  assert.equal(
    (await open().snapshot()).rules.find((rule) => rule.id === "lint").enabled,
    false,
  );
});

test("monitoring saves validated public fields with global conflict protection", async (t) => {
  const { service, open } = await fixture(t);
  const snapshot = await service.snapshot();
  const monitoring = {
    grafana: {
      baseUrl: "https://grafana.example.com",
      dashboardUid: "healing",
      token: "NEVER-STORE",
    },
    datasource: {
      uid: "prom-main",
      name: "Prometheus",
      password: "NEVER-STORE",
    },
    namespaces: ["production"],
    token: "NEVER-STORE",
  };
  const saved = await service.saveMonitoring(
    { monitoring, expectedRevision: snapshot.revision },
    manager,
  );
  assert.equal(saved.snapshot.monitoring.status, "ready");
  assert.equal(saved.snapshot.monitoring.connectivity, "unverified");
  assert.ok(!JSON.stringify(saved).includes("NEVER-STORE"));
  await assert.rejects(
    service.saveMonitoring(
      { monitoring, expectedRevision: snapshot.revision },
      manager,
    ),
    (error) => error.status === 409,
  );
  await service.close();
  assert.deepEqual((await open().snapshot()).monitoring.namespaces, [
    "production",
  ]);
});

test("bulk cancellation reports partial success without changing stale records", async (t) => {
  const { service } = await fixture(t);
  const first = await service.trigger(input, manager);
  const second = await service.trigger(input, manager);
  const response = await service.bulk(
    {
      type: "cancel",
      items: [
        { id: first.taskId, revision: 1 },
        { id: second.taskId, revision: 0 },
      ],
    },
    manager,
  );
  assert.equal(response.report.applied.length, 1);
  assert.equal(response.report.applied[0].id, first.taskId);
  assert.equal(response.report.skipped.length, 1);
  assert.equal(
    entry(response.snapshot, second.taskId).status.status,
    "pending",
  );
});

test("rejection and resubmission preserve history and stale rounds cannot approve", async (t) => {
  const { service } = await fixture(t);
  const { id, claim } = await createAndClaim(service);
  const proposal = await service.proposal(
    id,
    { leaseId: claim.lease.id, ...proposed },
    worker,
  );
  const rejected = await service.decide(
    id,
    {
      decision: "reject",
      nodeId: "code-review",
      round: 1,
      comment: "Needs another review",
      expectedRevision: entry(proposal.snapshot, id).revision,
    },
    manager,
  );
  assert.equal(entry(rejected.snapshot, id).status.status, "cancelled");
  const resubmitted = await service.decide(
    id,
    {
      decision: "resubmit",
      round: 1,
      comment: "Request review of the same candidate",
      expectedRevision: entry(rejected.snapshot, id).revision,
    },
    manager,
  );
  const task = entry(resubmitted.snapshot, id);
  assert.equal(task.approvalFlow.round, 2);
  assert.equal(
    task.approvalFlow.history.filter((event) => event.decision === "rejected")
      .length,
    1,
  );
  await assert.rejects(
    service.decide(
      id,
      {
        decision: "approve",
        nodeId: "code-review",
        round: 1,
        expectedRevision: task.revision,
      },
      manager,
    ),
    (error) => error.status === 409,
  );
});

test("failed atomic replacement does not publish an in-memory task or overwrite stored tasks", async (t) => {
  const { service, dataDir } = await fixture(t);
  const existing = await service.trigger(input, manager);
  const filename = join(dataDir, "console-state.json");
  const backup = join(dataDir, "saved-state.json");
  await rename(filename, backup);
  await mkdir(filename);
  await assert.rejects(
    service.trigger(input, manager),
    errorCode("STORE_WRITE_ERROR"),
  );
  assert.deepEqual((await service.snapshot()).tasks, existing.snapshot.tasks);
  await rm(filename, { recursive: true });
  await rename(backup, filename);
  assert.equal(JSON.parse(await readFile(filename, "utf8")).tasks.length, 1);
  assert.equal(
    (await service.trigger(input, manager)).snapshot.tasks.length,
    2,
  );
});

test("corrupt persisted state fails explicitly instead of resetting", async (t) => {
  const { service, open, dataDir } = await fixture(t);
  await service.trigger(input, manager);
  await service.close();
  await writeFile(
    join(dataDir, "console-state.json"),
    '{"schemaVersion":1,"tasks":[]',
  );
  await assert.rejects(open().snapshot(), errorCode("STORE_INVALID"));
});

test("creation request IDs survive restart and reject reuse with different input", async (t) => {
  const { service, open } = await fixture(t);
  const request = { ...input, requestId: "trigger-lost-response" };
  const created = await service.trigger(request, manager);
  const duplicate = await service.trigger(
    { requestId: request.requestId, ...input },
    manager,
  );
  assert.equal(duplicate.taskId, created.taskId);
  assert.equal(duplicate.snapshot.revision, created.snapshot.revision);
  await assert.rejects(
    service.trigger({ ...request, title: "Different work" }, manager),
    (error) => error.status === 409,
  );
  await service.close();
  const restored = await open().trigger(request, manager);
  assert.equal(restored.taskId, created.taskId);
  assert.equal(restored.snapshot.tasks.length, 1);
});

test("retry request IDs return the original new task and source revisions prevent duplicate retries", async (t) => {
  const { service } = await fixture(t);
  const created = await service.trigger(input, manager);
  await service.taskAction(
    created.taskId,
    "cancel",
    { expectedRevision: 1 },
    manager,
  );
  const request = { expectedRevision: 2, requestId: "retry-lost-response" };
  const retried = await service.taskAction(
    created.taskId,
    "retry",
    request,
    manager,
  );
  const replayed = await service.taskAction(
    created.taskId,
    "retry",
    request,
    manager,
  );
  assert.equal(replayed.taskId, retried.taskId);
  assert.equal(replayed.snapshot.tasks.length, 2);
  assert.equal(entry(replayed.snapshot, created.taskId).revision, 3);
  await assert.rejects(
    service.taskAction(
      created.taskId,
      "retry",
      { expectedRevision: 2 },
      manager,
    ),
    (error) => error.status === 409,
  );
});

test("bulk retry replay preserves its original per-item result", async (t) => {
  const { service } = await fixture(t);
  const created = await service.trigger(input, manager);
  await service.taskAction(
    created.taskId,
    "cancel",
    { expectedRevision: 1 },
    manager,
  );
  const request = {
    type: "retry",
    requestId: "bulk-lost-response",
    items: [{ id: created.taskId, revision: 2 }],
  };
  const first = await service.bulk(request, manager);
  const replay = await service.bulk(request, manager);
  assert.deepEqual(replay.report, first.report);
  assert.equal(replay.snapshot.tasks.length, 2);
});

test("successful execution must match the authorized routing action", async (t) => {
  const { service } = await fixture(t);
  const { id, claim } = await createAndClaim(service);
  await service.proposal(id, { leaseId: claim.lease.id, ...proposed }, worker);
  await approveBoth(service, id);
  const execute = await service.claim(
    { engineId: "fast", workerId: "worker-a" },
    worker,
  );
  await assert.rejects(
    service.complete(
      id,
      {
        leaseId: execute.lease.id,
        result: {
          ...completed,
          action: "committed",
          changes: { files: ["src/example.js"], commit: "b".repeat(40) },
        },
      },
      worker,
    ),
    (error) => error.status === 422,
  );
  assert.equal(entry(await service.snapshot(), id).status.status, "running");
});

test("an empty required-check configuration still cannot manufacture quality evidence", async (t) => {
  const { service, rootDir } = await fixture(t);
  await writeFile(
    join(rootDir, "configs/healing-config.json"),
    JSON.stringify({
      ...config,
      safety: { ...config.safety, requiredChecks: [] },
    }),
  );
  const { id, claim } = await createAndClaim(service);
  await assert.rejects(
    service.proposal(
      id,
      {
        ...proposed,
        leaseId: claim.lease.id,
        evidence: { testsRun: [], checksPass: [], checksFail: [] },
      },
      worker,
    ),
    errorCode("EVIDENCE_REQUIRED"),
  );
  assert.equal(entry(await service.snapshot(), id).approvalFlow, undefined);
});

test("persisted candidate tampering is rejected before an execution claim", async (t) => {
  const { service, open, dataDir } = await fixture(t);
  const { id, claim } = await createAndClaim(service);
  await service.proposal(id, { leaseId: claim.lease.id, ...proposed }, worker);
  await approveBoth(service, id);
  await service.close();
  const filename = join(dataDir, "console-state.json");
  const state = JSON.parse(await readFile(filename, "utf8"));
  state.tasks[0].diff[0].lines[1].content = "unreviewed change";
  await writeFile(filename, JSON.stringify(state));
  await assert.rejects(
    open().claim({ engineId: "fast", workerId: "worker-a" }, worker),
    errorCode("STORE_INVALID"),
  );
});

test("code completion requires the exact unique approved file set", async (t) => {
  const { service } = await fixture(t);
  const { id, claim } = await createAndClaim(service);
  const diff = ["src/a.js", "src/b.js"].map((path) => ({
    ...proposed.diff[0],
    path,
  }));
  await service.proposal(
    id,
    { ...proposed, diff, leaseId: claim.lease.id },
    worker,
  );
  await approveBoth(service, id);
  const execute = await service.claim(
    { engineId: "fast", workerId: "worker-a" },
    worker,
  );
  await assert.rejects(
    service.complete(
      id,
      {
        leaseId: execute.lease.id,
        result: {
          ...completed,
          changes: { files: ["src/a.js", "src/a.js"], pr: 42 },
        },
      },
      worker,
    ),
    errorCode("UNAPPROVED_CHANGE"),
  );
  assert.equal(entry(await service.snapshot(), id).status.status, "running");
  const result = await service.complete(
    id,
    {
      leaseId: execute.lease.id,
      result: {
        ...completed,
        changes: { files: ["src/b.js", "src/a.js"], pr: 42 },
      },
    },
    worker,
  );
  assert.equal(entry(result.snapshot, id).status.status, "completed");
});

for (const phase of ["diagnose", "execute"]) {
  test(`successful skipped results in ${phase} cannot contain external artifacts`, async (t) => {
    const { service } = await fixture(t);
    const { id, claim } = await createAndClaim(service);
    let lease = claim.lease;
    if (phase === "execute") {
      await service.proposal(id, { ...proposed, leaseId: lease.id }, worker);
      await approveBoth(service, id);
      lease = (
        await service.claim({ engineId: "fast", workerId: "worker-a" }, worker)
      ).lease;
    }
    for (const changes of [
      { files: [], commit: "b".repeat(40) },
      { files: [], pr: 42 },
      { files: [], issue: 43 },
      { files: ["src/example.js"] },
    ]) {
      await assert.rejects(
        service.complete(
          id,
          {
            leaseId: lease.id,
            result: {
              success: true,
              action: "skipped",
              changes,
              logs: [],
              evidence,
            },
          },
          worker,
        ),
        errorCode("UNAPPROVED_CHANGE"),
      );
    }
    const skipped = await service.complete(
      id,
      {
        leaseId: lease.id,
        result: { success: true, action: "skipped", logs: [], evidence },
      },
      worker,
    );
    assert.equal(entry(skipped.snapshot, id).status.status, "skipped");
    assert.equal(entry(skipped.snapshot, id).result.changes, undefined);
  });
}

test("failure reports preserve partial external effects for inspection", async (t) => {
  const { service } = await fixture(t);
  const { id, claim } = await createAndClaim(service);
  const changes = {
    files: ["src/unexpected.js"],
    commit: "b".repeat(40),
    pr: 42,
  };
  const result = await service.complete(
    id,
    {
      leaseId: claim.lease.id,
      result: {
        success: false,
        action: "failed",
        changes,
        logs: ["Unexpected partial changes must be inspected"],
        evidence: {
          testsRun: ["diagnose"],
          checksPass: [],
          checksFail: ["diagnose"],
        },
      },
    },
    worker,
  );
  assert.equal(entry(result.snapshot, id).status.status, "failed");
  assert.deepEqual(entry(result.snapshot, id).result.changes, changes);
});

async function actionFixture(t, action) {
  const setup = await fixture(t);
  const type = action === "retry" ? "ci-failure" : "architecture-violation";
  await writeFile(
    join(setup.rootDir, "configs/healing-rules.json"),
    JSON.stringify({
      version: "1.0.0",
      rules: [
        {
          ...rules.rules[0],
          match: { taskType: type },
          processor: { ...rules.rules[0].processor, action },
        },
      ],
    }),
  );
  const created = await setup.service.trigger({ ...input, type }, manager);
  const claim = await setup.service.claim(
    { engineId: "fast", workerId: "worker-a" },
    worker,
  );
  return { ...setup, id: created.taskId, claim };
}

const diagnosticEvidence = {
  testsRun: ["inspect CI failure"],
  checksPass: [],
  checksFail: ["inspect CI failure"],
  beforeState: { summary: "An actual failed workflow was inspected" },
  afterState: { summary: "No repository files were changed" },
};

for (const action of ["create-issue", "retry"]) {
  const resultAction = action === "create-issue" ? "issue-created" : "retry";
  test(`${action} executes an evidence-backed action after both approvals without invented code changes`, async (t) => {
    const { service, id, claim } = await actionFixture(t, action);
    const result = {
      success: true,
      action: resultAction,
      ...(action === "create-issue"
        ? { changes: { files: [], issue: 43 } }
        : {}),
      logs: ["Authorized action completed"],
      evidence: diagnosticEvidence,
    };
    await assert.rejects(
      service.complete(id, { leaseId: claim.lease.id, result }, worker),
      (error) => error.status === 409,
    );
    const response = await service.proposal(
      id,
      {
        leaseId: claim.lease.id,
        kind: "code-change",
        summary: "Address the observed failure without changing source files",
        diff: [],
        evidence: diagnosticEvidence,
      },
      worker,
    );
    let task = entry(response.snapshot, id);
    assert.equal(task.proposal.kind, "action");
    assert.deepEqual(task.diff, []);
    assert.deepEqual(task.evidence.checksFail, ["inspect CI failure"]);
    assert.match(task.approvalFlow.checks.quality.detail, /不代表检查通过/);
    assert.equal(
      (await service.claim({ engineId: "fast", workerId: "worker-a" }, worker))
        .task,
      null,
    );
    const first = await service.decide(
      id,
      {
        decision: "approve",
        nodeId: "code-review",
        round: 1,
        expectedRevision: task.revision,
      },
      manager,
    );
    assert.equal(
      (await service.claim({ engineId: "fast", workerId: "worker-a" }, worker))
        .task,
      null,
    );
    task = entry(first.snapshot, id);
    await service.decide(
      id,
      {
        decision: "approve",
        nodeId: "execution-auth",
        round: 1,
        expectedRevision: task.revision,
      },
      manager,
    );
    const execution = await service.claim(
      { engineId: "fast", workerId: "worker-a" },
      worker,
    );
    assert.equal(execution.lease.phase, "execute");
    const done = await service.complete(
      id,
      { leaseId: execution.lease.id, result },
      worker,
    );
    task = entry(done.snapshot, id);
    assert.equal(task.status.status, "completed");
    assert.equal(task.result.action, resultAction);
    assert.deepEqual(task.result.evidence.checksFail, ["inspect CI failure"]);
    assert.deepEqual(task.task.payload.files, []);
  });

  test(`${action} proposals reject code diffs and unrecorded diagnostic results`, async (t) => {
    const { service, id, claim } = await actionFixture(t, action);
    await assert.rejects(
      service.proposal(id, { ...proposed, leaseId: claim.lease.id }, worker),
      errorCode("UNAPPROVED_CHANGE"),
    );
    for (const invalidEvidence of [
      { testsRun: [], checksPass: [], checksFail: [] },
      { testsRun: ["diagnose"], checksPass: [], checksFail: [] },
      {
        testsRun: ["diagnose"],
        checksPass: [],
        checksFail: ["unrecorded check"],
      },
    ]) {
      await assert.rejects(
        service.proposal(
          id,
          {
            leaseId: claim.lease.id,
            summary: "Record the observed problem",
            diff: [],
            evidence: invalidEvidence,
          },
          worker,
        ),
        errorCode("EVIDENCE_REQUIRED"),
      );
    }
    assert.equal(entry(await service.snapshot(), id).approvalFlow, undefined);
  });

  test(`${action} successful completions reject unrelated artifacts and source changes`, async (t) => {
    const { service, id, claim } = await actionFixture(t, action);
    await service.proposal(
      id,
      {
        leaseId: claim.lease.id,
        summary: "Address the observed failure",
        diff: [],
        evidence: diagnosticEvidence,
      },
      worker,
    );
    await approveBoth(service, id);
    const execution = await service.claim(
      { engineId: "fast", workerId: "worker-a" },
      worker,
    );
    const baseline =
      action === "create-issue" ? { files: [], issue: 43 } : { files: [] };
    const extras = [
      { commit: "b".repeat(40) },
      { pr: 42 },
      { files: ["src/unapproved.js"] },
      ...(action === "retry" ? [{ issue: 43 }] : []),
    ];
    for (const extra of extras) {
      await assert.rejects(
        service.complete(
          id,
          {
            leaseId: execution.lease.id,
            result: {
              success: true,
              action: resultAction,
              changes: { ...baseline, ...extra },
              logs: [],
              evidence: diagnosticEvidence,
            },
          },
          worker,
        ),
        errorCode("UNAPPROVED_CHANGE"),
      );
    }
    assert.equal(entry(await service.snapshot(), id).status.status, "running");
  });
}
