import { spawn } from "node:child_process";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";
import { findTestFiles } from "./test-files.mjs";

const args = process.argv.slice(2);
if (
  args.length > 1 ||
  (args.length && !["--list", "--watch"].includes(args[0]))
) {
  throw new Error("Use --list, --watch, or no arguments");
}
const root = fileURLToPath(new URL("../", import.meta.url));
const files = await findTestFiles(root);
console.log(`Test files (${files.length}):\n${files.join("\n")}`);
if (args[0] !== "--list") {
  const child = spawn(
    process.execPath,
    ["--test", ...(args[0] === "--watch" ? ["--watch"] : []), ...files],
    {
      cwd: root,
      stdio: "inherit",
    },
  );
  const forward = (signal) => child.kill(signal);
  const interrupt = () => forward("SIGINT");
  const terminate = () => forward("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  child.once("error", () => {
    process.exitCode = 1;
  });
  child.once("close", (code, signal) => {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    process.exitCode = code ?? 128 + (constants.signals[signal] ?? 1);
  });
}
