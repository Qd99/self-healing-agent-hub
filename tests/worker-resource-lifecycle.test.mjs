import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { createWorkspaceEngine } from "../apps/healing-worker/src/workspace.mjs";
import { createWorkerRuntime } from "../apps/healing-worker/src/runtime.mjs";
import { openJournal } from "../apps/healing-worker/src/journal.mjs";
import { createCheckRunner } from "../apps/healing-worker/src/check-runner.mjs";
import { claim as makeClaim } from "./fixtures/worker/fixture.mjs";
import { createDockerTransport } from "./fixtures/worker/docker-transport.mjs";

const token = "12345678-1234-4234-8234-123456789abc";
const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const containerId = "c".repeat(64);
function checkResource(cwd) {
  return {
    version: 1,
    name: `healing-check-${token}`,
    runId: token,
    cwd,
    containerId,
  };
}
function uncertain() {
  return Object.assign(Error("Docker cleanup could not be confirmed"), {
    code: "CHECK_CLEANUP_UNCERTAIN",
  });
}
async function fixture(t, runCheck = async () => ({ exitCode: 1 })) {
  const root = await mkdtemp(join(tmpdir(), "worker-lifecycle-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  await writeFile(join(repo, "value.txt"), "broken\n");
  git("add", ".");
  git("commit", "-qm", "failure");
  const base = git("rev-parse", "HEAD");
  const config = {
    workerId: "worker-lifecycle",
    engineId: "fast",
    publish: { enabled: false },
    dataDir: join(root, "data"),
    repository: { fullName: "acme/project", branch: "main", localPath: repo },
    model: { contextPaths: ["value.txt"] },
    checks: {
      image: `node@sha256:${"a".repeat(64)}`,
      commands: { test: ["node", "test.mjs"] },
      timeoutMs: 1000,
    },
    heartbeatIntervalMs: 10,
    pollIntervalMs: 10,
  };
  const claim = makeClaim();
  claim.task.task.payload.context.commitSha = base;
  claim.task.task.payload.context.source.commitSha = base;
  claim.context.safety = { requiredChecks: ["test"], maxFilesPerFix: 2 };
  let journal = await openJournal(config.dataDir);
  const sent = [];
  let claims = 0,
    generations = 0;
  const client = {
    claim: async () => {
      claims++;
      return claim;
    },
    heartbeat: async () => ({ lease: claim.lease, cancelRequested: false }),
    complete: async (id, body) => sent.push({ method: "complete", body }),
    cancelled: async (id, body) => sent.push({ method: "cancelled", body }),
    proposal: async () => {
      throw Error("No proposal expected");
    },
  };
  const publisher = { readBase: async () => base, recover: async () => ({}) };
  const engine = createWorkspaceEngine(config, {
    runCheck,
    generate: async () => {
      generations++;
      return {
        summary: "Fix value",
        changes: [{ path: "value.txt", content: "fixed\n" }],
      };
    },
  });
  const worker = () =>
    createWorkerRuntime(config, { engine, client, publisher, journal });
  const id = claim.task.task.id;
  t.after(async () => {
    await journal.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    config,
    claim,
    client,
    publisher,
    engine,
    sent,
    worker,
    id,
    get journal() {
      return journal;
    },
    get claims() {
      return claims;
    },
    get generations() {
      return generations;
    },
    async reopen() {
      await journal.close();
      journal = await openJournal(config.dataDir);
    },
    async seed(state = "claimed", extra = {}) {
      const cwd = join(config.dataDir, `workspace-${workspaceId}`);
      await mkdir(cwd);
      await writeFile(join(cwd, "value.txt"), "keep until stopped\n");
      const resources = {
        version: 1,
        workspace: cwd,
        check: checkResource(cwd),
      };
      await journal.put(id, {
        state,
        claim,
        known: {},
        resourceVersion: 1,
        resources,
        ...extra,
      });
      return cwd;
    },
  };
}

test("unconfirmed active cancellation keeps durable container identity and mounted workspace without a stop ACK", async (t) => {
  let started = false,
    cwd;
  const runCheck = async (spec, options) => {
    cwd = spec.cwd;
    await options.onResource?.(checkResource(cwd));
    started = true;
    await new Promise((resolve) =>
      options.signal.addEventListener("abort", resolve, { once: true }),
    );
    throw uncertain();
  };
  runCheck.recover = async () => {
    throw uncertain();
  };
  const f = await fixture(t, runCheck);
  f.client.heartbeat = async () => ({
    lease: f.claim.lease,
    cancelRequested: started,
  });
  await f.worker().runOnce();
  assert.equal(
    f.sent.length,
    0,
    "no stopped receipt while the container may still run",
  );
  const record = f.journal.get(f.id);
  assert.equal(record.state, "cleanup-pending");
  assert.equal(record.resources.check.containerId, containerId);
  assert.equal(await readFile(join(cwd, "value.txt"), "utf8"), "broken\n");
  await f.reopen();
  await f.worker().runOnce();
  assert.equal(f.claims, 1, "blocked recovery must not claim another task");
  assert.equal(f.sent.length, 0);
});

test("restart cleans saved check before deleting workspace and acknowledging the interrupted lease", async (t) => {
  let f,
    recovered = 0;
  const runCheck = async () => {
    throw Error("old check must never resume");
  };
  runCheck.recover = async (resource) => {
    recovered++;
    assert.equal(resource.containerId, containerId);
    assert.equal(
      await readFile(join(resource.cwd, "value.txt"), "utf8"),
      "keep until stopped\n",
    );
  };
  f = await fixture(t, runCheck);
  const cwd = await f.seed();
  await f.reopen();
  f.client.complete = async (id, body) => {
    await assert.rejects(access(cwd), { code: "ENOENT" });
    assert.equal(f.journal.get(id).resources, null);
    f.sent.push({ method: "complete", body });
  };
  await f.worker().runOnce();
  assert.equal(recovered, 1);
  assert.equal(f.claims, 0);
  assert.equal(f.generations, 0);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].body.result.success, false);
  assert.equal(f.journal.get(f.id).state, "done");
});

test("daemon unavailable after restart retains recovery state across restarts and later releases one frozen cancellation", async (t) => {
  let unavailable = true,
    recoveries = 0;
  const runCheck = async () => {
    throw Error("must not execute");
  };
  runCheck.recover = async () => {
    recoveries++;
    if (unavailable) throw uncertain();
  };
  const f = await fixture(t, runCheck);
  const cwd = await f.seed("cleanup-pending", {
    cancelRequested: true,
    stopReason: "Cancellation requested",
  });
  await f.reopen();
  await f.worker().runOnce();
  await f.reopen();
  await f.worker().runOnce();
  assert.equal(f.sent.length, 0);
  assert.equal(f.claims, 0);
  assert.equal(f.journal.get(f.id).state, "cleanup-pending");
  assert.equal(
    await readFile(join(cwd, "value.txt"), "utf8"),
    "keep until stopped\n",
  );
  unavailable = false;
  await f.worker().runOnce();
  assert.equal(recoveries, 3);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].method, "cancelled");
  assert.equal(f.sent[0].body.result.error.code, "TASK_CANCELLED");
  assert.equal(f.journal.get(f.id).state, "done");
  await assert.rejects(access(cwd), { code: "ENOENT" });
});

