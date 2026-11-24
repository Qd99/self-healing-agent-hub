import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const modulePath = "../apps/healing-worker/src/workspace.mjs";
async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "worker-engine-"));
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
  const config = {
    dataDir: join(root, "data"),
    repository: { localPath: repo, fullName: "owner/repo", branch: "main" },
    model: { contextPaths: ["value.txt"] },
    checks: {
      image: "node@sha256:" + "a".repeat(64),
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
          context: {
            commitSha: base,
            source: { kind: "jenkins", commitSha: base },
          },
        },
      },
    },
    context: {
      rule: { processor: { action: "create-pr" } },
      safety: {
        requiredChecks: ["npm test"],
        protectedPaths: ["deploy/"],
        maxFilesPerFix: 2,
      },
    },
  };
  const generate = async ({ context }) => {
    assert.equal(context[0].content, "broken\n");
    return {
      summary: "Repair value",
      changes: [{ path: "value.txt", content: "fixed\n" }],
    };
  };
  const runCheck = async ({ cwd }) => ({
    exitCode:
      (await readFile(join(cwd, "value.txt"), "utf8")) === "fixed\n" ? 0 : 1,
    stdout: "bounded fixture evidence",
    stderr: "",
  });
  const { createWorkspaceEngine } = await import(modulePath);
  return {
    root,
    repo,
    git,
    config,
    claim,
    engine: createWorkspaceEngine(config, { generate, runCheck, ...overrides }),
  };
}
function moveBase(f) {
  f.claim.task.task.payload.context.commitSha = f.git("rev-parse", "HEAD");
  f.claim.task.task.payload.context.source.commitSha =
    f.claim.task.task.payload.context.commitSha;
}
test("exact base, canonical patch and fresh replay produce same files without touching source", async (t) => {
  const f = await fixture(t);
  const d = await f.engine.diagnose(f.claim);
  assert.equal(
    d.candidate.baseCommitSha,
    f.claim.task.task.payload.context.commitSha,
  );
  assert.equal(
    d.candidate.patchSha256,
    createHash("sha256").update(d.artifact.patch).digest("hex"),
  );
  assert.match(d.artifact.patch, /^-broken\n\+fixed/m);
  assert.deepEqual(d.evidence.checksPass, ["npm test"]);
  assert.equal(await readFile(join(f.repo, "value.txt"), "utf8"), "later\n");
  f.claim.task.proposal = { candidate: d.candidate };
  const p = await f.engine.prepareExecution(f.claim, d.artifact);
  assert.deepEqual(p.files, [
    { path: "value.txt", mode: "100644", content: "fixed\n" },
  ]);
  await p.cleanup();
});
test("rejects non-reproducing baseline without asking model", async (t) => {
  let called = false;
  const f = await fixture(t, {
    runCheck: async () => ({ exitCode: 0 }),
    generate: async () => {
      called = true;
    },
  });
  await assert.rejects(f.engine.diagnose(f.claim), /reproduce/i);
  assert.equal(called, false);
});
test("checks may not change source files or implant executable Git configuration", async (t) => {
  for (const metadata of [false, true]) {
    const f = await fixture(t, {
      runCheck: async ({ cwd }) => {
        await writeFile(
          join(cwd, metadata ? ".git/config" : "value.txt"),
          metadata
            ? "[core]\n fsmonitor = touch /tmp/worker-compromised\n"
            : "mutated\n",
        );
        return { exitCode: 1 };
      },
    });
    await assert.rejects(f.engine.diagnose(f.claim), /modified|metadata/i);
  }
});
test("rejects malformed, unsafe, duplicate and protected model changes", async (t) => {
  for (const changes of [
    [{ path: "../escape", content: "x" }],
    [{ path: ".git/config", content: "x" }],
    [{ path: "deploy/prod", content: "x" }],
    [
      { path: "value.txt", content: "x" },
      { path: "value.txt", content: "y" },
    ],
    [{ path: "value.txt", content: "\u0000" }],
  ]) {
    const f = await fixture(t, {
      generate: async () => ({ summary: "bad", changes }),
    });
    await assert.rejects(f.engine.diagnose(f.claim));
  }
});
test("artifact tampering, missing manifest and stale approved identities fail before checks", async (t) => {
  const f = await fixture(t);
  const d = await f.engine.diagnose(f.claim);
  f.claim.task.proposal = { candidate: d.candidate };
  for (const artifact of [
    undefined,
    { ...d.artifact, patch: d.artifact.patch + "corruption" },
    { ...d.artifact, candidate: { ...d.candidate, treeSha: "0".repeat(40) } },
    {
      ...d.artifact,
      files: [{ path: "value.txt", mode: "100644", content: "tampered" }],
    },
  ])
    await assert.rejects(f.engine.prepareExecution(f.claim, artifact));
  f.claim.task.proposal.candidate = {
    ...d.candidate,
    baseCommitSha: "a".repeat(40),
  };
  await assert.rejects(f.engine.prepareExecution(f.claim, d.artifact));
});
test("model cannot supply check claims and symlink context is rejected", async (t) => {
  const f = await fixture(t, {
    generate: async () => ({
      summary: "fake",
      changes: [{ path: "value.txt", content: "fixed\n" }],
      checksPass: ["npm test"],
    }),
  });
  await assert.rejects(f.engine.diagnose(f.claim));
  await symlink("/etc/passwd", join(f.repo, "link"));
  f.git("add", "link");
  f.git("commit", "-qm", "symlink");
  moveBase(f);
  await assert.rejects(f.engine.diagnose(f.claim), /symlink|regular|mode/i);
});
test("tampered metadata is rejected before any subsequent Git command can invoke its helper", async (t) => {
  const f = await fixture(t);
  const sentinel = join(f.root, "helper-ran");
  const helper = join(f.root, "evil-helper");
  await writeFile(helper, `#!/bin/sh\ntouch '${sentinel}'\n`, { mode: 0o755 });
  const { createWorkspaceEngine } = await import(modulePath);
  const engine = createWorkspaceEngine(f.config, {
    generate: async () => {
      throw new Error("must not generate");
    },
    runCheck: async ({ cwd }) => {
      await writeFile(
        join(cwd, ".git/config"),
        `[core]\nfsmonitor = ${helper}\n`,
      );
      return { exitCode: 1 };
    },
  });
  await assert.rejects(engine.diagnose(f.claim), /metadata/);
  await assert.rejects(readFile(sentinel), { code: "ENOENT" });
});
test("unregistered checks and changed source reject before model invocation", async (t) => {
  const f = await fixture(t);
  f.claim.context.safety.requiredChecks = ["npm test; touch /tmp/escape"];
  await assert.rejects(f.engine.diagnose(f.claim), /Unregistered/);
  f.claim.context.safety.requiredChecks = ["npm test"];
  f.claim.task.task.payload.context.source.commitSha = "1".repeat(40);
  await assert.rejects(f.engine.diagnose(f.claim), /source/);
});
test("rejects invalid Unicode replacement and non-UTF-8 baseline bytes", async (t) => {
  const f = await fixture(t, {
    generate: async () => ({
      summary: "bad unicode",
      changes: [{ path: "value.txt", content: "\ud800" }],
    }),
  });
  await assert.rejects(f.engine.diagnose(f.claim), /UTF/);
  await writeFile(join(f.repo, "value.txt"), Buffer.from([0xff, 10]));
  f.git("commit", "-qam", "binary");
  moveBase(f);
  await assert.rejects(f.engine.diagnose(f.claim), /UTF/);
});
test("candidate failures are not promoted and oversized context is rejected", async (t) => {
  const f = await fixture(t, { runCheck: async () => ({ exitCode: 1 }) });
  await assert.rejects(f.engine.diagnose(f.claim), /required checks/);
  await writeFile(join(f.repo, "value.txt"), "x".repeat(128 * 1024 + 1));
  f.git("commit", "-qam", "large");
  moveBase(f);
  await assert.rejects(f.engine.diagnose(f.claim), /context.*limit/);
});
test("source Git config and host credentials are never copied to checkout", async (t) => {
  const f = await fixture(t);
  f.git("config", "credential.helper", "dangerous-helper");
  f.git("config", "core.fsmonitor", "/nonexistent-helper");
  let calls = 0;
  const { createWorkspaceEngine } = await import(modulePath);
  const engine = createWorkspaceEngine(f.config, {
    generate: async () => ({
      summary: "fix",
      changes: [{ path: "value.txt", content: "fixed\n" }],
    }),
    runCheck: async ({ cwd }) => {
      assert.doesNotMatch(
        await readFile(join(cwd, ".git/config"), "utf8"),
        /dangerous-helper|nonexistent-helper/,
      );
      return { exitCode: calls++ === 0 ? 1 : 0 };
    },
  });
  await engine.diagnose(f.claim);
});
test("renames are rejected even when expressed as structured deletion and addition", async (t) => {
  const f = await fixture(t, {
    generate: async () => ({
      summary: "rename",
      changes: [
        { path: "value.txt", content: null },
        { path: "renamed.txt", content: "broken\n" },
      ],
    }),
  });
  await assert.rejects(f.engine.diagnose(f.claim), /rename/i);
});
test("published files retain UTF-8 BOM, missing final newline and executable mode", async (t) => {
  const f = await fixture(t, {
    generate: async ({ context }) => {
      assert.equal(context[0].content, "\ufeffbroken");
      return {
        summary: "fix exact text",
        changes: [{ path: "value.txt", content: "\ufefffixed" }],
      };
    },
    runCheck: async ({ cwd }) => ({
      exitCode:
        (await readFile(join(cwd, "value.txt"), "utf8")) === "\ufefffixed"
          ? 0
          : 1,
    }),
  });
  await writeFile(join(f.repo, "value.txt"), "\ufeffbroken");
  await chmod(join(f.repo, "value.txt"), 0o755);
  f.git("add", "value.txt");
  f.git("commit", "-qm", "BOM source");
  moveBase(f);
  const d = await f.engine.diagnose(f.claim);
  assert.equal(d.artifact.files[0].content, "\ufefffixed");
  assert.equal(d.artifact.files[0].mode, "100755");
  f.claim.task.proposal = { candidate: d.candidate };
  const prepared = await f.engine.prepareExecution(f.claim, d.artifact);
  assert.deepEqual(prepared.files, d.artifact.files);
  await prepared.cleanup();
});

