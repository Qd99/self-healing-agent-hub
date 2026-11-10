import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  lstat,
  readdir,
  readlink,
} from "node:fs/promises";
import { join, dirname, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import {
  runCommand as defaultRunCommand,
  cleanEnvironment,
} from "./process-runner.mjs";
import { createModelClient, validateGeneration } from "./model-client.mjs";
import { createCheckRunner } from "./check-runner.mjs";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const MAX_PATCH = 512 * 1024;
// Mandatory, case-insensitive path exclusions apply to every path component.
// Deployment-specific secret locations still belong in safety.protectedPaths.
const CREDENTIAL_PATHS = [
  ".env",
  ".env.*",
  "*.env",
  "*.env.*",
  "credential",
  "credential.*",
  "credentials",
  "credentials.*",
  "secret",
  "secret.*",
  "secrets",
  "secrets.*",
  ".aws",
  ".ssh",
  ".azure",
  ".kube",
  ".gnupg",
  ".docker",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "_netrc",
  ".git-credentials",
  ".boto",
  "id_rsa*",
  "id_dsa*",
  "id_ecdsa*",
  "id_ed25519*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.jks",
  "*.keystore",
  "*.kdbx",
  "*service-account*.json",
  "*service_account*.json",
];
const GIT_OPTIONS = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "credential.helper=",
  "-c",
  "diff.external=",
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.safecrlf=false",
  "-c",
  "core.fileMode=true",
  "-c",
  "submodule.recurse=false",
];
function textFile(buffer) {
  if (buffer.includes(0)) throw new Error("Binary file is unsupported");
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      buffer,
    );
  } catch {
    throw new Error("File must be valid UTF-8");
  }
}
function protectedPath(path, patterns) {
  return patterns.some((pattern) => {
    if (pattern.endsWith("/")) return path.startsWith(pattern);
    let regex = "";
    for (let i = 0; i < pattern.length; i++) {
      if (pattern[i] === "*" && pattern[i + 1] === "*") {
        regex += ".*";
        i++;
      } else if (pattern[i] === "*") regex += "[^/]*";
      else if (pattern[i] === "?") regex += "[^/]";
      else regex += pattern[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    const re = new RegExp(`^${regex}$`);
    return (
      re.test(path) ||
      (!pattern.includes("/") && path.split("/").some((p) => re.test(p)))
    );
  });
}
function safePath(path, safety = {}) {
  if (
    typeof path !== "string" ||
    !path ||
    path.length > 512 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    [...path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    path
      .split("/")
      .some((p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git")
  )
    throw new Error("Unsafe file path");
  const lowerPath = path.toLowerCase();
  if (
    protectedPath(lowerPath, CREDENTIAL_PATHS) ||
    /(^|\/)\.config\/gcloud(\/|$)/.test(lowerPath)
  )
    throw new Error("Protected credential file path");
  if (
    protectedPath(path, [
      ".gitmodules",
      ".gitattributes",
      ".github/workflows/",
      "Jenkinsfile",
      ...(safety.protectedPaths ?? []),
    ])
  )
    throw new Error("Protected file path");
  return path;
}
// Snapshot source AND metadata without invoking Git, following no symlinks.
// This must run before host Git is reused after every check, even failed checks.
async function snapshot(root) {
  const entries = [];
  let bytes = 0,
    count = 0;
  async function visit(dir, relative = "") {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name),
        key = relative ? `${relative}/${name}` : name,
        stat = await lstat(path);
      if (++count > 50000) throw new Error("Workspace file limit exceeded");
      if (stat.isSymbolicLink())
        entries.push([key, "link", await readlink(path)]);
      else if (stat.isDirectory()) {
        entries.push([key, "dir", stat.mode]);
        await visit(path, key);
      } else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > 256 * 1024 * 1024)
          throw new Error("Workspace size limit exceeded");
        entries.push([key, stat.mode, sha256(await readFile(path))]);
      } else throw new Error("Unsupported workspace file type");
    }
  }
  await visit(root);
  return sha256(JSON.stringify(entries));
}
function manifestEqual(a, b) {
  return (
    a &&
    b &&
    ["version", "baseCommitSha", "patchSha256", "treeSha", "artifactId"].every(
      (key) => a[key] === b[key],
    )
  );
}
function validateManifest(candidate, base) {
  if (
    !candidate ||
    candidate.version !== 2 ||
    candidate.baseCommitSha !== base ||
    !/^[a-f0-9]{40}$/.test(candidate.treeSha) ||
    !/^[a-f0-9]{64}$/.test(candidate.patchSha256) ||
    candidate.artifactId !== candidate.patchSha256
  )
    throw new Error("Invalid or stale candidate identity");
}
export function createWorkspaceEngine(
  config,
  {
    generate = createModelClient(config.model),
    runCheck,
    runCommand = defaultRunCommand,
  } = {},
) {
  runCheck ??= createCheckRunner({ runCommand });
  const git = async (cwd, args, signal) => {
    const result = await runCommand("git", [...GIT_OPTIONS, ...args], {
      cwd,
      signal,
      env: cleanEnvironment(),
      timeoutMs: 120000,
      maxOutputBytes: 2 * 1024 * 1024,
    });
    if (result.exitCode !== 0)
      throw new Error(`Git operation failed: ${args[0]}`);
    return result.stdout;
  };
  function claimInfo(claim) {
    const raw = claim?.task?.task;
    const task = {
      id: raw?.id,
      type: raw?.type,
      repo: raw?.payload?.repo,
      branch: raw?.payload?.branch,
      commitSha: raw?.payload?.context?.commitSha,
      source: raw?.payload?.context?.source,
    };
    const safety = claim?.context?.safety ?? {};
    if (
      task.type !== "ci-failure" ||
      task.repo !== config.repository.fullName ||
      task.branch !== config.repository.branch ||
      !/^[a-f0-9]{40}$/.test(task.commitSha) ||
      task.source?.kind !== "jenkins" ||
      (task.source.commitSha && task.source.commitSha !== task.commitSha) ||
      claim?.context?.rule?.processor?.action !== "create-pr"
    )
      throw new Error("Invalid task repository, source or action");
    const checks = safety.requiredChecks;
    if (
      !Array.isArray(checks) ||
      !checks.length ||
      new Set(checks).size !== checks.length ||
      checks.some((id) => !Object.hasOwn(config.checks.commands, id))
    )
      throw new Error("Unregistered required check");
    return { task, safety, checks };
  }
  async function active(options) {
    options.signal?.throwIfAborted();
    await options.assertActive?.();
    options.signal?.throwIfAborted();
  }
  async function checkout(base, options) {
    await active(options);
    if (!isAbsolute(config.dataDir) || !isAbsolute(config.repository.localPath))
      throw new Error("Workspace paths must be absolute");
    await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
    const cwd = await mkdtemp(join(config.dataDir, "workspace-"));
    try {
      await git(cwd, ["init", "--quiet", "--template="], options.signal);
      await git(
        cwd,
        [
          "-c",
          "protocol.file.allow=always",
          "fetch",
          "--quiet",
          "--no-tags",
          "--no-recurse-submodules",
          "--",
          config.repository.localPath,
          base,
        ],
        options.signal,
      );
      await git(cwd, ["checkout", "--quiet", "--detach", base], options.signal);
      const tree = await git(
        cwd,
        ["ls-tree", "-r", "-z", base],
        options.signal,
      );
      for (const record of tree.split("\0").filter(Boolean)) {
        const mode = record.slice(0, 6);
        if (!["100644", "100755"].includes(mode))
          throw new Error(
            "Only regular file modes are supported; symlink/submodule found",
          );
      }
      return cwd;
    } catch (error) {
      await rm(cwd, { recursive: true, force: true });
      throw error;
    }
  }
  async function checks(cwd, ids, options) {
    const records = [];
    for (const id of ids) {
      await active(options);
      const before = await snapshot(cwd);
      let result, error;
      try {
        result = await runCheck(
          {
            cwd,
            id,
            argv: config.checks.commands[id],
            image: config.checks.image,
            timeoutMs: config.checks.timeoutMs ?? 120000,
          },
          { signal: options.signal },
        );
      } catch (e) {
        error = e;
      }
      if (before !== (await snapshot(cwd)))
        throw new Error("Check modified workspace files or Git metadata");
      if (error) throw error;
      await active(options);
      if (
        !Number.isInteger(result?.exitCode) ||
        result.exitCode < 0 ||
        result.exitCode > 255
      )
        throw new Error("Invalid check result");
      records.push({
        id,
        exitCode: result.exitCode,
        stdout: String(result.stdout ?? "").slice(0, 8192),
        stderr: String(result.stderr ?? "").slice(0, 8192),
      });
    }
    return records;
  }
  async function context(cwd, safety) {
    const paths = config.model.contextPaths ?? [];
    if (!Array.isArray(paths) || paths.length > 20)
      throw new Error("Model context path limit exceeded");
    const result = [];
    let size = 0;
    for (const path of paths) {
      safePath(path, safety);
      await regularAncestors(cwd, path);
      const value = await readFile(join(cwd, path));
      size += value.length;
      if (size > 128 * 1024)
        throw new Error("Model context byte limit exceeded");
      result.push({ path, content: textFile(value) });
    }
    return result;
  }
  async function regularAncestors(cwd, path) {
    let current = cwd;
    for (const part of path.split("/")) {
      current = join(current, part);
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
          throw new Error("Only regular files are supported");
      } catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
      }
    }
  }
  async function applyChanges(cwd, changes, safety) {
    if (
      !changes.length ||
      changes.length > (safety.maxFilesPerFix ?? 5) ||
      new Set(changes.map((c) => c.path)).size !== changes.length
    )
      throw new Error("Invalid change count or duplicate paths");
    for (const { path, content } of changes) {
      safePath(path, safety);
      await regularAncestors(cwd, path);
      if (content === null) {
        const stat = await lstat(join(cwd, path));
        if (!stat.isFile())
          throw new Error("Only regular file deletion is supported");
        textFile(await readFile(join(cwd, path)));
        await rm(join(cwd, path));
      } else {
        if (content !== textFile(Buffer.from(content)))
          throw new Error("Invalid UTF-8");
        try {
          textFile(await readFile(join(cwd, path)));
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
        await mkdir(dirname(join(cwd, path)), { recursive: true });
        await writeFile(join(cwd, path), content);
      }
    }
  }
  async function measure(cwd, base, safety, signal) {
    await git(cwd, ["add", "--all", "--force", "--", "."], signal);
    const renameParts = (
      await git(
        cwd,
        [
          "diff",
          "--cached",
          "--find-renames",
          "--name-status",
          "-z",
          base,
          "--",
        ],
        signal,
      )
    ).split("\0");
    for (let i = 0; i < renameParts.length - 1; i += 2)
      if (/^[RC]/.test(renameParts[i]))
        throw new Error("Candidate renames are unsupported");
    const status = await git(
      cwd,
      ["diff", "--cached", "--no-renames", "--name-status", "-z", base, "--"],
      signal,
    );
    const parts = status.split("\0");
    const changed = [];
    for (let i = 0; i < parts.length - 1; i += 2) {
      if (!["A", "M", "D"].includes(parts[i]))
        throw new Error("Unsupported change type");
      changed.push({ status: parts[i], path: safePath(parts[i + 1], safety) });
    }
    if (!changed.length || changed.length > (safety.maxFilesPerFix ?? 5))
      throw new Error("Candidate file count exceeded or empty");
    const patch = await git(
      cwd,
      [
        "diff",
        "--cached",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--full-index",
        "--binary",
        base,
        "--",
      ],
      signal,
    );
    if (Buffer.byteLength(patch) > MAX_PATCH)
      throw new Error("Candidate patch exceeds limit");
    const files = [],
      diff = [];
    for (const change of changed) {
      const old = await git(cwd, ["ls-tree", base, "--", change.path], signal);
      const next = await git(
        cwd,
        ["ls-files", "--stage", "--", change.path],
        signal,
      );
      const oldMode = old.slice(0, 6),
        mode = change.status === "D" ? oldMode : next.slice(0, 6);
      if (
        !["100644", "100755"].includes(mode) ||
        (old && change.status !== "D" && mode !== oldMode)
      )
        throw new Error("Mode changes are unsupported");
      let content = null;
      if (change.status !== "D") {
        const bytes = await readFile(join(cwd, change.path));
        const blobSha = createHash("sha1")
          .update(`blob ${bytes.length}\0`)
          .update(bytes)
          .digest("hex");
        const stagedSha = next.match(/^[0-7]{6} ([a-f0-9]{40}) 0\t/)?.[1];
        // Git attributes may normalize line endings, encoding or ident markers
        // while staging. The bytes checked and published must be the exact blob
        // named by the approved tree, not merely a repeatable checkout form.
        if (blobSha !== stagedSha)
          throw new Error(
            "Working-tree bytes differ from staged blob; Git transformations are unsupported",
          );
        content = textFile(bytes);
      }
      if (old)
        textFile(
          Buffer.from(
            await git(cwd, ["show", `${base}:${change.path}`], signal),
          ),
        );
      files.push({ path: change.path, mode, content });
      const perFile = await git(
        cwd,
        [
          "diff",
          "--cached",
          "--no-ext-diff",
          "--no-textconv",
          "--no-renames",
          "--unified=3",
          base,
          "--",
          change.path,
        ],
        signal,
      );
      let hunk = false;
      const lines = [];
      for (const line of perFile.split("\n")) {
        if (line.startsWith("@@")) {
          hunk = true;
          continue;
        }
        if (!hunk || ![" ", "+", "-"].includes(line[0])) continue;
        const content = line.slice(1);
        if (content.length > 20000) throw new Error("Diff line exceeds limit");
        lines.push({
          type: { " ": "context", "+": "add", "-": "remove" }[line[0]],
          content,
        });
      }
      if (lines.length > 5000) throw new Error("Diff lines exceed limit");
      diff.push({
        path: change.path,
        additions: lines.filter((l) => l.type === "add").length,
        deletions: lines.filter((l) => l.type === "remove").length,
        lines,
      });
    }
    const treeSha = (await git(cwd, ["write-tree"], signal)).trim(),
      patchSha256 = sha256(patch);
    return {
      patch,
      files,
      diff,
      candidate: {
        version: 2,
        baseCommitSha: base,
        patchSha256,
        treeSha,
        artifactId: patchSha256,
      },
    };
  }
  function evidence(before, after) {
    return {
      beforeState: {
        summary: JSON.stringify(
          before.map(({ id, exitCode }) => ({ id, exitCode })),
        ),
      },
      afterState: {
        summary: JSON.stringify(
          after.map(({ id, exitCode }) => ({ id, exitCode })),
        ),
      },
      testsRun: after.map((r) => r.id),
      checksPass: after.filter((r) => r.exitCode === 0).map((r) => r.id),
      checksFail: after.filter((r) => r.exitCode !== 0).map((r) => r.id),
    };
  }
  return {
    async diagnose(claim, options = {}) {
      const { task, safety, checks: ids } = claimInfo(claim);
      const cwd = await checkout(task.commitSha, options);
      try {
        const before = await checks(cwd, ids, options);
        if (before.every((r) => r.exitCode === 0))
          throw new Error("Could not reproduce baseline failure");
        await active(options);
        const generated = validateGeneration(
          await generate(
            {
              task: {
                id: task.id,
                type: task.type,
                repo: task.repo,
                branch: task.branch,
                commitSha: task.commitSha,
              },
              failures: before,
              context: await context(cwd, safety),
            },
            { signal: options.signal },
          ),
        );
        await active(options);
        await applyChanges(cwd, generated.changes, safety);
        const initial = await measure(
          cwd,
          task.commitSha,
          safety,
          options.signal,
        );
        const after = await checks(cwd, ids, options);
        if (after.some((r) => r.exitCode !== 0))
          throw new Error("Candidate required checks failed");
        const measured = await measure(
          cwd,
          task.commitSha,
          safety,
          options.signal,
        );
        if (!manifestEqual(initial.candidate, measured.candidate))
          throw new Error("Check changed candidate");
        const result = {
          summary: generated.summary,
          diff: measured.diff,
          evidence: evidence(before, after),
          candidate: measured.candidate,
        };
        const artifact = {
          ...measured,
          summary: result.summary,
          evidence: result.evidence,
        };
        if (
          Buffer.byteLength(JSON.stringify({ ...result, artifact })) >
          900 * 1024
        )
          throw new Error("Candidate request exceeds limit");
        return { ...result, artifact };
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
    async prepareExecution(claim, artifact, options = {}) {
      const { task, safety, checks: ids } = claimInfo(claim);
      validateManifest(claim.task.proposal?.candidate, task.commitSha);
      validateManifest(artifact?.candidate, task.commitSha);
      if (
        !manifestEqual(artifact.candidate, claim.task.proposal.candidate) ||
        typeof artifact.patch !== "string" ||
        Buffer.byteLength(artifact.patch) > MAX_PATCH ||
        sha256(artifact.patch) !== artifact.candidate.patchSha256
      )
        throw new Error("Missing, tampered or stale candidate artifact");
      const cwd = await checkout(task.commitSha, options);
      try {
        const patchPath = join(cwd, ".git", "approved.patch");
        await writeFile(patchPath, artifact.patch);
        await git(
          cwd,
          ["apply", "--index", "--whitespace=nowarn", "--", patchPath],
          options.signal,
        );
        await rm(patchPath);
        const before = await measure(
          cwd,
          task.commitSha,
          safety,
          options.signal,
        );
        if (
          !manifestEqual(before.candidate, artifact.candidate) ||
          JSON.stringify(before.files) !== JSON.stringify(artifact.files) ||
          JSON.stringify(before.diff) !== JSON.stringify(artifact.diff)
        )
          throw new Error("Candidate artifact content mismatch");
        const records = await checks(cwd, ids, options);
        if (records.some((r) => r.exitCode !== 0))
          throw new Error("Candidate required checks failed");
        const after = await measure(
          cwd,
          task.commitSha,
          safety,
          options.signal,
        );
        if (!manifestEqual(after.candidate, artifact.candidate))
          throw new Error("Check changed approved candidate");
        await active(options);
        return {
          candidate: after.candidate,
          files: after.files,
          evidence: evidence([], records),
          cleanup: async () => rm(cwd, { recursive: true, force: true }),
        };
      } catch (error) {
        await rm(cwd, { recursive: true, force: true });
        throw error;
      }
    },
  };
}