test("resource cleanup precedes even a saved outbox replay", async (t) => {
  let confirmed = false;
  const runCheck = async () => {
    throw Error("must not run");
  };
  runCheck.recover = async () => {
    confirmed = true;
  };
  const f = await fixture(t, runCheck);
  const body = {
    workerId: f.config.workerId,
    leaseId: f.claim.lease.id,
    result: { success: false, action: "failed", evidence: {}, logs: [] },
  };
  const cwd = await f.seed("outbox", { outbox: { method: "complete", body } });
  f.client.complete = async (id, sentBody) => {
    assert.equal(confirmed, true);
    await assert.rejects(access(cwd), { code: "ENOENT" });
    assert.deepEqual(sentBody, body);
    f.sent.push(sentBody);
  };
  await f.worker().runOnce();
  assert.equal(f.sent.length, 1);
  assert.equal(f.claims, 0);
  assert.equal(f.journal.get(f.id).state, "done");
});

test("legacy active records without durable resource identity block ACK and new work", async (t) => {
  const f = await fixture(t);
  await f.journal.put(f.id, { state: "claimed", claim: f.claim, known: {} });
  await f.worker().runOnce();
  await f.reopen();
  await f.worker().runOnce();
  assert.equal(f.sent.length, 0);
  assert.equal(f.claims, 0);
  assert.equal(f.journal.get(f.id).state, "cleanup-pending");
  assert.equal(
    f.journal.get(f.id).cleanupError,
    "LEGACY_RESOURCE_IDENTITY_MISSING",
  );
});

test("failed durable check intent never starts the external workload", async (t) => {
  let starts = 0;
  const runCheck = async (spec, options) => {
    await options.onResource?.(checkResource(spec.cwd));
    starts++;
    return { exitCode: 0 };
  };
  const f = await fixture(t, runCheck);
  const put = f.journal.put;
  f.journal.put = async (id, record) => {
    if (record.resources?.check) throw Error("fixture durable write failure");
    return put(id, record);
  };
  await f.worker().runOnce();
  assert.equal(starts, 0);
  assert.equal(f.generations, 0);
});

test("recovery refuses resources outside its private workspace root", async (t) => {
  let removals = 0;
  const runCheck = async () => {
    throw Error("must not run");
  };
  runCheck.recover = async () => {
    removals++;
  };
  const f = await fixture(t, runCheck);
  const outside = join(f.root, "other-project");
  await mkdir(outside);
  await writeFile(join(outside, "value.txt"), "unrelated\n");
  await f.journal.put(f.id, {
    state: "claimed",
    claim: f.claim,
    known: {},
    resourceVersion: 1,
    resources: {
      version: 1,
      workspace: outside,
      check: checkResource(outside),
    },
  });
  await f.worker().runOnce();
  assert.equal(f.sent.length, 0);
  assert.equal(f.claims, 0);
  assert.equal(removals, 0);
  assert.equal(
    await readFile(join(outside, "value.txt"), "utf8"),
    "unrelated\n",
  );
});