for (const [attribute, content] of [
  ["text eol=crlf", "fixed\r\n"],
  ["working-tree-encoding=ISO-8859-1", "fixé\n"],
]) {
  test(`rejects publisher bytes transformed by Git ${attribute}`, async (t) => {
    let checkCalls = 0;
    const f = await fixture(t, {
      generate: async () => ({
        summary: "Fix value",
        changes: [{ path: "value.txt", content }],
      }),
      runCheck: async () => ({ exitCode: checkCalls++ === 0 ? 1 : 0 }),
    });
    await writeFile(join(f.repo, ".gitattributes"), `value.txt ${attribute}\n`);
    await writeFile(join(f.repo, "value.txt"), "broken\n");
    f.git("add", ".");
    f.git("commit", "-qm", "attribute fixture");
    moveBase(f);
    await assert.rejects(
      f.engine.diagnose(f.claim),
      /bytes.*blob|transformation/i,
    );
    assert.equal(checkCalls, 1, "reject divergence before candidate checks");
  });
}
test("saved CRLF artifact cannot replay publisher bytes different from its approved blob", async (t) => {
  let checkCalls = 0;
  const f = await fixture(t, {
    runCheck: async () => {
      checkCalls++;
      return { exitCode: 0 };
    },
  });
  await writeFile(join(f.repo, ".gitattributes"), "value.txt text eol=crlf\n");
  await writeFile(join(f.repo, "value.txt"), "broken\n");
  f.git("add", ".");
  f.git("commit", "-qm", "attribute baseline");
  moveBase(f);
  const base = f.claim.task.task.payload.context.commitSha;
  await writeFile(join(f.repo, "value.txt"), "fixed\r\n");
  f.git("add", "value.txt");
  const patch = execFileSync(
    "git",
    [
      "diff",
      "--cached",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--full-index",
      "--binary",
      base,
      "--",
    ],
    { cwd: f.repo, encoding: "utf8" },
  );
  const patchSha256 = createHash("sha256").update(patch).digest("hex");
  const candidate = {
    version: 2,
    baseCommitSha: base,
    patchSha256,
    artifactId: patchSha256,
    treeSha: f.git("write-tree"),
  };
  const artifact = {
    candidate,
    patch,
    files: [{ path: "value.txt", mode: "100644", content: "fixed\r\n" }],
    diff: [
      {
        path: "value.txt",
        additions: 1,
        deletions: 1,
        lines: [
          { type: "remove", content: "broken" },
          { type: "add", content: "fixed" },
        ],
      },
    ],
  };
  f.claim.task.proposal = { candidate };
  await assert.rejects(
    f.engine.prepareExecution(f.claim, artifact),
    /bytes.*blob|transformation/i,
  );
  assert.equal(checkCalls, 0);
});

