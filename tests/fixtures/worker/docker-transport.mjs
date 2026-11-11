const OWNER = "io.self-healing-agent-hub.check-owner";
const RUN = "io.self-healing-agent-hub.check-token";
const response = (exitCode = 0, stdout = "", stderr = "") => ({
  exitCode,
  stdout,
  stderr,
});

// Controlled Docker CLI boundary, not a real daemon or a replacement check runner.
// Tests may change control.* failures/results, inspect containers, or install
// onStart(container, options). Rejecting onStart leaves the workload running.
export function createDockerTransport() {
  let nextId = 1;
  const calls = [],
    containers = new Map(),
    control = { workloadExitCode: 0 };
  const transport = { calls, containers, control };
  function addContainer(resource, { status = "running" } = {}) {
    const id =
      resource.containerId ?? (nextId++).toString(16).padStart(64, "0");
    const container = {
      Id: id,
      Name: `/${resource.name}`,
      Config: {
        Labels: { [OWNER]: "worker-v1", [RUN]: resource.runId },
      },
      HostConfig: { RestartPolicy: { Name: "no" }, AutoRemove: false },
      Mounts: [{ Source: resource.cwd, Destination: "/workspace" }],
      State: {
        Status: status,
        Running: status === "running",
        Paused: false,
        Restarting: false,
        Dead: false,
        Error: "",
        ExitCode: 0,
        StartedAt:
          status === "created"
            ? "0001-01-01T00:00:00Z"
            : "2026-11-11T12:00:00.000000000Z",
        FinishedAt:
          status === "exited"
            ? "2026-11-11T12:00:01.000000000Z"
            : "0001-01-01T00:00:00Z",
      },
    };
    containers.set(id, container);
    return container;
  }
  const findContainer = (value) =>
    containers.get(value) ??
    [...containers.values()].find((c) => c.Name === `/${value}`);
  function create(args) {
    if (control.createError) throw control.createError;
    if (control.createExitCode)
      return response(control.createExitCode, "", "create failed");
    const labels = {};
    for (let i = 0; i < args.length; i++)
      if (args[i] === "--label") {
        const split = args[i + 1].indexOf("=");
        labels[args[i + 1].slice(0, split)] = args[i + 1].slice(split + 1);
      }
    const name = args[args.indexOf("--name") + 1];
    if (findContainer(name)) return response(1, "", "name already exists");
    const mount = args.find(
      (arg) =>
        arg.startsWith("type=bind,source=") &&
        arg.endsWith(",target=/workspace"),
    );
    const container = addContainer(
      {
        name,
        runId: labels[RUN],
        cwd: mount?.slice(
          "type=bind,source=".length,
          -",target=/workspace".length,
        ),
      },
      { status: "created" },
    );
    container.Config.Labels = labels;
    container.HostConfig.AutoRemove = args.includes("--rm");
    if (control.createAfterEffectError) throw control.createAfterEffectError;
    return response(0, `${container.Id}\n`);
  }
  async function start(id, options) {
    if (control.startError) throw control.startError;
    const container = findContainer(id);
    if (!container) return response(1, "", "No such container");
    if (control.skipExecution)
      return response(control.startExitCode ?? 1, "", "start failed");
    container.State.Status = "running";
    container.State.Running = true;
    container.State.StartedAt = "2026-11-11T12:00:00.000000000Z";
    await transport.onStart?.(container, options);
    container.State.Status = "exited";
    container.State.Running = false;
    container.State.FinishedAt = "2026-11-11T12:00:01.000000000Z";
    container.State.ExitCode = control.workloadExitCode;
    if (container.HostConfig.AutoRemove) containers.delete(container.Id);
    return response(
      control.startExitCode ?? control.workloadExitCode,
      "check output\n",
    );
  }
  async function runCommand(command, args, options = {}) {
    calls.push({ command, args: [...args], options });
    if (command !== "docker") throw Error(`Unexpected command: ${command}`);
    const operation = args[0] === "container" ? args[1] : args[0];
    if (operation === "create") return create(args);
    if (operation === "start") return start(args.at(-1), options);
    // Model the old combined launch solely to demonstrate the original RED bug.
    if (operation === "run") {
      const result = create(args);
      return result.exitCode === 0
        ? start(result.stdout.trim(), options)
        : result;
    }
    if (operation === "ls" || operation === "ps") {
      if (control.listError) throw control.listError;
      if (control.listExitCode)
        return response(control.listExitCode, "", "daemon unavailable");
      if (control.listStdout !== undefined)
        return response(0, control.listStdout);
      let selected = [...containers.values()];
      if (!args.includes("--all") && !args.includes("-a"))
        selected = selected.filter((c) => c.State.Running);
      for (let i = 0; i < args.length; i++) {
        if (args[i] !== "--filter") continue;
        const value = args[i + 1];
        if (value.startsWith("id="))
          selected = selected.filter((c) => c.Id.startsWith(value.slice(3)));
        if (value.startsWith("label=")) {
          const split = value.indexOf("=", 6);
          const key = value.slice(6, split),
            expected = value.slice(split + 1);
          selected = selected.filter((c) => c.Config.Labels[key] === expected);
        }
      }
      return response(
        0,
        selected
          .map((c) => (args.includes("--no-trunc") ? c.Id : c.Id.slice(0, 12)))
          .join("\n") + (selected.length ? "\n" : ""),
      );
    }
    if (operation === "inspect") {
      if (control.inspectError) throw control.inspectError;
      if (control.inspectExitCode)
        return response(control.inspectExitCode, "", "inspect failed");
      if (control.inspectStdout !== undefined)
        return response(0, control.inspectStdout);
      const container = findContainer(args.at(-1));
      return container
        ? response(0, JSON.stringify(container))
        : response(1, "", "No such container");
    }
    if (operation === "rm") {
      if (control.removeError) throw control.removeError;
      if (control.removeExitCode)
        return response(control.removeExitCode, "", "remove failed");
      const container = findContainer(args.at(-1));
      if (!container) return response(1, "", "No such container");
      if (!control.leaveAfterRemove) containers.delete(container.Id);
      return response(0, `${container.Id}\n`);
    }
    throw Error(`Unexpected Docker operation: ${operation}`);
  }
  return Object.assign(transport, { addContainer, runCommand });
}
