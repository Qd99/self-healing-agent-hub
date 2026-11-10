import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHealingService } from "../apps/healing-hub/src/console-service.mjs";

import { getApprovalFlow } from "../apps/console/public/approvals.js";
import { renderApprovalPage } from "../apps/console/public/approval-views.js";
import { renderTaskDetail, statusLabel } from "../apps/console/public/views.js";
import { getTaskDisplayStatus } from "../apps/console/public/task-model.js";

const manager = { id: "operator", name: "Operator" };
const worker = { id: "worker", name: "Worker", workerId: "worker-one" };
const evidence = {
  testsRun: ["npm test"],
  checksPass: ["npm test"],
  checksFail: [],
};
const candidate = {
  summary: "Repair the observed failure",
  diff: [
    {
      path: "src/example.js",
      additions: 1,
      deletions: 1,
      lines: [
        { type: "remove", content: "let value = 1" },
        { type: "add", content: "const value = 1;" },
      ],
    },
  ],
  evidence,
};
const success = {
  success: true,
  action: "pr-created",
  changes: { files: ["src/example.js"], pr: 42 },
  evidence,
  logs: ["Created pull request 42"],
};
const partial = {
  success: false,
  action: "failed",
  changes: { files: ["src/example.js"], commit: "a".repeat(40), pr: 42 },
  evidence,
  logs: ["PR created before cancellation was observed"],
  error: {
    code: "INTERRUPTED",
    message: "Stopped after creating PR",
    retriable: true,
  },
};
const hasCode = (code) => (error) => error.code === code;

async function fixture(t, action = "create-pr") {
  const rootDir = await mkdtemp(join(tmpdir(), "heal-receipts-"));
  await mkdir(join(rootDir, "configs"));
  await writeFile(
    join(rootDir, "configs/healing-config.json"),
    JSON.stringify({
      project: { id: "receipts", repo: "owner/project", defaultBranch: "main" },
      engines: { fast: { type: "worker" }, complex: { type: "worker" } },
      safety: {
        maxFilesPerFix: 2,
        protectedPaths: ["deploy/"],
        requiredChecks: ["npm test"],
      },
      triggers: { manual: { enabled: true } },
    }),
  );
  await writeFile(
    join(rootDir, "configs/healing-rules.json"),
    JSON.stringify({
      version: "1",
      rules: [
        {
          id: "lint",
          name: "Lint",
          enabled: true,
          match: { taskType: "lint-error" },
          processor: { engine: "fast", action, priority: "high" },
        },
        {
          id: "tests",
          name: "Tests",
          enabled: true,
          match: { taskType: "unit-test-failure" },
          processor: {
            engine: "complex",
            action: "create-pr",
            priority: "high",
          },
        },
      ],
    }),
  );
  let time = Date.parse("2026-11-10T14:00:00.000Z");
  const services = [];
  const open = () => {
    const service = createHealingService({
      rootDir,
      dataDir: join(rootDir, "data"),
      clock: () => new Date(time),
      leaseMs: 1000,
    });
    services.push(service);
    return service;
  };
  const service = open();
  t.after(async () => {
    await Promise.all(services.map((s) => s.close().catch(() => {})));
    await rm(rootDir, { recursive: true, force: true });
  });
  return {
    service,
    rootDir,
    open,
    advance(ms) {
      time += ms;
    },
  };
}
async function task(service, id) {
  return (await service.snapshot()).tasks.find((item) => item.task.id === id);
}
async function claim(service) {
  return service.claim({ engineId: "fast", workerId: worker.workerId }, worker);
}
async function create(service) {
  return service.trigger(
    { title: "Repair lint", type: "lint-error", priority: "high" },
    manager,
  );
}
async function execute(service) {
  const created = await create(service);
  const diagnosis = await claim(service);
  await service.proposal(
    created.taskId,
    { leaseId: diagnosis.lease.id, ...candidate },
    worker,
  );
  for (const nodeId of ["code-review", "execution-auth"]) {
    const item = await task(service, created.taskId);
    await service.decide(
      created.taskId,
      {
        expectedRevision: item.revision,
        round: item.approvalFlow.round,
        nodeId,
        decision: "approve",
        comment: "Approved",
      },
      manager,
    );
  }
  return { id: created.taskId, lease: (await claim(service)).lease };
}
async function cancel(service, id) {
  const item = await task(service, id);
  return service.taskAction(
    id,
    "cancel",
    { expectedRevision: item.revision },
    manager,
  );
}
async function reconcile(service, id, outcome = "changes-recorded") {
  const item = await task(service, id);
  return service.reconcile(
    id,
    {
      expectedRevision: item.revision,
      outcome,
      note: "Checked repository and linked external records",
    },
    manager,
  );
}

