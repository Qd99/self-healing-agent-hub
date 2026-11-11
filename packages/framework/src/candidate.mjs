import { createHash } from "node:crypto";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function invalid(field) {
  throw new TypeError(`Invalid candidate ${field}`);
}
function object(value, keys, field) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    invalid(field);
  return value;
}
function text(value, limit, field, allowEmpty = false) {
  if (
    typeof value !== "string" ||
    value.length > limit ||
    // Match persisted Hub text; tabs and line breaks are valid summary text.
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  )
    invalid(field);
  const result = value.trim();
  if (!allowEmpty && !result) invalid(field);
  return result;
}
export function normalizeCandidateSummaryV2(value) {
  return text(value, 4000, "summary");
}
// Persisted v2 identities retain the former Hub path alphabet. Internal tabs
// and differently cased .git components were accepted by that protocol, so
// rejecting them while hashing would make an existing Hub store unreadable.
// Edge whitespace is never canonical: the old Hub stored its trimmed form.
function canonicalPathV2(path) {
  if (
    typeof path !== "string" ||
    !path ||
    path.length > 500 ||
    path !== path.trim() ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes(":") ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000a-\u001f\u007f]/.test(path) ||
    path
      .split("/")
      .some((part) => !part || part === "." || part === ".." || part === ".git")
  )
    invalid("path");
  return path;
}
/** Strict admission for model changes, new proposals and Worker recovery.
 * Paths are identifiers: reject unsupported forms without renaming them.
 */
export function validateCandidatePathV2(path) {
  canonicalPathV2(path);
  if (
    path.includes("\t") ||
    path.split("/").some((part) => part.toLowerCase() === ".git")
  )
    invalid("path");
  return path;
}
function state(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string")
    return text(value, 4000, "evidence state", true);
  const keys = ["commitSha", "branch", "summary", "status"];
  object(value, keys, "evidence state");
  return Object.fromEntries(
    keys
      .filter((key) => value[key] !== undefined)
      .map((key) => [
        key,
        text(
          value[key],
          key === "summary" ? 4000 : 200,
          "evidence state",
          true,
        ),
      ]),
  );
}
function checks(value) {
  if (!Array.isArray(value) || value.length > 100) invalid("evidence checks");
  return value.map((item) => text(item, 300, "evidence check"));
}
/** One canonical v2 representation for storage, transmission and hashing.
 * Unknown identity fields are rejected, never silently removed. Artifact-only
 * data (patch/files) and request metadata belong outside these identity fields.
 */
export function normalizeCandidateV2({ summary, candidate, diff, evidence }) {
  const c = object(
    candidate,
    ["version", "baseCommitSha", "patchSha256", "treeSha", "artifactId"],
    "manifest",
  );
  if (
    c.version !== 2 ||
    typeof c.baseCommitSha !== "string" ||
    !/^[a-f0-9]{40}$/.test(c.baseCommitSha) ||
    typeof c.treeSha !== "string" ||
    !/^[a-f0-9]{40}$/.test(c.treeSha) ||
    typeof c.patchSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(c.patchSha256) ||
    c.artifactId !== c.patchSha256
  )
    invalid("manifest");
  if (!Array.isArray(diff) || !diff.length || diff.length > 100)
    invalid("diff");
  let bytes = 0;
  const normalizedDiff = diff.map((item) => {
    object(item, ["path", "additions", "deletions", "lines"], "diff");
    const path = canonicalPathV2(item.path);
    if (!Array.isArray(item.lines) || item.lines.length > 5000)
      invalid("diff lines");
    const lines = item.lines.map((line) => {
      object(line, ["type", "content"], "diff line");
      if (
        !["context", "add", "remove"].includes(line.type) ||
        typeof line.content !== "string" ||
        line.content.length > 20000 ||
        line.content.includes("\0")
      )
        invalid("diff line");
      bytes += Buffer.byteLength(line.content);
      return { type: line.type, content: line.content };
    });
    for (const [key, type] of [
      ["additions", "add"],
      ["deletions", "remove"],
    ])
      if (
        !Number.isSafeInteger(item[key]) ||
        item[key] < 0 ||
        item[key] > 100000 ||
        item[key] !== lines.filter((line) => line.type === type).length
      )
        invalid("diff count");
    return {
      path,
      additions: item.additions,
      deletions: item.deletions,
      lines,
    };
  });
  if (
    bytes > 1024 * 1024 ||
    new Set(normalizedDiff.map((item) => item.path)).size !==
      normalizedDiff.length
  )
    invalid("diff");
  const e = object(
    evidence,
    ["beforeState", "afterState", "testsRun", "checksPass", "checksFail"],
    "evidence",
  );
  return {
    summary: normalizeCandidateSummaryV2(summary),
    candidate: { ...c },
    diff: normalizedDiff,
    evidence: {
      beforeState: state(e.beforeState),
      afterState: state(e.afterState),
      testsRun: checks(e.testsRun ?? []),
      checksPass: checks(e.checksPass ?? []),
      checksFail: checks(e.checksFail ?? []),
    },
  };
}
function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, ordered(value[key])]),
    );
  return value;
}
/** Stable v2 identity shared by Hub and Worker. Arrays retain their order. */
export function hashCandidateV2({
  task,
  action,
  summary,
  candidate,
  diff,
  evidence,
}) {
  const { repo, branch, context } = task.payload;
  const canonical = normalizeCandidateV2({
    summary,
    candidate,
    diff,
    evidence,
  });
  return createHash("sha256")
    .update(
      JSON.stringify(
        ordered({
          version: 2,
          task: {
            id: task.id,
            repo,
            branch,
            source: context.source,
            commitSha: context.commitSha,
          },
          action,
          ...canonical,
        }),
      ),
    )
    .digest("hex");
}
export function repairBranchFor(taskId) {
  if (typeof taskId !== "string" || !UUID.test(taskId))
    throw new TypeError("A complete task UUID is required.");
  return `heal/${taskId.toLowerCase()}`;
}
