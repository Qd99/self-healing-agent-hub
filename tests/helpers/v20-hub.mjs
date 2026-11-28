import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConsoleServer } from "../../apps/healing-hub/src/console-server.mjs";

/** Real local HTTP and isolated state, with no inherited integration environment. */
export async function createV20Hub(t, options = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), "healing-v20-p1-"));
  let server;
  t.after(async () => {
    try {
      if (server) await server.shutdown();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
  await mkdir(join(rootDir, "configs"));
  for (const name of [
    "healing-config.example.json",
    "healing-rules.example.json",
  ]) {
    await copyFile(
      new URL(`../../configs/${name}`, import.meta.url),
      join(rootDir, "configs", name),
    );
  }
  const publicDir = options.publicDir ?? join(rootDir, "public");
  if (!options.publicDir) {
    await mkdir(join(publicDir, "v20"), { recursive: true });
    await writeFile(
      join(publicDir, "index.html"),
      "<!doctype html><title>Legacy fixture</title>",
    );
    await writeFile(
      join(publicDir, "v20/index.html"),
      "<!doctype html><title>V20 fixture</title>",
    );
  }
  const token = options.consoleToken ?? randomBytes(24).toString("hex");
  const workerToken = randomBytes(24).toString("hex");
  server = createConsoleServer({
    rootDir,
    publicDir,
    dataDir: join(rootDir, "data"),
    consoleToken: token,
    workerToken,
    clock: options.clock ?? Date.now,
    leaseMs: options.leaseMs,
    integrationsEnv: options.integrationsEnv ?? {},
    integrationsConfig: {},
    secureCookies: options.secureCookies ?? false,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { method = "GET", body, headers = {} } = {}) =>
    fetch(base + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const login = async () => {
    const response = await request("/api/healing/session", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Origin: base },
    });
    const body = await response.json();
    if (response.status !== 200) throw new Error("Fixture login failed");
    return {
      body,
      cookie: response.headers.get("set-cookie")?.split(";")[0],
      csrf: body.snapshot.csrfToken,
      response,
    };
  };
  return { rootDir, publicDir, base, token, workerToken, request, login };
}
