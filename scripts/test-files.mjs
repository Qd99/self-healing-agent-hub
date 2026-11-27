import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

const blocked = new Set(["fixtures", "helpers"]);

const list = (directory) => readdir(directory, { withFileTypes: true });

async function verifyRoot(rootDir, relative, optional = false) {
  let directory = rootDir;
  for (const segment of relative.split("/")) {
    directory = join(directory, segment);
    let info;
    try {
      info = await lstat(directory);
    } catch (error) {
      if (optional && error.code === "ENOENT") return false;
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Test root must be a directory, not a symlink");
  }
  return true;
}

/** Only trusted test roots are executable; fixture and symlink trees are never followed. */
export async function findTestFiles(rootDir) {
  const found = [];
  await verifyRoot(rootDir, "tests");
  for (const entry of await list(join(rootDir, "tests"))) {
    if (entry.isFile() && entry.name.endsWith(".test.mjs"))
      found.push(`tests/${entry.name}`);
  }
  const visit = async (relative) => {
    for (const entry of await list(join(rootDir, relative))) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory() && !blocked.has(entry.name)) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".test.mjs"))
        found.push(path);
    }
  };
  for (const path of ["tests/contract", "apps/console/test"]) {
    if (await verifyRoot(rootDir, path, true)) await visit(path);
  }
  const files = [...new Set(found)].sort();
  if (!files.length) throw new Error("No test files found");
  return files;
}

export function suiteFiles(files, suite = "all") {
  if (!["all", "console", "worker"].includes(suite))
    throw new Error("Unknown suite");
  if (suite === "all") return [...files];
  return files.filter((file) =>
    suite === "worker"
      ? /^tests\/worker-[^/]+\.test\.mjs$/.test(file)
      : /^tests\/console-[^/]+\.test\.mjs$/.test(file) ||
        file.startsWith("apps/console/test/") ||
        file.startsWith("tests/contract/console-"),
  );
}