test("every Worker mutation returns only its protocol fields, not the management snapshot", async (t) => {
  const { service } = await fixture(t);
  const created = await create(service);
  await service.trigger(
    {
      title: "Unrelated private task",
      type: "unit-test-failure",
      priority: "low",
    },
    manager,
  );
  const diagnosis = await claim(service);
  const heartbeat = await service.heartbeat(
    created.taskId,
    { leaseId: diagnosis.lease.id },
    worker,
  );
  const proposed = await service.proposal(
    created.taskId,
    { leaseId: diagnosis.lease.id, ...candidate },
    worker,
  );
  for (const response of [diagnosis, heartbeat, proposed]) {
    assert.equal(response.snapshot, undefined);
    assert.ok(!JSON.stringify(response).includes("Unrelated private task"));
  }
  for (const nodeId of ["code-review", "execution-auth"]) {
    const item = await task(service, created.taskId);
    await service.decide(
      created.taskId,
      {
        expectedRevision: item.revision,
        round: item.approvalFlow.round,
        nodeId,
        decision: "approve",
      },
      manager,
    );
  }
  const execution = await claim(service);
  const done = await service.complete(
    created.taskId,
    { leaseId: execution.lease.id, result: success },
    worker,
  );
  assert.equal(done.snapshot, undefined);
  assert.equal(
    (await task(service, created.taskId)).status.status,
    "completed",
  );
});

test("committed results reject unrelated PR and Issue artifacts without ending the lease", async (t) => {
  const { service } = await fixture(t, "auto-commit");
  const { id, lease } = await execute(service);
  for (const extra of [{ pr: 7 }, { issue: 8 }]) {
    await assert.rejects(
      service.complete(
        id,
        {
          leaseId: lease.id,
          result: {
            ...success,
            action: "committed",
            changes: {
              files: ["src/example.js"],
              commit: "a".repeat(40),
              ...extra,
            },
          },
        },
        worker,
      ),
      hasCode("UNAPPROVED_CHANGE"),
    );
    assert.equal((await task(service, id)).status.status, "running");
  }
  await service.complete(
    id,
    {
      leaseId: lease.id,
      result: {
        ...success,
        action: "committed",
        changes: { files: ["src/example.js"], commit: "a".repeat(40) },
      },
    },
    worker,
  );
});

test("PR success may include its commit but rejects an extra Issue", async (t) => {
  const { service } = await fixture(t);
  const { id, lease } = await execute(service);
  await assert.rejects(
    service.complete(
      id,
      {
        leaseId: lease.id,
        result: { ...success, changes: { ...success.changes, issue: 8 } },
      },
      worker,
    ),
    hasCode("UNAPPROVED_CHANGE"),
  );
  await service.complete(
    id,
    {
      leaseId: lease.id,
      result: {
        ...success,
        changes: { ...success.changes, commit: "b".repeat(40) },
      },
    },
    worker,
  );
});

test("identical completion is acknowledged after restart but a changed result cannot overwrite success", async (t) => {
  const { service, open } = await fixture(t);
  const { id, lease } = await execute(service);
  const body = { leaseId: lease.id, result: success };
  const first = await service.complete(id, body, worker);
  const before = await service.snapshot();
  await service.close();
  const restored = open();
  assert.deepEqual(await restored.complete(id, body, worker), first);
  assert.equal((await restored.snapshot()).revision, before.revision);
  await assert.rejects(
    restored.complete(
      id,
      { ...body, result: { ...success, logs: ["changed"] } },
      worker,
    ),
    hasCode("STATE_CONFLICT"),
  );
  await assert.rejects(
    restored.complete(id, body, { ...worker, id: "another-key" }),
    hasCode("STATE_CONFLICT"),
  );
  assert.ok(!JSON.stringify(await restored.snapshot()).includes(lease.id));
});