test("incomplete persisted resource state never becomes proof of an idle worker", async (t) => {
  for (const omitted of ["resources", "check"]) {
    await t.test(omitted, async (t) => {
      const f = await fixture(t);
      const cwd = await f.seed();
      const record = f.journal.get(f.id);
      if (omitted === "resources") delete record.resources;
      else delete record.resources.check;
      await f.journal.put(f.id, record);
      await f.reopen();
      await f.worker().runOnce();
      assert.equal(f.sent.length, 0);
      assert.equal(f.claims, 0);
      assert.equal(f.journal.get(f.id).state, "cleanup-pending");
      assert.equal(
        await readFile(join(cwd, "value.txt"), "utf8"),
        "keep until stopped\n",
      );
    });
  }
});

test("actual Docker runner cancellation cannot acknowledge a failed remove and recovers before the next claim", async (t) => {
  const docker = createDockerTransport();
  docker.control.removeExitCode = 1;
  let started = false;
  docker.onStart = async (container, { signal }) => {
    started = true;
    await new Promise((resolve) =>
      signal.addEventListener("abort", resolve, { once: true }),
    );
    throw Error("Process aborted");
  };
  const f = await fixture(
    t,
    createCheckRunner({ runCommand: docker.runCommand }),
  );
  f.client.heartbeat = async () => ({
    lease: f.claim.lease,
    cancelRequested: started,
  });
  await f.worker().runOnce();
  assert.equal(f.sent.length, 0);
  const interrupted = f.journal.get(f.id);
  assert.equal(interrupted.state, "cleanup-pending");
  assert.equal(
    docker.containers.get(interrupted.resources.check.containerId).State
      .Running,
    true,
  );
  assert.equal(
    await readFile(join(interrupted.resources.workspace, "value.txt"), "utf8"),
    "broken\n",
  );
  await f.reopen();
  docker.control.removeExitCode = 0;
  await f.worker().runOnce();
  assert.equal(docker.containers.size, 0);
  assert.equal(f.claims, 1);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].method, "cancelled");
  assert.equal(f.journal.get(f.id).state, "done");
});

for (const daemonUnavailable of [false, true]) {
  test(`SIGKILL during a started check restores durable ownership${daemonUnavailable ? " and blocks until daemon recovery" : " before its failed receipt"}`, async (t) => {
    const docker = createDockerTransport();
    const f = await fixture(
      t,
      createCheckRunner({ runCommand: docker.runCommand }),
    );
    await f.journal.close();
    const childConfig = join(f.root, "crash-fixture.json");
    await writeFile(
      childConfig,
      JSON.stringify({ config: f.config, claim: f.claim }),
      { mode: 0o600 },
    );
    const child = fork(
      fileURLToPath(
        new URL("./fixtures/worker/crash-child.mjs", import.meta.url),
      ),
      [childConfig],
      {
        execArgv: [],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    let errors = "";
    child.stderr.on("data", (chunk) => {
      errors += chunk.toString();
    });
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error(`Worker never reached check: ${errors}`)),
        5000,
      );
      child.once("message", (message) => {
        clearTimeout(timer);
        if (message.kind === "check-started") resolve();
        else
          reject(
            Error(
              `Worker ended before a durable running check: ${message.kind}`,
            ),
          );
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        reject(
          Error(`Worker exited before check (${code}/${signal}): ${errors}`),
        );
      });
    });
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    assert.deepEqual(await exited, [null, "SIGKILL"]);
    await f.reopen();
    const saved = f.journal.get(f.id);
    assert.equal(saved.state, "claimed");
    assert.match(saved.resources.check.containerId, /^[a-f0-9]{64}$/);
    // Docker outlives the killed Worker; reconstruct only the external transport
    // from its durable identity, without changing the saved journal.
    docker.addContainer(saved.resources.check);
    if (daemonUnavailable) {
      docker.control.listError = Error("daemon unavailable");
      await f.worker().runOnce();
      assert.equal(f.sent.length, 0);
      assert.equal(f.claims, 0);
      assert.equal(docker.containers.size, 1);
      assert.equal(f.journal.get(f.id).state, "cleanup-pending");
      await access(saved.resources.workspace);
      await f.reopen();
      docker.control.listError = undefined;
    }
    await f.worker().runOnce();
    assert.equal(docker.containers.size, 0);
    await assert.rejects(access(saved.resources.workspace), { code: "ENOENT" });
    assert.equal(f.claims, 0);
    assert.equal(f.generations, 0);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].body.result.success, false);
    assert.equal(f.journal.get(f.id).state, "done");
    assert.equal(
      docker.calls.some((call) =>
        ["create", "start", "run"].includes(call.args[0]),
      ),
      false,
    );
  });
}
