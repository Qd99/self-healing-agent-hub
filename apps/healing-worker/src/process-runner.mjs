import { spawn } from "node:child_process";

// Never inherit tokens, user Git settings, credential helpers or preload hooks.
export function cleanEnvironment() {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/nonexistent",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    GIT_ATTR_NOSYSTEM: "1",
  };
}
export async function runCommand(
  command,
  args,
  {
    cwd,
    env = cleanEnvironment(),
    signal,
    timeoutMs = 120000,
    maxOutputBytes = 1024 * 1024,
  } = {},
) {
  signal?.throwIfAborted();
  if (
    typeof command !== "string" ||
    !Array.isArray(args) ||
    args.some((a) => typeof a !== "string" || a.includes("\0"))
  )
    throw new Error("Invalid process argv");
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks = [],
      stderrChunks = [];
    let bytes = 0,
      failure;
    const kill = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    };
    const stop = (error) => {
      failure ??= error;
      kill();
    };
    const abort = () => stop(new Error("Process aborted"));
    const timer = setTimeout(
      () => stop(new Error("Process timeout")),
      timeoutMs,
    );
    signal?.addEventListener("abort", abort, { once: true });
    for (const [stream, key] of [
      [child.stdout, "stdout"],
      [child.stderr, "stderr"],
    ])
      stream.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > maxOutputBytes) {
          stop(new Error("Process output exceeded limit"));
          return;
        }
        if (key === "stdout") stdoutChunks.push(chunk);
        else stderrChunks.push(chunk);
      });
    child.on("error", (error) => {
      failure = error;
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      kill();
      if (failure) reject(failure);
      else {
        try {
          const decoder = new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
          });
          resolve({
            exitCode,
            stdout: decoder.decode(Buffer.concat(stdoutChunks)),
            stderr: decoder.decode(Buffer.concat(stderrChunks)),
          });
        } catch {
          reject(new Error("Process output is not valid UTF-8"));
        }
      }
    });
    if (signal?.aborted) abort();
  });
}
