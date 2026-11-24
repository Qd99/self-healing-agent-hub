import { createHash } from "node:crypto";
import { repairBranchFor } from "../../../packages/framework/src/candidate.mjs";
import { createJsonReader, upstreamError } from "./bounded-json.mjs";
export function normalizeVerificationPolicy(config) {
  const contexts = config?.requiredStatusContexts,
    creators = config?.trustedStatusCreators;
  if (
    !Array.isArray(contexts) ||
    !contexts.length ||
    contexts.length > 100 ||
    new Set(contexts).size !== contexts.length ||
    contexts.some(
      (x) =>
        typeof x !== "string" ||
        !x.trim() ||
        x !== x.trim() ||
        x.length > 200 ||
        /[\r\n\0]/.test(x),
    )
  )
    return null;
  if (
    !Array.isArray(creators) ||
    !creators.length ||
    creators.length > 100 ||
    new Set(creators).size !== creators.length ||
    creators.some(
      (x) =>
        typeof x !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9-]*(?:\[bot\])?$/.test(x),
    )
  )
    return null;
  const policy = {
    requiredStatusContexts: [...contexts].sort(),
    trustedStatusCreators: [...creators].sort(),
  };
  return {
    ...policy,
    policyHash: createHash("sha256")
      .update(JSON.stringify(policy))
      .digest("hex"),
  };
}
export function verificationTarget({ task, proposal, result, policy }) {
  return {
    proposalId: proposal.id,
    proposalHash: proposal.contentHash,
    repo: task.payload.repo,
    prNumber: result.changes.pr,
    baseCommitSha: proposal.candidate.baseCommitSha,
    headCommitSha: result.changes.commit,
    expectedTreeSha: proposal.candidate.treeSha,
    policyHash: policy.policyHash,
  };
}
export function createGithubVerifier(
  config,
  {
    fetchImpl = globalThis.fetch,
    env = process.env,
    clock = () => new Date(),
    timeoutMs,
  } = {},
) {
  return {
    async verify(input) {
      const target = verificationTarget(input),
        checks = {
          pullRequest: "unknown",
          commit: "unknown",
          files: "unknown",
          ci: "unknown",
        },
        statuses = [];
      const finish = (status, message) => ({
        schemaVersion: 1,
        provider: "github",
        status,
        checkedAt: new Date(clock()).toISOString(),
        message,
        target,
        checks,
        statuses,
      });
      if (
        config?.enabled !== true ||
        !env[config.tokenEnv] ||
        !normalizeVerificationPolicy(input.policy)
      )
        return finish("error", "独立核验策略或读取凭据未配置。");
      const reader = createJsonReader({
        fetchImpl,
        origin: "https://api.github.com",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${env[config.tokenEnv]}`,
          "X-GitHub-Api-Version": "2026-03-10",
        },
        timeoutMs,
      });
      const root = `https://api.github.com/repos/${target.repo}`,
        prUrl = `${root}/pulls/${target.prNumber}`;
      const mismatch = (check) => {
        checks[check] = "fail";
        return finish("mismatch", "远端事实与批准候选或可信 CI 策略不一致。");
      };
      function identity(pr) {
        return (
          pr.number === target.prNumber &&
          pr.state === "open" &&
          pr.merged === false &&
          pr.base?.repo?.full_name === target.repo &&
          pr.head?.repo?.full_name === target.repo &&
          pr.base?.sha === target.baseCommitSha &&
          pr.head?.sha === target.headCommitSha &&
          pr.base?.ref === input.task.payload.branch &&
          pr.head?.ref === repairBranchFor(input.task.id)
        );
      }
      async function pages(url) {
        const all = [],
          seen = new Set();
        let next = url;
        // Keep completeness evidence from earlier pages, even if later headers
        // omit rel=last (or omit Link entirely).
        let lastPage = null;
        const expected = new URL(url);
        while (next) {
          if (seen.has(next)) throw upstreamError();
          seen.add(next);
          const currentPage = Number(
            new URL(next).searchParams.get("page") ?? 1,
          );
          const { data, link } = await reader.get(next);
          if (!Array.isArray(data)) throw upstreamError();
          all.push(...data);
          next = null;
          if (link) {
            for (const part of link.split(",")) {
              const match = /^\s*<([^>]+)>;\s*rel="([^"]+)"\s*$/.exec(part);
              if (!match) throw upstreamError();
              const u = new URL(match[1]);
              if (
                u.origin !== expected.origin ||
                u.pathname !== expected.pathname ||
                u.username ||
                u.password
              )
                throw upstreamError();
              const page = Number(u.searchParams.get("page"));
              if (
                !Number.isSafeInteger(page) ||
                page < 1 ||
                u.searchParams.get("per_page") !== "100" ||
                [...u.searchParams.keys()].some(
                  (k) => !["page", "per_page"].includes(k),
                )
              )
                throw upstreamError();
              if (match[2] === "last") {
                if (
                  page < currentPage ||
                  (lastPage !== null && lastPage !== page)
                )
                  throw upstreamError();
                lastPage = page;
              }
              if (match[2] === "next") {
                if (next || page !== currentPage + 1) throw upstreamError();
                next = u.href;
              }
            }
          }
          if (
            lastPage !== null &&
            (currentPage > lastPage ||
              (currentPage < lastPage && !next) ||
              (currentPage === lastPage && next))
          )
            throw upstreamError();
        }
        return all;
      }
      try {
        const { data: pr } = await reader.get(prUrl);
        if (!identity(pr)) return mismatch("pullRequest");
        checks.pullRequest = "pass";
        const { data: commit } = await reader.get(
          `${root}/commits/${target.headCommitSha}`,
        );
        if (
          commit.sha !== target.headCommitSha ||
          commit.parents?.length !== 1 ||
          commit.parents[0].sha !== target.baseCommitSha ||
          commit.commit?.tree?.sha !== target.expectedTreeSha
        )
          return mismatch("commit");
        checks.commit = "pass";
        const files = await pages(prUrl + "/files?per_page=100");
        const expected = input.diff.map((f) => f.path);
        if (
          !Number.isSafeInteger(pr.changed_files) ||
          files.length !== pr.changed_files ||
          files.length !== expected.length ||
          new Set(files.map((f) => f.filename)).size !== files.length ||
          files.some(
            (f) =>
              !expected.includes(f.filename) ||
              (f.previous_filename && f.previous_filename !== f.filename),
          )
        )
          return mismatch("files");
        checks.files = "pass";
        const all = await pages(
          `${root}/commits/${target.headCommitSha}/statuses?per_page=100`,
        );
        let pending = false,
          failed = false;
        for (const context of input.policy.requiredStatusContexts) {
          const relevant = all.filter((s) => s.context === context);
          if (!relevant.length) {
            pending = true;
            continue;
          }
          if (
            relevant.some(
              (s) =>
                !Number.isSafeInteger(s.id) ||
                s.id <= 0 ||
                !Number.isFinite(Date.parse(s.updated_at)) ||
                !["success", "pending", "failure", "error"].includes(s.state),
            )
          )
            return mismatch("ci");
          relevant.sort((a, b) => b.id - a.id);
          const current = relevant[0];
          if (
            relevant.filter((s) => s.id === current.id).length !== 1 ||
            !input.policy.trustedStatusCreators.includes(current.creator?.login)
          )
            return mismatch("ci");
          statuses.push({
            context,
            state: current.state,
            id: current.id,
            updatedAt: current.updated_at,
          });
          if (current.state === "pending") pending = true;
          if (["failure", "error"].includes(current.state)) failed = true;
        }
        const { data: again } = await reader.get(prUrl);
        if (!identity(again) || again.changed_files !== pr.changed_files)
          return mismatch("pullRequest");
        checks.ci = failed ? "fail" : pending ? "pending" : "pass";
        return finish(
          failed ? "failed" : pending ? "pending" : "passed",
          failed
            ? "必需 CI 状态失败。"
            : pending
              ? "等待必需 CI 状态。"
              : "已独立核验 PR、提交、文件与可信 CI 状态。",
        );
      } catch {
        return finish("error", "GitHub 核验读取不可用、超时或响应不完整。");
      } finally {
        reader.close();
      }
    },
  };
}
