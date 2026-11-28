import { randomUUID } from "node:crypto";
import { isAbsolute, normalize } from "node:path";
import {
  runCommand as defaultRunCommand,
  cleanEnvironment,
} from "./process-runner.mjs";

const OWNER_LABEL = "io.self-healing-agent-hub.check-owner";
const RUN_LABEL = "io.self-healing-agent-hub.check-token";
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const CONTAINER_ID = /^[a-f0-9]{64}$/;
const validCwd = (cwd) =>
  typeof cwd === "string" &&
  isAbsolute(cwd) &&
  normalize(cwd) === cwd &&
  !cwd.includes(",") &&
  [...cwd].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127);
const uncertain = (cause) =>
  Object.assign(new Error("Docker check cleanup is uncertain", { cause }), {
    code: "CHECK_CLEANUP_UNCERTAIN",
  });
const unavailable = () => new Error("Docker check could not start");

export function validateCheckResource(resource) {
  if (
    !resource ||
    resource.version !== 1 ||
    !UUID.test(resource.runId ?? "")
  )
    throw uncertain();
  // `kind` was added with dependency preparation; journals written before it
  // only ever contained check containers.
  const kind = resource.kind === "prepare" ? "prepare" : "check";
  if (resource.name !== "healing-" + kind + "-" + resource.runId)
    throw uncertain();
  if (!validCwd(resource.cwd)) throw uncertain();
  if (
    resource.containerId !== undefined &&
    !CONTAINER_ID.test(resource.containerId)
  )
    throw uncertain();
  return {
    version: 1,
    kind,
    name: resource.name,
    runId: resource.runId,
    cwd: resource.cwd,
    ...(resource.containerId ? { containerId: resource.containerId } : {}),
  };
}

