import test from "node:test";
import assert from "node:assert/strict";
import { Linter } from "eslint";
import { fileURLToPath } from "node:url";
import boundaries from "../scripts/eslint/console-boundaries.mjs";

const base = new URL("../apps/console/public/v20/", import.meta.url);
function check(file, code) {
  return new Linter().verify(
    code,
    [
      {
        files: ["**/*.js"],
        plugins: { architecture: { rules: { boundaries } } },
        rules: { "architecture/boundaries": "error" },
      },
    ],
    { filename: fileURLToPath(new URL(file, base)) },
  );
}

test("new Console layers reject cross-domain, reverse, escape and runtime dependencies", () => {
  const invalid = [
    ["domains/tasks/model.js", 'import x from "../quality/model.js";'],
    ["shared/view.js", 'export {x} from "../domains/tasks/model.js";'],
    ["domains/tasks/model.js", 'import x from "./views.js";'],
    ["domains/tasks/controller.js", 'const x = import("./views.js");'],
    ["domains/tasks/views.js", 'import x from "../../session/controller.js";'],
    ["domains/tasks/model.js", 'import x from "../../api/client.js";'],
    ["domains/tasks/model.js", 'import x from "../../shared/../../data.js";'],
    ["app/main.js", 'import x from "../domains/tasks/views.js";'],
    ["shared/view.js", "const x = import(location.hash);"],
    ["shared/view.js", 'import x from "node:fs";'],
  ];
  for (const [file, code] of invalid) {
    const errors = check(file, code);
    assert.ok(
      errors.some((row) => row.ruleId === "architecture/boundaries"),
      `${file}: ${code}`,
    );
    assert.equal(
      errors.some((row) => row.fatal),
      false,
    );
  }
});

test("same-domain, shared, composition-root and exact legacy adapters remain legal", () => {
  const valid = [
    ["domains/tasks/views.js", 'import x from "./model.js";'],
    ["domains/tasks/views.js", 'import x from "../../shared/view.js";'],
    ["domains/tasks/model.js", 'export {x} from "./calculations.js";'],
    ["app/main.js", 'import x from "../domains/tasks/index.js";'],
    ["app/main.js", 'import x from "../session/controller.js";'],
    ["api/client.js", 'import x from "../../api-client.js";'],
    ["shared/view.js", 'export {x} from "../../model.js";'],
    ["shared/view.js", 'export {x} from "../../icons.js";'],
  ];
  for (const [file, code] of valid)
    assert.deepEqual(check(file, code), [], `${file}: ${code}`);
});
