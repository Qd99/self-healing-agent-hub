/** Real Git, Workspace, Hub service and durable journal. External model, checks
 * and publisher are controlled fixtures; no production service is contacted. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createHealingService } from "../apps/healing-hub/src/console-service.mjs";
import { createWorkspaceEngine } from "../apps/healing-worker/src/workspace.mjs";
import { createWorkerRuntime } from "../apps/healing-worker/src/runtime.mjs";
import { openJournal } from "../apps/healing-worker/src/journal.mjs";
import { config as workerConfig } from "./fixtures/worker/fixture.mjs";

const manager = { id: "manager", name: "Manager" };
async function fixture(
  t,
  { path = "value.mjs", changes, loseAck = false } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "candidate-boundary-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.test",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.test",
      },
    }).trim();
  git("init", "-q", "--initial-branch=main");
  await mkdir(join(repo, "src"));
  await writeFile(join(repo, path), "broken\n");
  git("add", ".");
  git("commit", "-qm", "Failing baseline");
  const base = git("rev-parse", "HEAD");
  const hubRoot = join(root, "hub");
  await mkdir(join(hubRoot, "configs"), { recursive: true });
  await writeFile(
    join(hubRoot, "configs/healing-config.json"),
    JSON.stringify({
      project: {
        id: "candidate-boundary",
        repo: "acme/project",
        defaultBranch: "main",
      },
      engines: { fast: { type: "pull-worker" } },
      safety: { requiredChecks: ["test"], maxFilesPerFix: 2 },
      triggers: { manual: { enabled: true } },
    }),
  );
  await writeFile(
    join(hubRoot, "configs/healing-rules.json"),
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
  const revision = {
    SHA1: base,
    branch: [{ name: "origin/main", SHA1: base }],
  };
  const service = createHealingService({
    rootDir: hubRoot,
    integrationsConfig: {
      jenkins: {
        enabled: true,
        sourceId: "ci",
        generation: "1",
        baseUrl: "https://ci.example/",
        jobSegments: ["test"],
        repo: "acme/project",
        branch: "main",
        scmBranch: "origin/main",
        scmRemoteUrls: ["https://github.com/acme/project.git"],
      },
    },
    integrationsFetch: async () =>
      Response.json({
        number: 7,
        building: false,
        result: "FAILURE",
        actions: [
          {
            _class: "hudson.plugins.git.util.BuildData",
            remoteUrls: ["https://github.com/acme/project.git"],
            lastBuiltRevision: revision,
            buildsByBranchName: {
              "origin/main": { buildNumber: 7, revision, marked: revision },
            },
          },
        ],
      }),
  });
  const config = {
    ...workerConfig(),
    dataDir: join(root, "worker"),
    repository: { fullName: "acme/project", branch: "main", localPath: repo },
    model: { contextPaths: [path] },
    checks: {
      image: "fixture@sha256:" + "a".repeat(64),
      commands: { test: ["fixture-check"] },
    },
  };
  const actor = { id: "worker", name: "Worker", workerId: config.workerId };
  let modelCalls = 0,
    checkCalls = 0,
    publishes = 0,
    claims = 0;
  const bodies = [];
  const engine = createWorkspaceEngine(config, {
    generate: async () => {
      modelCalls++;
      return {
        summary: "\nFix value\n",
        changes: changes ?? [{ path, content: "fixed\n" }],
      };
    },
    runCheck: async ({ cwd }) => {
      checkCalls++;
      return {
        exitCode:
          (await readFile(join(cwd, path), "utf8")) === "fixed\n" ? 0 : 1,
      };
    },
  });
  const client = {
    claim: async (body) => {
      claims++;
      return service.claim(body, actor);
    },
    heartbeat: (id, body) => service.heartbeat(id, body, actor),
    proposal: async (id, body) => {
      bodies.push(structuredClone(body));
      const ack = await service.proposal(id, body, actor);
      if (loseAck && bodies.length === 1) throw Error("Lost proposal ACK");
      return ack;
    },
    complete: (id, body) => service.complete(id, body, actor),
    cancelled: (id, body) => service.cancelled(id, body, actor),
  };
  const publisher = {
    readBase: async () => base,
    recover: async () => ({}),
    publish: async ({ prepared }) => {
      publishes++;
      return {
        commit: "c".repeat(40),
        pr: 7,
        files: prepared.files.map((file) => file.path),
      };
    },
  };
  let journal = await openJournal(config.dataDir);
  let worker = createWorkerRuntime(config, {
    client,
    journal,
    engine,
    publisher,
  });
  t.after(async () => {
    await worker.close();
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const { taskId } = await service.importJenkinsBuild(
    { sourceId: "ci", buildNumber: 7 },
    manager,
  );
  return {
    config,
    hubRoot,
    service,
    actor,
    engine,
    client,
    taskId,
    bodies,
    get worker() {
      return worker;
    },
    get journal() {
      return journal;
    },
    get modelCalls() {
      return modelCalls;
    },
    get checkCalls() {
      return checkCalls;
    },
    get publishes() {
      return publishes;
    },
    get claims() {
      return claims;
    },
    async restart() {
      await worker.close();
      journal = await openJournal(config.dataDir);
      worker = createWorkerRuntime(config, {
        client,
        journal,
        engine,
        publisher,
      });
    },
    async task() {
      return (await service.snapshot()).tasks.find(
        (entry) => entry.task.id === taskId,
      );
    },
    async approve(nodeId) {
      const task = await this.task();
      return service.decide(
        taskId,
        {
          expectedRevision: task.revision,
          round: task.approvalFlow.round,
          nodeId,
          decision: "approve",
          comment: "Reviewed exact candidate",
        },
        manager,
      );
    },
  };
}

test("real Hub acknowledges canonical model summary and preserves lost ACK identity through restart", async (t) => {
  const f = await fixture(t, { loseAck: true });
  await f.worker.runOnce();
  let record = f.journal.get(f.taskId);
  assert.equal(record.state, "proposal-pending");
  assert.equal(record.artifact.summary, "Fix value");
  assert.equal(record.proposalBody.summary, "Fix value");
  assert.equal((await f.task()).proposal.summary, "Fix value");
  await f.restart();
  await f.worker.runOnce();
  record = f.journal.get(f.taskId);
  assert.equal(record.state, "proposed");
  assert.deepEqual(f.bodies[0], f.bodies[1]);
  assert.equal(f.modelCalls, 1);
  assert.equal(
    record.proposal.contentHash,
    (await f.task()).proposal.contentHash,
  );
  f.config.publish.enabled = true;
  await f.worker.runOnce();
  assert.equal(f.publishes, 0);
  await f.approve("code-review");
  await f.worker.runOnce();
  assert.equal(f.publishes, 0);
  await f.approve("execution-auth");
  await f.worker.runOnce();
  assert.equal(f.publishes, 1);
  assert.equal((await f.task()).status.status, "completed");
});

test("legacy raw-summary pending proposal replays original body and adopts only canonical artifact metadata", async (t) => {
  const f = await fixture(t);
  const claim = await f.client.claim({
    engineId: "fast",
    workerId: f.config.workerId,
    candidateVersions: [2],
  });
  const output = await f.engine.diagnose(claim);
  const proposalBody = {
    workerId: f.config.workerId,
    leaseId: claim.lease.id,
    submissionId: "legacy-summary",
    summary: "\nFix value\n",
    candidate: output.candidate,
    diff: output.diff,
    evidence: output.evidence,
  };
  const ack = await f.service.proposal(f.taskId, proposalBody, f.actor);
  await assert.rejects(
    f.service.proposal(
      f.taskId,
      { ...proposalBody, summary: "Fix value" },
      f.actor,
    ),
    (error) => error.code === "IDEMPOTENCY_CONFLICT",
    "accepted legacy submission remains bound to its original request body",
  );
  await f.journal.put(f.taskId, {
    state: "proposal-pending",
    claim,
    known: {},
    proposalBody,
    artifact: { ...output.artifact, summary: "\nFix value\n" },
  });
  await f.restart();
  await f.worker.runOnce();
  const record = f.journal.get(f.taskId);
  assert.equal(record.state, "proposed");
  assert.deepEqual(f.bodies, [proposalBody]);
  assert.deepEqual(record.proposalBody, proposalBody);
  assert.deepEqual(record.proposal, ack.proposal);
  assert.equal(record.artifact.summary, "Fix value");
  assert.equal(f.modelCalls, 1);
  assert.equal(f.claims, 1, "recovery does not claim another task");
});

test("real Hub v2 paths preserve internal spaces and Unicode exactly", async (t) => {
  for (const path of [
    "src/value with space.mjs",
    "src/值.mjs",
    "src/e\u0301.mjs",
  ]) {
    await t.test(path, async (t) => {
      const f = await fixture(t, { path });
      await f.worker.runOnce();
      const record = f.journal.get(f.taskId);
      assert.equal(record.state, "proposed");
      assert.equal(record.artifact.files[0].path, path);
      assert.equal(record.proposalBody.diff[0].path, path);
      assert.equal((await f.task()).diff[0].path, path);
    });
  }
});

test("model path aliases are rejected before candidate checks or Hub proposal", async (t) => {
  for (const path of [
    " value.mjs",
    "value.mjs ",
    "src/value:copy.mjs",
    "a".repeat(250) + "/" + "b".repeat(250),
  ]) {
    await t.test(
      path.length > 100 ? "path exceeds protocol length" : JSON.stringify(path),
      async (t) => {
        const f = await fixture(t, {
          changes: [
            { path: "value.mjs", content: "fixed\n" },
            { path, content: "other\n" },
          ],
        });
        await f.worker.runOnce();
        assert.equal(
          f.checkCalls,
          1,
          "invalid path rejects the full generation before writes/checks",
        );
        assert.equal(f.bodies.length, 0);
        assert.equal(f.journal.get(f.taskId).artifact, undefined);
        assert.equal((await f.task()).proposal, undefined);
      },
    );
  }
});

test("real Hub rejects v2 path aliases without silently changing the reviewed path", async (t) => {
  const f = await fixture(t);
  const claim = await f.client.claim({
    engineId: "fast",
    workerId: f.config.workerId,
    candidateVersions: [2],
  });
  const output = await f.engine.diagnose(claim);
  for (const path of [
    " value.mjs",
    "value.mjs ",
    "\u00a0value.mjs",
    "a\tb",
    ".Git/config",
  ]) {
    await assert.rejects(
      f.service.proposal(
        f.taskId,
        {
          workerId: f.config.workerId,
          leaseId: claim.lease.id,
          submissionId: "invalid-path",
          summary: output.summary,
          candidate: output.candidate,
          diff: [{ ...output.diff[0], path }],
          evidence: output.evidence,
        },
        f.actor,
      ),
      (error) => error.code === "INVALID_REQUEST",
    );
  }
  assert.equal((await f.task()).proposal, undefined);
});

// Frozen pre-normalization v2 serializer for seeding historical Hub state. It
// deliberately does not call the current normalizer or hash under test.
function legacyHash(value) {
  const ordered = (item) =>
    Array.isArray(item)
      ? item.map(ordered)
      : item && typeof item === "object"
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, ordered(item[key])]),
          )
        : item;
  return createHash("sha256")
    .update(JSON.stringify(ordered(value)))
    .digest("hex");
}

test("saved legacy Hub v2 paths reopen with the original hash and still reject tampered identity", async (t) => {
  for (const path of ["a\tb", ".Git/config"]) {
    await t.test(JSON.stringify(path), async (t) => {
      const f = await fixture(t);
      await f.worker.runOnce();
      await f.worker.close();
      await f.service.close();
      const filename = join(f.hubRoot, ".healing/console-state.json");
      const state = JSON.parse(await readFile(filename, "utf8"));
      const entry = state.tasks.find((item) => item.task.id === f.taskId);
      const identity = () => ({
        version: 2,
        task: {
          id: entry.task.id,
          repo: entry.task.payload.repo,
          branch: entry.task.payload.branch,
          source: entry.task.payload.context.source,
          commitSha: entry.task.payload.context.commitSha,
        },
        action: entry.routingRule.processor.action,
        summary: entry.proposal.summary,
        candidate: entry.proposal.candidate,
        diff: entry.diff,
        evidence: entry.evidence,
      });
      assert.equal(legacyHash(identity()), entry.proposal.contentHash);
      entry.diff[0].path = path;
      entry.task.payload.files = [path];
      const hash = legacyHash(identity());
      entry.proposal.contentHash = hash;
      entry.proposalSubmission.response.proposal.contentHash = hash;
      const body = { ...f.bodies[0], diff: entry.diff };
      entry.proposalSubmission.fingerprint = legacyHash({
        command: "proposal",
        payload: body,
      });
      const original = JSON.stringify(state);
      await writeFile(filename, original);
      const reopened = createHealingService({ rootDir: f.hubRoot });
      try {
        const task = (await reopened.snapshot()).tasks.find(
          (item) => item.task.id === f.taskId,
        );
        assert.equal(task.proposal.contentHash, hash);
        assert.equal(task.diff[0].path, path);
        assert.equal(
          await readFile(filename, "utf8"),
          original,
          "opening legacy state must not rewrite approved identity",
        );
      } finally {
        await reopened.close();
      }
      entry.proposal.contentHash = "0".repeat(64);
      await writeFile(filename, JSON.stringify(state));
      const tampered = createHealingService({ rootDir: f.hubRoot });
      try {
        await assert.rejects(
          tampered.snapshot(),
          (error) => error.code === "STORE_INVALID",
        );
      } finally {
        await tampered.close().catch(() => {});
      }
    });
  }
});

test("v1 proposals retain existing Hub text and path normalization", async (t) => {
  const f = await fixture(t);
  const { taskId } = await f.service.trigger(
    { title: "Legacy manual repair", type: "ci-failure", priority: "high" },
    manager,
  );
  const claim = await f.client.claim({
    engineId: "fast",
    workerId: f.config.workerId,
    candidateVersions: [1],
  });
  assert.equal(claim.task.task.id, taskId);
  await f.service.proposal(
    taskId,
    {
      leaseId: claim.lease.id,
      summary: "\nLegacy fix\n",
      diff: [
        {
          path: " value.mjs ",
          additions: 1,
          deletions: 0,
          lines: [{ type: "add", content: " exact diff content " }],
        },
      ],
      evidence: { testsRun: [" test "], checksPass: ["test"] },
    },
    f.actor,
  );
  const task = (await f.service.snapshot()).tasks.find(
    (entry) => entry.task.id === taskId,
  );
  assert.equal(task.proposal.version, undefined);
  assert.equal(task.proposal.summary, "Legacy fix");
  assert.equal(task.diff[0].path, "value.mjs");
  assert.equal(task.diff[0].lines[0].content, " exact diff content ");
  assert.deepEqual(task.evidence.testsRun, ["test"]);
});

test("legacy noncanonical paths remain blocked across restart without replay or new claims", async (t) => {
  for (const path of [" value.mjs", "a\tb", ".Git/config"]) {
    await t.test(JSON.stringify(path), async (t) => {
      const f = await fixture(t);
      const claim = await f.client.claim({
        engineId: "fast",
        workerId: f.config.workerId,
        candidateVersions: [2],
      });
      const output = await f.engine.diagnose(claim);
      const diff = [{ ...output.diff[0], path }];
      const proposalBody = {
        workerId: f.config.workerId,
        leaseId: claim.lease.id,
        submissionId: "legacy-path",
        summary: output.summary,
        candidate: output.candidate,
        diff,
        evidence: output.evidence,
      };
      await f.journal.put(f.taskId, {
        state: "proposal-pending",
        claim,
        known: {},
        proposalBody,
        artifact: { ...output.artifact, diff },
      });
      for (let attempt = 0; attempt < 2; attempt++) {
        await f.restart();
        await f.worker.runOnce();
        const record = f.journal.get(f.taskId);
        assert.equal(record.state, "candidate-blocked");
        assert.deepEqual(record.proposalBody, proposalBody);
        assert.equal(
          f.bodies.length,
          0,
          "never submit an alias that could identify another path",
        );
        assert.equal(f.claims, 1, "blocked history prevents new work");
        assert.equal(f.modelCalls, 1);
      }
    });
  }
});
