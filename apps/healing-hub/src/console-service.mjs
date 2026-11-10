import { hashCandidateV2 } from "../../../packages/framework/src/candidate.mjs";
import { loadHealingIntegrations } from "./healing-integrations.mjs";
import {
  normalizeVerificationPolicy,
  verificationTarget,
} from "./github-verification.mjs";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createConsoleStore, HealingError } from "./console-store.mjs";
import { loadConsoleConfiguration } from "./console-config.mjs";
import {
  exportMonitoringConfig,
  normalizeMonitoringConfig,
} from "../../console/public/monitoring-model.js";

const defaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
const TASK_TYPES = new Set([
  "lint-error",
  "format-error",
  "type-error",
  "unit-test-failure",
  "e2e-test-failure",
  "architecture-violation",
  "security-issue",
  "ci-failure",
  "doc-outdated",
  "dependency-issue",
  "performance-regression",
]);
const PRIORITIES = new Set(["urgent", "high", "medium", "low"]);
const STATUSES = new Set([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "skipped",
]);
const ACTIONS = new Set([
  "committed",
  "pr-created",
  "issue-created",
  "retry",
  "failed",
  "skipped",
]);
const ROUTE_ACTIONS = new Set([
  "auto-commit",
  "create-pr",
  "create-issue",
  "retry",
]);
const RESULT_ACTION = {
  "auto-commit": "committed",
  "create-pr": "pr-created",
  "create-issue": "issue-created",
  retry: "retry",
};
const MAX_TASKS = 10000;
const MAX_EVENTS = 50000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const copy = (value) => structuredClone(value);
const fail = (status, code, message) => {
  throw new HealingError(status, code, message);
};
const invalid = () =>
  fail(400, "INVALID_REQUEST", "请求字段缺失、格式无效或内容过长。");
const conflict = (message = "任务已更新，请刷新后重试。") =>
  fail(409, "STATE_CONFLICT", message);

function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value;
}
function text(value, limit = 500, allowEmpty = false) {
  if (
    typeof value !== "string" ||
    value.length > limit ||
    // Reject control characters in persisted text and protocol identifiers.
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  )
    invalid();
  const result = value.trim();
  if (!allowEmpty && !result) invalid();
  return result;
}
function integer(value, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) invalid();
  return value;
}
function list(value, limit, map) {
  if (!Array.isArray(value) || value.length > limit) invalid();
  return value.map(map);
}
const strings = (value, limit = 100, itemLimit = 500) =>
  list(value, limit, (item) => text(item, itemLimit));
