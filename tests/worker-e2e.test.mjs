/** Real local Git + Hub HTTP + model HTTP + Node check processes.
 * Jenkins/GitHub/model responses are controlled fixtures, not production/Docker acceptance. */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createConsoleServer } from "../apps/healing-hub/src/console-server.mjs";
import { createApiClient } from "../apps/console/public/api-client.js";
import { renderTaskVerification } from "../apps/console/public/ci-views.js";
import { createWorkspaceEngine } from "../apps/healing-worker/src/workspace.mjs";
import { runCommand } from "../apps/healing-worker/src/process-runner.mjs";
import { createWorkerRuntime } from "../apps/healing-worker/src/runtime.mjs";
import { createHubClient } from "../apps/healing-worker/src/hub-client.mjs";
import { createGitHubPublisher } from "../apps/healing-worker/src/github-publisher.mjs";
import { openJournal } from "../apps/healing-worker/src/journal.mjs";
import { resolveConfig } from "../apps/healing-worker/src/config.mjs";

const managerToken = "fixture-manager-token-123456789",
  workerToken = "fixture-worker-token-1234567890";
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t, { loseAcks = false, pauseModel = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "healing-e2e-")),
    repo = join(root, "source"),
    hubRoot = join(root, "hub");
  await mkdir(repo);
  await mkdir(join(hubRoot, "configs"), { recursive: true });
  await mkdir(join(hubRoot, "public"));
  await writeFile(
    join(hubRoot, "public/index.html"),
    "<!doctype html><title>fixture</title>",
  );
  const gitEnv = {
    PATH: process.env.PATH,
    HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.test",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.test",
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
    'import assert from "node:assert/strict";\nimport { value } from "./value.mjs";\nassert.equal(process.env.HEALING_MODEL_TOKEN, undefined);\nassert.equal(process.env.HEALING_GITHUB_WRITE_TOKEN, undefined);\nassert.equal(value, 42);\nconsole.log("fixture check passed");\n',
  );
  git(["add", "."]);
  git(["commit", "-qm", "Reproduce a failing check"]);
  const base = git(["rev-parse", "HEAD"]);
  let remoteBase = base,
    pr = null,
    ci = [],
    modelCalls = 0,
    prCreates = 0;
  const upstreamRequests = [],
    checkResults = [],
    modelStarted = deferred(),
    modelRelease = deferred();
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
      parents: parents ? parents.split(" ").map((sha) => ({ sha })) : [],
      message: message.join("\n").trim(),
    };
  };
  const prState = () =>
    pr && {
      ...pr,
      head: {
        ...pr.head,
        sha: git(["rev-parse", `refs/heads/${pr.head.ref}`]),
      },
      base: { ...pr.base, sha: remoteBase },
    };
  const upstream = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://fixture");
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = raw ? JSON.parse(raw) : undefined,
        path = url.pathname;
      upstreamRequests.push({
        path,
        method: request.method,
        body,
        authorization: request.headers.authorization,
      });
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
        modelCalls++;
        assert.equal(
          request.headers.authorization,
          "Bearer fixture-model-secret",
        );
        assert.equal(body.response_format.type, "json_object");
        const input = JSON.parse(body.messages[1].content);
        assert.equal(input.task.commitSha, base);
        assert.equal(input.context[0].content, "export const value = 41;\n");
        modelStarted.resolve();
        if (pauseModel) await modelRelease.promise;
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
      } else if (path.startsWith("/repos/owner/repo/")) {
        assert.ok(
          ["Bearer fixture-read-token", "Bearer fixture-write-token"].includes(
            request.headers.authorization,
          ),
        );
        if (request.method !== "GET")
          assert.equal(
            request.headers.authorization,
            "Bearer fixture-write-token",
          );
        const route = path.slice("/repos/owner/repo".length);
        if (route === "/git/ref/heads/main")
          value = { object: { sha: remoteBase } };
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
          const env = { GIT_INDEX_FILE: join(root, "api-index") };
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
          assert.deepEqual(body.parents, [base]);
          value = gitCommit(
            git(
              ["commit-tree", body.tree, "-p", base, "-F", "-"],
              body.message,
            ),
          );
        } else if (route === "/git/refs" && request.method === "POST") {
          assert.match(body.ref, /^refs\/heads\/heal\/[a-f0-9-]{36}$/);
          git(["update-ref", body.ref, body.sha, "0".repeat(40)]);
          value = { ref: body.ref, object: { sha: body.sha } };
        } else if (route === "/pulls" && request.method === "GET")
          value = pr ? [prState()] : [];
        else if (route === "/pulls" && request.method === "POST") {
          prCreates++;
          assert.equal(pr, null, "a second PR must never be created");
          assert.equal(body.draft, true);
          pr = {
            number: 1,
            state: "open",
            merged: false,
            draft: true,
            changed_files: 1,
            body: body.body,
            head: {
              ref: body.head,
              sha: git(["rev-parse", `refs/heads/${body.head}`]),
              repo: { full_name: "owner/repo" },
            },
            base: {
              ref: body.base,
              sha: remoteBase,
              repo: { full_name: "owner/repo" },
            },
          };
          value = prState();
        } else if (route === "/pulls/1") value = prState();
        else if (route === "/pulls/1/files")
          value = git(["diff", "--name-only", base, pr.head.sha])
            .split("\n")
            .filter(Boolean)
            .map((filename) => ({ filename, status: "modified" }));
        else if (/^\/commits\/[a-f0-9]{40}\/statuses$/.test(route)) {
          assert.equal(
            route.split("/")[2],
            pr.head.sha,
            "CI must be queried on repair SHA",
          );
          value = ci;
        } else if (/^\/commits\/[a-f0-9]{40}$/.test(route)) {
          const c = gitCommit(route.split("/")[2]);
          value = { sha: c.sha, parents: c.parents, commit: { tree: c.tree } };
        } else
          throw Error(
            `Unexpected GitHub fixture request: ${request.method} ${route}`,
          );
      } else throw Error(`Unexpected upstream path: ${path}`);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ fixtureError: error.message }));
    }
  });
  const upstreamUrl = await listen(upstream);
  const upstreamFetch = async (url, init) => {
    const u = new URL(url);
    assert.ok(
      ["https://api.github.com", upstreamUrl].includes(u.origin),
      "fixture must never contact real upstreams",
    );
    const response = await fetch(upstreamUrl + u.pathname + u.search, init);
    // Test transport maps fixed upstream origins to localhost; no HTTP redirect occurs.
    // Preserve the real streamed body/status/headers without the test server URL.
    return new Response(response.body, {
      status: response.status,
      headers: response.headers,
    });
  };
  await writeFile(
    join(hubRoot, "configs/healing-config.json"),
    JSON.stringify({
      project: { id: "e2e", repo: "owner/repo", defaultBranch: "main" },
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
          processor: { engine: "fast", action: "create-pr", priority: "high" },
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
        sourceId: "fixture-ci",
        generation: "1",
        baseUrl: upstreamUrl,
        allowHttp: true,
        jobSegments: ["check"],
        repo: "owner/repo",
        branch: "main",
        scmBranch: "origin/main",
        scmRemoteUrls: ["https://github.com/owner/repo.git"],
      },
      githubVerification: {
        enabled: true,
        tokenEnv: "READ_TOKEN",
        requiredStatusContexts: ["fixture/check"],
        trustedStatusCreators: ["fixture-ci[bot]"],
      },
    },
    integrationsFetch: upstreamFetch,
    integrationsEnv: { READ_TOKEN: "fixture-read-token" },
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
      workerId: "fixture-worker",
      engineId: "fast",
      dataDir: join(root, "worker"),
      repository: { fullName: "owner/repo", branch: "main", localPath: repo },
      model: {
        endpoint: upstreamUrl + "/v1/chat/completions",
        model: "fixture-model",
        contextPaths: ["value.mjs"],
        timeoutMs: 5000,
      },
      checks: {
        image: "fixture@sha256:" + "a".repeat(64),
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
        HEALING_MODEL_TOKEN: "fixture-model-secret",
        HEALING_GITHUB_WRITE_TOKEN: "fixture-write-token",
      },
    },
  );
  let worker,
    journal,
    lostProposal = false,
    lostComplete = false,
    lostPr = false;
  const hubBodies = [];
  const client = createHubClient(config, {
    fetchImpl: async (url, init) => {
      assert.equal(new URL(url).origin, hubUrl);
      const result = await fetch(url, init);
      hubBodies.push({
        path: new URL(url).pathname,
        body: JSON.parse(init.body),
        status: result.status,
      });
      if (
        loseAcks &&
        result.ok &&
        ((url.endsWith("/proposal") && !lostProposal) ||
          (url.endsWith("/complete") && !lostComplete))
      ) {
        if (url.endsWith("/proposal")) lostProposal = true;
        else lostComplete = true;
        await result.text();
        throw Error("fixture dropped Hub ACK after acceptance");
      }
      return result;
    },
  });
  const engine = createWorkspaceEngine(config, {
    // Explicit test-only runner. Real Node process in temporary checkout, not Docker.
    runCheck: async ({ cwd, argv, timeoutMs }, { signal }) => {
      const result = await runCommand(argv[0], argv.slice(1), {
        cwd,
        signal,
        timeoutMs,
      });
      checkResults.push(result.exitCode);
      return result;
    },
  });
  const publisher = createGitHubPublisher(config, {
    fetchImpl: async (url, init) => {
      const result = await upstreamFetch(url, init);
      if (
        loseAcks &&
        !lostPr &&
        init.method === "POST" &&
        new URL(url).pathname.endsWith("/pulls") &&
        result.ok
      ) {
        lostPr = true;
        await result.text();
        throw Error("fixture dropped PR ACK after creation");
      }
      return result;
    },
  });
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
  t.after(async () => {
    modelRelease.resolve();
    await worker.close();
    await hub.shutdown();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return {
    api,
    base,
    config,
    root,
    repo,
    git,
    hubBodies,
    upstreamRequests,
    checkResults,
    modelStarted,
    get worker() {
      return worker;
    },
    get journal() {
      return journal;
    },
    get modelCalls() {
      return modelCalls;
    },
    get prCreates() {
      return prCreates;
    },
    async restartWorker() {
      await worker.close();
      await startWorker();
    },
    setCi(state, creator = "fixture-ci[bot]") {
      ci = state
        ? [
            {
              id: Date.now(),
              context: "fixture/check",
              state,
              updated_at: new Date().toISOString(),
              creator: { login: creator },
            },
          ]
        : [];
    },
    moveBase() {
      remoteBase = git([
        "commit-tree",
        gitCommit(base).tree.sha,
        "-p",
        base,
        "-m",
        "Base moved",
      ]);
    },
    async task(id) {
      return (await api.getSnapshot()).tasks.find((x) => x.task.id === id);
    },
    async approve(id, nodeId) {
      const task = await this.task(id);
      return api.decideApproval(id, {
        expectedRevision: task.revision,
        round: task.approvalFlow.round,
        nodeId,
        decision: "approve",
        comment: "Fixture exact candidate approval",
      });
    },
  };
}

test("full Jenkins/Git/HTTP/check flow survives lost ACK and restart with exactly one approved PR", async (t) => {
  const f = await fixture(t, { loseAcks: true });
  const imported = await f.api.importCiBuild({
      sourceId: "fixture-ci",
      buildNumber: 27,
    }),
    id = imported.taskId;
  assert.equal(imported.outcome, "created");
  assert.equal(
    (await f.api.importCiBuild({ sourceId: "fixture-ci", buildNumber: 27 }))
      .outcome,
    "duplicate",
  );
  await f.worker.runOnce();
  let task = await f.task(id);
  assert.equal(
    task.proposal?.version,
    2,
    JSON.stringify({ task, journal: f.journal.get(id) }),
  );
  assert.equal(task.proposal.candidate.baseCommitSha, f.base);
  assert.equal(f.journal.get(id).state, "proposal-pending");
  assert.deepEqual(f.checkResults, [1, 0]);
  assert.equal(f.prCreates, 0);
  await f.restartWorker();
  await f.worker.runOnce();
  assert.equal(f.journal.get(id).state, "proposed");
  assert.equal(f.modelCalls, 1);
  const proposals = f.hubBodies.filter((r) => r.path.endsWith("/proposal"));
  assert.equal(proposals.length, 2);
  assert.deepEqual(proposals[0].body, proposals[1].body);
  await f.worker.runOnce();
  assert.equal(f.prCreates, 0);
  await f.approve(id, "code-review");
  await f.worker.runOnce();
  assert.equal(f.prCreates, 0, "first approval cannot publish");
  await f.approve(id, "execution-auth");
  assert.equal(
    (await f.worker.runOnce()).idle,
    true,
    "publish stays disabled after approvals",
  );
  f.config.publish.enabled = true;
  await f.restartWorker();
  await f.worker.runOnce();
  task = await f.task(id);
  assert.equal(
    task.status.status,
    "completed",
    JSON.stringify({ task, journal: f.journal.get(id) }),
  );
  assert.equal(f.prCreates, 1);
  assert.equal(f.journal.get(id).state, "outbox");
  await f.restartWorker();
  await f.worker.runOnce();
  assert.equal(f.journal.get(id).state, "done");
  assert.equal(f.prCreates, 1);
  assert.equal(f.modelCalls, 1);
  assert.deepEqual(f.checkResults, [1, 0, 0]);
  const completions = f.hubBodies.filter((r) => r.path.endsWith("/complete"));
  assert.deepEqual(completions[0].body, completions[1].body);
  assert.equal(
    f.git(["rev-parse", `${task.result.changes.commit}^{tree}`]),
    task.proposal.candidate.treeSha,
  );
  assert.equal(f.git(["rev-parse", `${task.result.changes.commit}^`]), f.base);
  assert.equal(
    await readFile(join(f.repo, "value.mjs"), "utf8"),
    "export const value = 41;\n",
  );
  assert.equal(task.verification, undefined);
  for (const [ci, expected] of [
    [null, "pending"],
    ["failure", "failed"],
    ["success", "passed"],
  ]) {
    f.setCi(ci);
    task = await f.task(id);
    const verified = await f.api.verifyTask(id, {
      expectedRevision: task.revision,
    });
    task = verified.snapshot.tasks.find((x) => x.task.id === id);
    assert.equal(
      task.verification.status,
      expected,
      JSON.stringify(task.verification),
    );
    assert.equal(
      task.verification.target.headCommitSha,
      task.result.changes.commit,
    );
    assert.match(
      renderTaskVerification(task, {
        mode: "live",
        snapshot: verified.snapshot,
      }),
      new RegExp(
        { pending: "等待 CI", failed: "CI 检查失败", passed: "CI 核验通过" }[
          expected
        ],
      ),
    );
  }
  f.setCi("success", "untrusted-bot");
  const mismatch = await f.api.verifyTask(id, {
    expectedRevision: task.revision,
  });
  assert.equal(mismatch.snapshot.tasks[0].verification.status, "mismatch");
  assert.ok(
    f.upstreamRequests
      .filter((r) => r.method !== "GET" && r.path.startsWith("/repos/"))
      .every((r) =>
        ["/git/trees", "/git/commits", "/git/refs", "/pulls"].some((suffix) =>
          r.path.endsWith(suffix),
        ),
      ),
  );
  const saved = await readFile(join(f.config.dataDir, "journal.json"), "utf8");
  for (const secret of [
    managerToken,
    workerToken,
    "fixture-read-token",
    "fixture-write-token",
    "fixture-model-secret",
  ])
    assert.ok(!saved.includes(secret));
});
test("moved base stops approved execution before writes and requires reconciliation", async (t) => {
  const f = await fixture(t),
    { taskId } = await f.api.importCiBuild({
      sourceId: "fixture-ci",
      buildNumber: 27,
    });
  await f.worker.runOnce();
  await f.approve(taskId, "code-review");
  await f.approve(taskId, "execution-auth");
  f.config.publish.enabled = true;
  f.moveBase();
  await f.worker.runOnce();
  const task = await f.task(taskId);
  assert.equal(task.status.status, "failed");
  assert.equal(task.reconciliation.status, "required");
  assert.equal(f.prCreates, 0);
  assert.equal(f.modelCalls, 1);
  assert.ok(
    !f.upstreamRequests.some(
      (r) => r.method !== "GET" && r.path.startsWith("/repos/"),
    ),
  );
});
test("manager cancellation aborts model HTTP before acknowledging stopped diagnosis", async (t) => {
  const f = await fixture(t, { pauseModel: true }),
    { taskId } = await f.api.importCiBuild({
      sourceId: "fixture-ci",
      buildNumber: 27,
    });
  const running = f.worker.runOnce();
  await Promise.race([
    f.modelStarted.promise,
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(Error("model was not reached")),
        4000,
      );
      timer.unref();
    }),
  ]);
  const task = await f.task(taskId);
  await f.api.taskAction(taskId, "cancel", { expectedRevision: task.revision });
  await running;
  assert.equal((await f.task(taskId)).status.status, "cancelled");
  assert.equal(f.prCreates, 0);
  assert.ok(f.hubBodies.some((r) => r.path.endsWith("/cancelled")));
});
