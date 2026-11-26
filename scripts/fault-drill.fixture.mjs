/** Shared fixture for the fault-injection drills.
 *
 * Every drill runs against real local processes: a real Hub HTTP server, a real
 * Worker runtime, real local Git and a real journal on disk. Only the external
 * systems are controlled: Jenkins and GitHub are answered by a local HTTP
 * server, and the Docker CLI boundary is the controlled transport.
 *
 * This is NOT real-environment acceptance. Evidence produced here is tagged
 * externalTier="controlled" and must never be reported as a real Docker,
 * Jenkins or GitHub run.
 */
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConsoleServer } from "../apps/healing-hub/src/console-server.mjs";
import { createApiClient } from "../apps/console/public/api-client.js";
import { createWorkspaceEngine } from "../apps/healing-worker/src/workspace.mjs";
import { runCommand } from "../apps/healing-worker/src/process-runner.mjs";
import { createWorkerRuntime } from "../apps/healing-worker/src/runtime.mjs";
import { createHubClient } from "../apps/healing-worker/src/hub-client.mjs";
import { createGitHubPublisher } from "../apps/healing-worker/src/github-publisher.mjs";
import { openJournal } from "../apps/healing-worker/src/journal.mjs";
import { resolveConfig } from "../apps/healing-worker/src/config.mjs";

export const managerToken = "drill-manager-token-12345678";
export const workerToken = "drill-worker-token-123456789";
export const modelSecret = "drill-model-secret";
export const writeToken = "drill-write-token";
export const readToken = "drill-read-token";
export const origin = "owner/repo";

export async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

export async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

/** A local HTTP server that answers the Jenkins, model and GitHub routes the
 * drills need. Its behaviour is switched per scenario through `control`. */
