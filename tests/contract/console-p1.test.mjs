import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { operations } from "../../packages/contract/src/console-p1.mjs";
import { validateResponse } from "../../packages/contract/src/validate.mjs";
import {
  renderContract,
  checkContract,
} from "../../scripts/generate-contract.mjs";
import { createV20Hub } from "../helpers/v20-hub.mjs";

const generated = new URL(
  "../../apps/console/public/v20/api/contract.generated.js",
  import.meta.url,
);

test("the three browser operations match real Hub responses and preserve compatible added fields", async (t) => {
  assert.equal(
    new Set(Object.values(operations).map((x) => `${x.method} ${x.path}`)).size,
    3,
  );
  const api = await createV20Hub(t);
  const session = await api.login();
  assert.equal(validateResponse("sessionCreate", session.body), session.body);
  const response = await api.request(operations.snapshotRead.path, {
    headers: { Cookie: session.cookie },
  });
  const snapshot = await response.json();
  assert.equal(validateResponse("snapshotRead", snapshot), snapshot);
  validateResponse("snapshotRead", {
    ...snapshot,
    extension: { newField: true },
  });
  const end = await api.request(operations.sessionDelete.path, {
    method: "DELETE",
    headers: {
      Cookie: session.cookie,
      Origin: api.base,
      "X-Heal-CSRF": session.csrf,
    },
  });
  assert.equal(end.status, 200);
  validateResponse("sessionDelete", await end.json());
});

test("invalid snapshots are rejected without leaking source text", async (t) => {
  const api = await createV20Hub(t);
  const { body, cookie } = await api.login();
  const snapshot = body.snapshot;
  const mutations = [
    (x) => {
      delete x.project.repo;
    },
    (x) => {
      x.tasks = {};
    },
    (x) => {
      x.revision = -1;
    },
    (x) => {
      x.apiVersion = 999;
    },
    (x) => {
      delete x.auth;
    },
    (x) => {
      x.generatedAt = "invalid-secret-sentinel";
    },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(snapshot);
    mutate(value);
    assert.throws(
      () => validateResponse("snapshotRead", value),
      (error) => {
        assert.equal(error.code, "INVALID_RESPONSE");
        assert.doesNotMatch(error.message, /sentinel|secret|token/);
        return true;
      },
    );
  }
  const created = await api.request("/api/healing/trigger", {
    method: "POST",
    headers: {
      Cookie: cookie,
      "X-Heal-CSRF": body.snapshot.csrfToken,
      Origin: api.base,
    },
    body: { title: "Contract task", type: "format-error", priority: "medium" },
  });
  assert.equal(created.status, 201);
  const taskSnapshot = (await created.json()).snapshot;
  validateResponse("snapshotRead", taskSnapshot);
  taskSnapshot.tasks[0].status.progress = "100";
  assert.throws(() => validateResponse("snapshotRead", taskSnapshot), {
    code: "INVALID_RESPONSE",
  });
});

test("generated browser contract is deterministic and drift is rejected", async (t) => {
  const expected = await renderContract();
  assert.equal(await readFile(generated, "utf8"), expected);
  const browser = await import(generated);
  assert.deepEqual(browser.operations, operations);
  const api = await createV20Hub(t);
  const { body } = await api.login();
  browser.validateResponse("sessionCreate", body);
  const file = join(api.rootDir, "generated.js");
  await writeFile(file, expected + "\n// drift\n");
  await assert.rejects(checkContract(file), /out of date/);
  await writeFile(file, expected);
  await checkContract(file);
  assert.doesNotMatch(expected, /node:|\/worker\/|\/advanced\/runner|otlp/);
});
