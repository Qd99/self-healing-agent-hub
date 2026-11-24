import test from "node:test";
import assert from "node:assert/strict";
import { createGitHubPublisher } from "../apps/healing-worker/src/github-publisher.mjs";
import {
  claim,
  candidate,
  config,
  base,
  tree,
  commit,
} from "./fixtures/worker/fixture.mjs";
function setup({
  ambiguous = false,
  moved = false,
  conflicting = false,
  lostRef = false,
  unknownPost = false,
} = {}) {
  const c = claim("execute");
  c.task.proposal = {
    id: "proposal-1",
    contentHash: "d".repeat(64),
    candidate: candidate(),
    version: 2,
  };
  const cfg = config();
  cfg.publish.enabled = true;
  let ref = conflicting,
    pr = false;
  const calls = [],
    events = [];
  const marker = `Healing task: ${c.task.task.id}\nProposal: proposal-1\nContent hash: ${"d".repeat(64)}`;
  const branch = `heal/${c.task.task.id}`;
  const prValue = {
    number: 7,
    state: "open",
    merged: false,
    draft: true,
    body: marker,
    head: { sha: commit, ref: branch, repo: { full_name: "acme/project" } },
    base: { ref: "main", sha: base, repo: { full_name: "acme/project" } },
  };
  const fetchImpl = async (url, opt) => {
    const path = new URL(url).pathname;
    calls.push([opt.method, path, opt.body && JSON.parse(opt.body)]);
    assert.equal(opt.headers["X-GitHub-Api-Version"], "2026-03-10");
    assert.equal(opt.redirect, "error");
    let data,
      status = 200;
    if (opt.method === "POST") {
      assert.equal(events.at(-1)?.intent?.path, path);
      if (unknownPost) throw Error("uncertain mutation");
      if (path.endsWith("/git/trees")) data = { sha: tree };
      else if (path.endsWith("/git/commits")) data = { sha: commit };
      else if (path.endsWith("/git/refs")) {
        ref = true;
        if (lostRef) throw Error("reference response lost");
        data = { object: { sha: commit } };
      } else if (path.endsWith("/pulls")) {
        pr = true;
        if (ambiguous) throw Error("response lost");
        data = prValue;
      } else throw Error("unexpected mutation");
    } else if (path.endsWith("/git/ref/heads/main"))
      data = { object: { sha: moved ? tree : base } };
    else if (path.includes("/git/ref/heads/heal/")) {
      data = ref ? { object: { sha: commit } } : {};
      status = ref ? 200 : 404;
    } else if (path.endsWith(`/git/commits/${base}`))
      data = { sha: base, tree: { sha: "e".repeat(40) } };
    else if (path.endsWith(`/git/commits/${commit}`))
      data = {
        sha: commit,
        tree: { sha: tree },
        parents: [{ sha: conflicting ? tree : base }],
        message: marker,
      };
    else if (path.endsWith("/pulls")) data = pr ? [prValue] : [];
    else throw Error(`unexpected read ${path}`);
    return new Response(JSON.stringify(data), { status });
  };
  return {
    c,
    cfg,
    calls,
    events,
    publisher: createGitHubPublisher(cfg, { fetchImpl }),
    args: {
      claim: c,
      prepared: {
        candidate: candidate(),
        files: [{ path: "a.js", mode: "100644", content: "good" }],
      },
      summary: "Repair",
      assertActive: () => {},
      onProgress: async (e) => events.push(e),
    },
  };
}
test("publisher persists intent, creates approved tree/single parent and draft PR, and reuses exact branch", async () => {
  const s = setup();
  const facts = await s.publisher.publish(s.args);
  assert.deepEqual(facts, { commit, pr: 7, files: ["a.js"] });
  const writes = s.calls.filter((x) => x[0] === "POST");
  assert.equal(writes.length, 4);
  assert.deepEqual(
    writes.find((x) => x[1].endsWith("/git/commits"))[2].parents,
    [base],
  );
  assert.equal(writes.find((x) => x[1].endsWith("/git/commits"))[2].tree, tree);
  assert.equal(writes.at(-1)[2].draft, true);
  await s.publisher.publish(s.args);
  assert.equal(s.calls.filter((x) => x[0] === "POST").length, 4);
  assert.equal(
    s.calls.some((x) => ["PATCH", "PUT", "DELETE"].includes(x[0])),
    false,
  );
});
test("ambiguous PR POST recovers by reading without a second POST", async () => {
  const s = setup({ ambiguous: true });
  assert.equal((await s.publisher.publish(s.args)).pr, 7);
  assert.equal(
    s.calls.filter((x) => x[0] === "POST" && x[1].endsWith("/pulls")).length,
    1,
  );
});
test("moved base, disabled publishing, stopped lease and failed journal prevent every write", async () => {
  for (const mode of ["moved", "disabled", "cancel", "journal"]) {
    const s = setup({ moved: mode === "moved" });
    if (mode === "disabled") s.cfg.publish.enabled = false;
    if (mode === "cancel")
      s.args.assertActive = () => {
        throw Error("inactive");
      };
    if (mode === "journal")
      s.args.onProgress = () => {
        throw Error("disk");
      };
    await assert.rejects(s.publisher.publish(s.args));
    assert.equal(s.calls.filter((x) => x[0] === "POST").length, 0);
  }
});
test("recovery is read-only and disabled publishing still supports base reads", async () => {
  const s = setup();
  s.cfg.publish.enabled = false;
  assert.equal(
    await s.publisher.readBase({ repo: "acme/project", branch: "main" }),
    base,
  );
  await s.publisher.recover({
    claim: s.c,
    known: { intent: { operation: "create-pr" } },
  });
  assert.equal(s.calls.filter((x) => x[0] !== "GET").length, 0);
});
test("a conflicting deterministic branch is never changed or reused", async () => {
  const s = setup({ conflicting: true });
  await assert.rejects(s.publisher.publish(s.args), /does not match/);
  assert.equal(s.calls.filter((x) => x[0] !== "GET").length, 0);
});
test("ambiguous branch POST verifies exact commit before creating one PR", async () => {
  const s = setup({ lostRef: true });
  assert.equal((await s.publisher.publish(s.args)).pr, 7);
  assert.equal(
    s.calls.filter((x) => x[0] === "POST" && x[1].endsWith("/git/refs")).length,
    1,
  );
});
test("unknown mutation outcome stops, persists uncertainty and never retries POST", async () => {
  const s = setup({ unknownPost: true });
  await assert.rejects(s.publisher.publish(s.args));
  assert.equal(s.calls.filter((x) => x[0] === "POST").length, 1);
  assert.equal(s.events.at(-1).uncertain, true);
});
test("lease stop after first POST prevents every later mutation", async () => {
  const s = setup();
  s.args.assertActive = () => {
    if (s.calls.some((x) => x[0] === "POST")) throw Error("lease stopped");
  };
  await assert.rejects(s.publisher.publish(s.args));
  assert.equal(s.calls.filter((x) => x[0] === "POST").length, 1);
});
