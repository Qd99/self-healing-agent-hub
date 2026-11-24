import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveConfig,
  parseArgs,
  readiness,
} from "../apps/healing-worker/src/config.mjs";
import { createHubClient } from "../apps/healing-worker/src/hub-client.mjs";
const env = {
  HEALING_WORKER_TOKEN: "hub-secret",
  HEALING_MODEL_TOKEN: "model-secret",
  HEALING_GITHUB_WRITE_TOKEN: "git-secret",
};
const input = () => ({
  version: 1,
  hub: { url: "http://127.0.0.1:3000" },
  workerId: "worker-local",
  dataDir: "./worker-data",
  repository: { fullName: "acme/project", branch: "main", localPath: "./repo" },
  model: {
    endpoint: "https://example.com/chat",
    model: "model",
    contextPaths: ["src/a.js"],
  },
  checks: {
    image: `node@sha256:${"a".repeat(64)}`,
    commands: { test: ["npm", "test"] },
  },
  publish: { enabled: false },
});
test("strict config resolves private tokens, absolute paths and disabled publish defaults", () => {
  const c = resolveConfig(input(), { env, baseDir: "/tmp" });
  assert.equal(c.github.token, "git-secret");
  assert.equal(c.dataDir, "/tmp/worker-data");
  assert.equal(c.model.timeoutMs, 120000);
  assert.equal(c.publish.enabled, false);
  assert.equal(JSON.stringify(readiness(c)).includes("secret"), false);
});
test("invalid fields, endpoint origins, paths and unpinned checks fail without leaking secrets", () => {
  for (const mutate of [
    (c) => (c.extra = true),
    (c) => (c.github = { token: "raw" }),
    (c) => (c.hub.url = "https://hub.example/api"),
    (c) => (c.model.endpoint = "http://example.com/chat"),
    (c) => (c.model.contextPaths = ["../a"]),
    (c) => (c.checks.image = "node:latest"),
    (c) => (c.publish.enabled = "yes"),
  ]) {
    const c = input();
    mutate(c);
    assert.throws(() => resolveConfig(c, { env }));
  }
  assert.throws(() =>
    resolveConfig(input(), { env: { ...env, HEALING_GITHUB_WRITE_TOKEN: "" } }),
  );
});
test("CLI rejects unknown/repeated options and requires config even for check mode", () => {
  assert.deepEqual(parseArgs(["--config", "c.json", "--once"]), {
    config: "c.json",
    once: true,
    checkConfig: false,
  });
  for (const args of [
    ["--unknown"],
    ["--check-config"],
    ["--config", "c", "--once", "--once"],
  ])
    assert.throws(() => parseArgs(args));
});
test("Hub client uses real API prefix, bounded bodies, no redirects and redacted errors", async () => {
  const c = resolveConfig(input(), { env });
  let opts;
  const client = createHubClient(c, {
    fetchImpl: async (url, o) => {
      assert.equal(url, "http://127.0.0.1:3000/api/healing/worker/claim");
      opts = o;
      return new Response('{"task":null}');
    },
  });
  assert.deepEqual(await client.claim({ workerId: "a" }), { task: null });
  assert.equal(opts.redirect, "error");
  assert.equal(opts.headers.authorization, "Bearer hub-secret");
  await assert.rejects(client.claim({ x: "x".repeat(1024 * 1024) }), /limit/);
  const large = createHubClient(c, {
    fetchImpl: async () => new Response("x".repeat(1024 * 1024 + 1)),
  });
  await assert.rejects(large.claim({}), /limit/);
  const denied = createHubClient(c, {
    fetchImpl: async () => new Response("hub-secret", { status: 409 }),
  });
  await assert.rejects(
    denied.claim({}),
    (e) => e.status === 409 && !e.message.includes("secret"),
  );
});

test("Hub errors expose only bounded recognized protocol codes and never remote messages", async () => {
  const c = resolveConfig(input(), { env });
  for (const [status, code, expected] of [
    [409, "STATE_CONFLICT", "STATE_CONFLICT"],
    [422, "CANDIDATE_MISMATCH", "CANDIDATE_MISMATCH"],
    [401, "STATE_CONFLICT", undefined],
    [403, "STATE_CONFLICT", undefined],
    [409, "private-secret", undefined],
  ]) {
    const client = createHubClient(c, {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            error: { code, message: "private-secret upstream response" },
          }),
          { status },
        ),
    });
    await assert.rejects(
      client.proposal("id", {}),
      (error) =>
        error.status === status &&
        error.code === expected &&
        !JSON.stringify(error).includes("private-secret") &&
        !error.message.includes("private-secret"),
    );
  }
});

test("oversized Hub rejection bodies cannot supply a terminal proposal code", async () => {
  const c = resolveConfig(input(), { env });
  const client = createHubClient(c, {
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          error: { code: "STATE_CONFLICT", message: "private-secret" },
          padding: "x".repeat(16 * 1024),
        }),
        { status: 409 },
      ),
  });
  await assert.rejects(
    client.proposal("id", {}),
    (error) =>
      error.status === 409 &&
      error.code === undefined &&
      !error.message.includes("private-secret"),
  );
});
