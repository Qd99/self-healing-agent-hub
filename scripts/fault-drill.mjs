/** Fault-injection drill runner.
 *
 * Runs the registered drills against real local processes and writes a
 * machine-readable evidence record. The evidence binds the commit, tree,
 * working tree state, the exact command and the exit code, and states plainly
 * that the external systems were controlled.
 *
 * Usage:
 *   node scripts/fault-drill.mjs [--scenario <id>] [--out <dir>]
 *
 * Exit code 0 means every selected drill passed. Any failure exits 1.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { scenarios, createAssertions } from "./fault-drill.scenarios.mjs";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const selected = option("--scenario");
const outDir = resolve(
  option("--out") ??
    join(
      tmpdir(),
      "fault-drills",
      new Date().toISOString().replace(/[:.]/g, "-"),
    ),
);
const command = `node scripts/fault-drill.mjs${
  selected ? ` --scenario ${selected}` : ""
}`;

function gitState(root) {
  const run = (args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  const head = run(["rev-parse", "HEAD"]);
  const tree = run(["rev-parse", "HEAD^{tree}"]);
  const status = run(["status", "--porcelain"]);
  return {
    commitSha: head,
    treeSha: tree,
    workingTree: status ? "dirty" : "clean",
    dirtyFiles: status ? status.split("\n").length : 0,
  };
}

/** No drill evidence may contain a credential. */
const SECRET_PATTERNS = [
  "drill-manager-token",
  "drill-worker-token",
  "drill-model-secret",
  "drill-write-token",
  "drill-read-token",
];

function scanForSecrets(text) {
  return SECRET_PATTERNS.filter((secret) => text.includes(secret));
}

async function runScenario(scenario) {
  const assertions = createAssertions();
  const snapshots = {};
  const startedAt = new Date().toISOString();
  const ctx = {
    check: (name, ok, detail) => assertions.check(name, ok, detail),
    equal: (name, actual, expected) => assertions.equal(name, actual, expected),
    snapshot: (name, value) => {
      snapshots[name] = value;
    },
  };
  let error = null;
  let result = null;
  try {
    result = await scenario.run(ctx);
  } catch (thrown) {
    error = {
      message: thrown?.message ?? String(thrown),
      stack: thrown?.stack ?? null,
    };
  }
  const failed = assertions.results.filter((item) => !item.ok);
  return {
    id: scenario.id,
    title: scenario.title,
    covers: scenario.covers,
    relatedTests: scenario.relatedTests,
    status: error ? "failed" : failed.length ? "failed" : "passed",
    startedAt,
    finishedAt: new Date().toISOString(),
    assertions: assertions.results,
    snapshots,
    result,
    error,
  };
}

async function main() {
  const chosen = selected
    ? scenarios.filter((scenario) => scenario.id === selected)
    : scenarios;
  if (!chosen.length) {
    console.error(
      `Unknown drill scenario: ${selected}\nAvailable: ${scenarios
        .map((scenario) => scenario.id)
        .join(", ")}`,
    );
    return 2;
  }
  const root = resolve(join(import.meta.dirname, ".."));
  const state = gitState(root);
  const runId = `fault-drill-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  await mkdir(join(outDir, "journal-snapshots"), { recursive: true });
  const results = [];
  for (const scenario of chosen) {
    process.stderr.write(`\n▶ ${scenario.id}: ${scenario.title}\n`);
    const outcome = await runScenario(scenario);
    results.push(outcome);
    const failed = outcome.assertions.filter((item) => !item.ok);
    for (const item of outcome.assertions)
      process.stderr.write(
        `  ${item.ok ? "✔" : "✘"} ${item.name}${
          item.ok ? "" : ` — ${JSON.stringify(item.detail)}`
        }\n`,
      );
    if (outcome.error)
      process.stderr.write(`  ✘ 未捕获异常: ${outcome.error.message}\n`);
    process.stderr.write(
      `  → ${outcome.status}（断言 ${outcome.assertions.length}，失败 ${failed.length}）\n`,
    );
  }
  const summary = {
    runId,
    kind: "fault-injection-drill",
    // The external systems were controlled. This is NOT real-environment
    // acceptance; it proves the recovery contract on this machine only.
    externalTier: "controlled",
    externalSystems: {
      jenkins: "controlled-http",
      github: "controlled-http",
      docker: "controlled-cli-transport",
    },
    startedAt: results[0]?.startedAt ?? null,
    finishedAt: new Date().toISOString(),
    command,
    exitCode: results.some((result) => result.status !== "passed") ? 1 : 0,
    environment: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
    },
    repository: state,
    scenarios: results.map((result) => ({
      id: result.id,
      title: result.title,
      covers: result.covers,
      relatedTests: result.relatedTests,
      status: result.status,
      assertions: result.assertions,
      result: result.result,
      error: result.error,
    })),
  };
  const summaryText = JSON.stringify(summary, null, 2);
  const leaked = scanForSecrets(summaryText);
  if (leaked.length)
    throw Error(`Drill evidence contains credentials: ${leaked.join(", ")}`);
  await writeFile(join(outDir, "summary.json"), `${summaryText}\n`);
  for (const result of results) {
    const text = JSON.stringify(
      { id: result.id, snapshots: result.snapshots },
      null,
      2,
    );
    const snapshotLeak = scanForSecrets(text);
    if (snapshotLeak.length)
      throw Error(
        `Drill snapshot ${result.id} contains credentials: ${snapshotLeak.join(", ")}`,
      );
    await writeFile(
      join(outDir, "journal-snapshots", `${result.id}.json`),
      `${text}\n`,
    );
  }
  await writeFile(
    join(outDir, "README.md"),
    `# ${runId}\n\n故障注入演练证据。外部系统为受控响应（externalTier=controlled），\n不代表真实 Docker/Jenkins/GitHub 验收。\n\n- 命令：\`${command}\`\n- 提交：\`${state.commitSha}\`（tree \`${state.treeSha}\`，工作区 ${state.workingTree}）\n- 退出码：${summary.exitCode}\n`,
  );
  process.stderr.write(
    `\n证据已写入 ${outDir}\n提交 ${state.commitSha} · 工作区 ${state.workingTree} · 退出码 ${summary.exitCode}\n`,
  );
  return summary.exitCode;
}

process.exitCode = await main();
