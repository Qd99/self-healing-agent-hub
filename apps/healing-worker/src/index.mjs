import { pathToFileURL } from "node:url";
import { parseArgs, loadConfig, readiness } from "./config.mjs";
import { openJournal } from "./journal.mjs";
import { createHubClient } from "./hub-client.mjs";
import { createGitHubPublisher } from "./github-publisher.mjs";
import { createWorkerRuntime } from "./runtime.mjs";
export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args),
    config = await loadConfig(options.config);
  if (options.checkConfig) {
    process.stdout.write(`${JSON.stringify(readiness(config))}\n`);
    return;
  }
  const { createWorkspaceEngine } = await import("./workspace.mjs");
  const journal = await openJournal(config.dataDir);
  let runtime;
  try {
    runtime = createWorkerRuntime(config, {
      journal,
      client: createHubClient(config),
      publisher: createGitHubPublisher(config),
      engine: createWorkspaceEngine(config),
    });
  } catch (error) {
    await journal.close();
    throw error;
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    if (options.once) await runtime.runOnce({ signal: controller.signal });
    else await runtime.run({ signal: controller.signal });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await runtime.close();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(() => {
    process.stderr.write(
      "Worker stopped: configuration, lease, transport, or durable state unavailable. Inspect protected local state before restarting.\n",
    );
    process.exitCode = 1;
  });
}
