import { createHash } from "node:crypto";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
  const normalizedEvidence = {
    beforeState: evidence.beforeState ?? null,
    afterState: evidence.afterState ?? null,
    testsRun: evidence.testsRun ?? [],
    checksPass: evidence.checksPass ?? [],
    checksFail: evidence.checksFail ?? [],
  };
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
          summary,
          candidate,
          diff,
          evidence: normalizedEvidence,
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
