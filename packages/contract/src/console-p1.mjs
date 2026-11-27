/** Authoritative, browser-safe P1 management operations. Existing v1 semantics remain intact. */
export const API_PREFIX = "/api/healing";
const operation = (method, route, response, auth) =>
  Object.freeze({ method, route, path: API_PREFIX + route, response, auth });
export const operations = Object.freeze({
  sessionCreate: operation(
    "POST",
    "/session",
    "session",
    "management-bearer-or-local",
  ),
  sessionDelete: operation(
    "DELETE",
    "/session",
    "message",
    "management-session-csrf-or-bearer-or-local",
  ),
  snapshotRead: operation(
    "GET",
    "/snapshot",
    "snapshot",
    "management-session-or-bearer-or-local",
  ),
});
