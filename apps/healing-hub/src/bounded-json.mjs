import { HealingError } from "./console-store.mjs";
export const upstreamError = () =>
  new HealingError(
    502,
    "UPSTREAM_UNAVAILABLE",
    "上游读取未能完成，请检查服务配置与权限。",
  );
/** One budget/deadline covers the entire logical read, including every page. */
export function createJsonReader({
  fetchImpl = globalThis.fetch,
  origin,
  headers = {},
  timeoutMs = 10000,
}) {
  let count = 0,
    total = 0;
  const controller = new AbortController();
  let rejectDeadline;
  const deadline = new Promise((_, reject) => {
    rejectDeadline = reject;
  });
  const timer = setTimeout(
    () => {
      controller.abort();
      rejectDeadline(upstreamError());
    },
    Math.min(timeoutMs, 10000),
  );
  deadline.catch(() => {});
  async function get(url) {
    try {
      const target = new URL(url);
      if (
        target.origin !== origin ||
        target.username ||
        target.password ||
        ++count > 8
      )
        throw upstreamError();
      return await Promise.race([
        deadline,
        (async () => {
          const response = await fetchImpl(target.href, {
            method: "GET",
            headers,
            redirect: "error",
            signal: controller.signal,
          });
          if (
            !response.ok ||
            response.redirected ||
            (response.url && new URL(response.url).origin !== origin)
          )
            throw upstreamError();
          if (Number(response.headers.get("content-length")) > 262144)
            throw upstreamError();
          const chunks = [];
          let bytes = 0;
          for await (const chunk of response.body ?? []) {
            bytes += chunk.length;
            total += chunk.length;
            if (bytes > 262144 || total > 1048576) {
              controller.abort();
              throw upstreamError();
            }
            chunks.push(Buffer.from(chunk));
          }
          return {
            data: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            link: response.headers.get("link"),
          };
        })(),
      ]);
    } catch {
      throw upstreamError();
    }
  }
  return {
    get,
    close() {
      clearTimeout(timer);
      controller.abort();
    },
  };
}
