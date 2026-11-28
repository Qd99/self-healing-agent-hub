import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSecret, readSecretFile } from "../apps/healing-hub/src/secrets.mjs";

async function withDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "healing-secret-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("reads a secret from a file when the file variable is set", async (t) => {
  const dir = await withDir(t);
  const file = join(dir, "token");
  await writeFile(file, "file-secret-value\n");
  assert.equal(
    readSecret({ TOKEN_FILE: file }, "TOKEN"),
    "file-secret-value",
  );
});

test("falls back to the environment value when no file variable is set", () => {
  assert.equal(readSecret({ TOKEN: "env-secret" }, "TOKEN"), "env-secret");
  assert.equal(readSecret({}, "TOKEN"), "");
});

test("fails closed when the secret file cannot be read", () => {
  assert.throws(
    () => readSecret({ TOKEN_FILE: "/nonexistent/secret" }, "TOKEN"),
    /TOKEN_FILE could not be read/,
  );
});

test("the file-only reader ignores a plain environment value", async (t) => {
  const dir = await withDir(t);
  const file = join(dir, "token");
  await writeFile(file, "only-from-file");
  assert.equal(readSecretFile({ TOKEN: "ignored" }, "TOKEN"), "");
  assert.equal(
    readSecretFile({ TOKEN_FILE: file }, "TOKEN"),
    "only-from-file",
  );
});
