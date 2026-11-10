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
    /[\s~^:?*\[\\]/.test(name) ||
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
  const { requestId, ...payload } = body;
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
function validateStoredState(state) {
  object(state);
  if (state.schemaVersion !== 1) invalid();
  integer(state.revision);
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
        entry.proposal.contentHash !== candidateHash(entry.diff, entry.evidence)
      )
        invalid();
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
    ...(entry.result ? { result: copy(entry.result) } : {}),
  };
}

/** Persistent control plane. Only authenticated workers provide execution evidence. */
export function createHealingService({
  rootDir = defaultRoot,
  dataDir,
  clock = () => new Date(),
  leaseMs = 60000,
} = {}) {
  const root = resolve(rootDir);
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 3600000)
    throw new TypeError(
      "leaseMs must be a positive duration of at most one hour.",
    );
  const store = createConsoleStore({
    dataDir: dataDir ?? join(root, ".healing"),
    initialState: {
      schemaVersion: 1,
      revision: 0,
      tasks: [],
      activity: [],
      ruleOverrides: [],
      workers: [],
      requests: [],
      monitoring: null,
    },
    validate: validateStoredState,
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
  function snapshotFor(config, state, time) {
    const liveWorkers = state.workers.filter(
      (item) => time.getTime() - Date.parse(item.lastSeenAt) <= leaseMs,
    );
    return {
      apiVersion: 1,
      mode: "live",
      revision: state.revision,
      generatedAt: time.toISOString(),
      configSource: config.configSource,
      rulesSource: config.rulesSource,
      rulesVersion: config.rulesVersion,
      project: copy(config.project),
      safety: copy(config.safety),
      triggers: copy(config.triggers),
      capabilities: {
        trigger: config.triggers.manual?.enabled !== false,
        cancel: true,
        retry: true,
        approve: true,
        updateRules: true,
        updateMonitoring: true,
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
  function cancelFlow(entry, actor, at) {
    if (!entry.approvalFlow) return;
    const flow = entry.approvalFlow;
    const nodeId =
      flow.gates.find((gate) => gate.status === "pending")?.id ?? "execute";
    flow.status = "cancelled";
    for (const gate of flow.gates)
      if (gate.status === "pending") gate.status = "blocked";
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
  async function mutate(actor, operation) {
    const identity = actorIdentity(actor);
    const config = await loadConsoleConfiguration(root);
    const time = now();
    await expire(time);
    const outcome = await store.transact((state) =>
      operation(state, config, identity, time),
    );
    return {
      ...outcome.value,
      snapshot: snapshotFor(config, outcome.state, time),
    };
  }
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
  function newTask(state, config, input, actor, at, retryOf) {
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
          repo: config.project.repo,
          branch,
          files: [],
          errorDetails: { message: description },
          context: {
            retryCount,
            ...(retryOf ? { retryOf: retryOf.task.id } : {}),
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
    const registered = state.workers.find(
      (item) =>
        item.workerId === entry.lease.workerId &&
        item.actorId === actor.id &&
        item.engineId === entry.engineId,
    );
    if (registered) registered.lastSeenAt = at;
  }
  return {
    async snapshot() {
      const config = await loadConsoleConfiguration(root);
      const time = now();
      const { state } = await expire(time);
      return snapshotFor(config, state, time);
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
        checkRevision(body.expectedRevision, state.revision);
        if (typeof body.enabled !== "boolean") invalid();
        if (!config.rules.some((rule) => rule.id === id))
          fail(404, "RULE_NOT_FOUND", "找不到指定规则。");
        const current = state.ruleOverrides.find((item) => item.id === id);
        if (current) current.enabled = body.enabled;
        else state.ruleOverrides.push({ id, enabled: body.enabled });
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
        checkRevision(body.expectedRevision, state.revision);
        const exported = exportMonitoringConfig(body.monitoring);
        if (!exported)
          fail(422, "MONITORING_INVALID", "监控配置不完整或格式无效。");
        state.monitoring = exported.monitoring;
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
      const response = await mutate(actor, (state, config, identity, time) => {
        object(body);
        const engineId = text(body.engineId, 120);
        const workerId = text(body.workerId, 120);
        if (identity.workerId && identity.workerId !== workerId)
          fail(403, "WORKER_ID_MISMATCH", "执行器标识与认证身份不匹配。");
        if (!config.engines.some((engine) => engine.id === engineId))
          fail(422, "ENGINE_UNAVAILABLE", "指定引擎尚未配置。");
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
              task.status.status === "pending" &&
              !task.lease &&
              !task.cancellationRequested &&
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
      });
      const { snapshot, ...result } = response;
      return result;
    },
    heartbeat(id, body, actor) {
      return mutate(actor, (state, config, identity, time) => {
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
      return mutate(actor, (state, config, identity, time) => {
        const entry = activeLease(state, id, body, identity, "diagnose");
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
          value: { message: entry.status.message, taskId: id },
        };
      });
    },
    complete(id, body, actor) {
      return mutate(actor, (state, config, identity, time) => {
        const entry = activeLease(state, id, body, identity);
        const source = object(body.result);
        if (typeof source.success !== "boolean") invalid();
        const action = member(source.action, ACTIONS);
        if (
          (source.success && action === "failed") ||
          (!source.success && !["failed", "skipped"].includes(action))
        )
          invalid();
        if (
          source.success &&
          entry.lease.phase !== "execute" &&
          action !== "skipped"
        )
          conflict("成功的代码变更必须来自已批准的执行租约。");
        if (
          source.success &&
          action !== "skipped" &&
          action !== RESULT_ACTION[entry.routingRule.processor.action]
        )
          fail(422, "ACTION_MISMATCH", "完成的操作与路由授权不一致。");
        const evidence = readEvidence(source.evidence ?? {});
        const logs = list(source.logs ?? [], 1000, (line) =>
          text(line, 4000, true),
        );
        if (
          logs.reduce((size, line) => size + Buffer.byteLength(line), 0) >
          1024 * 1024
        )
          invalid();
        let changes;
        if (source.changes !== undefined) {
          const change = object(source.changes);
          const files = list(change.files ?? [], 100, safePath);
          changes = { files };
          if (change.commit !== undefined) {
            if (
              typeof change.commit !== "string" ||
              !/^[0-9a-f]{40,64}$/i.test(change.commit)
            )
              invalid();
            changes.commit = change.commit;
          }
          for (const key of ["pr", "issue"])
            if (change[key] !== undefined) {
              const value = integer(change[key]);
              if (!value) invalid();
              changes[key] = value;
            }
        }
        if (
          source.success &&
          action === "skipped" &&
          (changes?.files.length ||
            changes?.commit !== undefined ||
            changes?.pr !== undefined ||
            changes?.issue !== undefined)
        )
          fail(
            422,
            "UNAPPROVED_CHANGE",
            "跳过的操作不得包含文件变更、提交、拉取请求或议题。",
          );
        if (source.success && entry.lease.phase === "execute") {
          if (proposalKind(entry) === "code-change")
            requiredEvidence(evidence, entry.safety);
          else {
            diagnosticEvidence(evidence);
            if (
              changes?.files.length ||
              changes?.commit !== undefined ||
              changes?.pr !== undefined ||
              (action !== "issue-created" && changes?.issue !== undefined)
            )
              fail(
                422,
                "UNAPPROVED_CHANGE",
                "操作结果不得包含代码变更或未经授权的外部产物。",
              );
          }
          if (
            (action === "committed" && !changes?.commit) ||
            (action === "pr-created" && !changes?.pr) ||
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
        const at = time.toISOString();
        refreshWorker(state, entry, identity, at);
        const startedAt = entry.status.startedAt ?? entry.lease.claimedAt;
        entry.result = {
          taskId: id,
          success: source.success,
          action,
          ...(changes ? { changes } : {}),
          logs,
          evidence,
          timings: {
            startedAt,
            completedAt: at,
            durationMs: Math.max(0, time.getTime() - Date.parse(startedAt)),
          },
        };
        if (!source.success) {
          const error = source.error ? object(source.error) : {};
          entry.result.error = {
            code: text(error.code ?? "WORKER_FAILED", 120),
            message: text(error.message ?? "执行器已报告失败。", 1000),
            retriable: error.retriable === true,
          };
        }
        entry.status = {
          ...entry.status,
          status: source.success
            ? action === "skipped"
              ? "skipped"
              : "completed"
            : "failed",
          completedAt: at,
          progress: source.success ? 100 : entry.status.progress,
          message: source.success
            ? "执行器已报告执行成功。"
            : "执行器已报告失败。",
        };
        entry.executionPhase = "done";
        entry.revision += 1;
        delete entry.lease;
        audit(
          state,
          entry.status.status,
          entry.status.message,
          identity,
          at,
          id,
          source.success ? "success" : "error",
        );
        return {
          changed: true,
          value: { message: entry.status.message, taskId: id },
        };
      });
    },
    acknowledgeCancellation(id, body, actor) {
      return mutate(actor, (state, config, identity, time) => {
        const entry = activeLease(state, id, body, identity, undefined, true);
        if (!entry.cancellationRequested) conflict("此任务尚未请求取消。");
        const at = time.toISOString();
        refreshWorker(state, entry, identity, at);
        entry.status = {
          ...entry.status,
          status: "cancelled",
          completedAt: at,
          message: "执行器已确认取消。",
        };
        entry.executionPhase = "done";
        entry.revision += 1;
        delete entry.lease;
        cancelFlow(entry, identity, at);
        audit(
          state,
          "cancelled",
          entry.status.message,
          identity,
          at,
          id,
          "warning",
        );
        return {
          changed: true,
          value: { message: entry.status.message, taskId: id },
        };
      });
    },
    close: () => store.close(),
  };
}
