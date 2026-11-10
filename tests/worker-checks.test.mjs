import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("process output is bounded and child environment excludes ambient credentials", async () => {
  const { runCommand } =
    await import("../apps/healing-worker/src/process-runner.mjs");
  process.env.HEALING_MODEL_TOKEN = "private-secret";
  try {
    const r = await runCommand(process.execPath, [
      "-e",
      'console.log(process.env.HEALING_MODEL_TOKEN || "clean")',
    ]);
    assert.equal(r.stdout.trim(), "clean");
    await assert.rejects(
      runCommand(process.execPath, ["-e", 'console.log("a".repeat(10000))'], {
        maxOutputBytes: 100,
      }),
      /output/i,
    );
  } finally {
    delete process.env.HEALING_MODEL_TOKEN;
  }
});
test("timeout and cancellation kill the process group including descendants", async (t) => {
  const { runCommand } =
    await import("../apps/healing-worker/src/process-runner.mjs");
  const root = await mkdtemp(join(tmpdir(), "worker-process-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, "escaped");
  const script = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'escaped'),600)`)}],{stdio:'ignore'});setInterval(()=>{},1000);`;
  await assert.rejects(
    runCommand(process.execPath, ["-e", script], { timeoutMs: 100 }),
    /timeout/i,
  );
  await new Promise((r) => setTimeout(r, 750));
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  const controller = new AbortController();
  const running = runCommand(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    { signal: controller.signal },
  );
  controller.abort();
  await assert.rejects(running, /abort/i);
});
test("Docker uses pinned image and restrictive mounts; missing Docker never executes host checks", async () => {
  const { createCheckRunner } =
    await import("../apps/healing-worker/src/check-runner.mjs");
  const calls = [];
  const runner = createCheckRunner({
    runCommand: async (command, args, options) => {
      calls.push({ command, args, options });
      return { exitCode: 0, stdout: "ok", stderr: "" };
    },
  });
  await runner(
    {
      cwd: "/tmp/workspace",
      image: "node@sha256:" + "a".repeat(64),
      argv: ["npm", "test"],
      timeoutMs: 1000,
    },
    {},
  );
  const call = calls.find((c) => c.args[0] === "run");
  assert.equal(call.command, "docker");
  for (const flag of [
    "--pull=never",
    "--network=none",
    "--cap-drop=ALL",
    "--read-only",
    "--security-opt=no-new-privileges",
  ])
    assert.ok(call.args.includes(flag));
  assert.ok(
    call.args.includes(
      "type=bind,source=/tmp/workspace/.git,target=/workspace/.git,readonly",
    ),
  );
  assert.deepEqual(call.args.slice(-3), [
    "node@sha256:" + "a".repeat(64),
    "npm",
    "test",
  ]);
  assert.equal(call.options.env.HEALING_MODEL_TOKEN, undefined);
  assert.ok(
    calls.some((c) => c.args[0] === "rm" && c.args.includes("--force")),
  );
  await assert.rejects(
    runner({ cwd: "/tmp/x", image: "node:latest", argv: ["npm", "test"] }),
    /digest/i,
  );
  const fail = createCheckRunner({
    runCommand: async () => {
      throw new Error("Docker unavailable");
    },
  });
  await assert.rejects(
    fail({
      cwd: "/tmp/x",
      image: "node@sha256:" + "b".repeat(64),
      argv: ["npm", "test"],
    }),
    /Docker/,
  );
});
test("process runner rejects invalid UTF-8 instead of changing canonical bytes", async () => {
  const { runCommand } =
    await import("../apps/healing-worker/src/process-runner.mjs");
  await assert.rejects(
    runCommand(process.execPath, [
      "-e",
      "process.stdout.write(Buffer.from([255]))",
    ]),
    /UTF/,
  );
});
test("Docker launch failures cannot count as reproduced repository failures", async () => {
  const { createCheckRunner } =
    await import("../apps/healing-worker/src/check-runner.mjs");
  const run = createCheckRunner({
    runCommand: async () => ({
      exitCode: 125,
      stdout: "",
      stderr: "missing image",
    }),
  });
  await assert.rejects(
    run({
      cwd: "/tmp/workspace",
      image: "node@sha256:" + "a".repeat(64),
      argv: ["npm", "test"],
    }),
    /Docker/,
  );
});

test("Docker startup ENOENT and EACCES are normalized only at the Docker invocation boundary", async () => {
  const { createCheckRunner } =
    await import("../apps/healing-worker/src/check-runner.mjs");
  for (const code of ["ENOENT", "EACCES", "EIO"]) {
    const original = Object.assign(Error(`spawn failure ${code}`), { code });
    const run = createCheckRunner({
      runCommand: async (command, args) => {
        if (args[0] === "run") throw original;
        return { exitCode: 0 };
      },
    });
    await assert.rejects(
      run({
        cwd: "/tmp/controlled-check",
        image: `node@sha256:${"a".repeat(64)}`,
        argv: ["true"],
      }),
      (error) =>
        code === "EIO"
          ? error === original
          : error.message === "Docker check could not start",
    );
  }
});
