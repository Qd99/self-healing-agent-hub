/** Fault-injection drills for the healing Hub and Worker.
 *
 * Each drill injects one real failure against real local processes and asserts
 * the contract the Worker and Hub promise for that failure. The drills reuse
 * the production runtime, Hub service, Git operations and journal; only
 * Jenkins, GitHub and the Docker CLI boundary are controlled.
 *
 * Evidence produced by these drills is externalTier="controlled". It proves
 * the recovery contract on this machine; it does NOT stand in for the real
 * Docker, Jenkins or GitHub acceptance defined in
 * docs/design/console-v20-jenkins-handoff.md.
 */
import { isDeepStrictEqual } from "node:util";
import { once } from "node:events";
import { fork, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openJournal } from "../apps/healing-worker/src/journal.mjs";
import { createWorkerRuntime } from "../apps/healing-worker/src/runtime.mjs";
import { createWorkspaceEngine } from "../apps/healing-worker/src/workspace.mjs";
import { createCheckRunner } from "../apps/healing-worker/src/check-runner.mjs";
import { createDrillFixture } from "./fault-drill.fixture.mjs";
import { createDockerTransport } from "../tests/fixtures/worker/docker-transport.mjs";
import { claim as makeClaim } from "../tests/fixtures/worker/fixture.mjs";

const crashChild = fileURLToPath(
  new URL("../tests/fixtures/worker/crash-child.mjs", import.meta.url),
);

/** Assertion recorder. A drill fails when any assertion is not ok. */
export function createAssertions() {
  const results = [];
  return {
    results,
    check(name, ok, detail) {
      results.push({ name, ok: Boolean(ok), detail: detail ?? null });
      return Boolean(ok);
    },
    equal(name, actual, expected) {
      const ok = isDeepStrictEqual(actual, expected);
      return this.check(name, ok, ok ? null : { actual, expected });
    },
  };
}

