import { cp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = path.join(root, "dist");
const demo = process.argv.includes("--demo");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(path.join(root, "apps/console/public"), output, { recursive: true });
if (demo) {
  const index = await readFile(path.join(output, "index.html"), "utf8");
  await writeFile(
    path.join(output, "index.html"),
    index.replace(
      'name="console-default-mode" content="live"',
      'name="console-default-mode" content="demo"',
    ),
  );
}
console.log(
  `Built management console to dist/ (${demo ? "explicit demo" : "same-origin API"} mode).`,
);
