import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { findTestFiles, suiteFiles } from "./test-files.mjs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const reporter = fileURLToPath(new URL("./workbench-node-reporter.mjs", import.meta.url));
const args = process.argv.slice(2);
const options = { suite: "console", environment: "local-isolated", timeout: "300", out: "" };
for (let i = 0; i < args.length; i += 2) {
  const key = args[i]?.slice(2);
  if (!args[i]?.startsWith("--") || !Object.hasOwn(options, key) || !args[i + 1]) throw Error("Invalid runner option");
  options[key] = args[i + 1];
}
if (process.platform === "win32") throw Error("Run this isolated runner on Linux or macOS");
if (!["console", "worker", "all"].includes(options.suite) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(options.environment) || /prod/i.test(options.environment)) throw Error("Invalid suite or non-production environment");
const timeout = Number(options.timeout);
if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 900 || !options.out) throw Error("Provide --out and --timeout 1..900 seconds");
const out = resolve(options.out);
const discovered = suiteFiles(await findTestFiles(root), options.suite);
const files = discovered.map(path => join(root, path));
if (!files.length) throw Error("No trusted suite files found");
// Preserve the single JSON report summary on stdout for existing callers.
console.error(JSON.stringify({ suite: options.suite, files: discovered }));
const scratch = await mkdtemp(join(tmpdir(), "hub-test-run-"));
try {
  const env = { PATH: process.env.PATH || "", HOME: scratch, TMPDIR: scratch, LANG: "C.UTF-8", TZ: "UTC", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  const git = argv => execFileSync("git", argv, { cwd: root, env, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 }).trim();
  const sha = git(["rev-parse", "HEAD"]);
  if (!/^[a-f0-9]{40}$/.test(sha)) throw Error("Invalid repository HEAD");
  const before = git(["status", "--porcelain", "--untracked-files=normal"]);
  const startedAt = new Date().toISOString();
  let forced = "", output = "", killTimer;
  const child = spawn(process.execPath, ["--test", "--test-reporter=" + reporter, ...files], { cwd: root, env, stdio: ["ignore", "pipe", "ignore"], detached: true });
  const stop = reason => {
    if (forced) return;
    forced = reason;
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* already exited */ }
    killTimer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ } }, 1500);
  };
  const interrupt = () => stop("cancelled");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const timer = setTimeout(() => stop("timeout"), timeout * 1000);
  let outcome;
  try {
    outcome = await new Promise((resolveOutcome, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolveOutcome({ code, signal }));
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", chunk => {
        if (forced) return;
        output += chunk;
        if (Buffer.byteLength(output) > 900 * 1024) stop("output-limit");
      });
    });
  } finally {
    clearTimeout(timer);
    // Always clean up the process group after a forced stop, including children.
    if (forced) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ } }
    clearTimeout(killTimer);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
  const results = [], attempts = new Map();
  let summary = null, malformed = false;
  for (const line of output.split("\n").filter(Boolean)) {
    let row;
    try { row = JSON.parse(line); } catch { malformed = true; continue; }
    if (row.type === "summary") { summary = row.success === true; continue; }
    if (row.type !== "result" || typeof row.id !== "string" || typeof row.name !== "string" || !["pass", "fail", "skip", "error", "timeout", "cancelled", "unknown"].includes(row.result) || results.length >= 1999) { malformed = true; continue; }
    const attempt = (attempts.get(row.id) || 0) + 1;
    attempts.set(row.id, attempt);
    const { id, name, result, durationMs, error } = row;
    results.push({ id, name, result, durationMs, error, attempt });
  }
  if (forced || malformed || summary === null || !results.length || (summary !== (outcome.code === 0))) {
    results.push({ id: "hub-runner:incomplete", name: "Runner / reporter incomplete", result: forced === "timeout" ? "timeout" : forced === "cancelled" ? "cancelled" : "error", durationMs: null, attempt: 1, error: forced || "incomplete-reporter" });
  }
  const after = git(["status", "--porcelain", "--untracked-files=normal"]);
  const report = { runId: randomUUID(), framework: "node:test", commitSha: sha, environment: options.environment, exitCode: Number.isSafeInteger(outcome.code) && outcome.code >= 0 && outcome.code <= 255 ? outcome.code : null, dirty: Boolean(before || after || git(["rev-parse", "HEAD"]) !== sha), startedAt, finishedAt: new Date().toISOString(), results, planRef: "" };
  if (Buffer.byteLength(JSON.stringify(report)) > 850 * 1024) {
    const marker = { id: "hub-runner:report-limit", name: "Report capacity exceeded", result: "error", durationMs: null, attempt: 1, error: "report-limit" };
    while (results.length && Buffer.byteLength(JSON.stringify(report)) > 840 * 1024) results.pop();
    results.push(marker);
    malformed = true;
  }
  await writeFile(out, JSON.stringify(report) + "\n", { flag: "wx", mode: 0o600 });
  const failed = results.some(row => !["pass", "skip"].includes(row.result));
  console.log(JSON.stringify({ report: out, cases: results.length, incomplete: Boolean(forced || malformed || summary === null), exitCode: report.exitCode, dirty: report.dirty }));
  if (failed || report.exitCode !== 0 || report.dirty) process.exitCode = 1;
} finally {
  await rm(scratch, { recursive: true, force: true });
}
