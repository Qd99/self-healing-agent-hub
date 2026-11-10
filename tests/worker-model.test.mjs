import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
async function server(t, handler) {
  const s = http.createServer(handler);
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  t.after(() => {
    s.closeAllConnections();
    return new Promise((r) => s.close(r));
  });
  return `http://127.0.0.1:${s.address().port}/chat`;
}
test("bounded HTTP model request sends selected context and parses strict changes", async (t) => {
  const { createModelClient } =
    await import("../apps/healing-worker/src/model-client.mjs");
  const endpoint = await server(t, async (req, res) => {
    let data = "";
    for await (const chunk of req) data += chunk;
    assert.equal(req.headers.authorization, "Bearer model-only");
    assert.match(data, /broken/);
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "Fix",
                changes: [{ path: "a", content: "good" }],
              }),
            },
          },
        ],
      }),
    );
  });
  const generate = createModelClient({
    endpoint,
    model: "fixture",
    token: "model-only",
  });
  assert.deepEqual(
    await generate({
      task: { id: "task" },
      failures: [],
      context: [{ path: "a", content: "broken" }],
    }),
    { summary: "Fix", changes: [{ path: "a", content: "good" }] },
  );
});
test("rejects oversized response, unknown model fields, redirects and times out", async (t) => {
  const { createModelClient } =
    await import("../apps/healing-worker/src/model-client.mjs");
  for (const mode of ["large", "claims", "redirect", "timeout"]) {
    const endpoint = await server(t, (req, res) => {
      if (mode === "timeout") return;
      if (mode === "redirect") {
        res.writeHead(302, { location: "http://127.0.0.1:1/secret" });
        res.end();
        return;
      }
      res.end(
        mode === "large"
          ? "x".repeat(300000)
          : JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      summary: "fake",
                      changes: [],
                      checksPass: ["all"],
                    }),
                  },
                },
              ],
            }),
      );
    });
    await assert.rejects(
      createModelClient({
        endpoint,
        model: "fixture",
        token: "secret",
        timeoutMs: 50,
      })({ task: {}, context: [], failures: [] }),
    );
  }
});
