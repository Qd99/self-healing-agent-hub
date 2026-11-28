import assert from "node:assert/strict";
import test from "node:test";
import { createCheckRunner } from "../apps/healing-worker/src/check-runner.mjs";
import { createDockerTransport } from "./fixtures/worker/docker-transport.mjs";

const image = `node@sha256:${"a".repeat(64)}`;
const cwd = "/tmp/controlled-check";

const createArgs = (transport) => {
  const call = transport.calls.find(
    ({ args }) => args[0] === "create" || args[1] === "create",
  );
  assert.ok(call, "docker create was invoked");
  return call.args;
};
const flag = (args, name) => args.find((arg) => arg.startsWith(name + "="));

test("a check container keeps the network disabled and gets no injected env", async () => {
  const transport = createDockerTransport();
  const run = createCheckRunner({ runCommand: transport.runCommand });
  await run({ cwd, image, argv: ["npm", "test"] });
  const args = createArgs(transport);
  assert.equal(flag(args, "--network"), "--network=none");
  assert.equal(args.includes("--env"), false);
  const name = args[args.indexOf("--name") + 1];
  assert.match(name, /^healing-check-[a-f0-9-]{36}$/);
});

test("dependency preparation runs on the bridge network with a writable cache", async () => {
  const transport = createDockerTransport();
  const run = createCheckRunner({ runCommand: transport.runCommand });
  await run.prepare({ cwd, image, argv: ["npm", "ci"] });
  const args = createArgs(transport);
  assert.equal(flag(args, "--network"), "--network=bridge");
  const envs = args.flatMap((arg, i) => (arg === "--env" ? [args[i + 1]] : []));
  assert.deepEqual(envs.sort(), [
    "HOME=/tmp",
    "npm_config_cache=/tmp/.npm",
  ]);
  const name = args[args.indexOf("--name") + 1];
  assert.match(name, /^healing-prepare-[a-f0-9-]{36}$/);
});

test("preparation keeps the container hardening that checks rely on", async () => {
  const transport = createDockerTransport();
  const run = createCheckRunner({ runCommand: transport.runCommand });
  await run.prepare({ cwd, image, argv: ["npm", "ci"] });
  const args = createArgs(transport);
  for (const expected of [
    "--pull=never",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--read-only",
    "--pids-limit=256",
    "--restart=no",
  ])
    assert.ok(args.includes(expected), expected);
  // The Git directory must stay read-only even while dependencies are written.
  assert.ok(
    args.includes(`type=bind,source=${cwd}/.git,target=/workspace/.git,readonly`),
  );
});

test("preparation requires a non-empty argv", async () => {
  const transport = createDockerTransport();
  const run = createCheckRunner({ runCommand: transport.runCommand });
  assert.throws(
    () => run.prepare({ cwd, image, argv: [] }),
    /preparation configuration/,
  );
  await assert.rejects(
    run.prepare({ cwd, image, argv: ["npm", "ci"], timeoutMs: 0 }),
    /Docker check configuration/,
  );
});

test("preparation rejects an image that is not pinned by digest", async () => {
  const transport = createDockerTransport();
  const run = createCheckRunner({ runCommand: transport.runCommand });
  await assert.rejects(
    run.prepare({ cwd, image: "node:22", argv: ["npm", "ci"] }),
    /pinned by digest/,
  );
});

test("a failed preparation returns its exit code so the caller can stop", async () => {
  const transport = createDockerTransport();
  transport.control.workloadExitCode = 1;
  const run = createCheckRunner({ runCommand: transport.runCommand });
  const result = await run.prepare({ cwd, image, argv: ["npm", "ci"] });
  assert.equal(result.exitCode, 1);
});

test("a saved preparation resource is recognised as owned and recoverable", async () => {
  const transport = createDockerTransport();
  const run = createCheckRunner({ runCommand: transport.runCommand });
  let saved;
  await run.prepare(
    { cwd, image, argv: ["npm", "ci"] },
    { onResource: async (resource) => (saved ??= resource) },
  );
  assert.equal(saved.kind, "prepare");
  await run.recover(saved);
  assert.equal(
    transport.calls.filter(({ args }) => args[0] === "rm").length,
    1,
  );
});

test("legacy check resources written before the kind field still validate", async () => {
  const transport = createDockerTransport();
  const run = createCheckRunner({ runCommand: transport.runCommand });
  await run.recover({
    version: 1,
    name: "healing-check-00000000-0000-4000-8000-000000000003",
    runId: "00000000-0000-4000-8000-000000000003",
    cwd,
  });
  assert.equal(
    transport.calls.filter(({ args }) => args[0] === "rm").length,
    0,
  );
});

