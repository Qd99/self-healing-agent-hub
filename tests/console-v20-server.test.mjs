import assert from "node:assert/strict";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createConsoleServer } from "../apps/healing-hub/src/console-server.mjs";

test("legacy and V20 assets share one authenticated, unchanged API v1", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "healing-v20-"));
  const publicDir = fileURLToPath(new URL("../apps/console/public/", import.meta.url));
  const configDir = join(rootDir, "configs");
  const token = "v20-test-only-console-token";
  let server;
  t.after(async () => {
    try {
      if (server?.listening) await server.shutdown();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
  await mkdir(configDir, { recursive: true });
  for (const name of ["healing-config.example.json", "healing-rules.example.json"]) {
    await copyFile(new URL(`../configs/${name}`, import.meta.url), join(configDir, name));
  }
  server = createConsoleServer({ rootDir, publicDir, consoleToken: token });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path, options) => fetch(base + path, options);

  const unauthenticated = await get("/api/healing/snapshot");
  assert.equal(unauthenticated.status, 401);
  const auth = { Authorization: `Bearer ${token}` };
  const snapshot = async () => {
    const response = await get("/api/healing/snapshot", { headers: auth });
    assert.equal(response.status, 200);
    return response.json();
  };
  const before = await snapshot();
  assert.equal(before.apiVersion, 1);
  assert.equal(before.mode, "live");

  for (const [path, name] of [
    ["/", "index.html"],
    ["/console-v20.html", "console-v20.html"],
    ["/v20-compatible.css", "v20-compatible.css"],
    ["/app.js", "app.js"],
    ["/api-client.js", "api-client.js"],
  ]) {
    const response = await get(path);
    assert.equal(response.status, 200, path);
    assert.equal(await response.text(), await readFile(join(publicDir, name), "utf8"), path);
  }
  // The same browser session must work from both entry URLs. Neither page
  // may bypass CSRF merely because the presentation variant changed.
  const login = await get("/api/healing/session", {
    method: "POST",
    headers: auth,
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get("set-cookie");
  assert.match(setCookie || "", /HttpOnly/i);
  assert.match(setCookie || "", /SameSite=Strict/i);
  const cookie = setCookie.split(";")[0];
  const session = (await login.json()).snapshot;
  assert.ok(session.csrfToken);
  for (const page of ["/", "/console-v20.html"]) {
    const response = await get("/api/healing/snapshot", {
      headers: { Cookie: cookie, Referer: base + page },
    });
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.equal(value.apiVersion, 1);
    assert.equal(value.csrfToken, session.csrfToken);
    assert.deepEqual(value.tasks, before.tasks);
    const blocked = await get("/api/healing/trigger", {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: base,
        Referer: base + page,
        "Content-Type": "application/json",
        "X-Heal-CSRF": "incorrect-token",
      },
      body: JSON.stringify({ title: "must not run", type: "ci-failure", priority: "high" }),
    });
    assert.equal(blocked.status, 403);
  }
  const after = await snapshot();
  for (const key of ["apiVersion", "mode", "revision", "capabilities", "project", "tasks", "activity"]) {
    assert.deepEqual(after[key], before[key], key);
  }
  const stillDenied = await get("/api/healing/snapshot");
  assert.equal(stillDenied.status, 401);
});
