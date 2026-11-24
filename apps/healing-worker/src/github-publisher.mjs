import { isDeepStrictEqual as same } from "node:util";
import { repairBranchFor } from "../../../packages/framework/src/candidate.mjs";
import { boundedJson } from "./hub-client.mjs";
const validSha = (value) => {
  if (!/^[a-f0-9]{40}$/.test(value ?? ""))
    throw Error("Invalid GitHub object identity");
  return value;
};
export function createGitHubPublisher(config, { fetchImpl = fetch } = {}) {
  const repoPath = `/repos/${config.repository.fullName.split("/").map(encodeURIComponent).join("/")}`;
  function scope(repo, branch) {
    if (
      repo !== config.repository.fullName ||
      branch !== config.repository.branch
    )
      throw Error("Repository scope mismatch");
    if (!config.github.token) throw Error("GitHub credential missing");
  }
  async function request(
    method,
    path,
    body,
    { signal, allow404 = false } = {},
  ) {
    const timeout = AbortSignal.timeout(30000);
    let response;
    try {
      response = await fetchImpl(`https://api.github.com${path}`, {
        method,
        redirect: "error",
        headers: {
          Authorization: `Bearer ${config.github.token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2026-03-10",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
    } catch {
      const error = Error("GitHub request outcome uncertain");
      error.uncertain = method === "POST";
      throw error;
    }
    if (allow404 && response.status === 404) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const error = Error(`GitHub request rejected (${response.status})`);
      error.status = response.status;
      error.uncertain = method === "POST" && response.status >= 500;
      throw error;
    }
    return boundedJson(response);
  }
  async function readBase({ repo, branch, signal }) {
    scope(repo, branch);
    const result = await request(
      "GET",
      `${repoPath}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`,
      undefined,
      { signal },
    );
    return validSha(result?.object?.sha);
  }
  function details(claim) {
    const task = claim.task.task,
      proposal = claim.task.proposal;
    scope(task.payload.repo, task.payload.branch);
    if (
      claim.lease.phase !== "execute" ||
      proposal?.version !== 2 ||
      proposal.candidate?.baseCommitSha !== task.payload.context.commitSha
    )
      throw Error("Invalid approved execution");
    validSha(proposal.candidate.baseCommitSha);
    validSha(proposal.candidate.treeSha);
    return {
      branch: repairBranchFor(task.id),
      base: proposal.candidate.baseCommitSha,
      tree: proposal.candidate.treeSha,
      marker: `Healing task: ${task.id}\nProposal: ${proposal.id}\nContent hash: ${proposal.contentHash}`,
    };
  }
  async function branchCommit(d, signal) {
    const ref = await request(
      "GET",
      `${repoPath}/git/ref/heads/${d.branch}`,
      undefined,
      { signal, allow404: true },
    );
    if (!ref) return null;
    const sha = validSha(ref.object?.sha);
    const obj = await request(
      "GET",
      `${repoPath}/git/commits/${sha}`,
      undefined,
      { signal },
    );
    if (
      obj.sha !== sha ||
      obj.tree?.sha !== d.tree ||
      obj.parents?.length !== 1 ||
      obj.parents[0].sha !== d.base ||
      !obj.message?.endsWith(d.marker)
    )
      throw Error("Existing repair branch does not match approval");
    return sha;
  }
  function verifyPr(pr, d, sha) {
    if (
      !Number.isSafeInteger(pr?.number) ||
      pr.number < 1 ||
      !pr.draft ||
      pr.state !== "open" ||
      pr.merged === true ||
      pr.head?.sha !== sha ||
      pr.head?.ref !== d.branch ||
      pr.head?.repo?.full_name !== config.repository.fullName ||
      pr.base?.ref !== config.repository.branch ||
      pr.base?.sha !== d.base ||
      pr.base?.repo?.full_name !== config.repository.fullName ||
      !pr.body?.endsWith(d.marker)
    )
      throw Error("Existing PR does not match approval");
    return pr.number;
  }
  async function findPr(d, sha, signal) {
    const owner = config.repository.fullName.split("/")[0];
    const list = await request(
      "GET",
      `${repoPath}/pulls?state=all&head=${encodeURIComponent(`${owner}:${d.branch}`)}&base=${encodeURIComponent(config.repository.branch)}&per_page=100`,
      undefined,
      { signal },
    );
    if (!Array.isArray(list) || list.length >= 100 || list.length > 1)
      throw Error("Ambiguous repair pull requests");
    return list.length ? verifyPr(list[0], d, sha) : null;
  }
  async function recover({ claim, known = {}, signal }) {
    const d = details(claim);
    const sha = await branchCommit(d, signal);
    if (!sha)
      return { ...known, uncertain: Boolean(known.intent || known.uncertain) };
    const pr = await findPr(d, sha, signal);
    return { ...known, commit: sha, ...(pr ? { pr } : {}), uncertain: !pr };
  }
  async function publish({
    claim,
    prepared,
    summary,
    onProgress,
    assertActive,
    signal,
  }) {
    if (!config.publish.enabled) throw Error("GitHub publication disabled");
    const d = details(claim);
    if (!same(prepared.candidate, claim.task.proposal.candidate))
      throw Error("Prepared manifest mismatch");
    if (
      !Array.isArray(prepared.files) ||
      !prepared.files.length ||
      prepared.files.length > 100
    )
      throw Error("Invalid publication files");
    const seen = new Set();
    let bytes = 0;
    for (const f of prepared.files) {
      if (
        typeof f.path !== "string" ||
        f.path.startsWith("/") ||
        f.path.includes("\\") ||
        f.path
          .split("/")
          .some(
            (p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git",
          ) ||
        seen.has(f.path) ||
        !["100644", "100755"].includes(f.mode) ||
        (f.content !== null && typeof f.content !== "string")
      )
        throw Error("Unsafe publication file");
      seen.add(f.path);
      bytes += Buffer.byteLength(f.content ?? "");
    }
    if (bytes > 512 * 1024) throw Error("Publication exceeds limit");
    const files = prepared.files.map((f) => f.path);
    let sha,
      pr,
      firstWrite = true;
    const write = async (path, body, confirm) => {
      if (firstWrite) {
        assertActive();
        if (
          (await readBase({
            repo: config.repository.fullName,
            branch: config.repository.branch,
            signal,
          })) !== d.base
        )
          throw Error("Base branch moved");
        firstWrite = false;
      }
      await onProgress({
        intent: {
          method: "POST",
          path,
          branch: d.branch,
          base: d.base,
          tree: d.tree,
        },
      });
      assertActive();
      try {
        return await request("POST", path, body, { signal });
      } catch (error) {
        await onProgress({ uncertain: true });
        if (confirm) {
          const confirmed = await confirm();
          if (confirmed) return confirmed;
        }
        throw error;
      }
    };
    assertActive();
    if (
      (await readBase({
        repo: config.repository.fullName,
        branch: config.repository.branch,
        signal,
      })) !== d.base
    )
      throw Error("Base branch moved");
    assertActive();
    sha = await branchCommit(d, signal);
    if (sha) {
      pr = await findPr(d, sha, signal);
      await onProgress({ commit: sha, files, ...(pr ? { pr } : {}) });
      if (pr) return { commit: sha, pr, files };
    } else {
      const parent = await request(
        "GET",
        `${repoPath}/git/commits/${d.base}`,
        undefined,
        { signal },
      );
      validSha(parent?.tree?.sha);
      assertActive();
      const createdTree = await write(`${repoPath}/git/trees`, {
        base_tree: parent.tree.sha,
        tree: prepared.files.map((f) => ({
          path: f.path,
          mode: f.mode,
          type: "blob",
          ...(f.content === null ? { sha: null } : { content: f.content }),
        })),
      });
      if (createdTree?.sha !== d.tree)
        throw Error("Published tree differs from approved tree");
      await onProgress({ tree: d.tree });
      const createdCommit = await write(`${repoPath}/git/commits`, {
        message: `${summary.slice(0, 1000)}\n\n${d.marker}`,
        tree: d.tree,
        parents: [d.base],
      });
      sha = validSha(createdCommit?.sha);
      await onProgress({ commit: sha, files });
      const ref = await write(
        `${repoPath}/git/refs`,
        { ref: `refs/heads/${d.branch}`, sha },
        async () => {
          const existing = await branchCommit(d);
          return existing === sha ? { object: { sha: existing } } : null;
        },
      );
      if (ref?.object?.sha !== sha) throw Error("Repair branch mismatch");
      await onProgress({ branch: d.branch, commit: sha });
    }
    assertActive();
    const created = await write(
      `${repoPath}/pulls`,
      {
        title: `[healing] ${summary.slice(0, 150)}`,
        head: d.branch,
        base: config.repository.branch,
        draft: true,
        body: `Automated repair candidate awaiting review. CI results are tracked separately.\n\n${d.marker}`,
      },
      async () => {
        const found = await findPr(d, sha);
        return found ? { recoveredNumber: found } : null;
      },
    );
    pr = created.recoveredNumber ?? verifyPr(created, d, sha);
    await onProgress({ commit: sha, pr, files, uncertain: false });
    return { commit: sha, pr, files };
  }
  return { readBase, publish, recover };
}
