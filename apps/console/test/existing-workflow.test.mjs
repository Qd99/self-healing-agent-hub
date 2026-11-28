import test from "node:test";
import assert from "node:assert/strict";
import { mountConsole } from "../public/v20/app/main.js";
import { createV20Hub } from "../../../tests/helpers/v20-hub.mjs";
import { createV20Client } from "../public/v20/api/client.js";
import { memoryStorage } from "./helpers/snapshot.mjs";

function harness() {
  const listeners = () => {
    const events = new Map();
    return {
      events,
      addEventListener(type, fn) {
        events.set(type, fn);
      },
      removeEventListener(type) {
        events.delete(type);
      },
      fire(type, target, extra = {}) {
        return events.get(type)?.({ target, preventDefault() {}, ...extra });
      },
    };
  };
  const doc = {
    activeElement: null,
    documentElement: { dataset: {} },
    getElementById: () => null,
  };
  const root = {
    ...listeners(),
    innerHTML: "",
    ownerDocument: doc,
    contains: () => false,
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  const dialog = {
    ...listeners(),
    innerHTML: "",
    open: false,
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
      this.fire("close", this);
    },
  };
  const host = {
    ...listeners(),
    location: { hash: "#overview" },
    localStorage: memoryStorage(),
    matchMedia: () => ({ matches: false }),
    confirm: () => true,
    history: {
      replaceState(_s, _t, url) {
        host.location.hash = url;
      },
    },
  };
  return { root, dialog, host };
}

function live(hub) {
  let cookie;
  return createV20Client({
    fetch: async (path, init) => {
      const headers = new Headers(init.headers);
      headers.set("Origin", hub.base);
      if (cookie) headers.set("Cookie", cookie);
      const response = await fetch(hub.base + path, { ...init, headers });
      const next = response.headers.get("set-cookie");
      if (next) cookie = next.split(";")[0];
      return response;
    },
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function settle(root, marker, ms = 2500) {
  for (let end = Date.now() + ms; Date.now() < end;) {
    if (root.innerHTML.includes(marker)) return true;
    await sleep(20);
  }
  return root.innerHTML.includes(marker);
}

test("V20 renders real candidate evidence and uses the existing two approval gates, cancel and retry", async (t) => {
  const { root, dialog, host } = harness();
  const hub = await createV20Hub(t, {
    integrationsEnv: { HUB_GITHUB_READ_ENABLED: "0" },
  });
  const api = live(hub);
  await api.login(hub.token);
  const app = mountConsole({
    root,
    detailDialog: dialog,
    host,
    api,
    storage: memoryStorage(),
  });
  t.after(() => app.dispose());
  await app.ready;
  // Create a real isolated task; no Worker process is started.
  host.location.hash = "#tasks";
  await host.fire("hashchange");
  assert.ok(await settle(root, "当前快照 ·"));
  dialog.innerHTML = "";
  dialog.open = false;
  const created = await api.mutateExisting("taskCreate", {
    body: {
      title: "审批贯通任务",
      type: "lint-error",
      priority: "high",
      branch: "main",
      description: "对齐服务端审批用例",
    },
  });
  const taskId = created.taskId;
  // A worker proposes a candidate so the server-side approval gates unlock.
  const claim = await hub.request("/api/healing/worker/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${hub.workerToken}` },
    body: { engineId: "fast", workerId: "probe-worker" },
  });
  assert.equal(claim.status, 200);
  const proposal = await hub.request(
    `/api/healing/worker/tasks/${taskId}/proposal`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${hub.workerToken}` },
      body: {
        leaseId: (await claim.json()).lease.id,
        summary: "移除未使用的导入",
        diff: [
          {
            path: "src/app.js",
            additions: 0,
            deletions: 1,
            lines: [
              { type: "remove", content: "import unused from 'unused';" },
            ],
          },
        ],
        evidence: {
          beforeState: "lint 报告一个未使用导入",
          afterState: "候选工作区 lint 通过",
          testsRun: ["npm run typecheck", "npm run lint", "npm run test"],
          checksPass: ["npm run typecheck", "npm run lint", "npm run test"],
          checksFail: [],
        },
      },
    },
  );
  assert.equal(proposal.status, 200, await proposal.text());
  // Open the task detail and drive both real approval gates from V20.
  host.location.hash = `#tasks?task=${encodeURIComponent(taskId)}`;
  await host.fire("hashchange");
  await root.fire("click", {
    closest: () => ({ dataset: { action: "refresh" } }),
  });
  assert.ok(
    dialog.innerHTML.includes("代码审阅"),
    "approval panel did not render",
  );
  assert.ok(
    dialog.innerHTML.includes("src/app.js"),
    "candidate diff did not render",
  );
  const initial = (await api.read()).tasks.find((x) => x.task.id === taskId);
  await assert.rejects(
    api.mutateExisting("approvalDecide", {
      id: taskId,
      body: {
        expectedRevision: initial.revision,
        round: initial.approvalFlow.round,
        nodeId: "execution-auth",
        decision: "approve",
      },
    }),
    { status: 409 },
  );
  for (const nodeId of ["code-review", "execution-auth"]) {
    const snap = await api.read();
    const item = snap.tasks.find((x) => x.task.id === taskId);
    await api.mutateExisting("approvalDecide", {
      id: taskId,
      body: {
        expectedRevision: item.revision,
        round: item.approvalFlow.round,
        nodeId,
        decision: "approve",
        comment: "已核对证据",
      },
    });
  }
  const after = await api.read();
  const approved = after.tasks.find((x) => x.task.id === taskId);
  assert.equal(approved.reviewState, "approved");
  assert.equal(approved.execution.phase, "execute");
  // Reconciliation is only offered after a failure with side effects; retry works after cancel.
  await api.mutateExisting("taskCancel", {
    id: taskId,
    body: { expectedRevision: approved.revision },
  });
  const ended = await api.read();
  const cancelledTask = ended.tasks.find((x) => x.task.id === taskId);
  assert.equal(cancelledTask.status.status, "cancelled");
  const retry = await api.mutateExisting("taskRetry", {
    id: taskId,
    body: { expectedRevision: cancelledTask.revision },
  });
  assert.equal(
    retry.snapshot.tasks.find((x) => x.task.id === retry.taskId).task.payload
      .context.retryOf,
    taskId,
  );
  app.dispose();
});
