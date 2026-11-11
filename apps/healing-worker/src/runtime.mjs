import { randomUUID } from "node:crypto";
import { isDefinitiveProposalRejection } from "./hub-client.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual as same } from "node:util";
import {
  hashCandidateV2,
  normalizeCandidateV2,
  validateCandidatePathV2,
} from "../../../packages/framework/src/candidate.mjs";
const FAILURE_REASONS = new Map([
  [
    "Proposal rejected",
    [
      "PROPOSAL_REJECTED",
      "The Hub definitively rejected this saved proposal; work has stopped without regeneration.",
    ],
  ],
  [
    "Base branch moved",
    [
      "BASE_MOVED",
      "The target branch moved from the fixed source commit; import a new task.",
    ],
  ],
  [
    "Could not reproduce baseline failure",
    [
      "BASELINE_NOT_REPRODUCED",
      "Trusted checks could not reproduce the source failure; no repair was proposed.",
    ],
  ],
  [
    "Docker check could not start",
    [
      "CHECK_RUNNER_UNAVAILABLE",
      "The Docker check runner could not start; prepare Docker and the pinned image.",
    ],
  ],
  [
    "Candidate required checks failed",
    ["CHECKS_FAILED", "The candidate failed required trusted checks."],
  ],
  [
    "Unregistered required check",
    [
      "CHECK_NOT_CONFIGURED",
      "A required check is missing from the trusted command registry.",
    ],
  ],
  ...[
    "Check modified workspace files or Git metadata",
    "Check changed candidate",
    "Check changed approved candidate",
  ].map((m) => [
    m,
    [
      "CHECK_MODIFIED_WORKSPACE",
      "A check modified workspace files or Git metadata; the candidate was rejected.",
    ],
  ]),
  ...[
    "Approved artifact unavailable",
    "Artifact identity mismatch",
    "Prepared candidate mismatch",
    "Missing, tampered or stale candidate artifact",
    "Candidate artifact content mismatch",
    "Invalid or stale candidate identity",
  ].map((m) => [
    m,
    [
      "CANDIDATE_INVALID",
      "The saved candidate is missing, damaged, or different from the approved proposal; publication was stopped.",
    ],
  ]),
  [
    "Publishing disabled",
    ["PUBLISH_DISABLED", "Publication is disabled in worker configuration."],
  ],
  [
    "Lease is no longer active",
    [
      "LEASE_STOPPED",
      "The lease expired or became uncertain; work was stopped before further publication.",
    ],
  ],
  [
    "Cancellation requested",
    [
      "TASK_CANCELLED",
      "The Hub requested cancellation; active work has stopped.",
    ],
  ],
  [
    "Unsupported claim",
    [
      "CLAIM_UNSUPPORTED",
      "The claimed task does not match the configured repository, branch, source, or action.",
    ],
  ],
]);
function failureReason(error, known) {
  if (known.uncertain || (known.intent && !known.pr))
    return {
      code: "PUBLICATION_UNCERTAIN",
      message:
        "A publication request may have changed GitHub; manual reconciliation is required before retrying.",
      retriable: false,
    };
  const [code, message] = FAILURE_REASONS.get(error?.message) ?? [
    "WORKER_STOPPED",
    "Worker stopped; inspect protected local state and reconcile known publication facts before retrying.",
  ];
  return { code, message, retriable: false };
}
export function createWorkerRuntime(
  config,
  {
    client,
    engine,
    publisher,
    journal,
    now = () => Date.now(),
    sleep = (ms, options) => delay(ms, undefined, options),
  } = {},
) {
  let busy = false,
    closed = false,
    activeController,
    finishActive,
    activeFinished = Promise.resolve();
  const identity = (claim) => ({
    workerId: config.workerId,
    leaseId: claim.lease.id,
    ...(claim.lease.phase === "execute" && claim.task.proposal
      ? {
          proposalId: claim.task.proposal.id,
          contentHash: claim.task.proposal.contentHash,
        }
      : {}),
  });
  const failure = (known = {}, evidence = {}, error) => ({
    success: false,
    action: "failed",
    evidence,
    logs: [],
    error: failureReason(error, known),
    ...(known.commit || known.pr || known.files
      ? {
          changes: {
            ...(known.commit ? { commit: known.commit } : {}),
            ...(known.pr ? { pr: known.pr } : {}),
            files: known.files ?? [],
          },
        }
      : {}),
  });
  async function ensureIdentity() {
    const expected = {
      workerId: config.workerId,
      engineId: config.engineId,
      repo: config.repository.fullName,
      branch: config.repository.branch,
    };
    const existing = journal.get("__identity__");
    if (existing && !same(existing, expected))
      throw Error("Durable worker identity mismatch");
    if (!existing) await journal.put("__identity__", expected);
  }
  async function flush(id, record) {
    if (record.resources) return false;
    try {
      await client[record.outbox.method](id, record.outbox.body);
      await journal.put(id, { ...record, state: "done", outbox: undefined });
      return true;
    } catch {
      return false;
    }
  }
  async function receipt(id, record, method, result) {
    if (record.resources) throw Error("Resource cleanup is not confirmed");
    const outbox = { method, body: { ...identity(record.claim), result } };
    const next = { ...record, state: "outbox", outbox };
    await journal.put(id, next);
    return flush(id, next);
  }
  async function replayProposal(id, record, { signal } = {}) {
    let expected, artifact;
    try {
      const body = normalizeCandidateV2(record.proposalBody);
      artifact = {
        ...record.artifact,
        ...normalizeCandidateV2(record.artifact),
      };
      for (const file of [
        ...body.diff,
        ...artifact.diff,
        ...(artifact.files ?? []),
      ])
        validateCandidatePathV2(file.path);
      const hash = (payload) =>
        hashCandidateV2({
          task: record.claim.task.task,
          action: "create-pr",
          ...payload,
        });
      expected = hash(body);
      if (hash(artifact) !== expected)
        throw Error("Saved candidate identity mismatch");
    } catch {
      // Legacy path aliases or damaged artifacts cannot be reconciled by changing
      // a request whose original bytes may already be accepted by the Hub.
      await journal.put(id, {
        ...record,
        state: "candidate-blocked",
        candidateError: "CANDIDATE_RECONCILIATION_REQUIRED",
      });
      return { status: "blocked" };
    }
    if (!same(record.artifact, artifact)) {
      record = { ...record, artifact };
      await journal.put(id, record);
    }
    try {
      const ack = await client.proposal(id, record.proposalBody, { signal });
      if (
        typeof ack?.proposal?.id !== "string" ||
        !ack.proposal.id ||
        ack.proposal.version !== 2 ||
        ack.proposal.contentHash !== expected ||
        !same(ack.proposal.candidate, record.artifact.candidate)
      )
        throw Error("Proposal acknowledgment mismatch");
      await journal.put(id, {
        ...record,
        state: "proposed",
        proposal: ack.proposal,
      });
      return { status: "accepted" };
    } catch (error) {
      // Timeouts, aborts and invalid ACKs may hide a committed submission. Preserve
      // its exact identity. Auth and infrastructure errors cannot disprove a prior
      // acceptance; only recognized Hub rejection status/code pairs are terminal.
      return {
        status: isDefinitiveProposalRejection(error) ? "rejected" : "ambiguous",
      };
    }
  }
  async function finishProposal(id, record, outcome, cancelRequested) {
    if (outcome.status === "accepted") return { diagnosed: true };
    if (outcome.status === "blocked") return { pending: true };
    record = journal.get(id) ?? record;
    if (outcome.status === "ambiguous") {
      if (cancelRequested && !record.cancelRequested)
        await journal.put(id, { ...record, cancelRequested: true });
      return { pending: true };
    }
    await receipt(
      id,
      record,
      cancelRequested ? "cancelled" : "complete",
      failure(
        record.known,
        record.artifact?.evidence,
        Error(cancelRequested ? "Cancellation requested" : "Proposal rejected"),
      ),
    );
    return { stopped: true };
  }
  async function recoverPending(signal) {
    let cleaned = false;
    // Reconcile resources before *any* outbox or terminal ACK. A stopped Docker
    // client is not evidence that its detached container has stopped.
    for (let record of journal.list()) {
      const { id } = record;
      if (
        ["claimed", "executing", "cleanup-pending"].includes(record.state) &&
        (record.resourceVersion !== 1 || record.resources === undefined)
      ) {
        await journal.put(id, {
          ...record,
          state: "cleanup-pending",
          cleanupError:
            record.resourceVersion !== 1
              ? "LEGACY_RESOURCE_IDENTITY_MISSING"
              : "RESOURCE_STATE_INVALID",
        });
        return true;
      }
      if (!record.resources && record.state !== "cleanup-pending") continue;
      const resumeState = record.recoveryState ?? record.state;
      try {
        if (record.resources) {
          if (typeof engine.recoverResources !== "function")
            throw Error("Resource recovery unavailable");
          await engine.recoverResources(record.resources, {
            onResources: async (resources) => {
              const next = { ...record, resources };
              await journal.put(id, next);
              record = next;
            },
          });
          if (record.resources) throw Error("Resource recovery incomplete");
        }
        record = {
          ...record,
          state: resumeState === "cleanup-pending" ? "claimed" : resumeState,
          recoveryState: undefined,
          cleanupError: undefined,
        };
        await journal.put(id, record);
        cleaned = true;
      } catch {
        await journal.put(id, {
          ...record,
          state: "cleanup-pending",
          recoveryState: resumeState,
          cleanupError: "RESOURCE_STOP_UNCONFIRMED",
        });
        return true;
      }
    }
    for (const record of journal.list()) {
      const { id } = record;
      if (record.state === "candidate-blocked") return true;
      if (record.state === "outbox") {
        await flush(id, record);
        return true;
      }
      if (record.state === "proposal-pending") {
        const outcome = await replayProposal(id, record, { signal });
        await finishProposal(
          id,
          record,
          outcome,
          record.cancelRequested === true,
        );
        return true;
      }
      if (["claimed", "executing"].includes(record.state)) {
        let known = record.known ?? {};
        if (record.claim.lease.phase === "execute") {
          try {
            const facts = await publisher.recover({
              claim: record.claim,
              known,
            });
            known = { ...known, ...facts };
          } catch {
            known = { ...known, uncertain: true };
          }
        }
        await receipt(
          id,
          { ...record, known },
          record.cancelRequested ? "cancelled" : "complete",
          failure(
            known,
            record.artifact?.evidence,
            Error(record.stopReason ?? "Worker stopped"),
          ),
        );
        return true;
      }
    }
    return cleaned;
  }
  function validateClaim(claim) {
    const task = claim?.task?.task,
      payload = task?.payload;
    if (
      !task ||
      payload.repo !== config.repository.fullName ||
      payload.branch !== config.repository.branch ||
      task.type !== "ci-failure" ||
      payload.context?.source?.kind !== "jenkins" ||
      !/^[a-f0-9]{40}$/.test(payload.context?.commitSha ?? "") ||
      claim.context?.rule?.processor?.action !== "create-pr" ||
      !["diagnose", "execute"].includes(claim.lease?.phase)
    )
      throw Error("Unsupported claim");
  }
  async function runOnce({ signal } = {}) {
    if (closed) throw Error("Worker closed");
    if (busy) throw Error("Worker already active");
    busy = true;
    activeFinished = new Promise((resolve) => {
      finishActive = resolve;
    });
    try {
      await ensureIdentity();
      if (await recoverPending(signal)) return { replayed: true };
      const claim = await client.claim(
        {
          workerId: config.workerId,
          engineId: config.engineId,
          actions: ["create-pr"],
          sourceKinds: ["jenkins"],
          candidateVersions: [2],
          phases: config.publish.enabled
            ? ["diagnose", "execute"]
            : ["diagnose"],
        },
        { signal },
      );
      if (!claim?.task) return { idle: true };
      const id = claim.task.task.id;
      let record = {
        ...(journal.get(id) ?? {}),
        claim,
        state: "claimed",
        known: {},
        resourceVersion: 1,
        resources: null,
        recoveryState: undefined,
        cleanupError: undefined,
      };
      await journal.put(id, record);
      const onResources = async (resources) => {
        const next = { ...record, resources };
        await journal.put(id, next);
        record = next;
      };
      const controller = new AbortController();
      activeController = controller;
      const externalAbort = () => controller.abort();
      signal?.addEventListener("abort", externalAbort, { once: true });
      if (signal?.aborted) controller.abort();
      let cancellation = false,
        expiry = Date.parse(claim.lease.expiresAt),
        heartbeatTimer,
        deadlineTimer,
        heartbeatPromise = Promise.resolve(),
        stopping = false;
      const stop = () => controller.abort();
      const assertActive = () => {
        if (
          controller.signal.aborted ||
          !Number.isFinite(expiry) ||
          now() >= expiry ||
          closed
        ) {
          stop();
          throw Error("Lease is no longer active");
        }
      };
      const deadline = () => {
        clearTimeout(deadlineTimer);
        deadlineTimer = setTimeout(stop, Math.max(0, expiry - now()));
      };
      deadline();
      const beat = () => {
        heartbeatTimer = setTimeout(() => {
          heartbeatPromise = (async () => {
            try {
              assertActive();
              const response = await client.heartbeat(id, identity(claim), {
                signal: controller.signal,
              });
              if (response.cancelRequested) {
                cancellation = true;
                stop();
                return;
              }
              if (
                response.lease?.id !== claim.lease.id ||
                !Number.isFinite(Date.parse(response.lease.expiresAt))
              )
                throw Error("Invalid renewal");
              expiry = Date.parse(response.lease.expiresAt);
              assertActive();
              deadline();
            } catch {
              stop();
            } finally {
              if (!stopping && !controller.signal.aborted) beat();
            }
          })();
        }, config.heartbeatIntervalMs);
      };
      beat();
      let prepared,
        proposalUncertain = false;
      try {
        validateClaim(claim);
        assertActive();
        if (
          (await publisher.readBase({
            repo: config.repository.fullName,
            branch: config.repository.branch,
            signal: controller.signal,
          })) !== claim.task.task.payload.context.commitSha
        )
          throw Error("Base branch moved");
        assertActive();
        if (claim.lease.phase === "diagnose") {
          const output = await engine.diagnose(claim, {
            signal: controller.signal,
            assertActive,
            onResources,
          });
          assertActive();
          if (record.resources)
            throw Error("Resource cleanup is not confirmed");
          const canonical = normalizeCandidateV2(output);
          const artifact = {
            ...output.artifact,
            ...normalizeCandidateV2(output.artifact),
          };
          if (
            hashCandidateV2({
              task: claim.task.task,
              action: "create-pr",
              ...canonical,
            }) !==
            hashCandidateV2({
              task: claim.task.task,
              action: "create-pr",
              ...artifact,
            })
          )
            throw Error("Artifact identity mismatch");
          const proposalBody = {
            ...identity(claim),
            submissionId: randomUUID(),
            ...canonical,
            ...(output.trace ? { trace: output.trace } : {}),
          };
          record = {
            ...record,
            state: "proposal-pending",
            artifact,
            proposalBody,
          };
          await journal.put(id, record);
          assertActive();
          proposalUncertain = true;
          const outcome = await replayProposal(id, record, {
            signal: controller.signal,
          });
          proposalUncertain = outcome.status === "ambiguous";
          // A heartbeat may have settled while the submission was in flight.
          await heartbeatPromise;
          return await finishProposal(id, record, outcome, cancellation);
        }
        if (!config.publish.enabled) throw Error("Publishing disabled");
        const proposal = claim.task.proposal,
          artifact = record.artifact;
        if (
          !artifact ||
          !proposal ||
          proposal.version !== 2 ||
          !record.proposal ||
          proposal.id !== record.proposal.id ||
          proposal.contentHash !== record.proposal.contentHash ||
          !same(proposal.candidate, artifact.candidate) ||
          claim.task.reviewState !== "approved" ||
          claim.task.approvalFlow?.gates?.length !== 2 ||
          claim.task.approvalFlow.gates.some((g) => g.status !== "approved")
        )
          throw Error("Approved artifact unavailable");
        const hash = hashCandidateV2({
          task: claim.task.task,
          action: "create-pr",
          summary: artifact.summary,
          candidate: artifact.candidate,
          diff: artifact.diff,
          evidence: artifact.evidence,
        });
        if (hash !== proposal.contentHash)
          throw Error("Artifact identity mismatch");
        prepared = await engine.prepareExecution(claim, artifact, {
          signal: controller.signal,
          assertActive,
          onResources,
        });
        assertActive();
        if (!same(prepared.candidate, proposal.candidate))
          throw Error("Prepared candidate mismatch");
        if (
          (await publisher.readBase({
            repo: config.repository.fullName,
            branch: config.repository.branch,
            signal: controller.signal,
          })) !== proposal.candidate.baseCommitSha
        )
          throw Error("Base branch moved");
        assertActive();
        record = { ...record, state: "executing" };
        await journal.put(id, record);
        const facts = await publisher.publish({
          claim,
          prepared,
          summary: artifact.summary,
          signal: controller.signal,
          assertActive,
          onProgress: async (progress) => {
            const next = { ...record, known: { ...record.known, ...progress } };
            await journal.put(id, next);
            record = next;
          },
        });
        record = { ...record, known: { ...record.known, ...facts } };
        await journal.put(id, record);
        await prepared.cleanup();
        prepared = undefined;
        assertActive();
        await receipt(id, record, "complete", {
          success: true,
          action: "pr-created",
          changes: facts,
          evidence: artifact.evidence,
          logs: [],
        });
        return { executed: true };
      } catch (error) {
        // Never replace a potentially accepted proposal with a different receipt
        // when saving its ambiguous outcome fails. Its durable request can replay.
        if (proposalUncertain) throw error;
        if (prepared) {
          try {
            await prepared.cleanup();
          } catch {
            record = {
              ...record,
              known: { ...record.known, cleanupFailed: true },
            };
          }
          prepared = undefined;
        }
        const reason = cancellation
          ? Error("Cancellation requested")
          : controller.signal.aborted
            ? Error("Lease is no longer active")
            : error;
        if (record.resources) {
          await journal.put(id, {
            ...record,
            state: "cleanup-pending",
            recoveryState: record.state,
            cancelRequested: cancellation || record.cancelRequested === true,
            stopReason: FAILURE_REASONS.has(reason.message)
              ? reason.message
              : "Worker stopped",
            cleanupError: "RESOURCE_STOP_UNCONFIRMED",
          });
          return { cleanupPending: true };
        }
        await receipt(
          id,
          record,
          cancellation ? "cancelled" : "complete",
          failure(record.known, record.artifact?.evidence, reason),
        );
        return { stopped: true };
      } finally {
        stopping = true;
        clearTimeout(heartbeatTimer);
        clearTimeout(deadlineTimer);
        controller.abort();
        await heartbeatPromise;
        activeController = undefined;
        signal?.removeEventListener("abort", externalAbort);
      }
    } finally {
      busy = false;
      finishActive();
    }
  }
  return {
    runOnce,
    async run({ signal } = {}) {
      const abort = () => activeController?.abort();
      signal?.addEventListener("abort", abort);
      try {
        while (!closed && !signal?.aborted) {
          await runOnce({ signal });
          if (signal?.aborted) break;
          try {
            await sleep(config.pollIntervalMs, { signal });
          } catch {
            if (!signal?.aborted) throw Error("Worker polling interrupted");
          }
        }
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    },
    async close() {
      closed = true;
      activeController?.abort();
      await activeFinished;
      await journal.close();
    },
  };
}
