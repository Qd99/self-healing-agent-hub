import { createServer } from "node:http";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { ConsoleError } from "./console-config.mjs";
import { createConsoleAuth } from "./console-auth.mjs";
import { createHealingService } from "./console-service.mjs";
import { checkGrafanaConnection } from "./grafana-connection.mjs";

const defaultRoot = fileURLToPath(new URL("../../../", import.meta.url));
const mediaTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function json(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(body);
}

function fail(response, status, code, message, headers) {
  json(response, status, { error: { code, message } }, headers);
}

function pathname(request) {
  let path;
  try {
    // Inspect the original path before a URL parser can normalize away '..'.
    path = decodeURIComponent((request.url ?? "/").split("?")[0]);
  } catch {
    throw new ConsoleError(400, "BAD_REQUEST", "Malformed request path.");
  }
  if (path.includes("\0"))
    throw new ConsoleError(400, "BAD_REQUEST", "Malformed request path.");
  if (
    !path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part.startsWith("."))
  ) {
    throw new ConsoleError(404, "NOT_FOUND", "Resource not found.");
  }
  return path;
}

function withinDirectory(root, path) {
  const difference = relative(root, path);
  return (
    difference === "" ||
    (difference !== ".." &&
      !difference.startsWith(`..${sep}`) &&
      !isAbsolute(difference))
  );
}

// Storage may not exist yet. Resolve the nearest existing ancestor so a
// symlinked parent cannot place new private state beneath the public tree.
async function canonicalPath(path) {
  const remaining = [];
  let current = resolve(path);
  for (;;) {
    try {
      return resolve(await realpath(current), ...remaining);
    } catch (error) {
      if (error.code !== "ENOENT")
        throw new ConsoleError(
          500,
          "STORAGE_PATH_INVALID",
          "无法验证服务目录，请检查路径与权限。",
        );
      try {
        await lstat(current);
        throw new ConsoleError(
          500,
          "STORAGE_PATH_INVALID",
          "服务目录包含失效的符号链接。",
        );
      } catch (present) {
        if (present.code !== "ENOENT") throw present;
      }
      const parent = dirname(current);
      if (parent === current)
        throw new ConsoleError(
          500,
          "STORAGE_PATH_INVALID",
          "无法验证服务目录。",
        );
      remaining.unshift(basename(current));
      current = parent;
    }
  }
}

async function staticFile(request, response, publicDir, path, privateDir) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    fail(
      response,
      405,
      "METHOD_NOT_ALLOWED",
      "Use GET or HEAD for console assets.",
      { Allow: "GET, HEAD" },
    );
    return;
  }
  const candidate = resolve(
    publicDir,
    `.${path === "/" ? "/index.html" : path}`,
  );
  const type = mediaTypes.get(extname(candidate).toLowerCase());
  if (!type) throw new ConsoleError(404, "NOT_FOUND", "Resource not found.");
  try {
    const [root, file] = await Promise.all([
      realpath(publicDir),
      realpath(candidate),
    ]);
    const within = relative(root, file);
    if (
      !within ||
      isAbsolute(within) ||
      withinDirectory(privateDir, file) ||
      within.split(sep).some((part) => part.startsWith(".")) ||
      !mediaTypes.has(extname(file).toLowerCase())
    ) {
      throw new ConsoleError(404, "NOT_FOUND", "Resource not found.");
    }
    if (!(await stat(file)).isFile())
      throw new ConsoleError(404, "NOT_FOUND", "Resource not found.");
    const body = await readFile(file);
    response.writeHead(200, {
      "Content-Type": type,
      "Content-Length": body.length,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch (error) {
    if (error instanceof ConsoleError) throw error;
    if (["ENOENT", "ENOTDIR", "EACCES", "ELOOP"].includes(error.code)) {
      throw new ConsoleError(404, "NOT_FOUND", "Resource not found.");
    }
    throw error;
  }
}

function requireMethod(request, method) {
  const allowed = Array.isArray(method) ? method : [method];
  if (!allowed.includes(request.method))
    throw Object.assign(
      new ConsoleError(
        405,
        "METHOD_NOT_ALLOWED",
        `Use ${allowed.join(" or ")} for this endpoint.`,
      ),
      { allow: allowed.join(", ") },
    );
}

/** Drain rejected requests, but never buffer unbounded or indefinitely slow JSON. */
function readBody(request) {
  const maxBytes = 1024 * 1024;
  if (
    !/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] || "")
  ) {
    request.resume();
    throw new ConsoleError(
      415,
      "JSON_REQUIRED",
      "请使用 application/json 提交请求。",
    );
  }
  if (Number(request.headers["content-length"]) > maxBytes) {
    request.resume();
    throw new ConsoleError(413, "BODY_TOO_LARGE", "请求内容超过 1 MiB 限制。");
  }
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    const timer = setTimeout(
      () => finish(new ConsoleError(408, "BODY_TIMEOUT", "请求内容读取超时。")),
      15_000,
    );
    function finish(error, value) {
      clearTimeout(timer);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
      if (error) {
        request.resume();
        reject(error);
      } else resolveBody(value);
    }
    function onData(chunk) {
      size += chunk.length;
      if (size > maxBytes)
        finish(
          new ConsoleError(413, "BODY_TOO_LARGE", "请求内容超过 1 MiB 限制。"),
        );
      else chunks.push(chunk);
    }
    function onError() {
      finish(new ConsoleError(400, "BODY_READ_ERROR", "无法读取请求内容。"));
    }
    function onAborted() {
      finish(new ConsoleError(400, "BODY_ABORTED", "请求已中断。"));
    }
    function onEnd() {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error();
        finish(null, value);
      } catch {
        finish(
          new ConsoleError(400, "INVALID_JSON", "请求必须是有效的 JSON 对象。"),
        );
      }
    }
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
  });
}