test("a workspace without preparation configured never calls the prepare path", async (t) => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const root = await mkdtemp(join(tmpdir(), "worker-noprepare-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  await mkdir(repo);
  const git = (...args) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  await writeFile(join(repo, "value.txt"), "broken\n");
  git("add", ".");
  git("commit", "-qm", "failure");
  const base = git("rev-parse", "HEAD");
  await writeFile(join(repo, "value.txt"), "later\n");
  git("commit", "-qam", "later");

  let prepared = 0;
  const runCheck = Object.assign(
    async ({ cwd }) => ({
      exitCode:
        (await (await import("node:fs/promises")).readFile(
          join(cwd, "value.txt"),
          "utf8",
        )) === "fixed\n"
          ? 0
          : 1,
      stdout: "",
      stderr: "",
    }),
    {
      prepare: async () => {
        prepared += 1;
        return { exitCode: 0 };
      },
    },
  );
  const { createWorkspaceEngine } = await import(
    "../apps/healing-worker/src/workspace.mjs"
  );
  const config = {
    dataDir: join(root, "data"),
    repository: { localPath: repo, fullName: "owner/repo", branch: "main" },
    model: { contextPaths: ["value.txt"] },
    checks: {
      image: `node@sha256:${"a".repeat(64)}`,
      commands: { "npm test": ["npm", "test"] },
      timeoutMs: 2000,
    },
  };
  const claim = {
    task: {
      task: {
        id: "00000000-0000-4000-8000-000000000001",
        type: "ci-failure",
        payload: {
          repo: "owner/repo",
          branch: "main",
          context: { commitSha: base, source: { kind: "jenkins", commitSha: base } },
        },
      },
    },
    context: {
      rule: { processor: { action: "create-pr" } },
      safety: {
        requiredChecks: ["npm test"],
        protectedPaths: [],
        maxFilesPerFix: 2,
      },
    },
  };
  const engine = createWorkspaceEngine(config, {
    generate: async () => ({
      summary: "Repair value",
      changes: [{ path: "value.txt", content: "fixed\n" }],
    }),
    runCheck,
  });
  await engine.diagnose(claim);
  assert.equal(prepared, 0);
});

test("populating a gitignored dependency tree does not count as changing the candidate", async (t) => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const root = await mkdtemp(join(tmpdir(), "worker-ignoredeps-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  await mkdir(repo);
  const git = (...args) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  await writeFile(join(repo, "value.txt"), "broken\n");
  await writeFile(join(repo, ".gitignore"), "node_modules/\n");
  git("add", ".");
  git("commit", "-qm", "failure");
  const base = git("rev-parse", "HEAD");
  await writeFile(join(repo, "value.txt"), "later\n");
  git("commit", "-qam", "later");

  const runCheck = Object.assign(
    async ({ cwd }) => {
      // The "prepare" phase would have created this before the check runs.
      await mkdir(join(cwd, "node_modules", ".bin"), { recursive: true });
      await writeFile(
        join(cwd, "node_modules", ".bin", "tool"),
        "#!/bin/sh\n",
      );
      return {
        exitCode:
          (await (await import("node:fs/promises")).readFile(
            join(cwd, "value.txt"),
            "utf8",
          )) === "fixed\n"
          ? 0
          : 1,
        stdout: "",
        stderr: "",
      };
    },
    {
      prepare: async () => ({ exitCode: 0 }),
    },
  );
  const { createWorkspaceEngine } = await import(
    "../apps/healing-worker/src/workspace.mjs"
  );
  const config = {
    dataDir: join(root, "data"),
    repository: { localPath: repo, fullName: "owner/repo", branch: "main" },
    model: { contextPaths: ["value.txt"] },
    checks: {
      image: `node@sha256:${"a".repeat(64)}`,
      commands: { "npm test": ["npm", "test"] },
      timeoutMs: 2000,
      prepare: { argv: ["npm", "ci"], timeoutMs: 600000 },
    },
  };
  const claim = {
    task: {
      task: {
        id: "00000000-0000-4000-8000-000000000001",
        type: "ci-failure",
        payload: {
          repo: "owner/repo",
          branch: "main",
          context: { commitSha: base, source: { kind: "jenkins", commitSha: base } },
        },
      },
    },
    context: {
      rule: { processor: { action: "create-pr" } },
      safety: {
        requiredChecks: ["npm test"],
        protectedPaths: [],
        maxFilesPerFix: 2,
      },
    },
  };
  const engine = createWorkspaceEngine(config, {
    generate: async () => ({
      summary: "Repair value",
      changes: [{ path: "value.txt", content: "fixed\n" }],
    }),
    runCheck,
  });
  const d = await engine.diagnose(claim);
  // The candidate contains only the repaired file, never the dependency tree.
  assert.deepEqual(
    d.diff.map(({ path }) => path),
    ["value.txt"],
  );
  assert.deepEqual(
    d.artifact.files.map(({ path }) => path),
    ["value.txt"],
  );
});

test("a check keeps the small budget while preparation gets a larger one", async () => {
  const transport = createDockerTransport();
  const run = createCheckRunner({ runCommand: transport.runCommand });
  await run({ cwd, image, argv: ["npm", "test"] });
  const checkArgs = createArgs(transport);
  assert.equal(flag(checkArgs, "--memory"), "--memory=512m");
  assert.equal(flag(checkArgs, "--cpus"), "--cpus=1");
  assert.equal(flag(checkArgs, "--pids-limit"), "--pids-limit=128");
  assert.ok(checkArgs.includes("/tmp:rw,noexec,nosuid,size=64m"));

  transport.calls.length = 0;
  await run.prepare({ cwd, image, argv: ["npm", "ci"] });
  const prepareArgs = createArgs(transport);
  assert.equal(flag(prepareArgs, "--memory"), "--memory=3g");
  assert.equal(flag(prepareArgs, "--cpus"), "--cpus=2");
  assert.equal(flag(prepareArgs, "--pids-limit"), "--pids-limit=256");
  assert.ok(prepareArgs.includes("/tmp:rw,noexec,nosuid,size=512m"));
});
