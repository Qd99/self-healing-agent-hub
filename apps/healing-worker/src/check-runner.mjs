import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  runCommand as defaultRunCommand,
  cleanEnvironment,
} from "./process-runner.mjs";
export function createCheckRunner({ runCommand = defaultRunCommand } = {}) {
  return async ({ cwd, image, argv, timeoutMs = 120000 }, { signal } = {}) => {
    if (typeof image !== "string" || !/^\S+@sha256:[a-f0-9]{64}$/.test(image))
      throw new Error("Docker image must be pinned by digest");
    if (
      !isAbsolute(cwd) ||
      cwd.includes(",") ||
      !Array.isArray(argv) ||
      !argv.length ||
      argv.some((v) => typeof v !== "string" || v.includes("\0"))
    )
      throw new Error("Invalid Docker check configuration");
    const name = `healing-check-${randomUUID()}`;
    const args = [
      "run",
      "--name",
      name,
      "--rm",
      "--pull=never",
      "--network=none",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--read-only",
      "--cpus=1",
      "--memory=512m",
      "--pids-limit=128",
      "--user",
      `${process.getuid()}:${process.getgid()}`,
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=64m",
      "--mount",
      `type=bind,source=${cwd},target=/workspace`,
      "--mount",
      `type=bind,source=${cwd}/.git,target=/workspace/.git,readonly`,
      "--workdir",
      "/workspace",
      image,
      ...argv,
    ];
    try {
      const result = await runCommand("docker", args, {
        signal,
        timeoutMs,
        maxOutputBytes: 64 * 1024,
        env: cleanEnvironment(),
      });
      if ([125, 126, 127].includes(result.exitCode))
        throw new Error("Docker check could not start");
      return result;
    } catch (error) {
      // Only this Docker invocation boundary classifies executable startup errors;
      // repository/artifact ENOENT elsewhere must retain its own meaning.
      if (["ENOENT", "EACCES"].includes(error.code))
        throw new Error("Docker check could not start");
      throw error;
    } finally {
      // Killing a Docker client does not stop its container. Cleanup is independently
      // bounded and does not inherit the cancelled operation's AbortSignal.
      await runCommand("docker", ["rm", "--force", name], {
        timeoutMs: 10000,
        maxOutputBytes: 8192,
        env: cleanEnvironment(),
      }).catch(() => {});
    }
  };
}
