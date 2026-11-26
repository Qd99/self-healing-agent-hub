import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createJenkinsSource,
  validateJenkinsConfig,
} from "./jenkins-source.mjs";
import {
  createGithubVerifier,
  normalizeVerificationPolicy,
} from "./github-verification.mjs";
export async function loadHealingIntegrations({
  rootDir,
  config,
  fetchImpl,
  env = process.env,
  clock,
}) {
  let raw = config;
  if (raw === undefined) {
    try {
      const value = await readFile(
        join(rootDir, "configs/healing-integrations.json"),
        "utf8",
      );
      raw = value.length <= 262144 ? JSON.parse(value) : {};
    } catch {
      raw = {};
    }
  }
  const jenkins = validateJenkinsConfig(raw?.jenkins),
    credentials =
      jenkins &&
      ((!jenkins.usernameEnv && !jenkins.tokenEnv) ||
        (env[jenkins.usernameEnv] && env[jenkins.tokenEnv]));
  const policy = normalizeVerificationPolicy(raw?.githubVerification),
    verification =
      raw?.githubVerification?.enabled === true &&
      Boolean(policy) &&
      Boolean(env[raw.githubVerification.tokenEnv]);
  return {
    snapshot: {
      jenkins: {
        configured: Boolean(jenkins && credentials),
        ...(jenkins
          ? {
              sourceId: jenkins.sourceId,
              jobName: jenkins.jobSegments.join("/"),
              branch: jenkins.branch,
            }
          : {}),
        message:
          jenkins && credentials
            ? "已配置 Jenkins 来源；尚未查询远端。"
            : "Jenkins 来源未配置、配置无效或缺少读取凭据。",
      },
      verification: {
        configured: verification,
        requiredStatusContexts: policy?.requiredStatusContexts ?? [],
        message: verification
          ? "已配置独立只读核验；仅显式请求时查询。"
          : "独立核验未启用、策略不完整或缺少读取凭据。",
      },
    },
    policy: verification ? policy : null,
    jenkins: createJenkinsSource(raw?.jenkins, { fetchImpl, env, clock }),
    verifier: createGithubVerifier(raw?.githubVerification, {
      fetchImpl,
      env,
      clock,
    }),
  };
}
