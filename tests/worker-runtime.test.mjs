import test from "node:test";
import assert from "node:assert/strict";
import { createWorkerRuntime } from "../apps/healing-worker/src/runtime.mjs";
import { hashCandidateV2 } from "../packages/framework/src/candidate.mjs";
import {
  claim,
  base,
  result,
  config,
  memory,
} from "./fixtures/worker/fixture.mjs";
function setup(c = claim()) {
  const journal = memory(),
    sent = [];
  const cfg = config();
  const client = {
    claim: async (body) => {
      sent.push(["claim", body]);
      return c;
    },
    heartbeat: async () => ({ lease: { ...c.lease }, cancelRequested: false }),
    proposal: async (id, body) => {
      sent.push(["proposal", body]);
      assert.ok(journal.get(id).proposalBody);
      return {
        proposal: {
          id: "proposal-1",
          version: 2,
          candidate: body.candidate,
          contentHash: hashCandidateV2({
            task: c.task.task,
            action: "create-pr",
            ...body,
          }),
        },
      };
    },
    complete: async (id, body) => sent.push(["complete", body]),
    cancelled: async (id, body) => sent.push(["cancelled", body]),
  };
  const publisher = {
    readBase: async () => base,
    publish: async () => {
      throw Error("should not publish");
    },
    recover: async () => ({}),
  };
  const engine = { diagnose: async () => result() };
  return { journal, sent, cfg, client, publisher, engine, c };
}
async function approved(s) {
  const worker = createWorkerRuntime(s.cfg, s);
  await worker.runOnce();
  const rec = s.journal.get(s.c.task.task.id);
  s.c.lease.phase = "execute";
  s.c.lease.id = "lease-2";
  s.c.task.proposal = rec.proposal;
  s.cfg.publish.enabled = true;
  s.engine.prepareExecution = async (c, a) => ({
    candidate: a.candidate,
    files: a.files,
    cleanup: async () => {},
  });
  return worker;
}
test("diagnose saves artifact/submission before sending, stores ACK and filters claims", async () => {
  const s = setup();
  await createWorkerRuntime(s.cfg, s).runOnce();
  const rec = s.journal.get(s.c.task.task.id);
  assert.equal(rec.state, "proposed");
  assert.equal(rec.proposal.id, "proposal-1");
  assert.deepEqual(s.sent[0][1].phases, ["diagnose"]);
  assert.deepEqual(s.sent[0][1].candidateVersions, [2]);
});
test("lost proposal ACK replays the exact saved submission without generation", async () => {
  const s = setup();
  const bodies = [],
    send = s.client.proposal;
  s.client.proposal = async (id, b) => {
    bodies.push(structuredClone(b));
    if (bodies.length === 1) throw Error("lost ACK");
    return send(id, b);
  };
  await createWorkerRuntime(s.cfg, s).runOnce();
  s.engine.diagnose = () => {
    throw Error("must not regenerate");
  };
  await createWorkerRuntime(s.cfg, s).runOnce();
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0], bodies[1]);
});
test("execute missing saved approval fails before publishing", async () => {
  const s = setup(claim("execute"));
  s.cfg.publish.enabled = true;
  await createWorkerRuntime(s.cfg, s).runOnce();
  assert.equal(s.sent.at(-1)[0], "complete");
  assert.equal(s.sent.at(-1)[1].result.success, false);
});
test("heartbeat cancellation waits for engine stop before cancellation ACK", async () => {
  const s = setup();
  let stopped = false;
  s.client.heartbeat = async () => ({
    cancelRequested: true,
    lease: s.c.lease,
  });
  s.engine.diagnose = async (c, { signal }) =>
    new Promise((resolve, reject) =>
      signal.addEventListener(
        "abort",
        () => {
          stopped = true;
          reject(Error("stopped"));
        },
        { once: true },
      ),
    );
  s.client.cancelled = async (id, b) => {
    assert.equal(stopped, true);
    s.sent.push(["cancelled", b]);
  };
  await createWorkerRuntime(s.cfg, s).runOnce();
  assert.equal(s.sent.at(-1)[0], "cancelled");
});
test("restart recovery reads facts only and freezes an identical outbox across lost ACK", async () => {
  const s = setup(claim("execute"));
  let recovered = 0;
  s.publisher.recover = async () => {
    recovered++;
    return { commit: "c".repeat(40) };
  };
  await s.journal.put(s.c.task.task.id, {
    state: "executing",
    claim: s.c,
    known: { intent: "commit" },
    resourceVersion: 1,
    resources: null,
  });
  const bodies = [];
  s.client.complete = async (id, b) => {
    bodies.push(structuredClone(b));
    if (bodies.length === 1) throw Error("offline");
  };
  await createWorkerRuntime(s.cfg, s).runOnce();
  await createWorkerRuntime(s.cfg, s).runOnce();
  assert.equal(recovered, 1);
  assert.deepEqual(bodies[0], bodies[1]);
  assert.equal(bodies[0].result.success, false);
});
test("approved execute checks fixed base again and reports bound real facts after cleanup", async () => {
  const s = setup();
  let reads = 0,
    cleaned = false;
  s.publisher.readBase = async () => {
    reads++;
    return base;
  };
  const worker = await approved(s);
  const proposal = s.c.task.proposal;
  s.engine.prepareExecution = async (c, a) => ({
    candidate: a.candidate,
    files: a.files,
    cleanup: async () => {
      cleaned = true;
    },
  });
  s.publisher.publish = async ({ onProgress, assertActive }) => {
    assertActive();
    await onProgress({ intent: { operation: "create" } });
    assert.equal(
      s.journal.get(s.c.task.task.id).known.intent.operation,
      "create",
    );
    return { commit: "c".repeat(40), pr: 7, files: ["a.js"] };
  };
  await worker.runOnce();
  const body = s.sent.at(-1)[1];
  assert.equal(body.result.success, true);
  assert.equal(body.proposalId, proposal.id);
  assert.equal(body.contentHash, proposal.contentHash);
  assert.equal(cleaned, true);
  assert.equal(reads, 3);
});
test("moved base stops diagnosis before model or checks", async () => {
  const s = setup();
  s.publisher.readBase = async () => "b".repeat(40);
  let called = false;
  s.engine.diagnose = async () => {
    called = true;
    return result();
  };
  await createWorkerRuntime(s.cfg, s).runOnce();
  assert.equal(called, false);
  assert.equal(s.sent.at(-1)[1].result.error.code, "BASE_MOVED");
});
test("uncertain renewal and deadline both abort running work", async () => {
  for (const deadline of [false, true]) {
    const s = setup();
    if (deadline) {
      s.c.lease.expiresAt = new Date(Date.now() + 20).toISOString();
      s.cfg.heartbeatIntervalMs = 1000;
    } else
      s.client.heartbeat = async () => {
        const e = Error("lease rejected");
        e.status = 409;
        throw e;
      };
    let stopped = false;
    s.engine.diagnose = async (c, { signal }) =>
      new Promise((resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            stopped = true;
            reject(Error("stopped"));
          },
          { once: true },
        ),
      );
    await createWorkerRuntime(s.cfg, s).runOnce();
    assert.equal(stopped, true);
    assert.equal(s.sent.at(-1)[0], "complete");
    assert.equal(s.sent.at(-1)[1].result.error.code, "LEASE_STOPPED");
  }
});
test("close waits for active engine cleanup before releasing journal", async () => {
  const s = setup();
  let started,
    stopped = false;
  const ready = new Promise((r) => {
    started = r;
  });
  s.engine.diagnose = async (c, { signal }) => {
    started();
    return new Promise((resolve, reject) =>
      signal.addEventListener(
        "abort",
        () => {
          setTimeout(() => {
            stopped = true;
            reject(Error("stopped"));
          }, 10);
        },
        { once: true },
      ),
    );
  };
  s.journal.close = async () => assert.equal(stopped, true);
  const worker = createWorkerRuntime(s.cfg, s);
  const running = worker.runOnce();
  await ready;
  await worker.close();
  await running;
});
test("once-mode external abort reaches the running engine", async () => {
  const s = setup(),
    controller = new AbortController();
  s.engine.diagnose = async (c, { signal }) => {
    setTimeout(() => controller.abort(), 10);
    return new Promise((resolve, reject) =>
      signal.addEventListener("abort", () => reject(Error("stopped")), {
        once: true,
      }),
    );
  };
  await createWorkerRuntime(s.cfg, s).runOnce({ signal: controller.signal });
  assert.equal(s.sent.at(-1)[1].result.success, false);
});
test("safe failure categories survive without exposing arbitrary provider text", async () => {
  for (const [message, code] of [
    ["Could not reproduce baseline failure", "BASELINE_NOT_REPRODUCED"],
    ["Docker check could not start", "CHECK_RUNNER_UNAVAILABLE"],
    ["Candidate required checks failed", "CHECKS_FAILED"],
    ["Missing, tampered or stale candidate artifact", "CANDIDATE_INVALID"],
    ["secret-token raw provider body", "WORKER_STOPPED"],
  ]) {
    const s = setup();
    s.engine.diagnose = async () => {
      throw Error(message);
    };
    await createWorkerRuntime(s.cfg, s).runOnce();
    const error = s.sent.at(-1)[1].result.error;
    assert.equal(error.code, code);
    assert.equal(error.message.includes("secret-token"), false);
    assert.equal(error.retriable, false);
  }
});
test("unknown publication side effects preserve intent and freeze a non-retriable failure", async () => {
  const s = setup(),
    worker = await approved(s);
  s.publisher.publish = async ({ onProgress }) => {
    await onProgress({ intent: { operation: "commit" }, uncertain: true });
    throw Error("raw upstream secret");
  };
  await worker.runOnce();
  assert.equal(s.journal.get(s.c.task.task.id).known.uncertain, true);
  assert.equal(s.sent.at(-1)[1].result.error.code, "PUBLICATION_UNCERTAIN");
  assert.equal(s.sent.at(-1)[1].result.error.retriable, false);
  assert.equal(s.sent.at(-1)[1].result.success, false);
});
test("tampered saved artifact fails before preparation or publication", async () => {
  const s = setup(),
    worker = await approved(s),
    id = s.c.task.task.id;
  const record = s.journal.get(id);
  record.artifact.summary = "different candidate";
  await s.journal.put(id, record);
  let prepared = false;
  s.engine.prepareExecution = async () => {
    prepared = true;
  };
  await worker.runOnce();
  assert.equal(prepared, false);
  assert.equal(s.sent.at(-1)[1].result.error.code, "CANDIDATE_INVALID");
});
test("durable identity cannot be changed by restarting with another worker", async () => {
  const s = setup();
  await createWorkerRuntime(s.cfg, s).runOnce();
  s.cfg.workerId = "another-worker";
  await assert.rejects(createWorkerRuntime(s.cfg, s).runOnce(), /identity/);
});
test("cancellation while saving an unsent proposal still acknowledges cancellation", async () => {
  const s = setup(),
    put = s.journal.put;
  let saving = false;
  s.client.heartbeat = async () => ({
    lease: s.c.lease,
    cancelRequested: saving,
  });
  s.journal.put = async (id, record) => {
    await put(id, record);
    if (record.state === "proposal-pending") {
      saving = true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  await createWorkerRuntime(s.cfg, s).runOnce();
  assert.equal(
    s.sent.some(([method]) => method === "proposal"),
    false,
  );
  assert.equal(s.sent.at(-1)[0], "cancelled");
});

test("cancellation during proposal POST persists cancelled outbox after definitive rejection", async () => {
  const s = setup();
  let submitting = false,
    submissions = 0,
    signalSeen;
  const receipts = [];
  s.client.heartbeat = async () => ({
    lease: s.c.lease,
    cancelRequested: submitting,
  });
  s.client.proposal = async (id, body, { signal } = {}) => {
    submitting = true;
    submissions++;
    signalSeen = signal;
    await new Promise((resolve) => setTimeout(resolve, 35));
    const error = Error("rejected");
    error.status = 409;
    error.code = "STATE_CONFLICT";
    throw error;
  };
  s.client.cancelled = async (id, body) => {
    receipts.push(structuredClone(body));
    if (receipts.length === 1) throw Error("lost cancellation ACK");
  };
  const worker = createWorkerRuntime(s.cfg, s);
  const first = await worker.runOnce();
  assert.equal(first.diagnosed, undefined);
  assert.equal(signalSeen?.aborted, true);
  assert.equal(s.journal.get(s.c.task.task.id).state, "outbox");
  await worker.runOnce();
  assert.equal(submissions, 1);
  assert.deepEqual(receipts[0], receipts[1]);
  assert.equal(s.journal.get(s.c.task.task.id).state, "done");
});

test("ambiguous cancelled proposal retains identity until rejected replay resolves cancellation", async () => {
  const s = setup();
  let submitting = false;
  const bodies = [];
  let cancelled = 0;
  s.client.heartbeat = async () => ({
    lease: s.c.lease,
    cancelRequested: submitting,
  });
  s.client.proposal = async (id, body) => {
    bodies.push(structuredClone(body));
    if (bodies.length === 1) {
      submitting = true;
      await new Promise((resolve) => setTimeout(resolve, 35));
      throw Error("aborted response may be committed");
    }
    const error = Error("cancelled");
    error.status = 409;
    error.code = "STATE_CONFLICT";
    throw error;
  };
  s.client.cancelled = async () => {
    cancelled++;
  };
  const worker = createWorkerRuntime(s.cfg, s);
  await worker.runOnce();
  assert.equal(s.journal.get(s.c.task.task.id).state, "proposal-pending");
  await worker.runOnce();
  assert.deepEqual(bodies[0], bodies[1]);
  assert.equal(cancelled, 1);
  assert.equal(s.journal.get(s.c.task.task.id).state, "done");
});

test("ambiguous cancelled proposal can recover an accepted ACK without inventing cancellation", async () => {
  const s = setup(),
    send = s.client.proposal;
  let submitting = false;
  const bodies = [];
  let cancelled = 0;
  s.client.heartbeat = async () => ({
    lease: s.c.lease,
    cancelRequested: submitting,
  });
  s.client.proposal = async (id, body) => {
    bodies.push(structuredClone(body));
    if (bodies.length === 1) {
      submitting = true;
      await new Promise((resolve) => setTimeout(resolve, 35));
      throw Error("lost ACK");
    }
    return send(id, body);
  };
  s.client.cancelled = async () => {
    cancelled++;
  };
  const worker = createWorkerRuntime(s.cfg, s);
  const first = await worker.runOnce();
  assert.equal(first.diagnosed, undefined);
  await worker.runOnce();
  assert.deepEqual(bodies[0], bodies[1]);
  assert.equal(cancelled, 0);
  assert.equal(s.journal.get(s.c.task.task.id).state, "proposed");
});

test("definitively rejected proposal resolves a failed receipt instead of endless regeneration or replay", async () => {
  const s = setup();
  let submissions = 0;
  s.client.proposal = async () => {
    submissions++;
    const error = Error("expired lease");
    error.status = 409;
    error.code = "STATE_CONFLICT";
    throw error;
  };
  const worker = createWorkerRuntime(s.cfg, s);
  await worker.runOnce();
  assert.equal(s.journal.get(s.c.task.task.id).state, "done");
  assert.equal(s.sent.at(-1)[0], "complete");
  assert.equal(s.sent.at(-1)[1].result.success, false);
  assert.equal(submissions, 1);
});

import { createCheckRunner } from "../apps/healing-worker/src/check-runner.mjs";
test("real Docker check-runner startup errors become actionable runtime failure receipts", async () => {
  for (const code of ["ENOENT", "EACCES"]) {
    const s = setup();
    const check = createCheckRunner({
      runCommand: async (command, args) => {
        assert.equal(command, "docker");
        if (args[0] === "run") {
          const error = Error(`spawn docker ${code} private body`);
          error.code = code;
          throw error;
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    s.engine.diagnose = async (c, { signal }) =>
      check(
        {
          cwd: "/tmp/controlled-worker-fixture",
          image: `node@sha256:${"a".repeat(64)}`,
          argv: ["npm", "test"],
        },
        { signal },
      );
    await createWorkerRuntime(s.cfg, s).runOnce();
    const error = s.sent.at(-1)[1].result.error;
    assert.equal(error.code, "CHECK_RUNNER_UNAVAILABLE");
    assert.equal(error.message.includes("private body"), false);
  }
});

for (const status of [401, 403])
  test(`lost accepted proposal ACK survives ${status} until authenticated ACK replay`, async () => {
    const s = setup(),
      submit = s.client.proposal;
    const bodies = [];
    let diagnoses = 0,
      accepted;
    s.engine.diagnose = async () => {
      diagnoses++;
      return result();
    };
    s.client.proposal = async (id, body, options) => {
      bodies.push(structuredClone(body));
      if (bodies.length === 1) {
        accepted = await submit(id, body, options);
        throw Error("accepted response lost");
      }
      if (bodies.length === 2) {
        const error = Error("authentication unavailable");
        error.status = status;
        error.code = "STATE_CONFLICT";
        throw error;
      }
      return submit(id, body, options);
    };
    const worker = createWorkerRuntime(s.cfg, s);
    await worker.runOnce();
    await worker.runOnce();
    assert.equal(s.journal.get(s.c.task.task.id).state, "proposal-pending");
    assert.equal(
      s.sent.some(([kind]) => ["complete", "cancelled"].includes(kind)),
      false,
    );
    await worker.runOnce();
    assert.equal(diagnoses, 1);
    assert.equal(bodies.length, 3);
    assert.deepEqual(bodies[0], bodies[1]);
    assert.deepEqual(bodies[1], bodies[2]);
    assert.deepEqual(
      s.journal.get(s.c.task.task.id).proposal,
      accepted.proposal,
    );
    assert.equal(
      s.sent.some(([kind]) => ["complete", "cancelled"].includes(kind)),
      false,
    );
  });

test("infrastructure responses and unrecognized conflicts cannot replace an ambiguous proposal", async () => {
  for (const status of [400, 404, 408, 409, 422, 429, 500]) {
    const s = setup(),
      submit = s.client.proposal;
    let calls = 0;
    const bodies = [];
    s.client.proposal = async (id, body) => {
      calls++;
      bodies.push(structuredClone(body));
      if (calls === 1) {
        await submit(id, body);
        throw Error("lost accepted ACK");
      }
      if (calls === 2) {
        const error = Error("unrecognized upstream response");
        error.status = status;
        throw error;
      }
      return submit(id, body);
    };
    const worker = createWorkerRuntime(s.cfg, s);
    await worker.runOnce();
    await worker.runOnce();
    assert.equal(
      s.journal.get(s.c.task.task.id).state,
      "proposal-pending",
      `HTTP ${status}`,
    );
    await worker.runOnce();
    assert.equal(s.journal.get(s.c.task.task.id).state, "proposed");
    assert.deepEqual(bodies[0], bodies[2]);
    assert.equal(
      s.sent.some(([kind]) => ["complete", "cancelled"].includes(kind)),
      false,
    );
  }
});
