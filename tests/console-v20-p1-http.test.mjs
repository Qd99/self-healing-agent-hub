import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { createV20Hub } from "./helpers/v20-hub.mjs";
import { operations } from "../packages/contract/src/console-p1.mjs";
import { validateResponse } from "../packages/contract/src/validate.mjs";

function rawRequest(base, path) {
  const address = new URL(base);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { hostname: address.hostname, port: address.port, path },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () =>
          resolve({ status: response.statusCode, body }),
        );
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end();
  });
}

test("P1 entry has explicit index routing, preserves a proxy prefix and stays read-only", async (t) => {
  const api = await createV20Hub(t);
  const redirect = await fetch(api.base + "/v20?tab=tasks", {
    redirect: "manual",
  });
  assert.equal(redirect.status, 307);
  assert.equal(
    new URL(
      redirect.headers.get("location"),
      "https://site.invalid/healing/v20?tab=tasks",
    ).href,
    "https://site.invalid/healing/v20/?tab=tasks",
  );
  const response = await api.request("/v20/");
  assert.equal(response.status, 200);
  assert.equal(
    await response.text(),
    await readFile(join(api.publicDir, "v20/index.html"), "utf8"),
  );
  assert.equal(
    await (await api.request("/v20/", { method: "HEAD" })).text(),
    "",
  );
  assert.equal((await api.request("/v20/", { method: "POST" })).status, 405);
  assert.equal((await api.request("/v20", { method: "POST" })).status, 405);
  assert.equal((await api.request("/v20/api/healing/snapshot")).status, 404);
  await mkdir(join(api.rootDir, "data"), { recursive: true });
  await writeFile(
    join(api.rootDir, "data/private.json"),
    '{"private":"must-never-render"}',
  );
  await symlink(
    join(api.rootDir, "data/private.json"),
    join(api.publicDir, "v20/private.json"),
  );
  await symlink(
    join(api.publicDir, "absent.json"),
    join(api.publicDir, "v20/broken.json"),
  );
  for (const path of [
    "/v20/private.json",
    "/v20/broken.json",
    "/v20/%2e%2e/data/private.json",
    "/v20/%00/index.html",
  ]) {
    const value = await rawRequest(api.base, path);
    assert.ok([400, 404].includes(value.status), path);
    assert.doesNotMatch(value.body, /must-never-render/);
  }
});

test("P1 uses the unchanged real session, Origin and CSRF contract", async (t) => {
  const api = await createV20Hub(t);
  assert.equal((await api.request(operations.snapshotRead.path)).status, 401);
  assert.equal(
    (
      await api.request(operations.sessionCreate.path, {
        method: "POST",
        headers: { Authorization: "Bearer wrong" },
      })
    ).status,
    401,
  );
  const login = await api.login();
  validateResponse("sessionCreate", login.body);
  assert.match(
    login.response.headers.get("set-cookie"),
    /HttpOnly; SameSite=Strict/,
  );
  assert.match(login.response.headers.get("set-cookie"), /Path=\/api\/healing/);
  const headers = { Cookie: login.cookie, Origin: api.base };
  const snap = await api.request(operations.snapshotRead.path, { headers });
  const before = await snap.json();
  validateResponse("snapshotRead", before);
  for (const path of ["/", "/v20/", "/v20/index.html"])
    assert.equal((await api.request(path)).status, 200);
  const after = await (
    await api.request(operations.snapshotRead.path, { headers })
  ).json();
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.tasks, before.tasks);
  assert.equal(
    (
      await api.request(operations.sessionDelete.path, {
        method: "DELETE",
        headers,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await api.request(operations.sessionDelete.path, {
        method: "DELETE",
        headers: {
          ...headers,
          Origin: "https://other.invalid",
          "X-Heal-CSRF": login.csrf,
        },
      })
    ).status,
    403,
  );
  const end = await api.request(operations.sessionDelete.path, {
    method: "DELETE",
    headers: { ...headers, "X-Heal-CSRF": login.csrf },
  });
  assert.equal(end.status, 200);
  validateResponse("sessionDelete", await end.json());
  assert.equal(
    (await api.request(operations.snapshotRead.path, { headers })).status,
    401,
  );
});

test("snapshot keeps the existing once-only lease expiration semantics", async (t) => {
  let time = Date.now();
  const api = await createV20Hub(t, { clock: () => time, leaseMs: 1000 });
  const login = await api.login();
  const headers = {
    Cookie: login.cookie,
    Origin: api.base,
    "X-Heal-CSRF": login.csrf,
  };
  const created = await api.request("/api/healing/trigger", {
    method: "POST",
    headers,
    body: {
      title: "P1 expiry check",
      type: "format-error",
      priority: "medium",
    },
  });
  assert.equal(created.status, 201);
  const { taskId } = await created.json();
  const claim = await api.request("/api/healing/worker/claim", {
    method: "POST",
    headers: { Authorization: `Bearer ${api.workerToken}` },
    body: { engineId: "fast", workerId: "p1-test-worker" },
  });
  assert.equal(claim.status, 200);
  assert.ok((await claim.json()).lease);
  time += 1001;
  const expired = await (
    await api.request(operations.snapshotRead.path, { headers })
  ).json();
  const entry = expired.tasks.find((x) => x.task.id === taskId);
  assert.equal(entry.status.status, "failed");
  assert.equal(entry.result.error.code, "LEASE_EXPIRED");
  const again = await (
    await api.request(operations.snapshotRead.path, { headers })
  ).json();
  assert.equal(again.revision, expired.revision);
});

test("the legacy tokenless local mode remains explicit in the API", async (t) => {
  const api = await createV20Hub(t, { consoleToken: "" });
  const response = await api.request(operations.snapshotRead.path);
  assert.equal(response.status, 200);
  const value = await response.json();
  validateResponse("snapshotRead", value);
  assert.equal(value.auth.required, false);
});