export function createCheckRunner({ runCommand = defaultRunCommand } = {}) {
  const command = (args, options = {}) =>
    runCommand("docker", args, {
      timeoutMs: 10000,
      maxOutputBytes: 64 * 1024,
      env: cleanEnvironment(),
      ...options,
    });
  async function list(resource) {
    const result = await command(
      [
        "container",
        "ls",
        "--all",
        "--no-trunc",
        "--filter",
        resource.containerId
          ? "id=" + resource.containerId
          : "label=" + RUN_LABEL + "=" + resource.runId,
        "--format",
        "{{.ID}}",
      ],
      { maxOutputBytes: 8192 },
    );
    if (result?.exitCode !== 0 || typeof result.stdout !== "string")
      throw uncertain();
    const ids = result.stdout.trim() ? result.stdout.trim().split(/\r?\n/) : [];
    if (
      ids.length > 1 ||
      ids.some(
        (id) =>
          !CONTAINER_ID.test(id) ||
          (resource.containerId && id !== resource.containerId),
      )
    )
      throw uncertain();
    return ids;
  }
  async function inspectOwned(resource, id) {
    const result = await command([
      "container",
      "inspect",
      "--format",
      "{{json .}}",
      id,
    ]);
    if (result?.exitCode !== 0 || typeof result.stdout !== "string")
      throw uncertain();
    const container = JSON.parse(result.stdout);
    if (
      container?.Id !== id ||
      container.Name !== "/" + resource.name ||
      container.Config?.Labels?.[OWNER_LABEL] !== "worker-v1" ||
      container.Config?.Labels?.[RUN_LABEL] !== resource.runId
    )
      throw uncertain();
    return container;
  }
  async function recover(saved) {
    try {
      const resource = validateCheckResource(saved);
      const [id] = await list(resource);
      if (!id) return;
      try {
        await inspectOwned(resource, id);
      } catch (error) {
        // Auto-removal may have raced inspection. A failed inspect alone never
        // proves absence, including exit 1 from an unavailable Docker daemon.
        if ((await list({ ...resource, containerId: id })).length === 0) return;
        throw error;
      }
      // Remove only the verified immutable ID. A reused name is never a target.
      await command(["rm", "--force", id]).catch(() => {});
      if ((await list({ ...resource, containerId: id })).length !== 0)
        throw uncertain();
    } catch (error) {
      throw error?.code === "CHECK_CLEANUP_UNCERTAIN"
        ? error
        : uncertain(error);
    }
  }
  async function execute(
    {
      cwd,
      image,
      argv,
      timeoutMs = 120000,
      kind = "check",
      network = "none",
      env = {},
    },
    { signal, assertActive, onResource } = {},
  ) {
    if (typeof image !== "string" || !/^\S+@sha256:[a-f0-9]{64}$/.test(image))
      throw new Error("Docker image must be pinned by digest");
    if (
      !["check", "prepare"].includes(kind) ||
      !["none", "bridge"].includes(network) ||
      !validCwd(cwd) ||
      !Array.isArray(argv) ||
      typeof argv[0] !== "string" ||
      !argv[0].trim() ||
      argv.some((v) => typeof v !== "string" || v.includes("\0")) ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0 ||
      typeof env !== "object" ||
      env === null ||
      Array.isArray(env) ||
      Object.entries(env).some(
        ([k, v]) =>
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ||
          typeof v !== "string" ||
          /[\r\n]/.test(v),
      )
    )
      throw new Error("Invalid Docker check configuration");
    const active = async () => {
      signal?.throwIfAborted();
      await assertActive?.();
      signal?.throwIfAborted();
    };
    await active();
    const runId = randomUUID();
    let resource = {
      version: 1,
      kind,
      name: "healing-" + kind + "-" + runId,
      runId,
      cwd,
    };
    // This must finish before even a stopped container can be created.
    await onResource?.(structuredClone(resource));
    let mayExist = false;
    try {
      await active();
      const args = [
        "create",
        "--name",
        resource.name,
        "--label",
        OWNER_LABEL + "=worker-v1",
        "--label",
        RUN_LABEL + "=" + runId,
        "--restart=no",
        "--pull=never",
        "--network=" + network,
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--read-only",
        "--cpus=1",
        "--memory=512m",
        "--pids-limit=128",
        "--user",
        process.getuid() + ":" + process.getgid(),
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=64m",
        ...Object.entries(env).flatMap(([key, value]) => [
          "--env",
          key + "=" + value,
        ]),
        "--mount",
        "type=bind,source=" + cwd + ",target=/workspace",
        "--mount",
        "type=bind,source=" + cwd + "/.git,target=/workspace/.git,readonly",
        "--workdir",
        "/workspace",
        "--entrypoint",
        argv[0],
        image,
        ...argv.slice(1),
      ];
      let created;
      mayExist = true;
      try {
        created = await command(args, {
          signal,
          timeoutMs: Math.min(timeoutMs, 10000),
        });
      } catch (error) {
        // Only these failures at the initial process-spawn boundary prove that
        // no Docker create request was sent. Storage ENOENT is not equivalent.
        if (["ENOENT", "EACCES"].includes(error.code)) {
          mayExist = false;
          throw unavailable();
        }
        throw error;
      }
      if (
        created?.exitCode !== 0 ||
        typeof created.stdout !== "string" ||
        !CONTAINER_ID.test(created.stdout.trim())
      )
        throw unavailable();
      resource = { ...resource, containerId: created.stdout.trim() };
      await onResource?.(structuredClone(resource));
      await active();
      const result = await command(
        ["start", "--attach", resource.containerId],
        {
          signal,
          timeoutMs,
        },
      );
      let container;
      try {
        container = await inspectOwned(resource, resource.containerId);
      } catch {
        throw unavailable();
      }
      const state = container.State;
      // `docker start --attach` returns 1 for API failures as well as workload
      // failures. Retain container metadata until actual execution is proven;
      // --rm would erase the evidence needed to distinguish the two outcomes.
      if (
        !state ||
        state.Status !== "exited" ||
        state.Running !== false ||
        state.Restarting !== false ||
        state.Paused !== false ||
        state.Error !== "" ||
        !(Date.parse(state.StartedAt) > 0) ||
        !(Date.parse(state.FinishedAt) >= Date.parse(state.StartedAt)) ||
        !Number.isInteger(state.ExitCode) ||
        state.ExitCode < 0 ||
        state.ExitCode > 255 ||
        result?.exitCode !== state.ExitCode ||
        [125, 126, 127].includes(result.exitCode) ||
        container.HostConfig?.RestartPolicy?.Name !== "no"
      )
        throw unavailable();
      return result;
    } finally {
      // Neither cleanup nor proof queries inherit the cancelled lease signal.
      // Absence of the immutable ID also fences a delayed Docker start request.
      if (mayExist) await recover(resource);
      await onResource?.(null);
    }
  }
  /**
   * A check runs with no network and may not grow the workspace.
   */
  const run = (config, hooks) =>
    execute({ ...config, kind: "check", network: "none", env: {} }, hooks);
  /**
   * Dependency preparation runs once after checkout, before the baseline
   * checks. It needs the network to fetch packages and a writable workspace
   * to create the dependency tree; the container root stays read-only, the
   * Git directory stays read-only, and only gitignored paths may be written.
   */
  const prepare = (config, hooks) => {
    if (
      !config ||
      !Array.isArray(config.argv) ||
      !config.argv.length ||
      config.argv.length > 32
    )
      throw new Error("Invalid dependency preparation configuration");
    return execute(
      {
        cwd: config.cwd,
        image: config.image,
        argv: config.argv,
        timeoutMs: config.timeoutMs ?? 600000,
        kind: "prepare",
        network: "bridge",
        env: { HOME: "/tmp", npm_config_cache: "/tmp/.npm" },
      },
      hooks,
    );
  };
  run.prepare = prepare;
  run.recover = recover;
  return run;
}
