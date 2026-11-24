import test from "node:test";
import assert from "node:assert/strict";
const load = () =>
  import("../apps/healing-hub/src/github-verification.mjs").catch(() => ({}));
const id = "01234567-89ab-cdef-0123-456789abcdef",
  base = "a".repeat(40),
  head = "b".repeat(40),
  tree = "c".repeat(40);
const input = {
  task: {
    id,
    payload: {
      repo: "owner/repo",
      branch: "main",
      context: { commitSha: base },
    },
  },
  proposal: {
    id: "proposal",
    contentHash: "hash",
    candidate: { baseCommitSha: base, treeSha: tree },
  },
  diff: [{ path: "src/a.js" }],
  result: { changes: { pr: 7, commit: head } },
  policy: {
    requiredStatusContexts: ["tests"],
    trustedStatusCreators: ["ci[bot]"],
    policyHash: "policy",
  },
};
function responses() {
  return [
    {
      number: 7,
      state: "open",
      merged: false,
      changed_files: 1,
      base: { sha: base, ref: "main", repo: { full_name: "owner/repo" } },
      head: { sha: head, ref: `heal/${id}`, repo: { full_name: "owner/repo" } },
    },
    { sha: head, parents: [{ sha: base }], commit: { tree: { sha: tree } } },
    [{ filename: "src/a.js", status: "modified" }],
    [
      {
        id: 1,
        context: "tests",
        state: "success",
        updated_at: "2026-01-01T00:00:00Z",
        creator: { login: "ci[bot]" },
      },
    ],
  ];
}
async function run(mutate = () => {}, options = {}) {
  const m = await load();
  assert.equal(typeof m.createGithubVerifier, "function");
  const data = responses();
  mutate(data);
  let count = 0;
  return m
    .createGithubVerifier(
      { enabled: true, tokenEnv: "TOKEN" },
      {
        env: { TOKEN: "secret" },
        fetchImpl: async (u, o) => {
          assert.equal(o.headers["X-GitHub-Api-Version"], "2026-03-10");
          assert.equal(o.method, "GET");
          const n = count++;
          return Response.json(
            data[n === 4 ? 0 : n],
            options.headers ? { headers: options.headers(n) } : {},
          );
        },
        ...options,
      },
    )
    .verify(input);
}
test("proves PR, unique parent/tree, complete files, trusted exact-head status and rereads PR", async () => {
  assert.equal((await run()).status, "passed");
});
test("remote identity, incomplete files and untrusted or ambiguous status cannot pass", async () => {
  for (const mutate of [
    (d) => (d[0].head.repo.full_name = "other/repo"),
    (d) => d[1].parents.push({ sha: head }),
    (d) => (d[0].changed_files = 2),
    (d) => (d[2][0].filename = "other.js"),
    (d) => (d[3][0].creator.login = "attacker"),
    (d) => d[3].push({ ...d[3][0], state: "failure" }),
  ])
    assert.equal((await run(mutate)).status, "mismatch");
  assert.equal((await run((d) => (d[3] = []))).status, "pending");
  assert.equal(
    (await run((d) => (d[3][0].state = "failure"))).status,
    "failed",
  );
});
test("pagination rejects cross-origin, skipped pages and missing next despite last", async () => {
  for (const link of [
    '<https://evil.example/files?page=2>; rel="next"',
    `<https://api.github.com/repos/owner/repo/commits/${head}/statuses?per_page=100&page=3>; rel="next"`,
    `<https://api.github.com/repos/owner/repo/commits/${head}/statuses?per_page=100&page=2>; rel="last"`,
  ])
    assert.equal(
      (await run(() => {}, { headers: (n) => (n === 3 ? { Link: link } : {}) }))
        .status,
      "error",
    );
});
test("all status pages consumed and largest immutable status ID wins despite response ordering", async () => {
  const m = await load();
  assert.equal(typeof m.createGithubVerifier, "function");
  const data = responses();
  let statusPages = 0;
  const fetchImpl = async (url) => {
    if (url.includes("/files?")) return Response.json(data[2]);
    if (url.includes("/statuses?")) {
      statusPages++;
      return statusPages === 1
        ? Response.json([{ ...data[3][0], id: 1, state: "failure" }], {
            headers: {
              Link: `<https://api.github.com/repos/owner/repo/commits/${head}/statuses?per_page=100&page=2>; rel="next"`,
            },
          })
        : Response.json([
            { ...data[3][0], id: 3 },
            { ...data[3][0], id: 2, state: "failure" },
          ]);
    }
    return Response.json(url.includes("/commits/") ? data[1] : data[0]);
  };
  const result = await m
    .createGithubVerifier(
      { enabled: true, tokenEnv: "TOKEN" },
      { env: { TOKEN: "secret" }, fetchImpl },
    )
    .verify(input);
  assert.equal(result.status, "passed");
  assert.equal(result.statuses[0].id, 3);
  assert.equal(statusPages, 2);
});
test("moving heads, empty policy, timeout, redirects and bounded request count fail closed", async () => {
  const m = await load();
  assert.equal(typeof m.createGithubVerifier, "function");
  const data = responses();
  let calls = 0;
  const factory = (fetchImpl, options = {}) =>
    m.createGithubVerifier(
      { enabled: true, tokenEnv: "TOKEN" },
      { env: { TOKEN: "secret" }, fetchImpl, ...options },
    );
  assert.equal(
    (
      await factory(async () =>
        Response.json(
          ++calls === 5
            ? { ...data[0], head: { ...data[0].head, sha: base } }
            : data[calls - 1],
        ),
      ).verify(input)
    ).status,
    "mismatch",
  );
  assert.equal(
    (
      await factory(() => new Promise(() => {}), { timeoutMs: 10 }).verify(
        input,
      )
    ).status,
    "error",
  );
  assert.equal(
    (
      await factory(async () => {
        throw Error("secret");
      }).verify({
        ...input,
        policy: { ...input.policy, requiredStatusContexts: [] },
      })
    ).status,
    "error",
  );
  const error = await factory(async () => {
    throw Error("secret");
  }).verify(input);
  assert.equal(error.status, "error");
  assert.equal(JSON.stringify(error).includes("secret"), false);
  calls = 0;
  const budget = factory(async (url) => {
    calls++;
    if (url.includes("/statuses?")) {
      const page = Number(new URL(url).searchParams.get("page") ?? 1);
      return Response.json([], {
        headers: {
          Link: `<https://api.github.com/repos/owner/repo/commits/${head}/statuses?per_page=100&page=${page + 1}>; rel="next"`,
        },
      });
    }
    return Response.json(
      url.includes("/files?")
        ? data[2]
        : url.includes("/commits/")
          ? data[1]
          : data[0],
    );
  });
  assert.equal((await budget.verify(input)).status, "error");
  assert.equal(calls, 8);
  const redirect = factory(async () => {
    const response = Response.json(data[0]);
    Object.defineProperty(response, "redirected", { value: true });
    return response;
  });
  assert.equal((await redirect.verify(input)).status, "error");
});