test("cancellation preserves partial result and requires an explicit reconciliation before retry", async (t) => {
  const { service, open } = await fixture(t);
  const { id, lease } = await execute(service);
  await cancel(service, id);
  const receipt = await service.complete(
    id,
    { leaseId: lease.id, result: partial },
    worker,
  );
  assert.equal(receipt.snapshot, undefined);
  const stopped = await task(service, id);
  assert.equal(stopped.status.status, "cancelled");
  assert.equal(stopped.result.changes.pr, 42);
  assert.equal(stopped.result.error.code, "INTERRUPTED");
  assert.equal(stopped.reconciliation.status, "required");
  await assert.rejects(
    service.taskAction(
      id,
      "retry",
      { expectedRevision: stopped.revision },
      manager,
    ),
    hasCode("RECONCILIATION_REQUIRED"),
  );
  const bulk = await service.bulk(
    { type: "retry", items: [{ id, revision: stopped.revision }] },
    manager,
  );
  assert.equal(bulk.report.applied.length, 0);
  assert.equal(bulk.report.skipped[0].code, "RECONCILIATION_REQUIRED");
  await service.close();
  const restored = open();
  assert.equal((await task(restored, id)).result.changes.pr, 42);
  await assert.rejects(
    restored.reconcile(
      id,
      {
        expectedRevision: stopped.revision,
        outcome: "changes-recorded",
        note: "",
      },
      manager,
    ),
    hasCode("INVALID_REQUEST"),
  );
  await assert.rejects(
    restored.reconcile(
      id,
      {
        expectedRevision: stopped.revision - 1,
        outcome: "changes-recorded",
        note: "Checked",
      },
      manager,
    ),
    hasCode("STATE_CONFLICT"),
  );
  await reconcile(restored, id);
  const confirmed = await task(restored, id);
  assert.equal(confirmed.reconciliation.status, "resolved");
  assert.equal(confirmed.reconciliation.resolution.actor, manager.name);
  const retried = await restored.taskAction(
    id,
    "retry",
    { expectedRevision: confirmed.revision },
    manager,
  );
  assert.notEqual(retried.taskId, id);
});

test("cancellation acknowledgement stores supplied result and does not expose snapshot", async (t) => {
  const { service } = await fixture(t);
  const { id, lease } = await execute(service);
  await cancel(service, id);
  const body = { leaseId: lease.id, result: partial };
  const ack = await service.acknowledgeCancellation(id, body, worker);
  assert.equal(ack.snapshot, undefined);
  assert.equal(
    (await task(service, id)).result.changes.commit,
    partial.changes.commit,
  );
  assert.deepEqual(
    await service.acknowledgeCancellation(id, body, worker),
    ack,
  );
});

test("execute cancellation without a result remains unknown until checked; diagnosis cancellation can retry", async (t) => {
  const { service } = await fixture(t);
  const { id, lease } = await execute(service);
  await cancel(service, id);
  await service.acknowledgeCancellation(id, { leaseId: lease.id }, worker);
  assert.equal((await task(service, id)).reconciliation.status, "required");
  const diagnosisTask = await create(service);
  const diagnosis = await claim(service);
  await cancel(service, diagnosisTask.taskId);
  await service.acknowledgeCancellation(
    diagnosisTask.taskId,
    { leaseId: diagnosis.lease.id },
    worker,
  );
  const stopped = await task(service, diagnosisTask.taskId);
  await service.taskAction(
    diagnosisTask.taskId,
    "retry",
    { expectedRevision: stopped.revision },
    manager,
  );
});

test("expired execution accepts late evidence without turning the task into success or reopening execution", async (t) => {
  const { service, advance, open } = await fixture(t);
  const { id, lease } = await execute(service);
  advance(1001);
  const expired = await task(service, id);
  assert.equal(expired.status.status, "failed");
  assert.equal(expired.reconciliation.status, "required");
  await service.close();
  const restored = open();
  const response = await restored.complete(
    id,
    { leaseId: lease.id, result: success },
    worker,
  );
  assert.equal(response.snapshot, undefined);
  const received = await task(restored, id);
  assert.equal(received.status.status, "failed");
  assert.equal(received.result.changes.pr, 42);
  assert.equal(received.reconciliation.status, "required");
  await assert.rejects(
    restored.heartbeat(id, { leaseId: lease.id }, worker),
    hasCode("STATE_CONFLICT"),
  );
  assert.equal((await claim(restored)).task, null);
});

