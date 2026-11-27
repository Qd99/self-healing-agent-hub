import { operations } from "./console-p1.mjs";

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
