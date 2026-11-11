import { createHash } from "node:crypto";
import { HealingError } from "./console-store.mjs";
import { createJsonReader } from "./bounded-json.mjs";
const bad = () => {
  throw new HealingError(
    422,
    "SCM_PROVENANCE_UNSUPPORTED",
    "构建缺少唯一且一致的 Git 来源，不能导入。",
  );
};
const sha = (value) =>
  typeof value === "string" && /^[a-f0-9]{40}$/i.test(value);
export function validateJenkinsConfig(config) {
  try {
    const u = new URL(config.baseUrl);
    if (
      config.enabled !== true ||
      !/^https?:$/.test(u.protocol) ||
      (u.protocol === "http:" && config.allowHttp !== true) ||
      u.username ||
      u.password ||
      u.search ||
      u.hash
    )
      return null;
    if (
      !["sourceId", "generation", "repo", "branch", "scmBranch"].every(
        (k) =>
          typeof config[k] === "string" &&
          config[k].trim() &&
          config[k].length <= 200,
      )
    )
      return null;
    if (!/^[\w.-]+\/[\w.-]+$/.test(config.repo)) return null;
    if (
      !Array.isArray(config.jobSegments) ||
      !config.jobSegments.length ||
      config.jobSegments.some(
        (s) =>
          typeof s !== "string" ||
          !s ||
          s === "." ||
          s === ".." ||
          /[\\/\r\n]/.test(s),
      )
    )
      return null;
    if (
      !Array.isArray(config.scmRemoteUrls) ||
      !config.scmRemoteUrls.length ||
      config.scmRemoteUrls.some((s) => typeof s !== "string" || !s)
    )
      return null;
    u.pathname = u.pathname.replace(/\/?$/, "/");
    return { ...config, baseUrl: u.href };
  } catch {
    return null;
  }
}
export function createJenkinsSource(
  raw,
  {
    fetchImpl = globalThis.fetch,
    env = process.env,
    clock = () => new Date(),
    timeoutMs,
  } = {},
) {
  const config = validateJenkinsConfig(raw);
  return {
    async readBuild({ sourceId, buildNumber }) {
      if (!config || sourceId !== config.sourceId)
        throw new HealingError(
          422,
          "SOURCE_UNAVAILABLE",
          "Jenkins 来源未配置或不匹配。",
        );
      if (!Number.isSafeInteger(buildNumber) || buildNumber < 1)
        throw new HealingError(
          400,
          "INVALID_REQUEST",
          "构建编号必须为正整数。",
        );
      const buildUrl =
        config.baseUrl +
        config.jobSegments
          .map((s) => `job/${encodeURIComponent(s)}/`)
          .join("") +
        buildNumber +
        "/";
      const headers = { Accept: "application/json" };
      if (config.usernameEnv || config.tokenEnv) {
        const user = env[config.usernameEnv],
          token = env[config.tokenEnv];
        if (!user || !token)
          throw new HealingError(
            422,
            "SOURCE_UNAVAILABLE",
            "Jenkins 读取凭据未配置。",
          );
        headers.Authorization =
          "Basic " + Buffer.from(`${user}:${token}`).toString("base64");
      }
      const reader = createJsonReader({
        fetchImpl,
        origin: new URL(config.baseUrl).origin,
        headers,
        timeoutMs,
      });
      try {
        const { data: b } = await reader.get(buildUrl + "api/json");
        if (b.number !== buildNumber || typeof b.building !== "boolean") bad();
        if (b.building)
          throw new HealingError(
            409,
            "BUILD_RUNNING",
            "构建仍在运行，请完成后再导入。",
          );
        if (b.result !== "FAILURE") {
          if (
            !["SUCCESS", "UNSTABLE", "ABORTED", "NOT_BUILT"].includes(b.result)
          )
            bad();
          return { outcome: "ignored" };
        }
        const actions = (b.actions ?? []).filter(
          (a) => a?._class === "hudson.plugins.git.util.BuildData",
        );
        if (actions.length !== 1) bad();
        const a = actions[0];
        if (
          !Array.isArray(a.remoteUrls) ||
          a.remoteUrls.length !== config.scmRemoteUrls.length ||
          new Set(a.remoteUrls).size !== a.remoteUrls.length ||
          a.remoteUrls.some((u) => !config.scmRemoteUrls.includes(u))
        )
          bad();
        const revision = a.buildsByBranchName?.[config.scmBranch];
        if (revision?.buildNumber !== buildNumber) bad();
        const commit = revision.revision?.SHA1;
        if (!sha(commit)) bad();
        for (const r of [
          revision.revision,
          revision.marked,
          a.lastBuiltRevision,
        ])
          if (
            !r ||
            r.SHA1 !== commit ||
            !Array.isArray(r.branch) ||
            r.branch.length !== 1 ||
            r.branch[0].name !== config.scmBranch ||
            r.branch[0].SHA1 !== commit
          )
            bad();
        const eventId = createHash("sha256")
          .update(
            JSON.stringify({
              baseUrl: config.baseUrl,
              jobSegments: config.jobSegments,
              generation: config.generation,
              buildNumber,
            }),
          )
          .digest("hex");
        return {
          outcome: "created",
          source: {
            kind: "jenkins",
            sourceId: config.sourceId,
            eventId,
            generation: config.generation,
            jobName: config.jobSegments.join("/"),
            buildNumber,
            buildUrl,
            repo: config.repo,
            branch: config.branch,
            commitSha: commit.toLowerCase(),
            result: "FAILURE",
            observedAt: new Date(clock()).toISOString(),
          },
        };
      } finally {
        reader.close();
      }
    },
  };
}