test("a new late result invalidates a previous reconciliation but exact replay does not", async (t) => {
  const { service } = await fixture(t);
  const { id, lease } = await execute(service);
  await cancel(service, id);
  const body = { leaseId: lease.id, result: partial };
  await service.acknowledgeCancellation(id, body, worker);
  await reconcile(service, id);
  await service.acknowledgeCancellation(id, body, worker);
  assert.equal((await task(service, id)).reconciliation.status, "resolved");
  await service.complete(
    id,
    {
      leaseId: lease.id,
      result: { ...partial, changes: { ...partial.changes, pr: 43 } },
    },
    worker,
  );
  const changed = await task(service, id);
  assert.equal(changed.reconciliation.status, "required");
  assert.equal(changed.result.changes.pr, 43);
  assert.equal(changed.resultReceipts.length, 2);
  assert.equal(changed.resultReceipts[0].result.changes.pr, 42);
});

test("failed execution with reported side effects requires reconciliation and cannot assert no changes", async (t) => {
  const { service } = await fixture(t);
  const { id, lease } = await execute(service);
  await service.complete(id, { leaseId: lease.id, result: partial }, worker);
  const failed = await task(service, id);
  assert.equal(failed.status.status, "failed");
  assert.equal(failed.reconciliation.status, "required");
  await assert.rejects(
    reconcile(service, id, "no-changes"),
    hasCode("RECONCILIATION_MISMATCH"),
  );
});

async function retry(service, id) {
  const item = await task(service, id);
  return service.taskAction(
    id,
    "retry",
    { expectedRevision: item.revision },
    manager,
  );
}
async function prepareRetry(service, id, approvedGates = 2) {
  const diagnosis = await claim(service);
  assert.equal(diagnosis.task.task.id, id);
  await service.proposal(
    id,
    { leaseId: diagnosis.lease.id, ...candidate },
    worker,
  );
  for (const nodeId of ["code-review", "execution-auth"].slice(
    0,
    approvedGates,
  )) {
    const item = await task(service, id);
    await service.decide(
      id,
      {
        expectedRevision: item.revision,
        round: item.approvalFlow.round,
        nodeId,
        decision: "approve",
      },
      manager,
    );
  }
}
async function resolvedOrigin(service) {
  const origin = await execute(service);
  await cancel(service, origin.id);
  await service.acknowledgeCancellation(
    origin.id,
    { leaseId: origin.lease.id },
    worker,
  );
  await reconcile(service, origin.id, "no-changes");
  return origin;
}

for (const kind of ["side-effects", "expired", "cancelled-execution"]) {
  test(`legacy ${kind} requires reconciliation without changing saved revisions or history`, async (t) => {
    const { service, rootDir, open, advance } = await fixture(t);
    const { id, lease } = await execute(service);
    if (kind === "side-effects")
      await service.complete(
        id,
        { leaseId: lease.id, result: partial },
        worker,
      );
    else if (kind === "expired") {
      advance(1001);
      await service.snapshot();
    } else {
      await cancel(service, id);
      await service.acknowledgeCancellation(id, { leaseId: lease.id }, worker);
    }
    await service.close();
    const path = join(rootDir, "data/console-state.json");
    const saved = JSON.parse(await readFile(path, "utf8"));
    const legacy = saved.tasks.find((entry) => entry.task.id === id);
    for (const key of [
      "reconciliation",
      "receipts",
      "terminalLease",
      "interruption",
    ])
      delete legacy[key];
    await writeFile(path, JSON.stringify(saved));
    const restored = open();
    const snapshot = await restored.snapshot();
    const entry = snapshot.tasks.find((item) => item.task.id === id);
    assert.equal(entry.reconciliation?.status, "required");
    assert.equal(snapshot.revision, saved.revision);
    assert.equal(entry.revision, legacy.revision);
    assert.deepEqual(entry.result, legacy.result);
    assert.deepEqual(entry.approvalFlow, legacy.approvalFlow);
    assert.deepEqual(snapshot.activity, saved.activity);
    await assert.rejects(
      retry(restored, id),
      hasCode("RECONCILIATION_REQUIRED"),
    );
    const bulk = await restored.bulk(
      { type: "retry", items: [{ id, revision: entry.revision }] },
      manager,
    );
    assert.equal(bulk.report.skipped[0].code, "RECONCILIATION_REQUIRED");
    await reconcile(
      restored,
      id,
      kind === "side-effects" ? "changes-recorded" : "no-changes",
    );
    await restored.close();
    const again = open();
    assert.equal((await task(again, id)).reconciliation.status, "resolved");
    assert.ok((await retry(again, id)).taskId);
  });
}

