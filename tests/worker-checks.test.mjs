import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCheckRunner } from "../apps/healing-worker/src/check-runner.mjs";
import { createDockerTransport } from "./fixtures/worker/docker-transport.mjs";

const checkSpec = {
  cwd: "/tmp/controlled-check",
  image: `node@sha256:${"a".repeat(64)}`,
  argv: ["npm", "test"],
};
const savedResource = (containerId) => ({
  version: 1,
  name: "healing-check-00000000-0000-4000-8000-000000000001",
  runId: "00000000-0000-4000-8000-000000000001",
  cwd: checkSpec.cwd,
  ...(containerId ? { containerId } : {}),
});
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
  const { calls, runCommand } = createDockerTransport();
  const runner = createCheckRunner({ runCommand });
  await runner(
    {
      cwd: "/tmp/workspace",
      image: "node@sha256:" + "a".repeat(64),
      argv: ["npm", "test"],
      timeoutMs: 1000,
    },
    {},
  );
  const call = calls.find((c) => c.args[0] === "create");
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
  assert.equal(call.args.includes("--rm"), false);
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
  const docker = createDockerTransport();
  docker.control.createExitCode = 125;
  const run = createCheckRunner({ runCommand: docker.runCommand });
  await assert.rejects(
    run({
      cwd: "/tmp/workspace",
      image: "node@sha256:" + "a".repeat(64),
      argv: ["npm", "test"],
    }),
    /Docker check could not start/,
  );
});

test("Docker startup ENOENT and EACCES are normalized only at the Docker invocation boundary", async () => {
  for (const code of ["ENOENT", "EACCES", "EIO"]) {
    const original = Object.assign(Error(`spawn failure ${code}`), { code });
    const docker = createDockerTransport();
    docker.control.createError = original;
    const run = createCheckRunner({ runCommand: docker.runCommand });
    const resources = [];
    await assert.rejects(
      run(
        {
          cwd: "/tmp/controlled-check",
          image: `node@sha256:${"a".repeat(64)}`,
          argv: ["true"],
        },
        { onResource: async (resource) => resources.push(resource) },
      ),
      (error) =>
        code === "EIO"
          ? error === original
          : error.message === "Docker check could not start",
    );
    assert.equal(resources.at(-1), null);
    if (code !== "EIO") assert.equal(docker.calls.length, 1);
  }
});

