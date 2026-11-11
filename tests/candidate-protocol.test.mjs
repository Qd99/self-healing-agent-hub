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
    {
      ...input,
      diff: [{ ...input.diff[0], lines: [{ type: "add", content: " x " }] }],
    },
    {
      ...input,
      evidence: { ...input.evidence, afterState: "Different result" },
    },
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

test("v2 summary and evidence share the Hub canonical representation", async () => {
  const m = await import("../packages/framework/src/candidate.mjs");
  const raw = {
    ...input,
    summary: "\nFix\n",
    evidence: {
      beforeState: { summary: "\nBroken\n", status: " failed " },
      afterState: " passed ",
      testsRun: [" test "],
      checksPass: ["\ttest\n"],
    },
  };
  const expected = {
    summary: "Fix",
    candidate: input.candidate,
    diff: input.diff,
    evidence: {
      beforeState: { summary: "Broken", status: "failed" },
      afterState: "passed",
      testsRun: ["test"],
      checksPass: ["test"],
      checksFail: [],
    },
  };
  assert.equal(
    m.hashCandidateV2(raw),
    m.hashCandidateV2({ ...input, ...expected }),
  );
  assert.deepEqual(m.normalizeCandidateV2(raw), expected);
  assert.equal(
    raw.summary,
    "\nFix\n",
    "normalization must not rewrite a replay body",
  );
  assert.deepEqual(raw.evidence.testsRun, [" test "]);
});

test("v2 paths and diff text keep their exact identity without normalization", async () => {
  const m = await import("../packages/framework/src/candidate.mjs");
  for (const path of ["src/with space.js", "src/é.js", "src/e\u0301.js"]) {
    const value = {
      ...input,
      diff: [
        {
          path,
          additions: 1,
          deletions: 0,
          lines: [{ type: "add", content: "  exact text\r" }],
        },
      ],
    };
    assert.deepEqual(m.normalizeCandidateV2(value).diff, value.diff);
  }
  assert.notEqual(
    m.hashCandidateV2({ ...input, diff: [{ ...input.diff[0], path: "é" }] }),
    m.hashCandidateV2({
      ...input,
      diff: [{ ...input.diff[0], path: "e\u0301" }],
    }),
  );
  for (const path of [
    " a",
    "a ",
    "\u00a0a",
    "a\u00a0",
    "a:b",
    "/a",
    "a\\b",
    "a//b",
    "a/../b",
    "a".repeat(501),
  ])
    assert.throws(
      () => m.hashCandidateV2({ ...input, diff: [{ ...input.diff[0], path }] }),
      /path/i,
      JSON.stringify(path),
    );
});

test("historically accepted exact paths remain hashable while new Worker input rejects them", async () => {
  const m = await import("../packages/framework/src/candidate.mjs");
  for (const path of ["a\tb", ".Git/config"]) {
    const value = { ...input, diff: [{ ...input.diff[0], path }] };
    assert.equal(m.normalizeCandidateV2(value).diff[0].path, path);
    assert.match(m.hashCandidateV2(value), /^[a-f0-9]{64}$/);
    assert.throws(() => m.validateCandidatePathV2(path), /path/i);
  }
});

test("v2 normalization rejects unknown identity data rather than dropping it", async () => {
  const m = await import("../packages/framework/src/candidate.mjs");
  for (const changed of [
    { candidate: { ...input.candidate, publicationTarget: "other" } },
    { diff: [{ ...input.diff[0], hiddenChange: "other" }] },
    {
      diff: [
        {
          ...input.diff[0],
          lines: [{ ...input.diff[0].lines[0], hidden: "other" }],
        },
      ],
    },
    { evidence: { ...input.evidence, unverified: "other" } },
    { evidence: { ...input.evidence, beforeState: { hidden: "other" } } },
  ])
    assert.throws(
      () => m.hashCandidateV2({ ...input, ...changed }),
      /candidate/i,
    );
  for (const summary of ["\n \t", "Fix\u0000", "x".repeat(4001)])
    assert.throws(() => m.hashCandidateV2({ ...input, summary }), /summary/i);
});