test("ordinary failed completion is immutable and exact replay survives resolution and restart", async (t) => {
  const { service, open } = await fixture(t);
  const { id, lease } = await execute(service);
  const body = { leaseId: lease.id, result: partial };
  const response = await service.complete(id, body, worker);
  await reconcile(service, id);
  await service.close();
  const restored = open();
  const before = await restored.snapshot();
  assert.deepEqual(await restored.complete(id, body, worker), response);
  assert.equal((await restored.snapshot()).revision, before.revision);
  await assert.rejects(
    restored.complete(id, { leaseId: lease.id, result: success }, worker),
    hasCode("STATE_CONFLICT"),
  );
  assert.deepEqual((await task(restored, id)).result, before.tasks[0].result);
});

test("expired attempts retain late-evidence eligibility after result replacement and restart", async (t) => {
  const { service, open, advance } = await fixture(t);
  const { id, lease } = await execute(service);
  advance(1001);
  await service.complete(id, { leaseId: lease.id, result: partial }, worker);
  await reconcile(service, id);
  await service.close();
  const restored = open();
  await restored.complete(id, { leaseId: lease.id, result: success }, worker);
  const entry = await task(restored, id);
  assert.equal(entry.status.status, "failed");
  assert.equal(entry.reconciliation.status, "required");
  assert.equal(entry.resultReceipts.length, 2);
  assert.equal(entry.interruption, undefined);
});

test("late cancellation confirmation without new evidence preserves a resolved conclusion", async (t) => {
  const { service } = await fixture(t);
  const { id, lease } = await execute(service);
  await cancel(service, id);
  await service.complete(id, { leaseId: lease.id, result: partial }, worker);
  await reconcile(service, id);
  const before = (await task(service, id)).reconciliation;
  await service.acknowledgeCancellation(id, { leaseId: lease.id }, worker);
  assert.deepEqual((await task(service, id)).reconciliation, before);
  await service.acknowledgeCancellation(
    id,
    {
      leaseId: lease.id,
      result: { ...partial, changes: { ...partial.changes, pr: 43 } },
    },
    worker,
  );
  assert.equal((await task(service, id)).reconciliation.status, "required");
});

