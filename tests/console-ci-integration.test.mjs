import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHealingService } from "../apps/healing-hub/src/console-service.mjs";
const manager = { id: "manager", name: "Manager" },
  worker = { id: "worker", name: "Worker" },
  base = "a".repeat(40);
const integrationsConfig = {
  jenkins: {
    enabled: true,
    sourceId: "ci",
    generation: "1",
    baseUrl: "https://ci.example/",
    jobSegments: ["test"],
    repo: "owner/repo",
    branch: "main",
    scmBranch: "origin/main",
    scmRemoteUrls: ["https://github.com/owner/repo.git"],
  },
  githubVerification: {
    enabled: true,
    tokenEnv: "TOKEN",
    requiredStatusContexts: ["tests"],
    trustedStatusCreators: ["ci[bot]"],
  },
};
const build = {
  number: 7,
  building: false,
  result: "FAILURE",
  actions: [
    {
      _class: "hudson.plugins.git.util.BuildData",
      remoteUrls: integrationsConfig.jenkins.scmRemoteUrls,
      lastBuiltRevision: {
        SHA1: base,
        branch: [{ name: "origin/main", SHA1: base }],
      },
      buildsByBranchName: {
        "origin/main": {
          buildNumber: 7,
          revision: {
            SHA1: base,
            branch: [{ name: "origin/main", SHA1: base }],
          },
          marked: { SHA1: base, branch: [{ name: "origin/main", SHA1: base }] },
        },
      },
    },
  ],
};
const proposal = {
  summary: "Fix test",
  submissionId: "submit-1",
  candidate: {
    version: 2,
    baseCommitSha: base,
    patchSha256: "b".repeat(64),
    artifactId: "b".repeat(64),
    treeSha: "c".repeat(40),
  },
  diff: [
    {
      path: "src/a.js",
      additions: 1,
      deletions: 0,
      lines: [{ type: "add", content: "ok" }],
    },
  ],
  evidence: { testsRun: ["tests"], checksPass: ["tests"], checksFail: [] },
};
const claim = {
  engineId: "fast",
  workerId: "stable",
  actions: ["create-pr"],
  sourceKinds: ["jenkins"],
  candidateVersions: [2],
};
async function fixture(t, options = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), "ci-hub-"));
  await mkdir(join(rootDir, "configs"));
  const config = {
    project: { id: "ci", repo: "owner/repo", defaultBranch: "main" },
    engines: { fast: { type: "pull-worker" } },
    safety: { requiredChecks: ["tests"] },
    triggers: { manual: { enabled: true } },
  };
  await writeFile(
    join(rootDir, "configs/healing-config.json"),
    JSON.stringify(config),
  );
  await writeFile(
    join(rootDir, "configs/healing-rules.json"),
    JSON.stringify({
      version: "1",
      rules: [
        {
          id: "ci",
          name: "CI",
          enabled: true,
          match: { taskType: "ci-failure" },
          processor: { engine: "fast", action: "create-pr", priority: "high" },
        },
      ],
    }),
  );
  const service = createHealingService({
    rootDir,
    integrationsConfig,
    integrationsEnv: { TOKEN: "secret" },
    integrationsFetch: async () => Response.json(build),
    ...options,
  });
  t.after(async () => {
    await service.close();
    await rm(rootDir, { recursive: true, force: true });
  });
  assert.equal(typeof service.importJenkinsBuild, "function");
  return { service, rootDir, config };
}
async function approve(service, taskId) {
  for (const nodeId of ["code-review", "execution-auth"]) {
    const task = (await service.snapshot()).tasks[0];
    await service.decide(
      taskId,
      {
        expectedRevision: task.revision,
        round: 1,
        nodeId,
        decision: "approve",
        comment: "Reviewed",
      },
      manager,
    );
  }
}
async function completedFixture(t, options = {}) {
  const f = await fixture(t, options),
    { service } = f;
  const { taskId } = await service.importJenkinsBuild(
    { sourceId: "ci", buildNumber: 7 },
    manager,
  );
  const d = await service.claim(claim, worker);
  const ack = await service.proposal(
    taskId,
    { ...proposal, workerId: "stable", leaseId: d.lease.id },
    worker,
  );
  await approve(service, taskId);
  const e = await service.claim(claim, worker);
  if (options.cancelBeforeComplete) {
    const task = (await service.snapshot()).tasks[0];
    await service.taskAction(
      taskId,
      "cancel",
      { expectedRevision: task.revision },
      manager,
    );
  }
  const receipt = {
    workerId: "stable",
    leaseId: e.lease.id,
    proposalId: ack.proposal.id,
    contentHash: ack.proposal.contentHash,
    result: {
      success: true,
      action: "pr-created",
      changes: { files: ["src/a.js"], pr: 7, commit: "d".repeat(40) },
      evidence: proposal.evidence,
    },
  };
  await service.complete(taskId, receipt, worker);
  return { ...f, taskId, receipt, ack };
}
function githubFetch(id, { failure = false } = {}) {
  const pr = {
    number: 7,
    state: "open",
    merged: false,
    changed_files: 1,
    base: { sha: base, ref: "main", repo: { full_name: "owner/repo" } },
    head: {
      sha: "d".repeat(40),
      ref: `heal/${id}`,
      repo: { full_name: "owner/repo" },
    },
  };
  return async (url) =>
    Response.json(
      url.includes("/files?")
        ? [{ filename: "src/a.js" }]
        : url.includes("/statuses?")
          ? [
              {
                id: 1,
                context: "tests",
                state: failure ? "failure" : "success",
                updated_at: "2026-01-01T00:00:00Z",
                creator: { login: "ci[bot]" },
              },
            ]
          : url.includes("/commits/")
            ? {
                sha: "d".repeat(40),
                parents: [{ sha: base }],
                commit: { tree: { sha: "c".repeat(40) } },
              }
            : pr,
    );
}
test("atomic import, trusted source retention and retry despite changed project", async (t) => {
  const { service, rootDir, config } = await fixture(t);
  const results = await Promise.all([
    service.importJenkinsBuild({ sourceId: "ci", buildNumber: 7 }, manager),
    service.importJenkinsBuild(
      { sourceId: "ci", buildNumber: 7 },
      { id: "other", name: "Other" },
    ),
  ]);
  assert.deepEqual(results.map((r) => r.outcome).sort(), [
    "created",
    "duplicate",
  ]);
  const id = results[0].taskId;
  let task = (await service.snapshot()).tasks[0];
  assert.equal(task.task.payload.context.commitSha, base);
  assert.equal(task.task.payload.context.source.eventId.length, 64);
  await service.taskAction(
    id,
    "cancel",
    { expectedRevision: task.revision },
    manager,
  );
  await writeFile(
    join(rootDir, "configs/healing-config.json"),
    JSON.stringify({
      ...config,
      project: { ...config.project, repo: "other/repo" },
    }),
  );
  task = (await service.snapshot()).tasks[0];
  await service.taskAction(
    id,
    "retry",
    { expectedRevision: task.revision },
    manager,
  );
  const snapshot = await service.snapshot();
  assert.equal(snapshot.tasks[0].task.payload.repo, "owner/repo");
  assert.deepEqual(
    snapshot.tasks[0].task.payload.context.source,
    task.task.payload.context.source,
  );
  assert.equal(snapshot.integrations.jenkins.configured, true);
  assert.equal(snapshot.capabilities.verifyResult, true);
  const duplicate = await service.importJenkinsBuild(
    { sourceId: "ci", buildNumber: 7 },
    manager,
  );
  assert.equal(duplicate.taskId, id);
});
test("v2 filters phases, affinity, exact ACK replay and execution bindings", async (t) => {
  const { service } = await fixture(t);
  const { taskId } = await service.importJenkinsBuild(
    { sourceId: "ci", buildNumber: 7 },
    manager,
  );
  assert.equal(
    (await service.claim({ engineId: "fast", workerId: "legacy" }, worker))
      .task,
    null,
  );
  assert.equal(
    (await service.claim({ ...claim, actions: ["retry"] }, worker)).task,
    null,
  );
  assert.equal(
    (await service.claim({ ...claim, phases: ["execute"] }, worker)).task,
    null,
  );
  const leased = await service.claim(
    { ...claim, phases: ["diagnose"] },
    worker,
  );
  const body = { ...proposal, leaseId: leased.lease.id, workerId: "stable" };
  await assert.rejects(
    service.proposal(taskId, { ...body, workerId: "spoof" }, worker),
    { code: "WORKER_ID_MISMATCH" },
  );
  const ack = await service.proposal(taskId, body, worker);
  assert.equal(ack.proposal.version, 2);
  assert.equal(ack.snapshot, undefined);
  assert.deepEqual(await service.proposal(taskId, body, worker), ack);
  await assert.rejects(
    service.proposal(taskId, { ...body, summary: "conflict" }, worker),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
  assert.equal(
    JSON.stringify((await service.snapshot()).tasks[0]).includes("submit-1"),
    false,
  );
  await approve(service, taskId);
  assert.equal(
    (await service.claim({ ...claim, phases: ["diagnose"] }, worker)).task,
    null,
  );
  assert.equal(
    (await service.claim({ ...claim, workerId: "different" }, worker)).task,
    null,
  );
  const exec = await service.claim(claim, worker);
  const complete = {
    workerId: "stable",
    leaseId: exec.lease.id,
    result: {
      success: true,
      action: "pr-created",
      changes: { files: ["src/a.js"], pr: 7, commit: "d".repeat(40) },
      evidence: proposal.evidence,
    },
  };
  await assert.rejects(service.complete(taskId, complete, worker), {
    code: "CANDIDATE_MISMATCH",
  });
  await service.complete(
    taskId,
    {
      ...complete,
      proposalId: ack.proposal.id,
      contentHash: ack.proposal.contentHash,
    },
    worker,
  );
  assert.equal((await service.snapshot()).tasks[0].status.status, "completed");
});
test("manual trigger cannot forge trusted Jenkins provenance", async (t) => {
  const { service } = await fixture(t);
  const forged = {
    kind: "jenkins",
    sourceId: "forged",
    eventId: "f".repeat(64),
    generation: "1",
    jobName: "fake",
    buildNumber: 7,
    buildUrl: "https://ci.example/fake",
    repo: "owner/repo",
    branch: "main",
    commitSha: base,
    result: "FAILURE",
    observedAt: new Date().toISOString(),
  };
  const result = await service.trigger(
    {
      title: "manual",
      type: "ci-failure",
      priority: "high",
      trustedSource: forged,
    },
    manager,
  );
  assert.equal(result.snapshot.tasks[0].task.payload.context.source, undefined);
});
test("lease determines v2 affinity without body workerId and ACK survives restart", async (t) => {
  const { service, rootDir } = await fixture(t);
  const { taskId } = await service.importJenkinsBuild(
    { sourceId: "ci", buildNumber: 7 },
    manager,
  );
  const lease = await service.claim(claim, worker);
  const body = { ...proposal, leaseId: lease.lease.id };
  const ack = await service.proposal(taskId, body, worker);
  await service.close();
  const reopened = createHealingService({
    rootDir,
    integrationsConfig,
    integrationsEnv: { TOKEN: "secret" },
    integrationsFetch: async () => Response.json(build),
  });
  t.after(() => reopened.close());
  assert.deepEqual(await reopened.proposal(taskId, body, worker), ack);
  assert.equal(
    (
      await reopened.importJenkinsBuild(
        { sourceId: "ci", buildNumber: 7 },
        { id: "new", name: "New" },
      )
    ).taskId,
    taskId,
  );
  await approve(reopened, taskId);
  assert.equal((await reopened.claim(claim, worker)).task.task.id, taskId);
});
test("verification executes outside lock and newest attempt fences reordered responses", async (t) => {
  let transport = async () => Response.json(build);
  const { service, taskId } = await completedFixture(t, {
    integrationsFetch: (...args) => transport(...args),
  });
  const success = githubFetch(taskId),
    failure = githubFetch(taskId, { failure: true });
  let release, started;
  const waiting = new Promise((r) => {
    started = r;
  });
  let first = true;
  transport = async (...args) => {
    if (first) {
      first = false;
      started();
      await new Promise((r) => {
        release = r;
      });
      return success(...args);
    }
    return failure(...args);
  };
  let task = (await service.snapshot()).tasks[0];
  const old = service.verifyResult(
    taskId,
    { expectedRevision: task.revision },
    manager,
  );
  await waiting;
  task = (await service.snapshot()).tasks[0];
  const latest = await service.verifyResult(
    taskId,
    { expectedRevision: task.revision },
    manager,
  );
  assert.equal(latest.verification.status, "failed");
  release();
  await old;
  assert.equal(
    (await service.snapshot()).tasks[0].verification.status,
    "failed",
  );
  assert.equal(
    JSON.stringify(await service.snapshot()).includes("verificationAttempt"),
    false,
  );
});
test("frozen verification policy ignores changed contexts and rejects client targets", async (t) => {
  let transport = async () => Response.json(build);
  const localConfig = structuredClone(integrationsConfig);
  const { service, taskId, rootDir } = await completedFixture(t, {
    integrationsConfig: localConfig,
    integrationsFetch: (...args) => transport(...args),
  });
  localConfig.githubVerification.requiredStatusContexts = ["new-policy"];
  transport = githubFetch(taskId);
  const task = (await service.snapshot()).tasks[0];
  await assert.rejects(
    service.verifyResult(
      taskId,
      { expectedRevision: task.revision, sha: base },
      manager,
    ),
    { code: "INVALID_REQUEST" },
  );
  const verified = await service.verifyResult(
    taskId,
    { expectedRevision: task.revision },
    manager,
  );
  assert.equal(verified.verification.status, "passed");
  assert.deepEqual(
    verified.verification.statuses.map((s) => s.context),
    ["tests"],
  );
  await service.close();
  const reopened = createHealingService({
    rootDir,
    integrationsConfig: localConfig,
    integrationsEnv: { TOKEN: "secret" },
  });
  t.after(() => reopened.close());
  assert.equal(
    (await reopened.snapshot()).tasks[0].verification.status,
    "passed",
  );
});
test("late receipts invalidate persisted and inflight verification while preserving reconciliation", async (t) => {
  let transport = async () => Response.json(build);
  const { service, taskId, receipt } = await completedFixture(t, {
    cancelBeforeComplete: true,
    integrationsFetch: (...args) => transport(...args),
  });
  transport = githubFetch(taskId);
  let task = (await service.snapshot()).tasks[0];
  assert.equal(
    (
      await service.verifyResult(
        taskId,
        { expectedRevision: task.revision },
        manager,
      )
    ).verification.status,
    "passed",
  );
  let release, started;
  const waiting = new Promise((r) => {
    started = r;
  });
  let first = true;
  const ordinary = transport;
  transport = async (...args) => {
    if (first) {
      first = false;
      started();
      await new Promise((r) => {
        release = r;
      });
    }
    return ordinary(...args);
  };
  task = (await service.snapshot()).tasks[0];
  const pending = service.verifyResult(
    taskId,
    { expectedRevision: task.revision },
    manager,
  );
  await waiting;
  await service.complete(
    taskId,
    {
      ...receipt,
      result: {
        ...receipt.result,
        changes: { ...receipt.result.changes, commit: "e".repeat(40) },
      },
    },
    worker,
  );
  release();
  await pending;
  task = (await service.snapshot()).tasks[0];
  assert.equal(task.verification.status, "stale");
  assert.equal(task.reconciliation.status, "required");
  assert.equal(task.result.changes.commit, "e".repeat(40));
});
test("management CI routes enforce authentication CSRF and worker separation", async (t) => {
  const { createConsoleServer } =
    await import("../apps/healing-hub/src/console-server.mjs");
  const { service, rootDir } = await fixture(t);
  await service.close();
  const server = createConsoleServer({
    rootDir,
    consoleToken: "admin-secret",
    workerToken: "worker-secret",
    integrationsConfig,
    integrationsEnv: { TOKEN: "secret" },
    integrationsFetch: async () => Response.json(build),
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.shutdown());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (path, headers, body) =>
    fetch(origin + "/api/healing" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  for (const path of [
    "/integrations/jenkins/builds",
    "/tasks/01234567-89ab-cdef-0123-456789abcdef/verification",
  ]) {
    assert.equal((await post(path, {}, {})).status, 401);
    assert.equal(
      (await post(path, { Authorization: "Bearer worker-secret" }, {})).status,
      401,
    );
  }
  const login = await post(
    "/session",
    { Authorization: "Bearer admin-secret" },
    {},
  );
  const session = await login.json();
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.equal(
    (
      await post(
        "/integrations/jenkins/builds",
        { Cookie: cookie },
        { sourceId: "ci", buildNumber: 7 },
      )
    ).status,
    403,
  );
  const response = await post(
    "/integrations/jenkins/builds",
    {
      Cookie: cookie,
      "X-Heal-Csrf": session.snapshot.csrfToken,
      Origin: origin,
    },
    { sourceId: "ci", buildNumber: 7 },
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).outcome, "created");
});
