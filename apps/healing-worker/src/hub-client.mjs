// Only these Hub protocol responses prove that this exact proposal was rejected.
// Authentication failures, gateway responses and idempotency conflicts do not.
const PROPOSAL_REJECTIONS = new Map([
  [400, new Set(["INVALID_REQUEST"])],
  [409, new Set(["STATE_CONFLICT"])],
  [
    422,
    new Set([
      "CANDIDATE_MISMATCH",
      "EVIDENCE_REQUIRED",
      "UNSAFE_CHANGE",
      "PROTECTED_PATH",
      "UNAPPROVED_CHANGE",
    ]),
  ],
]);
export function isDefinitiveProposalRejection(error) {
  return PROPOSAL_REJECTIONS.get(error?.status)?.has(error?.code) === true;
}
export async function boundedJson(response, maxBytes = 1024 * 1024) {
  const length = Number(response.headers.get("content-length"));
  if (length > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw Error("Response exceeds limit");
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw Error("Response exceeds limit");
      chunks.push(Buffer.from(value));
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Error("Invalid JSON response");
  }
}
export function createHubClient(
  config,
  { fetchImpl = fetch, timeoutMs = 30000 } = {},
) {
  async function request(route, body, { signal } = {}) {
    const json = JSON.stringify(body);
    if (Buffer.byteLength(json) > 1024 * 1024)
      throw Error("Hub request exceeds limit");
    const timeout = AbortSignal.timeout(timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${config.hub.url}/api/healing${route}`, {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${config.hub.token}`,
          "content-type": "application/json",
        },
        body: json,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      throw Error("Hub request unavailable");
    }
    if (!response.ok) {
      const error = Error(`Hub request rejected (${response.status})`);
      error.status = response.status;
      if (PROPOSAL_REJECTIONS.has(response.status)) {
        try {
          const body = await boundedJson(response, 16 * 1024);
          if (
            isDefinitiveProposalRejection({
              status: response.status,
              code: body?.error?.code,
            })
          )
            error.code = body.error.code;
        } catch {
          /* Unknown or oversized responses leave the outcome ambiguous. */
        }
      } else await response.body?.cancel().catch(() => {});
      throw error;
    }
    return boundedJson(response);
  }
  const client = {
    claim: (body, options) => request("/worker/claim", body, options),
  };
  for (const method of ["heartbeat", "proposal", "complete", "cancelled"])
    client[method] = (id, body, options) =>
      request(
        `/worker/tasks/${encodeURIComponent(id)}/${method}`,
        body,
        options,
      );
  return client;
}