for (const source of ["live", "startup-active", "startup-cancelled"]) {
  for (const approvedGates of [0, 1]) {
    test(`${source} invalidation stops a retry waiting at approval gate ${approvedGates + 1}`, async (t) => {
      const { service, rootDir, open } = await fixture(t);
      const origin = await execute(service);
      await cancel(service, origin.id);
      await service.complete(
        origin.id,
        { leaseId: origin.lease.id, result: partial },
        worker,
      );
      await reconcile(service, origin.id);
      const next = await retry(service, origin.id);
      await prepareRetry(service, next.taskId, approvedGates);
      const before = await task(service, next.taskId);
      assert.equal(
        getApprovalFlow(before).currentNodeId,
        approvedGates ? "execution-auth" : "code-review",
      );
      let active = service;
      if (source === "live") {
        await service.complete(
          origin.id,
          { leaseId: origin.lease.id, result: success },
          worker,
        );
      } else {
        await service.close();
        const path = join(rootDir, "data/console-state.json");
        const saved = JSON.parse(await readFile(path, "utf8"));
        const savedOrigin = saved.tasks.find(
          (entry) => entry.task.id === origin.id,
        );
        if (source === "startup-active") {
          savedOrigin.reconciliation.status = "required";
          delete savedOrigin.reconciliation.resolution;
        }
        if (source === "startup-cancelled") {
          const legacy = saved.tasks.find(
            (entry) => entry.task.id === next.taskId,
          );
          legacy.status.status = "cancelled";
          legacy.status.completedAt = savedOrigin.reconciliation.updatedAt;
          legacy.executionPhase = "done";
          legacy.cancellationRequested = true;
          legacy.blockedByReconciliation = {
            taskId: origin.id,
            reason: "来源结果需要重新核对",
            at: legacy.status.completedAt,
          };
          // The ancestor is already resolved, but the old hold left a live review.
        }
        await writeFile(path, JSON.stringify(saved));
        active = open();
      }
      const snapshot = await active.snapshot();
      const held = snapshot.tasks.find(
        (entry) => entry.task.id === next.taskId,
      );
      assert.equal(held.status.status, "cancelled");
      assert.equal(held.execution.phase, "done");
      assert.equal(held.reviewState, undefined);
      assert.equal(held.approvalFlow.status, "cancelled");
      assert.deepEqual(
        held.approvalFlow.gates,
        before.approvalFlow.gates.map((gate) => ({
          ...gate,
          status: gate.status === "pending" ? "blocked" : gate.status,
        })),
      );
      assert.deepEqual(held.approvalFlow.checks, before.approvalFlow.checks);
      assert.deepEqual(
        held.approvalFlow.history.slice(0, -1),
        before.approvalFlow.history,
      );
      assert.equal(held.approvalFlow.history.at(-1).decision, "cancelled");
      assert.equal(
        held.approvalFlow.history.at(-1).nodeId,
        approvedGates ? "execution-auth" : "code-review",
      );
      for (const key of [
        "proposal",
        "diff",
        "evidence",
        "trace",
        "result",
        "resultReceipts",
      ])
        assert.deepEqual(held[key], before[key], key);
      assert.equal(getApprovalFlow(held).currentGate, null);
      assert.equal(getTaskDisplayStatus(held), "cancelled");
      assert.match(statusLabel(held), /已取消/);
      assert.equal(
        snapshot.tasks.filter((entry) => entry.reviewState === "pending")
          .length,
        0,
      );
      const state = {
        mode: "live",
        snapshot,
        approvalFilter: "all",
        approvalTaskId: next.taskId,
      };
      const approval = renderApprovalPage(state);
      assert.match(approval, /等待审批<\/span><strong>0<\/strong>/);
      assert.doesNotMatch(approval, /id="approval-(?:decision|resubmit)-form"/);
      assert.match(approval, /任务已取消/);
      if (source !== "startup-cancelled") {
        await assert.rejects(
          retry(active, next.taskId),
          hasCode("RECONCILIATION_REQUIRED"),
        );
        await reconcile(active, origin.id);
      }
      const resolved = await active.snapshot();
      const detail = renderTaskDetail(held, { ...state, snapshot: resolved });
      assert.doesNotMatch(detail, /data-action="select-approval"/);
      assert.match(
        detail,
        /<button[^>]*data-command="retry"[^>]*>.*?重新尝试<\/button>/s,
      );
      assert.doesNotMatch(
        detail,
        /<button[^>]*data-command="retry"[^>]*disabled/,
      );
      const history = held.approvalFlow.history;
      const manual = await retry(active, next.taskId);
      assert.ok(manual.taskId);
      await active.close();
      const restored = open();
      assert.deepEqual(
        (await task(restored, next.taskId)).approvalFlow.history,
        history,
      );
      assert.equal(
        (await task(restored, manual.taskId)).status.status,
        "pending",
      );
    });
  }
}

