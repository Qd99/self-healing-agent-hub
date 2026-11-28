import test from "node:test";
import assert from "node:assert/strict";
import { registry, parseRoute, routeHref } from "../public/v20/app/routes.js";

const pages = [
  "overview",
  "tasks",
  "requirements",
  "trace",
  "tests",
  "delivery",
  "jenkins",
  "monitor",
  "healing",
  "workers",
  "audit",
  "knowledge",
  "radar",
  "settings",
];

test("the confirmed prototype navigation has exactly 14 distinct V20 destinations", () => {
  assert.deepEqual(Object.keys(registry), pages);
  for (const page of pages)
    assert.equal(parseRoute(routeHref({ page })).page, page);
});

test("V20 keeps the old in-page bookmarks, including approval task links", () => {
  for (const [old, page] of Object.entries({
    approvals: "requirements",
    engines: "workers",
    rules: "settings",
    safety: "settings",
    metrics: "monitor",
    monitoring: "monitor",
    activity: "audit",
  })) {
    assert.equal(parseRoute(`#${old}`).page, page);
  }
  assert.equal(
    routeHref(parseRoute("#approvals?task=example")),
    "#tasks?task=example",
  );
});