test("Docker cannot create or start until each ownership record is durably saved", async () => {
  const docker = createDockerTransport();
  const writes = [];
  let durable;
  const runner = createCheckRunner({
    runCommand: async (command, args, options) => {
      if (args[0] === "create") {
        assert.ok(durable?.runId);
        assert.equal(durable.containerId, undefined);
      }
      if (args[0] === "start") assert.equal(durable?.containerId, args.at(-1));
      return docker.runCommand(command, args, options);
    },
  });
  const result = await runner(checkSpec, {
    onResource: async (resource) => {
      await Promise.resolve();
      writes.push(structuredClone(resource));
      durable = structuredClone(resource);
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(writes.length, 3);
  assert.equal(writes[0].name, `healing-check-${writes[0].runId}`);
  assert.match(writes[1].containerId, /^[a-f0-9]{64}$/);
  assert.equal(durable, null);
  assert.equal(docker.containers.size, 0);
  assert.equal(
    docker.calls.some((c) => c.args[0] === "run"),
    false,
  );
});

test("uncertain removal keeps a running container recorded until later recovery proves absence", async () => {
  for (const failure of ["nonzero", "throw", "false-success"]) {
    const docker = createDockerTransport();
    const controller = new AbortController();
    docker.onStart = async () => {
      controller.abort();
      throw Error("Process aborted");
    };
    if (failure === "nonzero") docker.control.removeExitCode = 1;
    if (failure === "throw")
      docker.control.removeError = Error("Process timeout");
    if (failure === "false-success") docker.control.leaveAfterRemove = true;
    let durable;
    const runner = createCheckRunner({ runCommand: docker.runCommand });
    await assert.rejects(
      runner(checkSpec, {
        signal: controller.signal,
        onResource: async (resource) => {
          durable = structuredClone(resource);
        },
      }),
      { code: "CHECK_CLEANUP_UNCERTAIN" },
    );
    assert.ok(durable?.containerId);
    assert.equal(
      docker.containers.get(durable.containerId).State.Running,
      true,
    );
    const cleanupCalls = docker.calls.filter(
      (c) => c.args[0] === "container" || c.args[0] === "rm",
    );
    assert.ok(cleanupCalls.length);
    for (const call of cleanupCalls) {
      assert.equal(call.options.signal, undefined);
      assert.ok(call.options.timeoutMs > 0 && call.options.timeoutMs <= 10000);
      assert.ok(
        call.options.maxOutputBytes > 0 && call.options.maxOutputBytes <= 65536,
      );
      assert.equal(call.options.env.HEALING_MODEL_TOKEN, undefined);
    }
    docker.control.removeExitCode = 0;
    docker.control.removeError = undefined;
    docker.control.leaveAfterRemove = false;
    await runner.recover(durable);
    assert.equal(docker.containers.size, 0);
    assert.ok(
      docker.calls
        .filter((c) => c.args[0] === "rm")
        .every((c) => c.args.at(-1) === durable.containerId),
    );
  }
});

test("only a successful complete Docker query can prove an already removed container absent", async () => {
  const resource = savedResource("1".repeat(64));
  const docker = createDockerTransport();
  const runner = createCheckRunner({ runCommand: docker.runCommand });
  await runner.recover(resource);
  assert.equal(
    docker.calls.some((c) => c.args[0] === "rm"),
    false,
  );
  for (const control of [
    { listExitCode: 1 },
    { listError: Error("daemon down") },
    { listError: Error("Process timeout") },
    { listStdout: "not a container ID\n" },
  ]) {
    const unavailable = createDockerTransport();
    Object.assign(unavailable.control, control);
    await assert.rejects(
      createCheckRunner({ runCommand: unavailable.runCommand }).recover(
        resource,
      ),
      { code: "CHECK_CLEANUP_UNCERTAIN" },
    );
  }
});

test("restart recovery discovers an unacknowledged create by its recorded ownership and never starts it", async () => {
  const docker = createDockerTransport();
  const resource = savedResource();
  const owned = docker.addContainer(resource, { status: "created" });
  const unrelated = docker.addContainer({
    ...savedResource("f".repeat(64)),
    name: "healing-check-unrelated",
    runId: "00000000-0000-4000-8000-000000000002",
  });
  await createCheckRunner({ runCommand: docker.runCommand }).recover(resource);
  assert.equal(docker.containers.has(owned.Id), false);
  assert.equal(docker.containers.has(unrelated.Id), true);
  assert.equal(
    docker.calls.some((c) => ["create", "start", "run"].includes(c.args[0])),
    false,
  );
});

test("recovery refuses wrong ownership and malformed saved resource identities", async () => {
  for (const change of ["name", "owner", "runId"]) {
    const docker = createDockerTransport();
    const resource = savedResource("e".repeat(64));
    const container = docker.addContainer(resource);
    if (change === "name") container.Name = "/somebody-elses-check";
    if (change === "owner")
      container.Config.Labels["io.self-healing-agent-hub.check-owner"] =
        "other";
    if (change === "runId")
      container.Config.Labels["io.self-healing-agent-hub.check-token"] =
        "other";
    await assert.rejects(
      createCheckRunner({ runCommand: docker.runCommand }).recover(resource),
      { code: "CHECK_CLEANUP_UNCERTAIN" },
    );
    assert.equal(
      docker.calls.some((c) => c.args[0] === "rm"),
      false,
    );
    assert.equal(docker.containers.size, 1);
  }
  for (const resource of [
    { ...savedResource(), cwd: "relative/path" },
    { ...savedResource(), name: "unrelated-container" },
    { ...savedResource(), runId: "not-a-uuid" },
    { ...savedResource(), containerId: "short-id" },
  ]) {
    const docker = createDockerTransport();
    await assert.rejects(
      createCheckRunner({ runCommand: docker.runCommand }).recover(resource),
      { code: "CHECK_CLEANUP_UNCERTAIN" },
    );
    assert.equal(docker.calls.length, 0);
  }
});

test("persist failures and cancellation before start cannot launch a check", async () => {
  for (const boundary of ["intent", "container", "cancel"]) {
    const docker = createDockerTransport();
    const controller = new AbortController();
    const storageError = Object.assign(Error("journal unavailable"), {
      code: "ENOENT",
    });
    let durable;
    await assert.rejects(
      createCheckRunner({ runCommand: docker.runCommand })(checkSpec, {
        signal: controller.signal,
        onResource: async (resource) => {
          if (resource && boundary === "intent") throw storageError;
          if (resource?.containerId && boundary === "container")
            throw storageError;
          durable = resource;
          if (resource?.containerId && boundary === "cancel")
            controller.abort();
        },
      }),
      boundary === "cancel" ? /abort/i : (error) => error === storageError,
    );
    assert.equal(
      docker.calls.some((c) => c.args[0] === "start"),
      false,
    );
    assert.equal(docker.containers.size, 0);
    if (boundary === "intent") assert.equal(docker.calls.length, 0);
    else assert.equal(durable, null);
  }
});

test("a lost create response is cleaned by ownership without starting the recovered container", async () => {
  const docker = createDockerTransport();
  const lost = Error("create response lost");
  docker.control.createAfterEffectError = lost;
  let durable;
  await assert.rejects(
    createCheckRunner({ runCommand: docker.runCommand })(checkSpec, {
      onResource: async (resource) => {
        durable = resource;
      },
    }),
    (error) => error === lost,
  );
  assert.equal(docker.containers.size, 0);
  assert.equal(durable, null);
  assert.equal(
    docker.calls.some((c) => c.args[0] === "start"),
    false,
  );
});

test("Docker client exit one is a failed check only when retained daemon state proves execution", async () => {
  const executed = createDockerTransport();
  executed.control.workloadExitCode = 1;
  assert.equal(
    (await createCheckRunner({ runCommand: executed.runCommand })(checkSpec))
      .exitCode,
    1,
  );
  const unavailable = createDockerTransport();
  unavailable.control.skipExecution = true;
  unavailable.control.startExitCode = 1;
  await assert.rejects(
    createCheckRunner({ runCommand: unavailable.runCommand })(checkSpec),
    /Docker check could not start/,
  );
  assert.equal(unavailable.containers.size, 0);
});

test("cleanup remains recoverable if clearing the durable resource fails after removal", async () => {
  const docker = createDockerTransport();
  const runner = createCheckRunner({ runCommand: docker.runCommand });
  let durable;
  const storageError = Error("clear record failed");
  await assert.rejects(
    runner(checkSpec, {
      onResource: async (resource) => {
        if (resource === null) throw storageError;
        durable = resource;
      },
    }),
    (error) => error === storageError,
  );
  assert.ok(durable?.containerId);
  assert.equal(docker.containers.size, 0);
  await runner.recover(durable);
});