for (const source of [
  "live",
  "startup-active",
  "startup-cancelled",
  "ordinary-cancel",
]) {
  test(`${source} preserves exactly 10000 approval history entries at cancellation`, async (t) => {
    const { service, rootDir, open } = await fixture(t);
    const origin = await resolvedOrigin(service);
    const next = await retry(service, origin.id);
    await prepareRetry(service, next.taskId, 1);
    const before = await task(service, next.taskId);
    await service.close();
    const path = join(rootDir, "data/console-state.json");
    const saved = JSON.parse(await readFile(path, "utf8"));
    const savedOrigin = saved.tasks.find(
      (entry) => entry.task.id === origin.id,
    );
    const descendant = saved.tasks.find(
      (entry) => entry.task.id === next.taskId,
    );
    const originalHistory = [
      ...descendant.approvalFlow.history,
      ...Array.from(
        { length: 10000 - descendant.approvalFlow.history.length },
        (_, index) => ({
          ...descendant.approvalFlow.history[0],
          id: `retained-history-${index}`,
        }),
      ),
    ];
    descendant.approvalFlow.history = originalHistory;
    if (source === "startup-active") {
      savedOrigin.reconciliation.status = "required";
      delete savedOrigin.reconciliation.resolution;
    } else if (source === "startup-cancelled") {
      descendant.status.status = "cancelled";
      descendant.status.completedAt = savedOrigin.reconciliation.updatedAt;
      descendant.executionPhase = "done";
      descendant.cancellationRequested = true;
      descendant.blockedByReconciliation = {
        taskId: origin.id,
        reason: "来源结果需要重新核对",
        at: descendant.status.completedAt,
      };
    }
    await writeFile(path, JSON.stringify(saved));
    let active = open();
    if (source === "live") {
      await active.complete(
        origin.id,
        { leaseId: origin.lease.id, result: success },
        worker,
      );
    } else if (source === "ordinary-cancel") {
      const unchanged = await active.snapshot();
      await assert.rejects(cancel(active, next.taskId), hasCode("STORE_FULL"));
      const after = await active.snapshot();
      assert.equal(after.revision, unchanged.revision);
      assert.deepEqual(after.tasks, unchanged.tasks);
      assert.deepEqual(after.activity, unchanged.activity);
      return;
    }
    for (let restart = 0; restart < 3; restart++) {
      const snapshot = await active.snapshot();
      assert.equal(snapshot.storage.status, "ready");
      const held = snapshot.tasks.find(
        (entry) => entry.task.id === next.taskId,
      );
      assert.equal(held.status.status, "cancelled");
      assert.equal(held.reviewState, undefined);
      assert.equal(held.approvalFlow.status, "cancelled");
      assert.deepEqual(held.approvalFlow.history, originalHistory);
      assert.equal(held.approvalFlow.history.length, 10000);
      assert.deepEqual(
        held.approvalFlow.gates[0],
        before.approvalFlow.gates[0],
      );
      assert.equal(held.approvalFlow.gates[1].status, "blocked");
      assert.deepEqual(held.evidence, before.evidence);
      assert.deepEqual(held.proposal, before.proposal);
      assert.equal(held.execution.blockedByReconciliation.taskId, origin.id);
      assert.match(held.execution.blockedByReconciliation.reason, /核对/);
      if (source === "live") {
        const updated = snapshot.tasks.find(
          (entry) => entry.task.id === origin.id,
        );
        assert.equal(updated.reconciliation.status, "required");
        assert.equal(updated.result.changes.pr, success.changes.pr);
        assert.deepEqual(
          updated.resultReceipts.at(-1).result.changes,
          success.changes,
        );
        assert.equal(
          snapshot.activity.filter(
            (event) =>
              event.taskId === next.taskId &&
              event.action === "retry-interrupted",
          ).length,
          1,
        );
      }
      if (restart === 1 && source !== "live") {
        if (source === "startup-active")
          await reconcile(active, origin.id, "no-changes");
        assert.ok((await retry(active, next.taskId)).taskId);
      }
      await active.close();
      if (restart < 2) active = open();
    }
  });
}

