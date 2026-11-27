import test from "node:test";
import assert from "node:assert/strict";
import {
  copyFile,
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  symlink,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findTestFiles, suiteFiles } from "../scripts/test-files.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "healing-test-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const add = async (path, contents = "// fixture") => {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents);
  };
  return { root, add };
}

test("discovers existing top-level, contract, and new Console tests without fixture or symlink leakage", async (t) => {
  const { root, add } = await fixture(t);
  for (const file of [
    "tests/z.test.mjs",
    "tests/console-one.test.mjs",
    "tests/worker-one.test.mjs",
    "tests/contract/console-one.test.mjs",
    "apps/console/test/p1-one.test.mjs",
    "tests/helper.mjs",
    "tests/fixtures/trap.test.mjs",
    "tests/helpers/trap.test.mjs",
    "tests/contract/fixtures/trap.test.mjs",
    "apps/console/test/helpers/trap.test.mjs",
    "apps/agent-autoloop/tests/foreign.test.mjs",
  ])
    await add(file);
  await symlink(
    join(root, "tests/z.test.mjs"),
    join(root, "tests/symlink.test.mjs"),
  );
  await symlink(
    join(root, "tests/contract"),
    join(root, "apps/console/test/linked"),
  );
  const files = await findTestFiles(root);
  assert.deepEqual(files, [
    "apps/console/test/p1-one.test.mjs",
    "tests/console-one.test.mjs",
    "tests/contract/console-one.test.mjs",
    "tests/worker-one.test.mjs",
    "tests/z.test.mjs",
  ]);
  assert.deepEqual(suiteFiles(files, "console"), [
    "apps/console/test/p1-one.test.mjs",
    "tests/console-one.test.mjs",
    "tests/contract/console-one.test.mjs",
  ]);
  assert.deepEqual(suiteFiles(files, "worker"), ["tests/worker-one.test.mjs"]);
  assert.deepEqual(suiteFiles(files, "all"), files);
  assert.throws(() => suiteFiles(files, "other"), /Unknown suite/);
});

test("optional roots can be absent while a missing or empty required root cannot pass", async (t) => {
  const { root, add } = await fixture(t);
  await assert.rejects(findTestFiles(root));
  await mkdir(join(root, "tests"));
  await assert.rejects(findTestFiles(root), /No test files/);
  await add("tests/console-existing.test.mjs");
  assert.deepEqual(await findTestFiles(root), [
    "tests/console-existing.test.mjs",
  ]);
});

test("the runner executes all discovered files and propagates failure", async (t) => {
  const { root, add } = await fixture(t);
  await add(
    "tests/contract/b.test.mjs",
    "import test from 'node:test'; test('contract b', () => {});",
  );
  await add(
    "tests/a.test.mjs",
    "import test from 'node:test'; test('top a', () => {});",
  );
  await add(
    "tests/failing.test.mjs",
    "import test from 'node:test'; import assert from 'node:assert/strict'; test('expected failure', () => { assert.equal(1, 2); });",
  );
  await add(
    "apps/console/test/c.test.mjs",
    "import test from 'node:test'; test('console c', () => {});",
  );
  await mkdir(join(root, "scripts"));
  for (const name of ["run-tests.mjs", "test-files.mjs"]) {
    await copyFile(
      new URL(`../scripts/${name}`, import.meta.url),
      join(root, "scripts", name),
    );
  }
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = (args = []) =>
    spawnSync(
      process.execPath,
      [join(root, "scripts/run-tests.mjs"), ...args],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 15000,
        env,
      },
    );
  const failed = run();
  for (const name of ["top a", "contract b", "console c", "expected failure"]) {
    assert.match(failed.stdout, new RegExp(name));
  }
  assert.equal(failed.status, 1);
  await rm(join(root, "tests/failing.test.mjs"));
  assert.equal(run().status, 0);
  const listed = run(["--list"]);
  assert.equal(listed.status, 0);
  assert.match(listed.stdout, /tests\/a\.test\.mjs/);
  assert.match(listed.stdout, /apps\/console\/test\/c\.test\.mjs/);
  assert.doesNotMatch(listed.stdout, /contract b/);
  assert.notEqual(run(["--unknown"]).status, 0);
});

test("a trusted root itself cannot be a symlink to an executable fixture tree", async (t) => {
  const { root, add } = await fixture(t);
  await add("tests/console-real.test.mjs");
  await add("outside/console-trap.test.mjs");
  await symlink(join(root, "outside"), join(root, "tests/contract"));
  await assert.rejects(findTestFiles(root), /symlink|directory/i);
});
