/** Test-only shape; the contract suite separately validates actual Hub responses. */
export function snapshot(overrides = {}) {
  return {
    apiVersion: 1,
    mode: "live",
    revision: 1,
    project: { id: "test", repo: "test/repository", defaultBranch: "main" },
    auth: { required: true, actor: "Test operator" },
    storage: { status: "ready" },
    generatedAt: "2026-11-27T01:00:00.000Z",
    csrfToken: "test-only-csrf",
    capabilities: { trigger: true, cancel: true, retry: true },
    tasks: [],
    engines: [],
    activity: [],
    ...overrides,
  };
}
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
export function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}