for (const phase of ["pending", "approved", "executing"]) {
  test(`late origin evidence stops ${phase} retries and never resumes them on resolution`, async (t) => {
    const { service, open } = await fixture(t);
    const origin = await resolvedOrigin(service);
    const next = await retry(service, origin.id);
    if (phase !== "pending") await prepareRetry(service, next.taskId);
    const execution = phase === "executing" ? await claim(service) : null;
    const before = await task(service, next.taskId);
    const body = { leaseId: origin.lease.id, result: success };
    await service.complete(origin.id, body, worker);
    await assert.rejects(
      retry(service, origin.id),
      hasCode("RECONCILIATION_REQUIRED"),
    );
    const held = await task(service, next.taskId);
    assert.equal(held.execution.blockedByReconciliation?.taskId, origin.id);
    assert.match(held.execution.blockedByReconciliation.reason, /核对/);
    if (phase === "approved") {
      assert.equal(held.reviewState, undefined);
      assert.equal(held.approvalFlow.status, "cancelled");
      assert.deepEqual(held.approvalFlow.gates, before.approvalFlow.gates);
      assert.deepEqual(held.approvalFlow.checks, before.approvalFlow.checks);
      assert.deepEqual(
        held.approvalFlow.history.slice(0, -1),
        before.approvalFlow.history,
      );
      assert.equal(held.approvalFlow.history.at(-1).decision, "cancelled");
    } else assert.deepEqual(held.approvalFlow, before.approvalFlow);
    if (execution) {
      assert.equal(
        (
          await service.heartbeat(
            next.taskId,
            { leaseId: execution.lease.id },
            worker,
          )
        ).cancelRequested,
        true,
      );
      await service.complete(
        next.taskId,
        { leaseId: execution.lease.id, result: success },
        worker,
      );
      assert.equal(
        (await task(service, next.taskId)).status.status,
        "cancelled",
      );
      await reconcile(service, next.taskId);
    } else assert.equal(held.status.status, "cancelled");
    await assert.rejects(
      retry(service, next.taskId),
      hasCode("RECONCILIATION_REQUIRED"),
    );
    const replayRevision = (await service.snapshot()).revision;
    await service.complete(origin.id, body, worker);
    assert.equal((await service.snapshot()).revision, replayRevision);
    await reconcile(service, origin.id);
    await service.close();
    const restored = open();
    assert.equal((await claim(restored)).task, null);
    assert.equal(
      (await task(restored, next.taskId)).status.status,
      "cancelled",
    );
    assert.ok((await retry(restored, next.taskId)).taskId);
  });
}

test("retry guards trace unresolved ancestors through an already cancelled intermediate retry", async (t) => {
  const { service } = await fixture(t);
  const origin = await resolvedOrigin(service);
  const middle = await retry(service, origin.id);
  await cancel(service, middle.taskId);
  const last = await retry(service, middle.taskId);
  await service.complete(
    origin.id,
    { leaseId: origin.lease.id, result: success },
    worker,
  );
  assert.equal((await task(service, last.taskId)).status.status, "cancelled");
  await assert.rejects(
    retry(service, middle.taskId),
    hasCode("RECONCILIATION_REQUIRED"),
  );
  await assert.rejects(
    retry(service, last.taskId),
    hasCode("RECONCILIATION_REQUIRED"),
  );
  assert.equal((await claim(service)).task, null);
});

test("a normal failure named LEASE_EXPIRED does not gain interrupted receipt privileges on restart", async (t) => {
  const { service, open } = await fixture(t);
  const { id, lease } = await execute(service);
  await service.complete(
    id,
    {
      leaseId: lease.id,
      result: {
        ...partial,
        error: { ...partial.error, code: "LEASE_EXPIRED" },
      },
    },
    worker,
  );
  await service.close();
  const restored = open();
  await assert.rejects(
    restored.complete(id, { leaseId: lease.id, result: success }, worker),
    hasCode("STATE_CONFLICT"),
  );
});

test("diagnosis-only expiry stays retryable across restart without stopping its retry", async (t) => {
  const { service, open, advance } = await fixture(t);
  const created = await create(service);
  const diagnosis = await claim(service);
  assert.equal(diagnosis.lease.phase, "diagnose");
  advance(1001);
  const expired = await task(service, created.taskId);
  assert.equal(expired.status.status, "failed");
  assert.equal(expired.reconciliation, undefined);
  const next = await retry(service, created.taskId);
  const before = await service.snapshot();
  await service.close();
  const restored = open();
  const origin = await task(restored, created.taskId);
  const descendant = await task(restored, next.taskId);
  assert.equal(origin.reconciliation, undefined);
  assert.equal((await restored.snapshot()).revision, before.revision);
  assert.equal(descendant.status.status, "pending");
  assert.equal(descendant.execution.cancelRequested, false);
  assert.equal(descendant.execution.blockedByReconciliation, undefined);
  const claimed = await claim(restored);
  assert.equal(claimed.task.task.id, next.taskId);
  assert.equal(claimed.lease.phase, "diagnose");
});
