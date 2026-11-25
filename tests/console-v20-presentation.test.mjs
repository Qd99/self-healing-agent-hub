import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const assets = new URL("../apps/console/public/", import.meta.url);
const read = (path) => readFile(new URL(path, assets), "utf8");

test("V20 entry retains the original application, controls and live default", async () => {
  const [legacy, preview] = await Promise.all([
    read("index.html"),
    read("console-v20.html"),
  ]);
  assert.match(preview, /data-console-ui="v20"/);
  assert.match(preview, /name="console-default-mode" content="live"/);
  assert.match(
    preview,
    /href="\.\/v20-compatible\.css" \/>\s*<script src="\.\/app\.js" type="module"/,
  );
  assert.doesNotMatch(legacy, /data-console-ui|v20-compatible\.css/);
  assert.equal(
    preview
      .replace(' data-console-ui="v20"', "")
      .replace("heal — V20 兼容预览", "heal — 自愈工作台")
      .replace(
        '    <link rel="stylesheet" href="./v20-compatible.css" />\n',
        "",
      ),
    legacy,
    "Both entries must share the same scripts, controls, and dialog IDs",
  );
});

test("V20 stylesheet does not load external assets or synthesize business data", async () => {
  const css = await read("v20-compatible.css");
  assert.doesNotMatch(css, /@import\b|\burl\s*\(/i);
  assert.match(css, /:root\[data-console-ui="v20"\]\[data-theme="dark"\]/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  // Content may create a decorative rule, never a label or a metric.
  for (const match of css.matchAll(/(?:^|[;{])\s*content\s*:\s*([^;]+);/g)) {
    assert.equal(match[1].trim(), '""');
  }
  // All ordinary selector lines are scoped to the opt-in document.
  for (const line of css.split("\n")) {
    const trimmed = line.trim();
    if (/^[.#:[]/.test(trimmed)) {
      assert.ok(trimmed.startsWith(':root[data-console-ui="v20"]'), trimmed);
    }
  }
});