async function announcedThreePages(secondLink) {
  const { createGithubVerifier } = await load();
  const data = responses();
  const statusPages = [];
  let requests = 0;
  const link = (page, relation) =>
    `<https://api.github.com/repos/owner/repo/commits/${head}/statuses?per_page=100&page=${page}>; rel="${relation}"`;
  const result = await createGithubVerifier(
    { enabled: true, tokenEnv: "TOKEN" },
    {
      env: { TOKEN: "secret" },
      fetchImpl: async (url) => {
        requests++;
        if (url.includes("/statuses?")) {
          const page = Number(new URL(url).searchParams.get("page") ?? 1);
          statusPages.push(page);
          const header =
            page === 1
              ? `${link(2, "next")}, ${link(3, "last")}`
              : page === 2
                ? secondLink(link)
                : link(2, "prev");
          return Response.json(
            page === 1 ? data[3] : [],
            header ? { headers: { Link: header } } : {},
          );
        }
        return Response.json(
          url.includes("/files?")
            ? data[2]
            : url.includes("/commits/")
              ? data[1]
              : data[0],
        );
      },
    },
  ).verify(input);
  return { result, statusPages, requests };
}
for (const [label, secondLink] of [
  ["missing Link", () => null],
  ["prev-only Link", (link) => link(1, "prev")],
]) {
  test(`announced last page survives ${label} on an intermediate response`, async () => {
    const { result, statusPages } = await announcedThreePages(secondLink);
    assert.equal(result.status, "error");
    assert.deepEqual(statusPages, [1, 2]);
  });
}
test("complete announced three-page walk succeeds within eight-request budget", async () => {
  const { result, statusPages, requests } = await announcedThreePages(
    (link) => `${link(1, "prev")}, ${link(3, "next")}, ${link(3, "last")}`,
  );
  assert.equal(result.status, "passed");
  assert.deepEqual(statusPages, [1, 2, 3]);
  assert.equal(requests, 7);
});
test("announced final-page boundary rejects conflicting later metadata", async () => {
  for (const secondLink of [
    (link) => `${link(1, "prev")}, ${link(2, "last")}`,
    (link) => `${link(3, "next")}, ${link(4, "last")}`,
    (link) => `${link(3, "next")}, ${link(3, "last")}, ${link(4, "last")}`,
  ]) {
    const { result } = await announcedThreePages(secondLink);
    assert.equal(result.status, "error");
  }
});