function member(value, accepted) {
  if (!accepted.has(value)) invalid();
  return value;
}
function actorIdentity(actor) {
  if (typeof actor === "string")
    return { id: text(actor, 160), name: text(actor, 160) };
  const source = object(actor);
  const id = text(source.id ?? source.name, 160);
  return {
    id,
    name: text(source.name ?? source.id, 160),
    ...(source.workerId ? { workerId: text(source.workerId, 120) } : {}),
  };
}
function safePath(value) {
  const path = text(value, 500);
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes(":") ||
    path
      .split("/")
      .some(
        (part) => !part || part === "." || part === ".." || part === ".git",
      ) ||
    /[\r\n]/.test(path)
  )
    invalid();
  return path;
}
function branchName(value) {
  const name = text(value, 200);
  if (
    name.startsWith("-") ||
    /[\s~^:?*[\\]/.test(name) ||
    name.includes("..") ||
    name.includes("@{") ||
    name.endsWith(".") ||
    name
      .split("/")
      .some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))
  )
    invalid();
  return name;
}
function checkRevision(expected, actual) {
  if (!Number.isSafeInteger(expected) || expected < 0) invalid();
  if (expected !== actual) conflict();
}
function checkConfigRevision(body, state, resource) {
  if (body.expectedConfigRevision !== undefined)
    checkRevision(body.expectedConfigRevision, state.configRevisions[resource]);
  else checkRevision(body.expectedRevision, state.revision);
}
function safeState(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return text(value, 4000, true);
  const source = object(value);
  const result = {};
  for (const key of ["commitSha", "branch", "summary", "status"]) {
    if (source[key] !== undefined)
      result[key] = text(source[key], key === "summary" ? 4000 : 200, true);
  }
  return result;
}
function readEvidence(value) {
  const source = object(value);
  return {
    beforeState: safeState(source.beforeState),
    afterState: safeState(source.afterState),
    testsRun: strings(source.testsRun ?? [], 100, 300),
    checksPass: strings(source.checksPass ?? [], 100, 300),
    checksFail: strings(source.checksFail ?? [], 100, 300),
  };
}
function requiredEvidence(evidence, safety) {
  const required = safety.requiredChecks ?? [];
  if (
    !evidence.testsRun.length ||
    !evidence.checksPass.length ||
    evidence.checksFail.length ||
    evidence.checksPass.some((check) => !evidence.testsRun.includes(check)) ||
    required.some(
      (check) =>
        !evidence.testsRun.includes(check) ||
        !evidence.checksPass.includes(check),
    )
  )
    fail(
      422,
      "EVIDENCE_REQUIRED",
      "请提供全部必需检查的通过证据，且不能包含失败项。",
    );
}
function diagnosticEvidence(evidence) {
  const recorded = [...evidence.checksPass, ...evidence.checksFail];
  if (
    !evidence.testsRun.length ||
    !recorded.length ||
    recorded.some((check) => !evidence.testsRun.includes(check))
  )
    fail(
      422,
      "EVIDENCE_REQUIRED",
      "请提供已执行诊断的记录，以及对应的通过或失败结果。",
    );
}
function proposalKind(entry) {
  return ["auto-commit", "create-pr"].includes(
    entry.routingRule.processor.action,
  )
    ? "code-change"
    : "action";
}
function actionDiff(value) {
  if (!Array.isArray(value)) invalid();
  if (value.length)
    fail(422, "UNAPPROVED_CHANGE", "此操作方案不得包含代码变更。");
  return [];
}
function validateProposal(entry) {
  if (proposalKind(entry) === "code-change") {
    requiredEvidence(entry.evidence, entry.safety);
    validatePaths(
      entry.diff.map((item) => item.path),
      entry.safety,
    );
  } else {
    actionDiff(entry.diff);
    diagnosticEvidence(entry.evidence);
  }
}
function globExpression(pattern) {
  let result = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      result += ".*";
      index += 1;
    } else if (character === "*") result += "[^/]*";
    else if (character === "?") result += "[^/]";
    else result += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${result}$`);
}
function protectedPath(path, patterns) {
  return patterns.some((pattern) => {
    if (pattern.endsWith("/")) return path.startsWith(pattern);
    const expression = globExpression(pattern);
    return (
      expression.test(path) ||
      (!pattern.includes("/") &&
        path.split("/").some((part) => expression.test(part)))
    );
  });
}
function validatePaths(paths, safety) {
  const maximum = safety.maxFilesPerFix ?? 5;
  if (
    !paths.length ||
    paths.length > maximum ||
    new Set(paths).size !== paths.length
  )
    fail(422, "UNSAFE_CHANGE", "候选方案的文件为空、重复或超过允许数量。");
  if (paths.some((path) => protectedPath(path, safety.protectedPaths ?? [])))
    fail(422, "PROTECTED_PATH", "候选方案涉及受保护的路径。");
}
function readDiff(value, safety) {
  let bytes = 0;
  const diff = list(value, 100, (item) => {
    const source = object(item);
    const lines = list(source.lines, 5000, (line) => {
      object(line);
      const content =
        typeof line.content === "string" ? line.content : invalid();
      if (content.length > 20000 || content.includes("\0")) invalid();
      bytes += Buffer.byteLength(content);
      return {
        type: member(line.type, new Set(["context", "add", "remove"])),
        content,
      };
    });
    const additions = integer(source.additions, 100000);
    const deletions = integer(source.deletions, 100000);
    if (
      additions !== lines.filter((line) => line.type === "add").length ||
      deletions !== lines.filter((line) => line.type === "remove").length
    )
      invalid();
    return { path: safePath(source.path), additions, deletions, lines };
  });
  if (bytes > 1024 * 1024) invalid();
  validatePaths(
    diff.map((item) => item.path),
    safety,
  );
  return diff;
}
function readTrace(value = []) {
  return list(value, 200, (step) => {
    object(step);
    return {
      id: text(step.id, 120),
      ...(step.parentId === undefined
        ? {}
        : { parentId: text(step.parentId, 120) }),
      title: text(step.title, 200),
      kind: member(step.kind, new Set(["agent", "tool", "check"])),
      status: member(
        step.status,
        new Set(["completed", "running", "pending", "failed"]),
      ),
      ...(step.durationMs === undefined
        ? {}
        : { durationMs: integer(step.durationMs, 86400000) }),
      ...(step.detail === undefined
        ? {}
        : { detail: text(step.detail, 4000, true) }),
    };
  });
}
function candidateHash(diff, evidence) {
  return createHash("sha256")
    .update(JSON.stringify({ diff, evidence }))
    .digest("hex");
}
function entryCandidateHash(entry) {
  return entry.proposal?.version === 2
    ? hashCandidateV2({
        task: entry.task,
        action: entry.routingRule.processor.action,
        summary: entry.proposal.summary,
        candidate: entry.proposal.candidate,
        diff: entry.diff,
        evidence: entry.evidence,
      })
    : candidateHash(entry.diff, entry.evidence);
}
function readCandidate(value, entry) {
  const c = object(value),
    context = entry.task.payload.context;
  if (
    c.version !== 2 ||
    context.source?.kind !== "jenkins" ||
    entry.routingRule.processor.action !== "create-pr" ||
    c.baseCommitSha !== context.commitSha ||
    !/^[a-f0-9]{40}$/.test(c.baseCommitSha) ||
    !/^[a-f0-9]{40}$/.test(c.treeSha) ||
    !/^[a-f0-9]{64}$/.test(c.patchSha256) ||
    c.artifactId !== c.patchSha256
  )
    fail(422, "CANDIDATE_MISMATCH", "候选必须绑定固定来源提交与完整产物。");
  return {
    version: 2,
    baseCommitSha: c.baseCommitSha,
    patchSha256: c.patchSha256,
    treeSha: c.treeSha,
    artifactId: c.artifactId,
  };
}
function validateCompletionBinding(entry, body, lease) {
  if (
    entry.proposal?.version === 2 &&
    lease.phase === "execute" &&
    (body.proposalId !== entry.proposal.id ||
      body.contentHash !== entry.proposal.contentHash)
  )
    fail(422, "CANDIDATE_MISMATCH", "完成回执与已批准候选不匹配。");
}
function commandFingerprint(command, body) {
  const normalize = (value) => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, normalize(value[key])]),
      );
    return value;
  };
  const payload = { ...body };
  delete payload.requestId;
  let serialized;
  try {
    serialized = JSON.stringify({ command, payload });
    if (Buffer.byteLength(serialized) > 2 * 1024 * 1024) invalid();
    serialized = JSON.stringify(normalize({ command, payload }));
  } catch {
    invalid();
  }
  return createHash("sha256").update(serialized).digest("hex");
}

function hasSideEffects(result) {
  const changes = result?.changes;
  return Boolean(
    changes?.files?.length ||
    changes?.commit !== undefined ||
    changes?.pr !== undefined ||
    changes?.issue !== undefined,
  );
}

function readResult(value, entry, lease, at) {
  const source = object(value);
  if (typeof source.success !== "boolean") invalid();
  const action = member(source.action, ACTIONS);
  if (
    (source.success && action === "failed") ||
    (!source.success && !["failed", "skipped"].includes(action))
  )
    invalid();
  const evidence = readEvidence(source.evidence ?? {});
  const logs = list(source.logs ?? [], 1000, (line) => text(line, 4000, true));
  if (
    logs.reduce((size, line) => size + Buffer.byteLength(line), 0) >
    1024 * 1024
  )
    invalid();
  let changes;
  if (source.changes !== undefined) {
    const change = object(source.changes);
    changes = { files: list(change.files ?? [], 100, safePath) };
    if (change.commit !== undefined) {
      if (
        typeof change.commit !== "string" ||
        !/^[0-9a-f]{40,64}$/i.test(change.commit)
      )
        invalid();
      changes.commit = change.commit;
    }
    for (const key of ["pr", "issue"]) {
      if (change[key] === undefined) continue;
      const value = integer(change[key]);
      if (!value) invalid();
      changes[key] = value;
    }
  }
  const startedAt = entry.status.startedAt ?? lease.claimedAt;
  const result = {
    taskId: entry.task.id,
    success: source.success,
    action,
    ...(changes ? { changes } : {}),
    logs,
    evidence,
    timings: {
      startedAt,
      completedAt: at,
      durationMs: Math.max(0, Date.parse(at) - Date.parse(startedAt)),
    },
  };
  if (!source.success) {
    const error = source.error ? object(source.error) : {};
    result.error = {
      code: text(error.code ?? "WORKER_FAILED", 120),
      message: text(error.message ?? "执行器已报告失败。", 1000),
      retriable: error.retriable === true,
    };
  }
  return result;
}

function validateSuccessfulResult(result, entry, lease) {
  if (!result.success) return;
  const { action, changes, evidence } = result;
  if (action === "skipped") {
    if (hasSideEffects(result))
      fail(422, "UNAPPROVED_CHANGE", "跳过的操作不得包含外部变更。");
    return;
  }
  if (lease.phase !== "execute")
    conflict("成功的操作必须来自已批准的执行租约。");
  if (action !== RESULT_ACTION[entry.routingRule.processor.action])
    fail(422, "ACTION_MISMATCH", "完成的操作与路由授权不一致。");
  const allowed = {
    committed: new Set(["commit"]),
    "pr-created": new Set(["pr", "commit"]),
    "issue-created": new Set(["issue"]),
    retry: new Set(),
  }[action];
  if (
    ["commit", "pr", "issue"].some(
      (key) => changes?.[key] !== undefined && !allowed.has(key),
    )
  )
    fail(422, "UNAPPROVED_CHANGE", "完成结果包含路由未授权的外部产物。");
  if (proposalKind(entry) === "code-change")
    requiredEvidence(evidence, entry.safety);
  else {
    diagnosticEvidence(evidence);
    if (changes?.files.length)
      fail(422, "UNAPPROVED_CHANGE", "操作结果不得包含未经授权的代码变更。");
  }
  if (
    (action === "committed" && !changes?.commit) ||
    (action === "pr-created" &&
      (!changes?.pr ||
        (entry.proposal?.version === 2 &&
          !/^[a-f0-9]{40}$/.test(changes?.commit ?? "")))) ||
    (action === "issue-created" && !changes?.issue)
  )
    invalid();
  if (["committed", "pr-created"].includes(action)) {
    const files = changes?.files ?? [];
    const approved = new Set(entry.diff.map((item) => item.path));
    if (
      !files.length ||
      files.length !== approved.size ||
      new Set(files).size !== files.length ||
      files.some((path) => !approved.has(path))
    )
      fail(
        422,
        "UNAPPROVED_CHANGE",
        "完成结果必须准确列明已批准方案的全部文件，且不能重复。",
      );
  }
}

function requireReconciliation(entry, reason, at) {
  entry.reconciliation = {
    status: "required",
    reason,
    updatedAt: at,
    ...(entry.reconciliation?.history
      ? { history: copy(entry.reconciliation.history) }
      : {}),
  };
}
// Follow the complete retry chain; a resolved immediate parent cannot hide an
// unresolved earlier execution. The visited set also bounds corrupt cycles.
function retryAncestors(state, entry) {
  const ancestors = [];
  const visited = new Set([entry.task.id]);
  let id = entry.task.payload.context.retryOf;
  while (id && !visited.has(id)) {
    visited.add(id);
    const parent = state.tasks.find((item) => item.task.id === id);
    if (!parent) break;
    ancestors.push(parent);
    id = parent.task.payload.context.retryOf;
  }
  return ancestors;
}

function validateStoredState(state) {
  object(state);
  if (state.schemaVersion !== 1) invalid();
  integer(state.revision);
  object(state.configRevisions);
  integer(state.configRevisions.rules);
  integer(state.configRevisions.monitoring);
  list(state.tasks, MAX_TASKS, (entry) => {
    object(entry);
    if (!UUID.test(entry.task?.id)) invalid();
    integer(entry.revision);
    if (entry.revision < 1 || entry.status?.taskId !== entry.task.id) invalid();
    member(entry.status.status, STATUSES);
    member(entry.task.type, TASK_TYPES);
    member(entry.task.priority, PRIORITIES);
    text(entry.title, 200);
    text(entry.engineId, 120);
    object(entry.task.payload);
    text(entry.task.payload.repo, 200);
    branchName(entry.task.payload.branch);
    integer(entry.task.payload.context?.retryCount, 10000);
    const source = entry.task.payload.context.source;
    if (source) {
      object(source);
      if (
        source.kind !== "jenkins" ||
        source.result !== "FAILURE" ||
        source.repo !== entry.task.payload.repo ||
        source.branch !== entry.task.payload.branch ||
        source.commitSha !== entry.task.payload.context.commitSha ||
        source.buildUrl !== entry.task.payload.context.ciJobUrl ||
        !/^[a-f0-9]{40}$/.test(source.commitSha) ||
        !/^[a-f0-9]{64}$/.test(source.eventId) ||
        !Number.isFinite(Date.parse(source.observedAt))
      )
        invalid();
      for (const key of ["sourceId", "generation", "jobName", "buildUrl"])
        text(source[key], 2000);
      integer(source.buildNumber);
      if (source.buildNumber < 1) invalid();
    }
    if (
      entry.verificationPolicy &&
      normalizeVerificationPolicy(entry.verificationPolicy)?.policyHash !==
        entry.verificationPolicy.policyHash
    )
      invalid();
    object(entry.task.metadata);
    if (!Number.isFinite(Date.parse(entry.task.metadata.createdAt))) invalid();
    if (!Array.isArray(entry.trace) || !Array.isArray(entry.diff)) invalid();
    object(entry.routingRule);
    object(entry.safety);
    member(
      entry.executionPhase,
      new Set(["diagnose", "review", "execute", "done"]),
    );
    if (typeof entry.cancellationRequested !== "boolean") invalid();
    if (entry.lease) {
      object(entry.lease);
      if (!UUID.test(entry.lease.id) || entry.status.status !== "running")
        invalid();
      member(entry.lease.phase, new Set(["diagnose", "execute"]));
      text(entry.lease.workerId, 120);
      text(entry.lease.actorId, 160);
      if (!Number.isFinite(Date.parse(entry.lease.expiresAt))) invalid();
    } else if (entry.status.status === "running") invalid();
    if (entry.interruption !== undefined)
      member(entry.interruption, new Set(["cancelled", "lease-expired"]));
    if (entry.blockedByReconciliation) {
      const blocked = object(entry.blockedByReconciliation);
      if (
        !UUID.test(blocked.taskId) ||
        !Number.isFinite(Date.parse(blocked.at))
      )
        invalid();
      text(blocked.reason, 500);
    }
    if (entry.terminalLease) {
      const lease = object(entry.terminalLease);
      if (!UUID.test(lease.id)) invalid();
      member(lease.phase, new Set(["diagnose", "execute"]));
      text(lease.actorId, 160);
      text(lease.workerId, 120);
      if (
        !Number.isFinite(Date.parse(lease.claimedAt)) ||
        !Number.isFinite(Date.parse(lease.expiresAt))
      )
        invalid();
    }
    if (entry.receipts)
      list(entry.receipts, 10, (receipt) => {
        object(receipt);
        member(receipt.kind, new Set(["complete", "cancelled"]));
        if (
          !/^[0-9a-f]{64}$/.test(receipt.fingerprint) ||
          !Number.isFinite(Date.parse(receipt.receivedAt))
        )
          invalid();
        object(receipt.response);
        if (receipt.result) object(receipt.result);
      });
    if (entry.reconciliation) {
      const record = object(entry.reconciliation);
      member(record.status, new Set(["required", "resolved"]));
      text(record.reason, 500);
      if (!Number.isFinite(Date.parse(record.updatedAt))) invalid();
      const validateResolution = (resolution) => {
        object(resolution);
        member(resolution.outcome, new Set(["no-changes", "changes-recorded"]));
        text(resolution.note, 1000);
        text(resolution.actor, 160);
        if (!Number.isFinite(Date.parse(resolution.at))) invalid();
      };
      if (record.status === "resolved") validateResolution(record.resolution);
      if (record.history) list(record.history, 100, validateResolution);
    }
    if (entry.approvalFlow) {
      const flow = object(entry.approvalFlow);
      if (
        flow.schemaVersion !== 1 ||
        flow.source !== "server" ||
        flow.round < 1
      )
        invalid();
      integer(flow.round, 10000);
      member(
        flow.status,
        new Set(["pending", "approved", "rejected", "cancelled"]),
      );
      object(flow.checks);
      list(flow.gates, 2, (gate) => object(gate));
      if (
        flow.gates.length !== 2 ||
        flow.gates[0].id !== "code-review" ||
        flow.gates[1].id !== "execution-auth"
      )
        invalid();
      list(flow.history, 10000, (item) => object(item));
      if (
        !entry.evidence ||
        !entry.proposal ||
        !UUID.test(entry.proposal.id) ||
        (entry.proposal.kind !== undefined &&
          entry.proposal.kind !== proposalKind(entry)) ||
        entry.proposal.contentHash !== entryCandidateHash(entry)
      )
        invalid();
      if (entry.proposal.version === 2)
        readCandidate(entry.proposal.candidate, entry);
      validateProposal(entry);
    }
  });
  if (
    new Set(state.tasks.map((entry) => entry.task.id)).size !==
    state.tasks.length
  )
    invalid();
  list(state.activity, MAX_EVENTS, (item) => {
    object(item);
    if (!UUID.test(item.id) || !Number.isFinite(Date.parse(item.at))) invalid();
    text(item.action, 120);
    text(item.message, 500);
    text(item.actor, 160);
  });
  list(state.ruleOverrides, 10000, (item) => {
    text(item.id, 120);
    if (typeof item.enabled !== "boolean") invalid();
  });
  list(state.workers, 1000, (item) => {
    text(item.workerId, 120);
    text(item.engineId, 120);
    text(item.actorId, 160);
    if (!Number.isFinite(Date.parse(item.lastSeenAt))) invalid();
  });
  list(state.requests, 50000, (item) => {
    text(item.id, 128);
    text(item.actorId, 160);
    text(item.command, 200);
    if (!/^[0-9a-f]{64}$/.test(item.fingerprint)) invalid();
    object(item.result);
  });
  if (state.monitoring !== null && !exportMonitoringConfig(state.monitoring))
    invalid();
}

function publicTask(entry) {
  // Nothing from the private lease or routing/safety control state is spread.
  const task = entry.task;
  return {
    task: {
      id: task.id,
      type: task.type,
      priority: task.priority,
      payload: {
        repo: task.payload.repo,
        branch: task.payload.branch,
        files: copy(task.payload.files),
        errorDetails: { message: task.payload.errorDetails.message },
        context: {
          retryCount: task.payload.context.retryCount,
          ...(task.payload.context.source
            ? {
                source: copy(task.payload.context.source),
                commitSha: task.payload.context.commitSha,
                ciJobUrl: task.payload.context.ciJobUrl,
              }
            : {}),
          ...(task.payload.context.retryOf
            ? { retryOf: task.payload.context.retryOf }
            : {}),
        },
      },
      metadata: {
        triggeredBy: task.metadata.triggeredBy,
        triggeredAt: task.metadata.triggeredAt,
        source: task.metadata.source,
        createdAt: task.metadata.createdAt,
      },
    },
    revision: entry.revision,
    title: entry.title,
    engineId: entry.engineId,
    status: copy(entry.status),
    trace: copy(entry.trace),
    diff: copy(entry.diff),
    execution: {
      phase: entry.executionPhase,
      cancelRequested: entry.cancellationRequested,
      ...(entry.blockedByReconciliation
        ? { blockedByReconciliation: copy(entry.blockedByReconciliation) }
        : {}),
      ...(entry.lease
        ? {
            workerId: entry.lease.workerId,
            leaseExpiresAt: entry.lease.expiresAt,
          }
        : {}),
    },
    ...(entry.reviewState ? { reviewState: entry.reviewState } : {}),
    ...(entry.approvalFlow ? { approvalFlow: copy(entry.approvalFlow) } : {}),
    ...(entry.evidence ? { evidence: copy(entry.evidence) } : {}),
    ...(entry.proposal
      ? { proposal: { ...copy(entry.proposal), kind: proposalKind(entry) } }
      : {}),
    ...(entry.verification ? { verification: copy(entry.verification) } : {}),
    ...(entry.result ? { result: copy(entry.result) } : {}),
    ...(entry.reconciliation
      ? { reconciliation: copy(entry.reconciliation) }
      : {}),
    ...(entry.receipts?.length
      ? {
          resultReceipts: entry.receipts.map((receipt) => ({
            kind: receipt.kind,
            receivedAt: receipt.receivedAt,
            ...(receipt.result ? { result: copy(receipt.result) } : {}),
          })),
        }
      : {}),
  };
}

/** Persistent control plane. Only authenticated workers provide execution evidence. */
export function createHealingService({
  rootDir = defaultRoot,
  dataDir,
  clock = () => new Date(),
  leaseMs = 60000,
  maxBytes,
  integrationsConfig,
  integrationsFetch = globalThis.fetch,
  integrationsEnv = process.env,
} = {}) {
  const root = resolve(rootDir);
  const integrations = () =>
    loadHealingIntegrations({
      rootDir: root,
      config: integrationsConfig,
      fetchImpl: integrationsFetch,
      env: integrationsEnv,
      clock,
    });
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 3600000)
    throw new TypeError(
      "leaseMs must be a positive duration of at most one hour.",
    );
  const store = createConsoleStore({
    dataDir: dataDir ?? join(root, ".healing"),
    maxBytes,
    initialState: {
      schemaVersion: 1,
      revision: 0,
      configRevisions: { rules: 0, monitoring: 0 },
      tasks: [],
      activity: [],
      ruleOverrides: [],
      workers: [],
      requests: [],
      monitoring: null,
    },
    validate: validateStoredState,
    assertWritable(state) {
      if (
        state.tasks.length >= MAX_TASKS ||
        state.activity.length >= MAX_EVENTS ||
        state.requests.length >= 50000 ||
        state.workers.length >= 1000
      )
        fail(503, "STORE_FULL", "持久状态已达到容量上限。");
    },
    migrate(state) {
      if (state && state.configRevisions === undefined)
        state.configRevisions = {
          rules: state.revision,
          monitoring: state.revision,
        };
      for (const entry of state?.tasks ?? []) {
        if (!["failed", "cancelled"].includes(entry.status?.status)) continue;
        // Repair terminal retries saved by the older hold path without reopening
        // gates or altering recorded approvals and proposal evidence.
        if (
          entry.status.status === "cancelled" &&
          entry.blockedByReconciliation &&
          (entry.reviewState !== undefined ||
            ["pending", "approved"].includes(entry.approvalFlow?.status))
        )
          cancelFlow(
            entry,
            { name: "管理服务" },
            entry.status.completedAt ?? entry.blockedByReconciliation.at,
            { allowFullHistory: true },
          );
        const expired =
          (!entry.receipts?.length &&
            entry.result?.error?.code === "LEASE_EXPIRED") ||
          state.activity?.some(
            (event) =>
              event.taskId === entry.task.id &&
              event.action === "failed" &&
              event.message ===
                "执行器租约已过期，执行结果未知；请确认外部变更后再重试。",
          );
        if (!entry.interruption) {
          if (expired) entry.interruption = "lease-expired";
          else if (entry.cancellationRequested)
            entry.interruption = "cancelled";
        }
        // Old stores have no retained lease. Infer uncertainty from saved facts,
        // never manufacture a lease or reinterpret an ordinary failed receipt.
        const executedCancellation =
          !entry.blockedByReconciliation &&
          entry.cancellationRequested &&
          (entry.terminalLease?.phase === "execute" ||
            entry.approvalFlow?.gates.every(
              (gate) => gate.status === "approved",
            ));
        // A retained diagnosis lease proves this expiry did not execute. Legacy
        // entries without a retained phase still require conservative review.
        const uncertainExpiry =
          expired && entry.terminalLease?.phase !== "diagnose";
        if (
          !entry.reconciliation &&
          (hasSideEffects(entry.result) ||
            uncertainExpiry ||
            executedCancellation)
        ) {
          requireReconciliation(
            entry,
            "旧任务记录含外部变更或未知执行结果，请先核对。",
            entry.status.completedAt ?? entry.task.metadata.createdAt,
          );
        }
      }
      for (const entry of state?.tasks ?? []) {
        if (entry.reconciliation?.status === "required")
          holdRetryDescendants(state, entry, entry.reconciliation.updatedAt);
      }
    },
  });
  const now = () => {
    const value = new Date(clock());
    if (!Number.isFinite(value.getTime()))
      throw new TypeError("clock must provide a valid time.");
    return value;
  };
  function audit(
    state,
    action,
    message,
    actor,
    at,
    taskId,
    level = "info",
    ruleId,
  ) {
    if (state.activity.length >= MAX_EVENTS)
      fail(503, "STORE_FULL", "操作记录已达到存储上限。");
    state.activity.unshift({
      id: randomUUID(),
      at,
      action,
      message,
      actor: actor.name,
      level,
      ...(taskId ? { taskId } : {}),
      ...(ruleId ? { ruleId } : {}),
    });
  }
  function holdRetryDescendants(
    state,
    origin,
    at,
    actor = { name: "管理服务" },
  ) {
    const held = [];
    for (const entry of state.tasks) {
      if (
        !["pending", "running"].includes(entry.status.status) ||
        !retryAncestors(state, entry).includes(origin) ||
        entry.blockedByReconciliation
      )
        continue;
      const reason = `来源任务 ${origin.task.id} 的外部结果需要重新核对，重试任务已停止，须核对后手动重试。`;
      entry.blockedByReconciliation = { taskId: origin.task.id, reason, at };
      entry.cancellationRequested = true;
      entry.status.message = reason;
      if (!entry.lease) {
        entry.status.status = "cancelled";
        entry.status.completedAt = at;
        entry.executionPhase = "done";
        cancelFlow(entry, actor, at, { allowFullHistory: true });
      } else entry.interruption = "cancelled";
      entry.revision += 1;
      held.push(entry);
    }
    return held;
  }

  function markReconciliation(state, entry, reason, at, actor) {
    requireReconciliation(entry, reason, at);
    for (const held of holdRetryDescendants(state, entry, at, actor))
      audit(
        state,
        "retry-interrupted",
        held.status.message,
        actor,
        at,
        held.task.id,
        "warning",
      );
  }
  function rulesFor(config, state) {
    return config.rules.map((rule) => ({
      ...copy(rule),
      enabled:
        state.ruleOverrides.find((item) => item.id === rule.id)?.enabled ??
        rule.enabled,
    }));
  }
  function monitoringFor(config, state) {
    return state.monitoring === null
      ? copy(config.monitoring)
      : normalizeMonitoringConfig(state.monitoring);
  }
  function storageFor(state, stored) {
    const usage = {
      bytes: stored.bytes,
      tasks: { used: state.tasks.length, limit: MAX_TASKS },
      activity: { used: state.activity.length, limit: MAX_EVENTS },
      requests: { used: state.requests.length, limit: 50000 },
      workers: { used: state.workers.length, limit: 1000 },
    };
    const full = Object.values(usage).some(({ used, limit }) => used >= limit);
    const reason = full ? "STORE_FULL" : (stored.failure?.code ?? null);
    return {
      status: reason ? "read-only" : "ready",
      reason,
      message: reason
        ? `${full ? "持久状态已达到容量上限。" : stored.failure.message}当前显示最后成功保存的状态；租约过期等变更可能尚未保存。请备份导出并恢复存储容量或可写权限。`
        : "持久状态可写。",
      usage,
    };
  }
  function snapshotFor(config, state, time, stored) {
    const storage = storageFor(state, stored);
    const writable = storage.status === "ready";
    const liveWorkers = state.workers.filter(
      (item) => time.getTime() - Date.parse(item.lastSeenAt) <= leaseMs,
    );
    return {
      apiVersion: 1,
      mode: "live",
      revision: state.revision,
      configRevisions: copy(state.configRevisions),
      storage,
      generatedAt: time.toISOString(),
      configSource: config.configSource,
      rulesSource: config.rulesSource,
      rulesVersion: config.rulesVersion,
      project: copy(config.project),
      safety: copy(config.safety),
      triggers: copy(config.triggers),
      integrations: copy(config.integrations.snapshot),
      capabilities: {
        importCi: writable && config.integrations.snapshot.jenkins.configured,
        verifyResult:
          writable && config.integrations.snapshot.verification.configured,
        trigger: writable && config.triggers.manual?.enabled !== false,
        cancel: writable,
        retry: writable,
        approve: writable,
        updateRules: writable,
        updateMonitoring: writable,
        reconcile: writable,
      },
      engines: config.engines.map((engine) => {
        const connected = liveWorkers.some(
          (item) => item.engineId === engine.id,
        );
        return {
          ...copy(engine),
          implemented: connected,
          status: connected
            ? state.tasks.some(
                (entry) =>
                  entry.engineId === engine.id &&
                  entry.status.status === "running",
              )
              ? "running"
              : "idle"
            : "unavailable",
          message: connected
            ? "已认证的执行器近期已连接管理服务。"
            : "此引擎暂无已认证的在线执行器。",
        };
      }),
      rules: rulesFor(config, state),
      rulesOverridden: state.ruleOverrides.length > 0,
      monitoring: monitoringFor(config, state),
      monitoringSource: state.monitoring === null ? "configuration" : "saved",
      tasks: state.tasks.map(publicTask),
      activity: copy(state.activity),
    };
  }
  function taskFor(state, id) {
    if (typeof id !== "string" || !UUID.test(id))
      fail(404, "TASK_NOT_FOUND", "找不到指定任务。");
    const task = state.tasks.find((entry) => entry.task.id === id);
    if (!task) fail(404, "TASK_NOT_FOUND", "找不到指定任务。");
    return task;
  }
  function history(entry, decision, nodeId, comment, actor, at) {
    const flow = entry.approvalFlow;
    if (flow.history.length >= 10000)
      fail(503, "STORE_FULL", "审批历史已达到存储上限。");
    flow.history.push({
      id: randomUUID(),
      round: flow.round,
      nodeId,
      decision,
      actor: actor.name,
      at,
      comment,
    });
  }
  function cancelFlow(entry, actor, at, { allowFullHistory = false } = {}) {
    if (!entry.approvalFlow) return;
    const flow = entry.approvalFlow;
    const nodeId =
      flow.gates.find((gate) => gate.status === "pending")?.id ?? "execute";
    flow.status = "cancelled";
    for (const gate of flow.gates)
      if (gate.status === "pending") gate.status = "blocked";
    // Retry safety transitions must not need an extra approval-history slot.
    // At capacity, their stop marker/status (and live audit) retain the reason.
    if (!allowFullHistory || flow.history.length < 10000)
      history(entry, "cancelled", nodeId, "任务已取消。", actor, at);
    delete entry.reviewState;
  }
  function failureResult(entry, code, message, at) {
    const startedAt = entry.status.startedAt ?? at;
    return {
      taskId: entry.task.id,
      success: false,
      action: "failed",
      logs: [message],
      evidence: copy(
        entry.evidence ?? {
          beforeState: null,
          afterState: null,
          testsRun: [],
          checksPass: [],
          checksFail: [],
        },
      ),
      timings: {
        startedAt,
        completedAt: at,
        durationMs: Math.max(0, Date.parse(at) - Date.parse(startedAt)),
      },
      error: { code, message, retriable: true },
    };
  }
  async function expire(time) {
    return store.transact((state) => {
      let changed = false;
      const at = time.toISOString();
      for (const entry of state.tasks) {
        if (!entry.lease || Date.parse(entry.lease.expiresAt) > time.getTime())
          continue;
        const message =
          "执行器租约已过期，执行结果未知；请确认外部变更后再重试。";
        entry.result = failureResult(entry, "LEASE_EXPIRED", message, at);
        entry.status = {
          ...entry.status,
          status: "failed",
          completedAt: at,
          message,
        };
        entry.executionPhase = "done";
        entry.revision += 1;
        entry.terminalLease = copy(entry.lease);
        entry.interruption = "lease-expired";
        if (entry.lease.phase === "execute")
          markReconciliation(
            state,
            entry,
            "执行租约已过期，外部操作结果需要核对。",
            at,
            { name: "管理服务" },
          );
        delete entry.lease;
        audit(
          state,
          "failed",
          message,
          { name: "管理服务" },
          at,
          entry.task.id,
          "error",
        );
        changed = true;
      }
      return { changed };
    });
  }
  async function mutate(actor, operation, includeSnapshot = true) {
    const identity = actorIdentity(actor);
    const config = await loadConsoleConfiguration(root);
    config.integrations = await integrations();
    const time = now();
    await expire(time);
    const outcome = await store.transact((state) =>
      operation(state, config, identity, time),
    );
    return {
      ...outcome.value,
      ...(includeSnapshot
        ? {
            snapshot: snapshotFor(config, outcome.state, time, outcome.storage),
          }
        : {}),
    };
  }
  const workerMutation = (actor, operation) => mutate(actor, operation, false);
  function idempotent(state, command, body, identity, operation) {
    object(body);
    if (body.requestId === undefined) return operation();
    const id = text(body.requestId, 128);
    const fingerprint = commandFingerprint(command, body);
    const previous = state.requests.find(
      (item) => item.id === id && item.actorId === identity.id,
    );
    if (previous) {
      if (previous.command !== command || previous.fingerprint !== fingerprint)
        fail(
          409,
          "IDEMPOTENCY_CONFLICT",
          "此请求标识已用于其他操作或内容，请勿重复使用。",
        );
      return { changed: false, value: copy(previous.result) };
    }
    if (state.requests.length >= 50000)
      fail(503, "STORE_FULL", "请求历史已达到存储上限。");
    const result = operation();
    state.requests.push({
      id,
      actorId: identity.id,
      command,
      fingerprint,
      result: copy(result.value),
    });
    return { ...result, changed: true };
  }
  function route(config, state, type, retryCount) {
    const rule = rulesFor(config, state).find((item) => {
      if (
        !item.enabled ||
        (item.match.taskType && item.match.taskType !== type)
      )
        return false;
      return Object.entries(item.match["context.retryCount"] ?? {}).every(
        ([operator, value]) =>
          ({
            $lt: retryCount < value,
            $lte: retryCount <= value,
            $gt: retryCount > value,
            $gte: retryCount >= value,
            $eq: retryCount === value,
          })[operator] === true,
      );
    });
    if (!rule)
      fail(422, "NO_MATCHING_RULE", "没有已启用的路由规则匹配此任务。");
    if (
      !config.engines.some((engine) => engine.id === rule.processor.engine) ||
      !ROUTE_ACTIONS.has(rule.processor.action)
    )
      fail(422, "INVALID_ROUTE", "匹配规则使用了不支持的引擎或操作。");
    return rule;
  }
  function newTask(state, config, input, actor, at, retryOf, trustedSource) {
    if (state.tasks.length >= MAX_TASKS)
      fail(503, "STORE_FULL", "任务记录已达到存储上限。");
    object(input);
    const title = text(input.title, 200);
    const type = member(input.type, TASK_TYPES);
    const priority = member(input.priority, PRIORITIES);
    const description = text(input.description ?? title, 10000, true);
    const branch = branchName(input.branch ?? config.project.defaultBranch);
    const retryCount = retryOf
      ? retryOf.task.payload.context.retryCount + 1
      : 0;
    integer(retryCount, 10000);
    const rule = route(config, state, type, retryCount);
    const id = randomUUID();
    const entry = {
      task: {
        id,
        type,
        priority,
        payload: {
          repo:
            retryOf?.task.payload.repo ??
            trustedSource?.repo ??
            config.project.repo,
          branch,
          files: [],
          errorDetails: { message: description },
          context: {
            retryCount,
            ...(retryOf ? { retryOf: retryOf.task.id } : {}),
            ...((retryOf?.task.payload.context.source ?? trustedSource)
              ? {
                  source: copy(
                    retryOf?.task.payload.context.source ?? trustedSource,
                  ),
                  commitSha: (
                    retryOf?.task.payload.context.source ?? trustedSource
                  ).commitSha,
                  ciJobUrl: (
                    retryOf?.task.payload.context.source ?? trustedSource
                  ).buildUrl,
                }
              : {}),
          },
        },
        metadata: {
          triggeredBy: "manual",
          triggeredAt: at,
          source: actor.id,
          createdAt: at,
        },
      },
      revision: 1,
      title,
      engineId: rule.processor.engine,
      status: {
        taskId: id,
        status: "pending",
        progress: 0,
        message: "已加入队列，等待已认证的执行器领取。",
      },
      trace: [
        {
          id: randomUUID(),
          title: "已接收任务",
          kind: "agent",
          status: "completed",
          detail: "任务已保存到持久队列。",
        },
      ],
      diff: [],
      routingRule: copy(rule),
      safety: copy(config.safety),
      ...(retryOf?.verificationPolicy
        ? { verificationPolicy: copy(retryOf.verificationPolicy) }
        : trustedSource && config.integrations.policy
          ? { verificationPolicy: copy(config.integrations.policy) }
          : {}),
      executionPhase: "diagnose",
      cancellationRequested: false,
    };
    state.tasks.unshift(entry);
    audit(
      state,
      retryOf ? "retry" : "trigger",
      retryOf ? "已创建重试任务，原记录已保留。" : "已创建任务并保存到队列。",
      actor,
      at,
      id,
    );
    return entry;
  }
  function actionOn(state, config, id, action, body, actor, time) {
    object(body);
    const entry = taskFor(state, id);
    checkRevision(body.expectedRevision, entry.revision);
    const at = time.toISOString();
    if (action === "retry") {
      if (!["failed", "cancelled"].includes(entry.status.status))
        conflict("只有失败或已取消的任务可以重试。");
      if (
        [entry, ...retryAncestors(state, entry)].some(
          (item) => item.reconciliation?.status === "required",
        )
      )
        fail(
          409,
          "RECONCILIATION_REQUIRED",
          "请先核对外部执行结果，再创建重试任务。",
        );
      const next = newTask(
        state,
        config,
        {
          title: entry.title,
          type: entry.task.type,
          priority: entry.task.priority,
          description: entry.task.payload.errorDetails.message,
          branch: entry.task.payload.branch,
        },
        actor,
        at,
        entry,
      );
      entry.revision += 1;
      return { message: "重试任务已创建。", taskId: next.task.id };
    }
    if (action !== "cancel") invalid();
    if (
      !["pending", "running"].includes(entry.status.status) ||
      entry.cancellationRequested
    )
      conflict("当前状态下无法取消此任务。");
    entry.revision += 1;
    if (entry.lease) {
      entry.cancellationRequested = true;
      entry.interruption = "cancelled";
      entry.status.message = "已请求取消，等待执行器确认。";
    } else {
      entry.status = {
        ...entry.status,
        status: "cancelled",
        completedAt: at,
        message: "任务已在执行前取消。",
      };
      entry.executionPhase = "done";
      cancelFlow(entry, actor, at);
    }
    audit(state, "cancel", entry.status.message, actor, at, id, "warning");
    return { message: entry.status.message, taskId: id };
  }
  function activeLease(
    state,
    id,
    body,
    actor,
    phase,
    permitCancellation = false,
  ) {
    object(body);
    const leaseId = text(body.leaseId, 100);
    const entry = taskFor(state, id);
    if (
      !entry.lease ||
      entry.lease.id !== leaseId ||
      entry.lease.actorId !== actor.id ||
      (actor.workerId && actor.workerId !== entry.lease.workerId) ||
      entry.status.status !== "running" ||
      (phase && entry.lease.phase !== phase)
    )
      conflict("执行器租约无效、已过期或不属于当前执行器。");
    if (!permitCancellation && entry.cancellationRequested)
      conflict("任务已请求取消，请确认取消，不再提交执行结果。");
    return entry;
  }
  function gates() {
    return [
      {
        id: "code-review",
        title: "代码审阅",
        role: "代码审阅人",
        detail: "审阅候选变更及检查证据。",
        actor: "",
        status: "pending",
      },
      {
        id: "execution-auth",
        title: "执行授权",
        role: "执行授权人",
        detail: "授权执行器执行已审阅的候选方案。",
        actor: "",
        status: "blocked",
      },
    ];
  }
  function refreshWorker(state, entry, actor, at) {
    const lease = entry.lease ?? entry.terminalLease;
    const registered = state.workers.find(
      (item) =>
        item.workerId === lease.workerId &&
        item.actorId === actor.id &&
        item.engineId === entry.engineId,
    );
    if (registered) registered.lastSeenAt = at;
  }

  function receiptContext(state, id, body, actor, kind) {
    object(body);
    const entry = taskFor(state, id);
    const lease = entry.lease ?? entry.terminalLease;
    if (
      !lease ||
      lease.id !== text(body.leaseId, 100) ||
      lease.actorId !== actor.id ||
      (actor.workerId && actor.workerId !== lease.workerId)
    )
      conflict("执行器回执不属于当前执行器或已知租约。");
    const fingerprint = commandFingerprint(kind, body);
    const previous = entry.receipts?.find(
      (receipt) => receipt.kind === kind && receipt.fingerprint === fingerprint,
    );
    if (previous)
      return { replay: { changed: false, value: copy(previous.response) } };
    if (
      !entry.lease &&
      !(
        ["failed", "cancelled"].includes(entry.status.status) &&
        entry.interruption
      )
    )
      conflict("终态执行结果不能由另一份完成回执覆盖。");
    if ((entry.receipts?.length ?? 0) >= 10)
      fail(
        409,
        "RECEIPT_LIMIT",
        "此任务的回执数量已达上限，请由管理员核对现有证据。",
      );
    return { entry, lease, fingerprint, late: !entry.lease };
  }

  function rememberReceipt(
    entry,
    kind,
    fingerprint,
    lease,
    result,
    response,
    at,
  ) {
    if (entry.verification)
      entry.verification = {
        ...entry.verification,
        status: "stale",
        message: "收到新执行回执，请重新核验。",
      };
    delete entry.verificationAttempt;
    entry.terminalLease = copy(lease);
    (entry.receipts ??= []).push({
      kind,
      fingerprint,
      receivedAt: at,
      response: copy(response),
      ...(result ? { result: copy(result) } : {}),
    });
  }
  return {
    async importJenkinsBuild(body, actor) {
      object(body);
      if (
        Object.keys(body).some(
          (key) => !["sourceId", "buildNumber", "requestId"].includes(key),
        )
      )
        invalid();
      const integration = await integrations();
      const read = await integration.jenkins.readBuild(body);
      return mutate(actor, (state, config, identity, time) => {
        if (read.outcome === "ignored")
          return {
            changed: false,
            value: {
              outcome: "ignored",
              message: "构建已完成且不是失败，无需导入。",
            },
          };
        const source = read.source;
        const existing = state.tasks.find(
          (item) =>
            !item.task.payload.context.retryOf &&
            item.task.payload.context.source?.eventId === source.eventId,
        );
        if (existing) {
          const original = existing.task.payload.context.source;
          if (
            ["repo", "branch", "commitSha", "sourceId"].some(
              (k) => original[k] !== source[k],
            )
          )
            fail(409, "SOURCE_CONFLICT", "同一构建事件的来源发生冲突。");
          return {
            changed: false,
            value: {
              taskId: existing.task.id,
              outcome: "duplicate",
              message: "此失败构建已导入。",
            },
          };
        }
        if (
          source.repo !== config.project.repo ||
          source.branch !== config.project.defaultBranch
        )
          fail(422, "SOURCE_MISMATCH", "Jenkins 来源与项目仓库或分支不一致。");
        const entry = newTask(
          state,
          config,
          {
            title: `Jenkins ${source.jobName} #${source.buildNumber} 失败`,
            type: "ci-failure",
            priority: "high",
            branch: source.branch,
          },
          identity,
          time.toISOString(),
          undefined,
          source,
        );
        if (entry.routingRule.processor.action !== "create-pr")
          fail(
            422,
            "INVALID_ROUTE",
            "Jenkins 修复来源需要明确的 create-pr 路由。",
          );
        return {
          changed: true,
          value: {
            taskId: entry.task.id,
            outcome: "created",
            message: "已导入固定失败提交，等待执行器诊断。",
          },
        };
      });
    },
    async verifyResult(id, body, actor) {
      object(body);
      if (Object.keys(body).some((key) => key !== "expectedRevision"))
        invalid();
      const attemptId = randomUUID();
      let input, fingerprint;
      await mutate(
        actor,
        (state, config, identity, time) => {
          if (!config.integrations.snapshot.verification.configured)
            fail(422, "VERIFICATION_UNAVAILABLE", "独立核验未配置或不可用。");
          const entry = taskFor(state, id);
          checkRevision(body.expectedRevision, entry.revision);
          if (
            entry.proposal?.version !== 2 ||
            !entry.verificationPolicy ||
            !entry.result?.changes?.pr ||
            !entry.result?.changes?.commit
          )
            fail(
              422,
              "VERIFICATION_UNAVAILABLE",
              "任务尚无可独立核验的 v2 PR 回执。",
            );
          input = copy({
            task: entry.task,
            proposal: entry.proposal,
            diff: entry.diff,
            result: entry.result,
            policy: entry.verificationPolicy,
          });
          fingerprint = commandFingerprint(
            "verification",
            verificationTarget(input),
          );
          entry.revision += 1;
          entry.verificationAttempt = {
            id: attemptId,
            fingerprint,
            revision: entry.revision,
          };
          if (entry.verification)
            entry.verification = {
              ...entry.verification,
              status: "stale",
              message: "新的独立核验正在进行。",
            };
          audit(
            state,
            "verification-start",
            "已开始独立只读核验。",
            identity,
            time.toISOString(),
            id,
          );
          return { changed: true, value: {} };
        },
        false,
      );
      // Every remote read is outside the serialized persistent transaction.
      const integration = await integrations();
      let verification = await integration.verifier.verify(input);
      return mutate(actor, (state, config, identity, time) => {
        const entry = taskFor(state, id),
          attempt = entry.verificationAttempt;
        if (
          attempt?.id !== attemptId ||
          attempt.fingerprint !== fingerprint ||
          attempt.revision !== entry.revision ||
          commandFingerprint(
            "verification",
            verificationTarget({
              task: entry.task,
              proposal: entry.proposal,
              result: entry.result,
              policy: entry.verificationPolicy,
            }),
          ) !== fingerprint
        )
          return {
            changed: false,
            value: { message: "核验目标已更新，此次过期结果未保存。" },
          };
        if (!config.integrations.snapshot.verification.configured)
          verification = {
            ...verification,
            status: "error",
            message: "独立核验配置在查询期间已禁用。",
          };
        entry.verification = verification;
        delete entry.verificationAttempt;
        entry.revision += 1;
        audit(
          state,
          "verification",
          verification.message,
          identity,
          time.toISOString(),
          id,
        );
        return {
          changed: true,
          value: {
            verification: copy(verification),
            message: verification.message,
          },
        };
      });
    },
    async snapshot() {
      const config = await loadConsoleConfiguration(root);
      config.integrations = await integrations();
      const time = now();
      let outcome;
      try {
        outcome = await expire(time);
      } catch (error) {
        if (!["STORE_FULL", "STORE_WRITE_ERROR"].includes(error.code))
          throw error;
        // Read the committed state, never the discarded expiry transaction.
        outcome = await store.inspect();
      }
      return snapshotFor(config, outcome.state, time, outcome.storage);
    },
    trigger(body, actor) {
      return mutate(actor, (state, config, identity, time) =>
        idempotent(state, "trigger", body, identity, () => {
          if (config.triggers.manual?.enabled === false)
            fail(403, "TRIGGER_DISABLED", "手动创建任务已停用。");
          const entry = newTask(
            state,
            config,
            body,
            identity,
            time.toISOString(),
          );
          return {
            changed: true,
            value: { message: "任务已创建。", taskId: entry.task.id },
          };
        }),
      );
    },
    taskAction(id, action, body, actor) {
      return mutate(actor, (state, config, identity, time) =>
        idempotent(state, `${action}:${id}`, body, identity, () => ({
          changed: true,
          value: actionOn(state, config, id, action, body, identity, time),
        })),
      );
    },
    reconcile(id, body, actor) {
      return mutate(actor, (state, config, identity, time) =>
        idempotent(state, `reconcile:${id}`, body, identity, () => {
          const entry = taskFor(state, id);
          checkRevision(body.expectedRevision, entry.revision);
          if (
            !["failed", "cancelled"].includes(entry.status.status) ||
            entry.reconciliation?.status !== "required"
          )
            conflict("当前任务没有待核对的外部执行结果。");
          const outcome = member(
            body.outcome,
            new Set(["no-changes", "changes-recorded"]),
          );
          const note = text(body.note, 1000);
          if (
            outcome === "no-changes" &&
            (hasSideEffects(entry.result) ||
              entry.receipts?.some((receipt) => hasSideEffects(receipt.result)))
          )
            fail(
              422,
              "RECONCILIATION_MISMATCH",
              "已有回执记录外部变更，请选择已记录变更并说明核对结果。",
            );
          const at = time.toISOString();
          const resolution = { outcome, note, actor: identity.name, at };
          const previous = entry.reconciliation.history ?? [];
          if (previous.length >= 100)
            fail(409, "RECONCILIATION_LIMIT", "核对记录已达到上限。");
          entry.reconciliation = {
            ...entry.reconciliation,
            status: "resolved",
            updatedAt: at,
            resolution,
            history: [...previous, copy(resolution)],
          };
          entry.revision += 1;
          audit(
            state,
            "reconciled",
            "管理员已记录外部执行结果核对结论。",
            identity,
            at,
            id,
          );
          return {
            changed: true,
            value: {
              taskId: id,
              message: "核对结论已保存，可按实际情况重新尝试。",
            },
          };
        }),
      );
    },
    bulk(body, actor) {
      object(body);
      member(body.type, new Set(["cancel", "retry"]));
      const items = list(body.items, 100, (item) => {
        object(item);
        return { id: text(item.id, 100), revision: integer(item.revision) };
      });
      if (
        !items.length ||
        new Set(items.map((item) => item.id)).size !== items.length
      )
        invalid();
      return mutate(actor, (state, config, identity, time) =>
        idempotent(state, "bulk", body, identity, () => {
          const report = {
            type: body.type,
            requested: items.length,
            applied: [],
            skipped: [],
          };
          for (const item of items) {
            const title =
              state.tasks.find((entry) => entry.task.id === item.id)?.title ??
              item.id;
            try {
              const result = actionOn(
                state,
                config,
                item.id,
                body.type,
                { expectedRevision: item.revision },
                identity,
                time,
              );
              report.applied.push({
                id: item.id,
                title,
                ...(body.type === "retry" ? { newId: result.taskId } : {}),
              });
            } catch (error) {
              if (!(error instanceof HealingError) || error.status >= 500)
                throw error;
              report.skipped.push({
                id: item.id,
                title,
                reason: error.message,
                code: error.code,
              });
            }
          }
          return {
            changed: report.applied.length > 0,
            value: {
              message: `已处理 ${report.applied.length} 项任务，跳过 ${report.skipped.length} 项。`,
              report,
            },
          };
        }),
      );
    },
    decide(id, body, actor) {
      return mutate(actor, (state, config, identity, time) => {
        object(body);
        const entry = taskFor(state, id);
        checkRevision(body.expectedRevision, entry.revision);
        const decision = member(
          body.decision,
          new Set(["approve", "reject", "resubmit"]),
        );
        const flow = entry.approvalFlow;
        if (
          !flow ||
          !Number.isSafeInteger(body.round) ||
          body.round !== flow.round
        )
          conflict("审批轮次已变化，或当前没有可处理的审批。");
        const comment = text(body.comment ?? "", 500, decision === "approve");
        const at = time.toISOString();
        validateProposal(entry);
        if (decision === "resubmit") {
          if (flow.status !== "rejected" || entry.status.status !== "cancelled")
            conflict("只有已拒绝的方案可以重新发起审批。");
          flow.round += 1;
          flow.status = "pending";
          flow.gates = gates();
          entry.reviewState = "pending";
          entry.status.status = "pending";
          entry.executionPhase = "review";
          entry.cancellationRequested = false;
          delete entry.status.completedAt;
          history(entry, "resubmitted", "code-review", comment, identity, at);
        } else {
          if (
            flow.status !== "pending" ||
            entry.reviewState !== "pending" ||
            entry.status.status !== "pending" ||
            entry.executionPhase !== "review"
          )
            conflict("此任务当前没有待处理的审批关卡。");
          const index = flow.gates.findIndex(
            (gate) => gate.status === "pending",
          );
          if (
            index < 0 ||
            flow.gates[index].id !== body.nodeId ||
            flow.gates
              .slice(0, index)
              .some((gate) => gate.status !== "approved")
          )
            conflict("审批节点已变化或尚未解锁。");
          const gate = flow.gates[index];
          gate.status = decision === "approve" ? "approved" : "rejected";
          gate.actor = identity.name;
          gate.decidedAt = at;
          gate.comment = comment;
          history(
            entry,
            decision === "approve" ? "approved" : "rejected",
            gate.id,
            comment,
            identity,
            at,
          );
          if (decision === "reject") {
            flow.status = "rejected";
            for (const later of flow.gates.slice(index + 1))
              later.status = "blocked";
            entry.reviewState = "rejected";
            entry.status.status = "cancelled";
            entry.status.completedAt = at;
            entry.executionPhase = "done";
          } else if (index === 0) flow.gates[1].status = "pending";
          else {
            flow.status = "approved";
            entry.reviewState = "approved";
            entry.executionPhase = "execute";
          }
        }
        entry.revision += 1;
        entry.status.message =
          decision === "reject"
            ? "候选方案已拒绝，后续执行已阻止。"
            : flow.status === "approved"
              ? "候选方案已通过审批，等待执行器领取。"
              : "等待下一项审批决定。";
        audit(
          state,
          decision === "resubmit" ? "resubmit-approval" : `${decision}-gate`,
          entry.status.message,
          identity,
          at,
          id,
          decision === "reject" ? "warning" : "info",
        );
        return {
          changed: true,
          value: { message: entry.status.message, taskId: id },
        };
      });
    },
    toggleRule(id, body, actor) {
      return mutate(actor, (state, config, identity, time) => {
        object(body);
        checkConfigRevision(body, state, "rules");
        if (typeof body.enabled !== "boolean") invalid();
        if (!config.rules.some((rule) => rule.id === id))
          fail(404, "RULE_NOT_FOUND", "找不到指定规则。");
        const current = state.ruleOverrides.find((item) => item.id === id);
        if (current) current.enabled = body.enabled;
        else state.ruleOverrides.push({ id, enabled: body.enabled });
        state.configRevisions.rules += 1;
        audit(
          state,
          "toggle-rule",
          body.enabled ? "已启用路由规则。" : "已停用路由规则。",
          identity,
          time.toISOString(),
          undefined,
          "info",
          id,
        );
        return { changed: true, value: { message: "路由规则已保存。" } };
      });
    },
    saveMonitoring(body, actor) {
      return mutate(actor, (state, config, identity, time) => {
        object(body);
        checkConfigRevision(body, state, "monitoring");
        const exported = exportMonitoringConfig(body.monitoring);
        if (!exported)
          fail(422, "MONITORING_INVALID", "监控配置不完整或格式无效。");
        state.monitoring = exported.monitoring;
        state.configRevisions.monitoring += 1;
        audit(
          state,
          "update-monitoring",
          "监控配置已保存，远端连接尚未验证。",
          identity,
          time.toISOString(),
        );
        return {
          changed: true,
          value: { message: "监控配置已保存。" },
        };
      });
    },
    async claim(body, actor) {
      const response = await workerMutation(
        actor,
        (state, config, identity, time) => {
          object(body);
          const engineId = text(body.engineId, 120);
          const workerId = text(body.workerId, 120);
          if (identity.workerId && identity.workerId !== workerId)
            fail(403, "WORKER_ID_MISMATCH", "执行器标识与认证身份不匹配。");
          if (!config.engines.some((engine) => engine.id === engineId))
            fail(422, "ENGINE_UNAVAILABLE", "指定引擎尚未配置。");
          const filters = {};
          for (const key of [
            "actions",
            "sourceKinds",
            "candidateVersions",
            "phases",
          ])
            if (body[key] !== undefined) {
              if (
                !Array.isArray(body[key]) ||
                !body[key].length ||
                body[key].length > 20
              )
                invalid();
              filters[key] = body[key];
            }
          if (
            filters.actions?.some((v) => !ROUTE_ACTIONS.has(v)) ||
            filters.sourceKinds?.some((v) => v !== "jenkins") ||
            filters.candidateVersions?.some((v) => ![1, 2].includes(v)) ||
            filters.phases?.some((v) => !["diagnose", "execute"].includes(v))
          )
            invalid();
          const at = time.toISOString();
          const registered = state.workers.find(
            (item) =>
              item.workerId === workerId &&
              item.actorId === identity.id &&
              item.engineId === engineId,
          );
          if (registered) registered.lastSeenAt = at;
          else {
            if (state.workers.length >= 1000)
              fail(503, "STORE_FULL", "执行器注册记录已达到存储上限。");
            state.workers.push({
              workerId,
              actorId: identity.id,
              engineId,
              lastSeenAt: at,
            });
            audit(
              state,
              "worker-connected",
              "已认证的执行器已注册到引擎。",
              identity,
              at,
            );
          }
          const entry = [...state.tasks]
            .reverse()
            .find(
              (task) =>
                task.engineId === engineId &&
                (!filters.actions ||
                  filters.actions.includes(
                    task.routingRule.processor.action,
                  )) &&
                (!filters.sourceKinds ||
                  filters.sourceKinds.includes(
                    task.task.payload.context.source?.kind,
                  )) &&
                (!filters.candidateVersions ||
                  filters.candidateVersions.includes(
                    task.task.payload.context.source?.kind === "jenkins"
                      ? 2
                      : 1,
                  )) &&
                (!filters.phases ||
                  filters.phases.includes(task.executionPhase)) &&
                (task.task.payload.context.source?.kind !== "jenkins" ||
                  filters.candidateVersions?.includes(2)) &&
                (task.proposal?.version !== 2 ||
                  task.executionPhase !== "execute" ||
                  (task.proposalSubmission?.workerId === workerId &&
                    task.proposalSubmission?.actorId === identity.id)) &&
                task.status.status === "pending" &&
                !task.lease &&
                !task.cancellationRequested &&
                !retryAncestors(state, task).some(
                  (parent) => parent.reconciliation?.status === "required",
                ) &&
                (task.executionPhase === "diagnose" ||
                  (task.executionPhase === "execute" &&
                    task.reviewState === "approved" &&
                    task.approvalFlow?.gates.every(
                      (gate) => gate.status === "approved",
                    ))),
            );
          if (!entry) return { changed: true, value: { task: null } };
          entry.lease = {
            id: randomUUID(),
            phase: entry.executionPhase,
            workerId,
            actorId: identity.id,
            claimedAt: at,
            expiresAt: new Date(time.getTime() + leaseMs).toISOString(),
          };
          entry.status = {
            ...entry.status,
            status: "running",
            startedAt: entry.status.startedAt ?? at,
            message:
              entry.executionPhase === "execute"
                ? "执行器正在执行已批准的候选方案。"
                : "执行器正在诊断任务。",
          };
          entry.revision += 1;
          audit(
            state,
            "running",
            entry.status.message,
            identity,
            at,
            entry.task.id,
          );
          return {
            changed: true,
            value: {
              task: publicTask(entry),
              lease: {
                id: entry.lease.id,
                phase: entry.lease.phase,
                expiresAt: entry.lease.expiresAt,
              },
              context: {
                safety: copy(entry.safety),
                rule: copy(entry.routingRule),
                monitoring: monitoringFor(config, state),
              },
            },
          };
        },
      );
      return response;
    },
    heartbeat(id, body, actor) {
      return workerMutation(actor, (state, config, identity, time) => {
        const entry = activeLease(state, id, body, identity, undefined, true);
        entry.lease.expiresAt = new Date(
          time.getTime() + leaseMs,
        ).toISOString();
        refreshWorker(state, entry, identity, time.toISOString());
        // Lease renewals do not invalidate a human task action's revision.
        return {
          changed: true,
          value: {
            message: "执行器租约已续期。",
            taskId: id,
            cancelRequested: entry.cancellationRequested,
            lease: {
              id: entry.lease.id,
              phase: entry.lease.phase,
              expiresAt: entry.lease.expiresAt,
            },
          },
        };
      });
    },
    proposal(id, body, actor) {
      return workerMutation(actor, (state, config, identity, time) => {
        object(body);
        const existing = taskFor(state, id);
        if (body.submissionId !== undefined && existing.proposalSubmission) {
          const previous = existing.proposalSubmission;
          if (
            previous.submissionId === body.submissionId &&
            previous.actorId === identity.id &&
            (body.workerId === undefined ||
              previous.workerId === body.workerId) &&
            (!identity.workerId || identity.workerId === previous.workerId) &&
            previous.leaseId === body.leaseId
          ) {
            if (previous.fingerprint !== commandFingerprint("proposal", body))
              fail(
                409,
                "IDEMPOTENCY_CONFLICT",
                "此候选提交标识已用于不同内容。",
              );
            return { changed: false, value: copy(previous.response) };
          }
        }
        const entry = activeLease(state, id, body, identity, "diagnose");
        const candidate =
          body.candidate === undefined
            ? undefined
            : readCandidate(body.candidate, entry);
        if (entry.task.payload.context.source?.kind === "jenkins" && !candidate)
          fail(422, "CANDIDATE_MISMATCH", "Jenkins 来源需要 v2 候选。");
        if (candidate) {
          text(body.submissionId, 128);
          if (
            body.workerId !== undefined &&
            body.workerId !== entry.lease.workerId
          )
            fail(403, "WORKER_ID_MISMATCH", "候选提交的执行器与租约不一致。");
        }
        const summary = text(body.summary, 4000);
        const kind = proposalKind(entry);
        const diff =
          kind === "code-change"
            ? readDiff(body.diff, entry.safety)
            : actionDiff(body.diff);
        const evidence = readEvidence(body.evidence);
        if (kind === "code-change") requiredEvidence(evidence, entry.safety);
        else diagnosticEvidence(evidence);
        const trace = readTrace(body.trace);
        const at = time.toISOString();
        refreshWorker(state, entry, identity, at);
        entry.diff = diff;
        entry.task.payload.files = diff.map((item) => item.path);
        entry.evidence = evidence;
        entry.proposal = {
          id: randomUUID(),
          kind,
          summary,
          submittedAt: at,
          contentHash: candidateHash(diff, evidence),
          ...(candidate ? { version: 2, candidate } : {}),
        };
        entry.proposal.contentHash = entryCandidateHash(entry);
        const response = {
          message: "已收到候选方案，等待代码审阅。",
          taskId: id,
          ...(candidate
            ? {
                proposal: {
                  id: entry.proposal.id,
                  version: 2,
                  contentHash: entry.proposal.contentHash,
                  candidate: copy(candidate),
                },
              }
            : {}),
        };
        if (candidate)
          entry.proposalSubmission = {
            submissionId: body.submissionId,
            actorId: identity.id,
            workerId: entry.lease.workerId,
            leaseId: entry.lease.id,
            fingerprint: commandFingerprint("proposal", body),
            response: copy(response),
          };
        entry.trace.push(...trace, {
          id: randomUUID(),
          title: "候选方案已校验",
          kind: "check",
          status: "completed",
          detail:
            kind === "code-change"
              ? "管理服务已校验必需检查证据、文件数量及保护路径。"
              : "管理服务已记录诊断证据，并确认操作方案不包含代码变更。",
        });
        entry.approvalFlow = {
          schemaVersion: 1,
          source: "server",
          round: 1,
          status: "pending",
          checks: {
            plan: { status: "completed", detail: summary, at },
            quality: {
              status: "completed",
              detail:
                kind === "code-change"
                  ? "执行器已回传全部必需检查的通过证据。"
                  : "诊断证据已记录，无代码变更，不代表检查通过。",
              at,
            },
            safety: {
              status: "completed",
              detail:
                kind === "code-change"
                  ? "管理服务已校验文件数量及保护路径。"
                  : "管理服务已确认操作方案不包含代码变更。",
              at,
            },
          },
          gates: gates(),
          history: [],
        };
        history(
          entry,
          "submitted",
          "code-review",
          "候选方案已提交审批。",
          identity,
          at,
        );
        entry.reviewState = "pending";
        entry.executionPhase = "review";
        entry.status = {
          ...entry.status,
          status: "pending",
          message: "已收到候选方案，等待代码审阅。",
        };
        entry.revision += 1;
        delete entry.lease;
        audit(
          state,
          "proposal",
          "执行器已提交通过校验的候选方案，等待两级审批。",
          identity,
          at,
          id,
        );
        return {
          changed: true,
          value: response,
        };
      });
    },
    complete(id, body, actor) {
      return workerMutation(actor, (state, config, identity, time) => {
        const context = receiptContext(state, id, body, identity, "complete");
        if (context.replay) return context.replay;
        const { entry, lease, fingerprint, late } = context;
        validateCompletionBinding(entry, body, lease);
        const at = time.toISOString();
        const result = readResult(body.result, entry, lease, at);
        const interrupted = late || entry.cancellationRequested;
        // Interrupted reports record facts only; they never authorize or resume an action.
        if (!interrupted) validateSuccessfulResult(result, entry, lease);
        refreshWorker(state, entry, identity, at);
        entry.result = result;
        if (!late) {
          entry.status = {
            ...entry.status,
            status: entry.cancellationRequested
              ? "cancelled"
              : result.success
                ? result.action === "skipped"
                  ? "skipped"
                  : "completed"
                : "failed",
            completedAt: at,
            progress:
              !interrupted && result.success ? 100 : entry.status.progress,
            message: entry.cancellationRequested
              ? "执行已中断，回执已保存，请核对外部操作。"
              : result.success
                ? "执行器已报告执行成功。"
                : "执行器已报告失败。",
          };
        } else {
          entry.status.message =
            "已补录迟到回执，任务终态保持不变，请核对外部操作。";
        }
        if (
          (interrupted && lease.phase === "execute") ||
          (!result.success && lease.phase === "execute") ||
          (interrupted && hasSideEffects(result)) ||
          (!result.success && hasSideEffects(result))
        ) {
          markReconciliation(
            state,
            entry,
            "执行中断或失败，外部操作结果需要核对。",
            at,
            identity,
          );
        }
        entry.executionPhase = "done";
        entry.revision += 1;
        if (entry.cancellationRequested && !late)
          cancelFlow(entry, identity, at);
        const response = { message: entry.status.message, taskId: id };
        rememberReceipt(
          entry,
          "complete",
          fingerprint,
          lease,
          result,
          response,
          at,
        );
        delete entry.lease;
        audit(
          state,
          late ? "late-result" : entry.status.status,
          entry.status.message,
          identity,
          at,
          id,
          entry.reconciliation?.status === "required"
            ? "warning"
            : result.success
              ? "success"
              : "error",
        );
        return { changed: true, value: response };
      });
    },
    acknowledgeCancellation(id, body, actor) {
      return workerMutation(actor, (state, config, identity, time) => {
        const context = receiptContext(state, id, body, identity, "cancelled");
        if (context.replay) return context.replay;
        const { entry, lease, fingerprint, late } = context;
        if (body.result !== undefined)
          validateCompletionBinding(entry, body, lease);
        if (!entry.cancellationRequested) conflict("此任务尚未请求取消。");
        const at = time.toISOString();
        const result =
          body.result === undefined
            ? undefined
            : readResult(body.result, entry, lease, at);
        refreshWorker(state, entry, identity, at);
        if (result) entry.result = result;
        else if (!entry.result)
          entry.result = failureResult(
            entry,
            "CANCELLED",
            "执行器已确认停止，未提供执行回执。",
            at,
          );
        if (!late) {
          entry.status = {
            ...entry.status,
            status: "cancelled",
            completedAt: at,
            message: "执行器已确认取消。",
          };
          cancelFlow(entry, identity, at);
        } else entry.status.message = "已补录取消确认，任务终态保持不变。";
        if (
          (!late || result) &&
          (lease.phase === "execute" || hasSideEffects(result))
        )
          markReconciliation(
            state,
            entry,
            "执行器已停止，请核对取消前可能发生的外部操作。",
            at,
            identity,
          );
        entry.executionPhase = "done";
        entry.revision += 1;
        const response = { message: entry.status.message, taskId: id };
        rememberReceipt(
          entry,
          "cancelled",
          fingerprint,
          lease,
          result,
          response,
          at,
        );
        delete entry.lease;
        audit(
          state,
          "cancelled",
          entry.status.message,
          identity,
          at,
          id,
          "warning",
        );
        return { changed: true, value: response };
      });
    },
    close: () => store.close(),
  };
}
