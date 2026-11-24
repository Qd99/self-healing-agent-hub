import test from "node:test";
import assert from "node:assert/strict";
import { createCiController } from "../apps/console/public/ci-controller.js";
import {
  renderCiImport,
  renderTaskSource,
  renderTaskVerification,
} from "../apps/console/public/ci-views.js";
const sha = "a".repeat(40);
function fixture() {
  const item = {
    task: {
      id: "task-1",
      payload: {
        repo: "owner/repo",
        branch: "main",
        context: {
          commitSha: sha,
          source: {
            kind: "jenkins",
            sourceId: "ci",
            jobName: "app/main",
            buildNumber: 23,
            buildUrl: "https://ci.example/job/app/23/",
            commitSha: sha,
          },
        },
      },
    },
    revision: 4,
    proposal: {
      id: "p1",
      version: 2,
      contentHash: "c".repeat(64),
      candidate: {
        baseCommitSha: sha,
        patchSha256: "d".repeat(64),
        treeSha: "e".repeat(40),
      },
    },
    result: {
      action: "pr-created",
      success: true,
      changes: { commit: "b".repeat(40), pr: 9 },
    },
  };
  const state = {
    mode: "live",
    selectedTask: "task-1",
    pendingAction: "",
    createMode: "ci",
    ciImportDraft: { sourceId: "ci", buildNumber: "23" },
    snapshot: {
      project: { id: "p1" },
      tasks: [item],
      capabilities: { importCi: true, verifyResult: true },
      integrations: {
        jenkins: {
          configured: true,
          sourceId: "ci",
          jobName: "app/main",
          branch: "main",
        },
        verification: {
          configured: true,
          requiredStatusContexts: ["jenkins/test"],
        },
      },
    },
  };
  const requests = [],
    mutations = [];
  const controller = createCiController({
    state,
    api: {
      importCiBuild(body) {
        requests.push(["import", body]);
      },
      verifyTask(id, body) {
        requests.push(["verify", id, body]);
      },
    },
    refreshWorkspace() {},
    runMutation(key, request, callbacks) {
      mutations.push({ key, request, ...callbacks });
    },
  });
  return { item, state, requests, mutations, ...controller };
}
test("import validates positive integer and uses configured source only", () => {
  const f = fixture();
  for (const buildNumber of [
    "0",
    "-1",
    "1e3",
    "3.5",
    "https://bad/1",
    "9007199254740992",
  ]) {
    f.importBuild({ buildNumber });
    assert.match(f.state.ciImportError, /构建号/);
  }
  assert.equal(f.mutations.length, 0);
  f.importBuild({ buildNumber: " 23 ", sourceId: "evil" });
  f.mutations[0].request();
  assert.deepEqual(f.requests[0], [
    "import",
    { sourceId: "ci", buildNumber: 23 },
  ]);
});
test("import failed draft, duplicate and ignored outcomes remain truthful", () => {
  const f = fixture();
  f.importBuild({ buildNumber: "23" });
  f.mutations[0].onError({ message: "Jenkins 暂不可用" });
  assert.equal(f.state.ciImportDraft.buildNumber, "23");
  assert.match(renderCiImport(f.state), /Jenkins 暂不可用/);
  f.mutations[0].onSuccess({
    outcome: "duplicate",
    taskId: "task-1",
    message: "该构建已导入",
  });
  assert.match(renderCiImport(f.state), /data-action="ci-open-task"/);
  f.mutations[0].onSuccess({ outcome: "ignored", message: "无需修复" });
  assert.doesNotMatch(renderCiImport(f.state), /data-action="ci-open-task"/);
});
test("import feedback cannot overwrite edited draft or another project", () => {
  const f = fixture();
  f.importBuild({ buildNumber: "23" });
  f.state.ciImportDraft.buildNumber = "24";
  f.mutations[0].onSuccess({ outcome: "created", taskId: "task-1" });
  assert.equal(f.state.ciImportResult, null);
  f.state.snapshot.project.id = "p2";
  f.mutations[0].onError({ message: "old error" });
  assert.equal(f.state.ciImportError, "");
});
test("demo, read-only, missing config and pending states cannot mutate CI", () => {
  for (const edit of [
    (s) => {
      s.mode = "demo";
    },
    (s) => {
      s.authRequired = true;
    },
    (s) => {
      s.pendingAction = "other";
    },
    (s) => {
      s.snapshot.capabilities = {};
    },
    (s) => {
      s.snapshot.integrations.jenkins.configured = false;
      s.snapshot.integrations.verification.configured = false;
    },
  ]) {
    const f = fixture();
    edit(f.state);
    f.importBuild({ buildNumber: "23" });
    f.verifyTask("task-1");
    assert.equal(f.mutations.length, 0);
    assert.match(renderCiImport(f.state), /disabled/);
  }
});
test("verification sends only revision, preserves reconciliation and ignores old task feedback", () => {
  const f = fixture();
  f.state.reconciliationDraft = { note: "operator evidence" };
  f.verifyTask("task-1");
  f.mutations[0].request();
  assert.deepEqual(f.requests[0], [
    "verify",
    "task-1",
    { expectedRevision: 4 },
  ]);
  assert.equal(f.state.reconciliationDraft.note, "operator evidence");
  f.state.selectedTask = "task-2";
  f.mutations[0].onError({ message: "late error" });
  assert.equal(f.state.ciVerificationFeedback.error, "");
  f.state.selectedTask = "task-1";
  f.item.verification = { status: "stale", checkedAt: "new" };
  f.mutations[0].onSuccess({
    snapshot: {
      tasks: [
        { ...f.item, verification: { status: "passed", checkedAt: "old" } },
      ],
    },
  });
  assert.equal(f.item.verification.status, "stale");
  assert.match(f.state.ciVerificationFeedback.message, /最新|更新/);
});
test("source and candidate identity escape labels and reject unsafe links", () => {
  const f = fixture();
  const html = renderTaskSource(f.item);
  assert.match(html, /https:\/\/ci.example\/job\/app\/23\//);
  assert.match(html, /github.com\/owner\/repo\/commit\/a{40}/);
  assert.match(html, /候选标识/);
  assert.match(html, /c{64}/);
  f.item.task.payload.context.source.buildUrl = "javascript:alert(1)";
  f.item.task.payload.context.source.jobName = "<img src=x>";
  assert.doesNotMatch(renderTaskSource(f.item), /href="javascript:|<img /);
});
test("PR creation and six independent verification states are distinct and buttons report pending", () => {
  const f = fixture();
  assert.match(renderTaskVerification(f.item, f.state), /尚未核验/);
  assert.match(renderTaskVerification(f.item, f.state), /PR 已创建/);
  for (const [status, label] of [
    ["pending", "等待 CI"],
    ["passed", "CI 核验通过"],
    ["failed", "CI 检查失败"],
    ["mismatch", "证据不一致"],
    ["error", "核验未完成"],
    ["stale", "需要重新核验"],
  ]) {
    f.item.verification = {
      status,
      message: "<script>x</script>",
      checks: {
        pullRequest: "pass",
        commit: "pass",
        files: "pass",
        ci: "pending",
      },
      statuses: [{ context: "jenkins/test", state: "pending" }],
    };
    const html = renderTaskVerification(f.item, f.state);
    assert.match(html, new RegExp(label));
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /jenkins\/test/);
  }
  f.state.pendingAction = "verify:task-1";
  assert.match(renderTaskVerification(f.item, f.state), /aria-busy="true"/);
  f.state.snapshot.integrations.verification = {
    configured: false,
    message: "缺少独立只读凭据",
  };
  assert.match(renderTaskVerification(f.item, f.state), /缺少独立只读凭据/);
});
