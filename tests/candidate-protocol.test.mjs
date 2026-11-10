import test from "node:test";
import assert from "node:assert/strict";
const id = "01234567-89ab-cdef-0123-456789abcdef";
const input = {
  task: {
    id,
    payload: {
      repo: "owner/repo",
      branch: "main",
      context: {
        commitSha: "a".repeat(40),
        source: { kind: "jenkins", eventId: "event" },
      },
    },
  },
  action: "create-pr",
  summary: "Fix",
  candidate: {
    version: 2,
    baseCommitSha: "a".repeat(40),
    patchSha256: "b".repeat(64),
    treeSha: "c".repeat(40),
    artifactId: "b".repeat(64),
  },
  diff: [
    {
      path: "a",
      lines: [{ type: "add", content: "x" }],
      additions: 1,
      deletions: 0,
    },
  ],
  evidence: { testsRun: ["test"], checksPass: ["test"], checksFail: [] },
};
test("v2 canonical identity binds immutable task/candidate and normalizes evidence", async () => {
  const m = await import("../packages/framework/src/candidate.mjs").catch(
    () => ({}),
  );
  assert.equal(typeof m.hashCandidateV2, "function");
  const hash = m.hashCandidateV2(input);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(
    m.hashCandidateV2({
      ...input,
      candidate: Object.fromEntries(Object.entries(input.candidate).reverse()),
    }),
    hash,
  );
  assert.equal(
    m.hashCandidateV2({
      ...input,
      evidence: { ...input.evidence, beforeState: null, afterState: null },
    }),
    hash,
  );
  assert.equal(
    m.hashCandidateV2({
      ...input,
      task: { ...input.task, metadata: { createdAt: "later" } },
    }),
    hash,
  );
  for (const changed of [
    { ...input, summary: "Other" },
    { ...input, action: "retry" },
    { ...input, task: { ...input.task, id: "other" } },
    { ...input, candidate: { ...input.candidate, treeSha: "d".repeat(40) } },
    { ...input, diff: [{ ...input.diff[0], path: "b" }] },
  ])
    assert.notEqual(m.hashCandidateV2(changed), hash);
});
test("repair branches require complete UUIDs", async () => {
  const m = await import("../packages/framework/src/candidate.mjs").catch(
    () => ({}),
  );
  assert.equal(typeof m.repairBranchFor, "function");
  assert.equal(m.repairBranchFor(id), `heal/${id}`);
  assert.throws(() => m.repairBranchFor("../bad"));
});