export const scenarios = [
  {
    id: "hub-disconnect-lost-ack",
    title: "Hub 断线后重放同一提案，不重复生成候选",
    covers: ["I01-真实服务断线", "I01-未确认发布"],
    relatedTests: ["tests/worker-e2e.test.mjs:551"],
    async run(ctx) {
      const f = await createDrillFixture({
        control: { dropProposalAck: true },
      });
      try {
        const { taskId } = await f.api.importCiBuild({
          sourceId: "drill-ci",
          buildNumber: 27,
        });
        await f.worker.runOnce();
        const afterFirst = f.journal.get(taskId);
        ctx.snapshot("journal-after-first-run", afterFirst);
        ctx.check(
          "提案 ACK 丢失后 journal 停在 proposal-pending",
          afterFirst?.state === "proposal-pending",
          { state: afterFirst?.state },
        );
        const firstProposal = f.hubBodies.filter((b) =>
          b.path.endsWith("/proposal"),
        );
        ctx.equal("Hub 收到第一次提案请求", firstProposal.length, 1);
        ctx.check(
          "候选只生成一次，重放不重新调用模型",
          f.upstreamState.modelCalls === 1,
          { modelCalls: f.upstreamState.modelCalls },
        );
        ctx.check("断线时 PR 尚未创建", f.upstreamState.prCreates === 0, {
          prCreates: f.upstreamState.prCreates,
        });

        // Restart: the Worker replays the saved proposal body byte for byte.
        await f.restartWorker();
        await f.worker.runOnce();
        const afterReplay = f.journal.get(taskId);
        ctx.snapshot("journal-after-replay", afterReplay);
        ctx.check("重放后提案被 Hub 接受", afterReplay?.state === "proposed", {
          state: afterReplay?.state,
        });
        const proposals = f.hubBodies.filter((b) =>
          b.path.endsWith("/proposal"),
        );
        ctx.equal("Hub 共收到两次提案请求", proposals.length, 2);
        ctx.check(
          "两次提案请求体结构等价",
          isDeepStrictEqual(proposals[0].body, proposals[1].body),
          { first: proposals[0]?.body, second: proposals[1]?.body },
        );
        ctx.check(
          "两次提案使用同一 submissionId",
          proposals[0]?.body?.submissionId === proposals[1]?.body?.submissionId,
          {
            first: proposals[0]?.body?.submissionId,
            second: proposals[1]?.body?.submissionId,
          },
        );
        ctx.check("重放仍只生成一次候选", f.upstreamState.modelCalls === 1, {
          modelCalls: f.upstreamState.modelCalls,
        });
        ctx.check(
          "Hub 对重放返回同一提案受理结果，证明只受理一次",
          proposals[0]?.response === proposals[1]?.response,
          {
            first: proposals[0]?.response,
            second: proposals[1]?.response,
          },
        );
        const task = await f.task(taskId);
        ctx.check("任务已受理候选并等待审批", task?.proposal?.version === 2, {
          proposal: task?.proposal?.version ?? null,
        });
        return {
          taskId,
          proposalSubmissions: proposals.map((p) => ({
            submissionId: p.body?.submissionId,
            contentHash: p.body?.candidate?.artifactId ?? null,
          })),
          modelCalls: f.upstreamState.modelCalls,
          prCreates: f.upstreamState.prCreates,
        };
      } finally {
        await f.cleanup();
      }
    },
  },
  {
    id: "worker-sigkill-resource-cleanup",
    title: "Worker 被 SIGKILL 后先确认资源清理，再补录失败回执",
    covers: ["I01-进程中断", "I01-资源清理"],
    relatedTests: ["tests/worker-resource-lifecycle.test.mjs:404"],
    async run(ctx) {
      // This drill runs a real Worker process with only the Docker CLI
      // boundary controlled, exactly like the existing lifecycle test.
      const root = await mkdtemp(join(tmpdir(), "fault-drill-sigkill-"));
      const repo = join(root, "repo");
      await mkdir(repo, { recursive: true });
      await writeFile(join(repo, "value.txt"), "broken\n");
      const git = (...args) =>
        execFileSync("git", args, {
          cwd: repo,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
      git("init", "-q");
      git("config", "user.name", "Drill");
      git("config", "user.email", "drill@example.test");
      git("add", ".");
      git("commit", "-qm", "Failing baseline");
      const base = git("rev-parse", "HEAD");
      const docker = createDockerTransport();
      const config = {
        workerId: "drill-sigkill-worker",
        engineId: "fast",
        publish: { enabled: false },
        dataDir: join(root, "data"),
        repository: {
          fullName: "acme/project",
          branch: "main",
          localPath: repo,
        },
        model: { contextPaths: ["value.txt"] },
        checks: {
          image: `node@sha256:${"a".repeat(64)}`,
          commands: { test: ["node", "test.mjs"] },
          timeoutMs: 1000,
        },
        heartbeatIntervalMs: 10,
        pollIntervalMs: 10,
      };
      const claim = makeClaim();
      claim.task.task.payload.context.commitSha = base;
      claim.task.task.payload.context.source.commitSha = base;
      claim.context.safety = { requiredChecks: ["test"], maxFilesPerFix: 2 };
      const childConfig = join(root, "crash-fixture.json");
      await writeFile(childConfig, JSON.stringify({ config, claim }), {
        mode: 0o600,
      });
      const child = fork(crashChild, [childConfig], {
        execArgv: [],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      const receipts = [];
      let claims = 0;
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(Error(`drill Worker never reached check: ${stderr}`)),
            10000,
          );
          child.once("message", (message) => {
            clearTimeout(timer);
            if (message.kind === "check-started") resolve();
            else reject(Error(`drill Worker ended early: ${message.kind}`));
          });
          child.once("error", reject);
        });
        // The real process dies here; the modeled container keeps running.
        child.kill("SIGKILL");
        const [code, signal] = await once(child, "exit");
        ctx.check(
          "Worker 进程被 SIGKILL 真实终止",
          code === null && signal === "SIGKILL",
          { code, signal },
        );

        const journal = await openJournal(config.dataDir);
        try {
          const saved = journal.get(claim.task.task.id);
          ctx.snapshot("journal-after-sigkill", saved);
          ctx.check(
            "崩溃后 journal 保留已认领状态",
            saved?.state === "claimed",
            { state: saved?.state },
          );
          ctx.check(
            "崩溃后 journal 保留完整容器标识",
            /^[a-f0-9]{64}$/.test(saved?.resources?.check?.containerId ?? ""),
            { containerId: saved?.resources?.check?.containerId ?? null },
          );
          ctx.check(
            "崩溃后工作区仍保留未清理",
            Boolean(saved?.resources?.workspace),
            { workspace: saved?.resources?.workspace ?? null },
          );

          // Rebuild the external transport from the durable identity only.
          docker.addContainer(saved.resources.check);
          // The daemon is unavailable: the Worker must not claim new work and
          // must not acknowledge a stop it cannot prove.
          docker.control.listError = Error("drill injected daemon outage");
          const worker = createWorkerRuntime(config, {
            journal,
            engine: createWorkspaceEngine(config, {
              runCheck: createCheckRunner({ runCommand: docker.runCommand }),
              generate: async () => {
                throw Error("drill must not generate after a crash");
              },
            }),
            client: {
              claim: async () => {
                claims++;
                return null;
              },
              heartbeat: async () => ({
                lease: claim.lease,
                cancelRequested: false,
              }),
              complete: async (id, body) =>
                receipts.push({ method: "complete", body }),
              cancelled: async (id, body) =>
                receipts.push({ method: "cancelled", body }),
            },
            publisher: {
              readBase: async () => claim.task.task.payload.context.commitSha,
            },
          });
          try {
            await worker.runOnce();
            const blocked = journal.get(claim.task.task.id);
            ctx.snapshot("journal-daemon-unavailable", blocked);
            ctx.check(
              "daemon 不可用时状态为 cleanup-pending",
              blocked?.state === "cleanup-pending",
              { state: blocked?.state },
            );
            ctx.check(
              "daemon 不可用时记录未确认清理原因",
              blocked?.cleanupError === "RESOURCE_STOP_UNCONFIRMED",
              { cleanupError: blocked?.cleanupError ?? null },
            );
            ctx.check("daemon 不可用时不领取新任务", claims === 0, { claims });
            ctx.check("daemon 不可用时不发送任何回执", receipts.length === 0, {
              receipts: receipts.length,
            });
            ctx.check(
              "daemon 不可用时容器仍然存在",
              docker.containers.size === 1,
              { containers: docker.containers.size },
            );

            // The daemon recovers: cleanup must complete before any receipt.
            docker.control.listError = undefined;
            await worker.runOnce();
            const recovered = journal.get(claim.task.task.id);
            ctx.snapshot("journal-after-recovery", recovered);
            ctx.check("daemon 恢复后容器被清理", docker.containers.size === 0, {
              containers: docker.containers.size,
            });
            ctx.check(
              "daemon 恢复后只补录一条失败回执",
              receipts.length === 1,
              { receipts: receipts.map((r) => r.method) },
            );
            ctx.check(
              "补录的回执是失败而不是成功",
              receipts[0]?.body?.result?.success === false,
              { result: receipts[0]?.body?.result ?? null },
            );
            ctx.check("恢复后不再领取新任务", claims === 0, { claims });
          } finally {
            await worker.close();
          }
        } finally {
          await journal.close();
        }
        return {
          receipts: receipts.length,
          containers: docker.containers.size,
        };
      } finally {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
        await rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    id: "publish-unconfirmed-manual-review",
    title: "发布结果无法确认时进入人工核对，不重发发布",
    covers: ["I01-未确认发布"],
    relatedTests: ["tests/worker-e2e.test.mjs:551"],
    async run(ctx) {
      // The PR is really created but the acknowledgement is lost, and every
      // read hides it, so the publisher can neither confirm nor repair.
      const f = await createDrillFixture({
        control: { dropPrAck: true, hidePullList: true },
      });
      try {
        const { taskId } = await f.api.importCiBuild({
          sourceId: "drill-ci",
          buildNumber: 27,
        });
        await f.worker.runOnce();
        await f.approve(taskId, "code-review");
        await f.approve(taskId, "execution-auth");
        f.config.publish.enabled = true;
        await f.restartWorker();
        await f.worker.runOnce();

        const task = await f.task(taskId);
        ctx.snapshot("task-after-unconfirmed-publish", task);
        ctx.check("远端确实写入过一次 PR", f.upstreamState.prCreates === 1, {
          prCreates: f.upstreamState.prCreates,
        });
        ctx.check("任务状态为失败", task?.status?.status === "failed", {
          status: task?.status?.status ?? null,
        });
        ctx.check(
          "回执错误码为 PUBLICATION_UNCERTAIN",
          task?.result?.error?.code === "PUBLICATION_UNCERTAIN",
          { error: task?.result?.error ?? null },
        );
        ctx.check(
          "未确认的发布不可自动重试",
          task?.result?.error?.retriable === false,
          { retriable: task?.result?.error?.retriable ?? null },
        );
        ctx.check(
          "任务进入需要人工核对",
          task?.reconciliation?.status === "required",
          { reconciliation: task?.reconciliation ?? null },
        );

        // A restart must only read, never re-post the publication.
        const publishesBefore = f.upstreamState.publishPosts;
        await f.restartWorker();
        await f.worker.runOnce();
        ctx.check(
          "重启后不重发发布请求",
          f.upstreamState.publishPosts === publishesBefore,
          {
            before: publishesBefore,
            after: f.upstreamState.publishPosts,
          },
        );
        const after = await f.task(taskId);
        ctx.check(
          "重启后任务仍需人工核对",
          after?.reconciliation?.status === "required",
          { reconciliation: after?.reconciliation ?? null },
        );
        const record = f.journal.get(taskId);
        ctx.snapshot("journal-after-unconfirmed-publish", record);
        ctx.check(
          "journal 持久记录了发布意图",
          Boolean(record?.known?.intent?.path),
          { intent: record?.known?.intent ?? null },
        );
        ctx.check(
          "journal 持久记录了结果不确定标记",
          record?.known?.uncertain === true,
          { uncertain: record?.known?.uncertain ?? null },
        );
        ctx.check(
          "journal 记录了远端已写入的提交",
          /^[a-f0-9]{40}$/.test(record?.known?.commit ?? ""),
          { commit: record?.known?.commit ?? null },
        );
        return {
          taskId,
          prCreates: f.upstreamState.prCreates,
          publishPosts: f.upstreamState.publishPosts,
          errorCode: task?.result?.error?.code ?? null,
        };
      } finally {
        await f.cleanup();
      }
    },
  },
  {
    id: "base-moved-refuse-execute",
    title: "基线移动后拒绝执行，不写入也不创建 PR",
    covers: ["I01-陈旧基线"],
    relatedTests: ["tests/worker-e2e.test.mjs:678"],
    async run(ctx) {
      // The base moves AFTER the diagnosis was accepted, so the execute lease
      // is the first one that sees the moved base. The base guard is triple
      // redundant (Worker common path, Worker execute path, publisher), and
      // this drill asserts that all of them stop the publication.
      const f = await createDrillFixture();
      try {
        const { taskId } = await f.api.importCiBuild({
          sourceId: "drill-ci",
          buildNumber: 27,
        });
        await f.worker.runOnce();
        await f.approve(taskId, "code-review");
        await f.approve(taskId, "execution-auth");
        f.config.publish.enabled = true;
        f.moveBase();
        await f.restartWorker();
        await f.worker.runOnce();

        const task = await f.task(taskId);
        ctx.snapshot("task-after-base-moved", task);
        ctx.check("基线移动后不创建 PR", f.upstreamState.prCreates === 0, {
          prCreates: f.upstreamState.prCreates,
        });
        ctx.check(
          "基线移动后不产生任何远端写入",
          f.upstreamState.publishPosts === 0,
          { publishPosts: f.upstreamState.publishPosts },
        );
        ctx.check(
          "基线移动后候选不重新生成",
          f.upstreamState.modelCalls === 1,
          { modelCalls: f.upstreamState.modelCalls },
        );
        ctx.check(
          "基线移动后任务状态为失败",
          task?.status?.status === "failed",
          { status: task?.status?.status ?? null },
        );
        ctx.check(
          "基线移动后错误码为 BASE_MOVED",
          task?.result?.error?.code === "BASE_MOVED",
          { error: task?.result?.error ?? null },
        );
        ctx.check(
          "基线移动后进入需要人工核对",
          task?.reconciliation?.status === "required",
          { reconciliation: task?.reconciliation ?? null },
        );
        return {
          taskId,
          prCreates: f.upstreamState.prCreates,
          errorCode: task?.result?.error?.code ?? null,
        };
      } finally {
        await f.cleanup();
      }
    },
  },
];

export const drillScenarios = scenarios;