for (const path of [
  ".env",
  "config/.env.production",
  ".aws/credentials",
  "config/service-account.json",
  "keys/client.pem",
  ".npmrc",
]) {
  test(`credential path ${path} cannot enter model context or artifacts with empty caller protection`, async (t) => {
    let generated = false;
    const f = await fixture(t, {
      generate: async () => {
        generated = true;
        return {
          summary: "Fix",
          changes: [{ path: "value.txt", content: "fixed\n" }],
        };
      },
    });
    await mkdir(join(f.repo, path.split("/").slice(0, -1).join("/")), {
      recursive: true,
    });
    await writeFile(join(f.repo, path), "API_TOKEN=fixture-secret\n");
    f.git("add", ".");
    f.git("commit", "-qm", "credential fixture");
    moveBase(f);
    f.claim.context.safety.protectedPaths = [];
    f.config.model.contextPaths = [path];
    await assert.rejects(f.engine.diagnose(f.claim), /protected|credential/i);
    assert.equal(
      generated,
      false,
      "credential context must never reach generator",
    );
    f.config.model.contextPaths = [];
    let checks = 0;
    const { createWorkspaceEngine } = await import(modulePath);
    const changed = createWorkspaceEngine(f.config, {
      generate: async () => ({
        summary: "Rewrite credential",
        changes: [{ path, content: "changed\n" }],
      }),
      runCheck: async () => ({ exitCode: checks++ === 0 ? 1 : 0 }),
    });
    await assert.rejects(changed.diagnose(f.claim), /protected|credential/i);
    assert.equal(
      checks,
      1,
      "no candidate check or artifact after forbidden change",
    );
  });
}