export function createUpstreamServer({ git, base }) {
  const state = {
    remoteBase: base,
    pr: null,
    ci: [],
    modelCalls: 0,
    prCreates: 0,
    publishPosts: 0,
    proposalAcks: 0,
    requests: [],
    // Fault switches. Each one defaults to the healthy path.
    control: {
      // Drop the Hub ACK after the Hub accepted the proposal body.
      dropProposalAck: false,
      // Accept POST /pulls but hide the created PR from every read.
      hidePullList: false,
      // Drop the GitHub acknowledgement after the PR was really created.
      dropPrAck: false,
      // Fail the GitHub list query so the publisher cannot confirm.
      breakPullList: false,
    },
  };
  const gitCommit = (sha) => {
    const [tree, parents, ...message] = git([
      "show",
      "-s",
      "--format=%T%n%P%n%B",
      sha,
    ]).split("\n");
    return {
      sha,
      tree: { sha: tree },
      parents: parents ? parents.split(" ").map((s) => ({ sha: s })) : [],
      message: message.join("\n").trim(),
    };
  };
  const prState = () =>
    state.pr && {
      ...state.pr,
      head: {
        ...state.pr.head,
        sha: git(["rev-parse", `refs/heads/${state.pr.head.ref}`]),
      },
      base: { ...state.pr.base, sha: state.remoteBase },
    };
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    const path = new URL(request.url, "http://drill").pathname;
    state.requests.push({ method: request.method, path, body });
    try {
      let value;
      if (path === "/job/check/27/api/json") {
        const revision = {
          SHA1: base,
          branch: [{ name: "origin/main", SHA1: base }],
        };
        value = {
          number: 27,
          building: false,
          result: "FAILURE",
          actions: [
            {
              _class: "hudson.plugins.git.util.BuildData",
              remoteUrls: ["https://github.com/owner/repo.git"],
              lastBuiltRevision: revision,
              buildsByBranchName: {
                "origin/main": { buildNumber: 27, revision, marked: revision },
              },
            },
          ],
        };
      } else if (path === "/v1/chat/completions") {
        state.modelCalls++;
        value = {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: "Correct the fixture value",
                  changes: [
                    {
                      path: "value.mjs",
                      content: "export const value = 42;\n",
                    },
                  ],
                }),
              },
            },
          ],
        };
      } else if (path.startsWith(`/repos/${origin}/`)) {
        const route = path.slice(`/repos/${origin}`.length);
        if (route === "/git/ref/heads/main")
          value = { object: { sha: state.remoteBase } };
        else if (route.startsWith("/git/ref/heads/heal/")) {
          try {
            value = {
              object: {
                sha: git([
                  "rev-parse",
                  `refs/heads/${route.slice("/git/ref/heads/".length)}`,
                ]),
              },
            };
          } catch {
            response.writeHead(404, { "content-type": "application/json" });
            response.end("{}");
            return;
          }
        } else if (route.startsWith("/git/commits/"))
          value = gitCommit(route.slice("/git/commits/".length));
        else if (route === "/git/trees" && request.method === "POST") {
          const env = { GIT_INDEX_FILE: join(state.root, "api-index") };
          git(["read-tree", body.base_tree], undefined, env);
          for (const file of body.tree) {
            if (file.sha === null)
              git(
                ["update-index", "--force-remove", "--", file.path],
                undefined,
                env,
              );
            else {
              const blob = git(["hash-object", "-w", "--stdin"], file.content);
              git(
                [
                  "update-index",
                  "--add",
                  "--cacheinfo",
                  `${file.mode},${blob},${file.path}`,
                ],
                undefined,
                env,
              );
            }
          }
          value = { sha: git(["write-tree"], undefined, env) };
        } else if (route === "/git/commits" && request.method === "POST") {
          value = gitCommit(
            git(
              ["commit-tree", body.tree, "-p", body.parents[0], "-F", "-"],
              body.message,
            ),
          );
        } else if (route === "/git/refs" && request.method === "POST") {
          git(["update-ref", body.ref, body.sha, "0".repeat(40)]);
          value = { ref: body.ref, object: { sha: body.sha } };
        } else if (route === "/pulls" && request.method === "GET") {
          if (state.control.breakPullList)
            throw Error("drill injected pull list failure");
          if (state.control.hidePullList) value = [];
          else value = state.pr ? [prState()] : [];
        } else if (route === "/pulls" && request.method === "POST") {
          state.prCreates++;
          state.publishPosts++;
          state.pr = {
            number: 1,
            state: "open",
            merged: false,
            draft: true,
            changed_files: 1,
            body: body.body,
            head: {
              ref: body.head,
              sha: git(["rev-parse", `refs/heads/${body.head}`]),
              repo: { full_name: origin },
            },
            base: {
              ref: body.base,
              sha: state.remoteBase,
              repo: { full_name: origin },
            },
          };
          value = prState();
        } else if (route === "/pulls/1") value = prState();
        else if (route === "/pulls/1/files")
          value = state.pr
            ? git(["diff", "--name-only", base, state.pr.head.sha])
                .split("\n")
                .filter(Boolean)
                .map((filename) => ({ filename, status: "modified" }))
            : [];
        else if (/^\/commits\/[a-f0-9]{40}\/statuses$/.test(route))
          value = state.ci;
        else if (/^\/commits\/[a-f0-9]{40}$/.test(route)) {
          const commit = gitCommit(route.split("/")[2]);
          value = {
            sha: commit.sha,
            parents: commit.parents,
            commit: { tree: commit.tree },
          };
        } else
          throw Error(
            `Unexpected GitHub drill request: ${request.method} ${route}`,
          );
      } else throw Error(`Unexpected drill upstream path: ${path}`);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ drillError: error.message }));
    }
  });
  return { server, state };
}

/** Build an isolated repository, Hub, upstream and Worker in a temporary root.
 * The returned handle owns the cleanup of every process and directory. */
