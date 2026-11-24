import { readFile } from "node:fs/promises";
import { createWorkerRuntime } from "../../../apps/healing-worker/src/runtime.mjs";
import { createWorkspaceEngine } from "../../../apps/healing-worker/src/workspace.mjs";
import { createCheckRunner } from "../../../apps/healing-worker/src/check-runner.mjs";
import { openJournal } from "../../../apps/healing-worker/src/journal.mjs";
import { createDockerTransport } from "./docker-transport.mjs";

// A real Worker process with only the Docker CLI boundary controlled. The parent
// SIGKILLs this process while the modeled Docker workload is still running.
const { config, claim } = JSON.parse(await readFile(process.argv[2], "utf8"));
const journal = await openJournal(config.dataDir);
const docker = createDockerTransport();
docker.onStart = async (container) => {
  const saved = journal.get(claim.task.task.id);
  if (saved?.resources?.check?.containerId !== container.Id)
    throw Error("Check started before durable resource identity");
  process.send({ kind: "check-started" });
  await new Promise(() => {});
};
const worker = createWorkerRuntime(config, {
  journal,
  engine: createWorkspaceEngine(config, {
    runCheck: createCheckRunner({ runCommand: docker.runCommand }),
    generate: async () => {
      throw Error("Crash must precede generation");
    },
  }),
  client: {
    claim: async () => claim,
    heartbeat: async () => ({ lease: claim.lease, cancelRequested: false }),
    complete: async () => process.send({ kind: "unexpected-receipt" }),
    cancelled: async () => process.send({ kind: "unexpected-receipt" }),
  },
  publisher: {
    readBase: async () => claim.task.task.payload.context.commitSha,
  },
});
try {
  await worker.runOnce();
  process.send({ kind: "unexpected-finish" });
} finally {
  await worker.close();
}
