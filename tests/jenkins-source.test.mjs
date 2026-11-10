import test from "node:test";
import assert from "node:assert/strict";
const load = () =>
  import("../apps/healing-hub/src/jenkins-source.mjs").catch(() => ({}));
const config = {
  enabled: true,
  sourceId: "ci",
  generation: "1",
  baseUrl: "https://ci.example/",
  jobSegments: ["folder", "build"],
  repo: "owner/repo",
  branch: "main",
  scmBranch: "origin/main",
  scmRemoteUrls: ["https://github.com/owner/repo.git"],
};
const sha = "a".repeat(40);
const build = () => ({
  number: 7,
  building: false,
  result: "FAILURE",
  actions: [
    {
      _class: "hudson.plugins.git.util.BuildData",
      remoteUrls: config.scmRemoteUrls,
      lastBuiltRevision: {
        SHA1: sha,
        branch: [{ name: "origin/main", SHA1: sha }],
      },
      buildsByBranchName: {
        "origin/main": {
          buildNumber: 7,
          revision: { SHA1: sha, branch: [{ name: "origin/main", SHA1: sha }] },
          marked: { SHA1: sha, branch: [{ name: "origin/main", SHA1: sha }] },
        },
      },
    },
  ],
});
test("trusted source constructs bounded read-only paths and stable event identity", async () => {
  const m = await load();
  assert.equal(typeof m.createJenkinsSource, "function");
  let url,
    calls = 0;
  const source = m.createJenkinsSource(config, {
    fetchImpl: async (u, o) => {
      calls++;
      url = u;
      assert.equal(o.method, "GET");
      assert.equal(o.redirect, "error");
      return Response.json(build());
    },
  });
  const result = await source.readBuild({ sourceId: "ci", buildNumber: 7 });
  assert.equal(result.source.commitSha, sha);
  assert.equal(
    result.source.buildUrl,
    "https://ci.example/job/folder/job/build/7/",
  );
  assert.equal(url, "https://ci.example/job/folder/job/build/7/api/json");
  assert.equal(
    (await source.readBuild({ sourceId: "ci", buildNumber: 7 })).source.eventId,
    result.source.eventId,
  );
  await assert.rejects(
    source.readBuild({ sourceId: "wrong", buildNumber: 7 }),
    { code: "SOURCE_UNAVAILABLE" },
  );
  assert.equal(calls, 2);
});
test("ambiguous SCM, stale build, inconsistent revision and running builds fail closed", async () => {
  const { createJenkinsSource } = await load();
  assert.equal(typeof createJenkinsSource, "function");
  for (const mutate of [
    (b) => b.actions.push(b.actions[0]),
    (b) => (b.actions[0].buildsByBranchName["origin/main"].buildNumber = 6),
    (b) => (b.actions[0].lastBuiltRevision.SHA1 = "b".repeat(40)),
    (b) => delete b.actions[0].buildsByBranchName["origin/main"].marked,
    (b) => (b.actions[0].remoteUrls = ["https://evil.example/repo.git"]),
  ]) {
    const b = build();
    mutate(b);
    await assert.rejects(
      createJenkinsSource(config, {
        fetchImpl: async () => Response.json(b),
      }).readBuild({ sourceId: "ci", buildNumber: 7 }),
      { code: "SCM_PROVENANCE_UNSUPPORTED" },
    );
  }
  await assert.rejects(
    createJenkinsSource(config, {
      fetchImpl: async () => Response.json({ ...build(), building: true }),
    }).readBuild({ sourceId: "ci", buildNumber: 7 }),
    { code: "BUILD_RUNNING" },
  );
  assert.equal(
    (
      await createJenkinsSource(config, {
        fetchImpl: async () => Response.json({ ...build(), result: "SUCCESS" }),
      }).readBuild({ sourceId: "ci", buildNumber: 7 })
    ).outcome,
    "ignored",
  );
});
test("JSON size, deadline, redirect and unsafe configuration are rejected without raw errors", async () => {
  const { createJenkinsSource } = await load();
  assert.equal(typeof createJenkinsSource, "function");
  for (const fetchImpl of [
    async () => new Response("x".repeat(262145)),
    async () => {
      throw Error("private-token");
    },
    async () => {
      const r = Response.json(build());
      Object.defineProperty(r, "redirected", { value: true });
      return r;
    },
    () => new Promise(() => {}),
  ]) {
    await assert.rejects(
      createJenkinsSource(config, { fetchImpl, timeoutMs: 10 }).readBuild({
        sourceId: "ci",
        buildNumber: 7,
      }),
      (e) =>
        e.code === "UPSTREAM_UNAVAILABLE" &&
        !e.message.includes("private-token"),
    );
  }
  for (const baseUrl of [
    "http://ci.example/",
    "https://user:secret@ci.example/",
  ])
    await assert.rejects(
      createJenkinsSource(
        { ...config, baseUrl },
        {
          fetchImpl: () => {
            throw Error("must not read");
          },
        },
      ).readBuild({ sourceId: "ci", buildNumber: 7 }),
      { code: "SOURCE_UNAVAILABLE" },
    );
});
