export const base = "a".repeat(40),
  tree = "b".repeat(40),
  commit = "c".repeat(40);
export function claim(phase = "diagnose") {
  return {
    task: {
      task: {
        id: "00000000-0000-4000-8000-000000000001",
        type: "ci-failure",
        payload: {
          repo: "acme/project",
          branch: "main",
          context: { commitSha: base, source: { kind: "jenkins" } },
        },
      },
      proposal: null,
      approvalFlow: { gates: [{ status: "approved" }, { status: "approved" }] },
      reviewState: "approved",
    },
    lease: {
      id: "lease-1",
      phase,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    },
    context: { rule: { processor: { action: "create-pr" } }, safety: {} },
  };
}
export function candidate() {
  return {
    version: 2,
    baseCommitSha: base,
    treeSha: tree,
    patchSha256: "d".repeat(64),
    artifactId: "d".repeat(64),
  };
}
export const result = () => {
  const data = {
    summary: "Repair test",
    diff: [{ path: "a.js", before: "bad", after: "good" }],
    evidence: { testsRun: ["test"], checksPass: ["test"], checksFail: [] },
    candidate: candidate(),
  };
  return {
    ...data,
    artifact: {
      ...data,
      patch: "patch",
      files: [{ path: "a.js", mode: "100644", content: "good" }],
    },
  };
};
export const config = () => ({
  workerId: "worker-local",
  engineId: "fast",
  publish: { enabled: false },
  repository: { fullName: "acme/project", branch: "main" },
  heartbeatIntervalMs: 10,
  pollIntervalMs: 10,
  github: { token: "secret" },
});
export function memory() {
  const m = new Map();
  return {
    get: (id) => structuredClone(m.get(id)),
    list: () => [...m].map(([id, r]) => ({ id, ...structuredClone(r) })),
    put: async (id, r) => m.set(id, structuredClone(r)),
    close: async () => {},
  };
}