/** Same-origin management service. Execution is performed only by authenticated Agents. */
export function createConsoleServer({
  rootDir = defaultRoot,
  publicDir = join(rootDir, "apps/console/public"),
  dataDir = join(rootDir, ".healing"),
  consoleToken = "",
  workerToken = "",
  actor = "管理员",
  secureCookies = false,
  grafanaAllowedOrigins = [],
  grafanaToken = "",
  grafanaFetch = globalThis.fetch,
  clock = Date.now,
  leaseMs,
} = {}) {
  const assetRoot = resolve(publicDir);
  const storageRoot = resolve(dataDir);
  if (withinDirectory(assetRoot, storageRoot))
    throw new Error("The persistent data directory must be outside publicDir.");
  const service = createHealingService({
    rootDir: resolve(rootDir),
    dataDir: storageRoot,
    clock,
    ...(leaseMs === undefined ? {} : { leaseMs }),
  });
  const auth = createConsoleAuth({
    consoleToken,
    workerToken,
    actor,
    secureCookies,
    clock,
  });
  let shutdownPromise;
  let closingService;
  const closeService = () => (closingService ||= service.close());
  const server = createServer((request, response) => {
    void (async () => {
      const path = pathname(request);
      const [canonicalAssets, canonicalStorage] = await Promise.all([
        canonicalPath(assetRoot),
        canonicalPath(storageRoot),
      ]);
      if (withinDirectory(canonicalAssets, canonicalStorage))
        throw new ConsoleError(
          500,
          "UNSAFE_STORAGE_PATH",
          "持久数据目录不能位于静态资源目录内，包括符号链接目标。",
        );
      if (path !== "/api" && !path.startsWith("/api/")) {
        await staticFile(request, response, assetRoot, path, canonicalStorage);
        return;
      }
      if (!path.startsWith("/api/healing/"))
        throw new ConsoleError(404, "NOT_FOUND", "API route not found.");
      const route = path.slice("/api/healing".length);
      if (route === "/session") {
        requireMethod(request, ["POST", "DELETE"]);
        request.resume();
        if (request.method === "DELETE") {
          const cookie = auth.logout(request);
          json(
            response,
            200,
            { message: "已退出登录。" },
            { "Set-Cookie": cookie },
          );
        } else {
          const session = auth.login(request);
          const snapshot = auth.decorate(
            await service.snapshot(),
            session.identity,
          );
          json(
            response,
            200,
            { snapshot, message: "已连接管理服务。" },
            session.cookie ? { "Set-Cookie": session.cookie } : {},
          );
        }
        return;
      }
      if (route.startsWith("/worker/")) {
        const identity = auth.authenticateWorker(request);
        const target =
          /^\/worker\/tasks\/([^/]+)\/(heartbeat|proposal|complete|cancelled)$/.exec(
            route,
          );
        if (route !== "/worker/claim" && !target)
          throw new ConsoleError(
            404,
            "NOT_FOUND",
            "Agent API route not found.",
          );
        requireMethod(request, "POST");
        const body = await readBody(request);
        const result =
          route === "/worker/claim"
            ? await service.claim(body, identity)
            : await service[
                {
                  heartbeat: "heartbeat",
                  proposal: "proposal",
                  complete: "complete",
                  cancelled: "acknowledgeCancellation",
                }[target[2]]
              ](target[1], body, identity);
        json(response, 200, result);
        return;
      }
      const identity = auth.authenticate(request);
      if (route === "/snapshot") {
        requireMethod(request, "GET");
        request.resume();
        json(response, 200, auth.decorate(await service.snapshot(), identity));
        return;
      }
      const taskAction = /^\/tasks\/([^/]+)\/(cancel|retry)$/.exec(route);
      const decision = /^\/approvals\/([^/]+)\/decision$/.exec(route);
      const rule = /^\/rules\/([^/]+)$/.exec(route);
      if (
        ![
          "/trigger",
          "/tasks/bulk",
          "/monitoring",
          "/monitoring/check",
        ].includes(route) &&
        !taskAction &&
        !decision &&
        !rule
      )
        throw new ConsoleError(404, "NOT_FOUND", "API route not found.");
      requireMethod(
        request,
        rule ? "PATCH" : route === "/monitoring" ? "PUT" : "POST",
      );
      auth.assertWrite(request, identity);
      const body = await readBody(request);
      let result;
      if (route === "/monitoring/check") {
        const snapshot = await service.snapshot();
        const check = await checkGrafanaConnection(snapshot.monitoring, {
          allowedOrigins: grafanaAllowedOrigins,
          token: grafanaToken,
          fetchImpl: grafanaFetch,
        });
        // Bind this result to the configuration captured before the outbound
        // request; a concurrent save must not relabel a different connection.
        json(response, 200, {
          check,
          monitoring: snapshot.monitoring,
          revision: snapshot.revision,
        });
        return;
      }
      if (route === "/trigger")
        result = await service.trigger(body, identity.actor);
      else if (route === "/tasks/bulk")
        result = await service.bulk(body, identity.actor);
      else if (route === "/monitoring")
        result = await service.saveMonitoring(body, identity.actor);
      else if (taskAction)
        result = await service.taskAction(
          taskAction[1],
          taskAction[2],
          body,
          identity.actor,
        );
      else if (decision)
        result = await service.decide(decision[1], body, identity.actor);
      else if (rule)
        result = await service.toggleRule(rule[1], body, identity.actor);
      json(response, route === "/trigger" ? 201 : 200, {
        ...result,
        snapshot: auth.decorate(result.snapshot, identity),
      });
    })().catch((error) => {
      request.resume();
      if (response.headersSent || response.destroyed) {
        response.destroy();
        return;
      }
      const known =
        Number.isInteger(error.status) &&
        error.status >= 400 &&
        error.status <= 599 &&
        /^[A-Z][A-Z_0-9]+$/.test(error.code || "");
      if (known)
        fail(
          response,
          error.status,
          error.code,
          error.message,
          error.allow ? { Allow: error.allow } : undefined,
        );
      else
        fail(
          response,
          500,
          "INTERNAL_ERROR",
          "管理请求未能完成，请检查服务端状态。",
        );
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.on("close", () => {
    void closeService().catch(() => {});
  });
  server.shutdown = () =>
    (shutdownPromise ||= (async () => {
      if (server.listening) {
        await new Promise((resolveClose, reject) => {
          server.close((error) => (error ? reject(error) : resolveClose()));
          server.closeIdleConnections?.();
        });
      }
      await closeService();
    })());
  return server;
}
