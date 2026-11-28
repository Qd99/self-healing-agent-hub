import { existingOperations, operations } from "./console-p1.mjs";

const record = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v) => typeof v === "string";
const nonempty = (v) => text(v) && v.length > 0;
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const date = (v) => text(v) && Number.isFinite(Date.parse(v));
const one = (v, values) => values.includes(v);
const check = (condition) => {
  if (!condition)
    throw Object.assign(new Error("管理服务返回的数据格式不正确。"), {
      code: "INVALID_RESPONSE",
    });
};

function task(item) {
  check(
    record(item) &&
      record(item.task) &&
      nonempty(item.task.id) &&
      text(item.title) &&
      integer(item.revision),
  );
  check(record(item.task.metadata) && date(item.task.metadata.createdAt));
  check(
    record(item.status) &&
      one(item.status.status, [
        "pending",
        "running",
        "completed",
        "failed",
        "cancelled",
        "skipped",
      ]),
  );
  check(
    Number.isFinite(item.status.progress) &&
      item.status.progress >= 0 &&
      item.status.progress <= 100 &&
      text(item.status.message),
  );
  check(
    record(item.execution) &&
      one(item.execution.phase, ["diagnose", "review", "execute", "done"]) &&
      typeof item.execution.cancelRequested === "boolean",
  );
  if (item.reviewState !== undefined)
    check(one(item.reviewState, ["pending", "approved", "rejected"]));
  if (item.trace !== undefined) {
    check(Array.isArray(item.trace));
    for (const row of item.trace)
      check(record(row) && text(row.id) && text(row.title) && text(row.status));
  }
  if (item.observation !== undefined) {
    check(record(item.observation) && Array.isArray(item.observation.events));
    for (const row of item.observation.events)
      check(
        record(row) &&
          text(row.stage) &&
          text(row.state) &&
          date(row.observedAt),
      );
  }
  if (item.proposal !== undefined)
    check(
      record(item.proposal) &&
        text(item.proposal.id) &&
        text(item.proposal.summary),
    );
  if (item.result !== undefined) {
    check(
      record(item.result) &&
        typeof item.result.success === "boolean" &&
        text(item.result.action),
    );
    if (item.result.error !== undefined)
      check(
        record(item.result.error) &&
          text(item.result.error.code) &&
          text(item.result.error.message),
      );
  }
}

function snapshot(value) {
  check(
    record(value) &&
      value.apiVersion === 1 &&
      value.mode === "live" &&
      integer(value.revision),
  );
  check(
    record(value.project) &&
      ["id", "repo", "defaultBranch"].every((key) =>
        nonempty(value.project[key]),
      ),
  );
  check(
    record(value.auth) &&
      typeof value.auth.required === "boolean" &&
      text(value.auth.actor),
  );
  check(
    record(value.storage) && one(value.storage.status, ["ready", "read-only"]),
  );
  check(
    date(value.generatedAt) &&
      nonempty(value.csrfToken) &&
      record(value.capabilities),
  );
  check(
    Array.isArray(value.tasks) &&
      Array.isArray(value.engines) &&
      Array.isArray(value.activity),
  );
  for (const item of value.tasks) task(item);
  for (const item of value.engines)
    check(record(item) && text(item.id) && text(item.status));
  for (const item of value.activity)
    check(record(item) && text(item.id) && text(item.message) && date(item.at));
}

/** Validate only the fields consumed by P1; permit compatible additions. */
export function validateResponse(operationId, value) {
  check(Object.hasOwn(operations, operationId));
  const shape = operations[operationId].response;
  if (shape === "snapshot") snapshot(value);
  else if (shape === "session") {
    check(record(value) && text(value.message));
    snapshot(value.snapshot);
  } else check(record(value) && text(value.message));
  return value;
}

export function validateExisting(action, value) {
  check(Object.hasOwn(existingOperations, action) && record(value));
  switch (existingOperations[action].response) {
    case "mutation":
    case "task-created":
    case "bulk": {
      check(text(value.message));
      snapshot(value.snapshot);
      if (existingOperations[action].response === "task-created")
        check(nonempty(value.taskId));
      if (existingOperations[action].response === "bulk") {
        check(
          record(value.report) &&
            Array.isArray(value.report.applied) &&
            Array.isArray(value.report.skipped),
        );
        check(
          [...value.report.applied, ...value.report.skipped].every(
            (x) => record(x) && text(x.id) && text(x.title),
          ),
        );
      }
      break;
    }
    case "monitor-check":
      check(
        record(value.check) &&
          record(value.monitoring) &&
          integer(value.revision),
      );
      break;
    case "list":
      check(Array.isArray(value.items) && value.items.every(record));
      break;
    case "github-detail":
      check(
        record(value.item) &&
          integer(value.item.number) &&
          text(value.item.title) &&
          text(value.item.body) &&
          Array.isArray(value.comments) &&
          value.comments.every(record),
      );
      break;
    case "series":
      check(
        text(value.metric) &&
          text(value.unit) &&
          text(value.namespace) &&
          Array.isArray(value.points),
      );
      check(
        value.points.length <= 241 &&
          value.points.every(
            (p, i, all) =>
              Array.isArray(p) &&
              p.length === 2 &&
              Number.isFinite(p[0]) &&
              (p[1] === null || Number.isFinite(p[1])) &&
              (!i || p[0] > all[i - 1][0]),
          ),
      );
      break;
    case "profiles":
      check(
        typeof value.enabled === "boolean" && Array.isArray(value.profiles),
      );
      break;
    case "job":
      check(nonempty(value.id) && text(value.state));
      break;
    case "runner":
      check(text(value.state));
      break;
    case "feishu":
      check(
        typeof value.online === "boolean" &&
          text(value.bot) &&
          text(value.user),
      );
      break;
    case "autoloop":
      // The Autoloop projection is a snapshot of the live workbench ledger:
      // counts, runs, cards, agents, lines and channels, each explicitly capped.
      check(
        text(value.source) &&
          value.source === "autoloop" &&
          text(value.observedAt) &&
          integer(value.seq) &&
          record(value.totals) &&
          Array.isArray(value.runs) &&
          Array.isArray(value.cards) &&
          Array.isArray(value.agents) &&
          Array.isArray(value.lines) &&
          Array.isArray(value.channels),
      );
      check(value.runs.length <= 120 && value.cards.length <= 200);
      check(value.agents.length <= 60 && value.lines.length <= 60);
      check(
        value.runs.every(
          (row) =>
            record(row) &&
            text(row.state) &&
            text(row.rule) &&
            text(row.agent) &&
            Array.isArray(row.events),
        ),
      );
      check(
        value.cards.every(
          (row) =>
            record(row) &&
            text(row.state) &&
            text(row.title) &&
            Array.isArray(row.options),
        ),
      );
      check(
        value.agents.every(
          (row) =>
            record(row) &&
            text(row.id) &&
            typeof row.online === "boolean" &&
            record(row.totals),
        ),
      );
      break;
    default:
      check(false);
  }
  return value;
}