export async function createDrillFixture({ control = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), "fault-drill-"));
  const repo = join(root, "source");
  const hubRoot = join(root, "hub");
  await mkdir(repo);
  await mkdir(join(hubRoot, "configs"), { recursive: true });
  await mkdir(join(hubRoot, "public"), { recursive: true });
  await writeFile(
    join(hubRoot, "public/index.html"),
    "<!doctype html><title>drill</title>",
  );
  const gitEnv = {
    PATH: process.env.PATH,
    HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Drill",
    GIT_AUTHOR_EMAIL: "drill@example.test",
    GIT_COMMITTER_NAME: "Drill",
    GIT_COMMITTER_EMAIL: "drill@example.test",
  };
  const git = (args, input, extra = {}) =>
    execFileSync("git", args, {
      cwd: repo,
      env: { ...gitEnv, ...extra },
      encoding: "utf8",
      input,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  git(["init", "-q", "--initial-branch=main"]);
  await writeFile(join(repo, "value.mjs"), "export const value = 41;\n");
  await writeFile(
    join(repo, "check.mjs"),
    'import assert from "node:assert/strict";\nimport { value } from "./value.mjs";\nassert.equal(process.env.HEALING_MODEL_TOKEN, undefined);\nassert.equal(process.env.HEALING_GITHUB_WRITE_TOKEN, undefined);\nassert.equal(value, 42);\n',
  );
  git(["add", "."]);
  git(["commit", "-qm", "Reproduce a failing check"]);
  const base = git(["rev-parse", "HEAD"]);

  const upstream = createUpstreamServer({ git, base });
  upstream.state.root = root;
  Object.assign(upstream.state.control, control);
  const upstreamUrl = await listen(upstream.server);
  const upstreamFetch = async (url, init) => {
    const u = new URL(url);
    const response = await fetch(upstreamUrl + u.pathname + u.search, init);
    return new Response(response.body, {
      status: response.status,
      headers: response.headers,
    });
  };

  await writeFile(
    join(hubRoot, "configs/healing-config.json"),
    JSON.stringify({
      project: { id: "drill", repo: origin, defaultBranch: "main" },
      engines: { fast: { type: "pull-worker" } },
      safety: {
        requiredChecks: ["node check.mjs"],
        maxFilesPerFix: 2,
        protectedPaths: ["check.mjs"],
      },
      triggers: { manual: { enabled: true } },
    }),
  );
  await writeFile(
    join(hubRoot, "configs/healing-rules.json"),
    JSON.stringify({
      version: "1",
      rules: [
        {
          id: "jenkins-repair",
          name: "Jenkins repair",
          enabled: true,
          match: { taskType: "ci-failure" },
          processor: {
            engine: "fast",
            action: "create-pr",
            priority: "high",
          },
        },
      ],
    }),
  );
  const hub = createConsoleServer({
    rootDir: hubRoot,
    publicDir: join(hubRoot, "public"),
    consoleToken: managerToken,
    workerToken,
    integrationsConfig: {
      jenkins: {
        enabled: true,
        sourceId: "drill-ci",
        generation: "1",
        baseUrl: upstreamUrl,
        allowHttp: true,
        jobSegments: ["check"],
        repo: origin,
        branch: "main",
        scmBranch: "origin/main",
        scmRemoteUrls: ["https://github.com/owner/repo.git"],
      },
      githubVerification: {
        enabled: true,
        tokenEnv: "READ_TOKEN",
        requiredStatusContexts: ["drill/check"],
        trustedStatusCreators: ["drill-ci[bot]"],
      },
    },
    integrationsFetch: upstreamFetch,
    integrationsEnv: { READ_TOKEN: readToken },
  });
  const hubUrl = await listen(hub);
  let cookie = "";
  const api = createApiClient({
    fetch: async (path, options) => {
      const result = await fetch(hubUrl + path, {
        ...options,
        headers: {
          ...options.headers,
          Origin: hubUrl,
          ...(cookie ? { Cookie: cookie } : {}),
        },
      });
      if (result.headers.get("set-cookie"))
        cookie = result.headers.get("set-cookie").split(";")[0];
      return result;
    },
  });
  await api.createSession(managerToken);
  const config = resolveConfig(
    {
      version: 1,
      hub: { url: hubUrl },
      workerId: "drill-worker",
      engineId: "fast",
      dataDir: join(root, "worker"),
      repository: { fullName: origin, branch: "main", localPath: repo },
      model: {
        endpoint: upstreamUrl + "/v1/chat/completions",
        model: "drill-model",
        contextPaths: ["value.mjs"],
        timeoutMs: 5000,
      },
      checks: {
        image: "drill@sha256:" + "a".repeat(64),
        commands: { "node check.mjs": [process.execPath, "check.mjs"] },
        timeoutMs: 5000,
      },
      github: {},
      publish: { enabled: false },
      heartbeatIntervalMs: 100,
      pollIntervalMs: 100,
    },
    {
      env: {
        HEALING_WORKER_TOKEN: workerToken,
        HEALING_MODEL_TOKEN: modelSecret,
        HEALING_GITHUB_WRITE_TOKEN: writeToken,
      },
    },
  );
  const hubBodies = [];
  let droppedProposalAck = false;
  let droppedPrAck = false;
  const client = createHubClient(config, {
    fetchImpl: async (url, init) => {
      const result = await fetch(url, init);
      // The response body is read once here so the Hub acknowledgement can be
      // compared across the replay. A dropped ACK is still recorded.
      const responseText = await result.clone().text();
      hubBodies.push({
        path: new URL(url).pathname,
        body: JSON.parse(init.body),
        status: result.status,
        response: responseText,
      });
      // The Hub accepted the proposal, but the acknowledgement never reaches
      // the Worker. The Worker must replay the identical body after restart.
      if (
        upstream.state.control.dropProposalAck &&
        !droppedProposalAck &&
        result.ok &&
        new URL(url).pathname.endsWith("/proposal")
      ) {
        droppedProposalAck = true;
        await result.text();
        throw Error("drill dropped the Hub proposal ACK after acceptance");
      }
      return result;
    },
  });
  const engine = createWorkspaceEngine(config, {
    // Real Node process in the temporary checkout. The Docker CLI boundary is
    // the only controlled part; the check itself really runs and really fails
    // before the repair.
    runCheck: async ({ cwd, argv, timeoutMs }, { signal }) =>
      runCommand(argv[0], argv.slice(1), { cwd, signal, timeoutMs }),
  });
  const publisher = createGitHubPublisher(config, {
    fetchImpl: async (url, init) => {
      const result = await upstreamFetch(url, init);
      // The PR is really created, but the acknowledgement is lost in transit.
      // The publisher can no longer prove what it wrote and must not guess.
      if (
        upstream.state.control.dropPrAck &&
        !droppedPrAck &&
        init?.method === "POST" &&
        new URL(url).pathname.endsWith("/pulls") &&
        result.ok
      ) {
        droppedPrAck = true;
        await result.text();
        throw Error("drill dropped the GitHub pull ACK after creation");
      }
      return result;
    },
  });
  let journal, worker;
  async function startWorker() {
    journal = await openJournal(config.dataDir);
    worker = createWorkerRuntime(config, {
      client,
      engine,
      publisher,
      journal,
    });
  }
  await startWorker();
  const handle = {
    root,
    repo,
    git,
    base,
    api,
    config,
    hub,
    hubUrl,
    upstream,
    upstreamUrl,
    hubBodies,
    get worker() {
      return worker;
    },
    get journal() {
      return journal;
    },
    get upstreamState() {
      return upstream.state;
    },
    async restartWorker() {
      await worker.close();
      await startWorker();
    },
    async task(id) {
      return (await api.getSnapshot()).tasks.find((x) => x.task.id === id);
    },
    async approve(id, nodeId) {
      const task = await handle.task(id);
      return api.decideApproval(id, {
        expectedRevision: task.revision,
        round: task.approvalFlow.round,
        nodeId,
        decision: "approve",
        comment: "Drill approval of the exact candidate",
      });
    },
    /** Advance the remote base branch so the next execution sees a moved base. */
    moveBase() {
      const tree = git(["show", "-s", "--format=%T", base]);
      upstream.state.remoteBase = git([
        "commit-tree",
        tree,
        "-p",
        base,
        "-m",
        "Base moved",
      ]);
    },
    async cleanup() {
      await worker?.close().catch(() => {});
      await journal?.close().catch(() => {});
      await hub.shutdown().catch(() => {});
      await closeServer(upstream.server);
      await rm(root, { recursive: true, force: true });
    },
  };
  return handle;
}
