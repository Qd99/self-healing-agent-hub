import { relative } from "node:path";

// Only result metadata is emitted. Never write assertion values, stdout, stderr,
// environment variables, stack traces, prompts or model responses into a report.
export default async function* report(source) {
  for await (const event of source) {
    const d = event.data || {};
    if (event.type === "test:summary" && !d.file) {
      yield JSON.stringify({ type: "summary", success: d.success === true }) + "\n";
      continue;
    }
    if (!["test:pass", "test:fail"].includes(event.type) || d.details?.type === "suite") continue;
    const failureType = d.details?.error?.failureType;
    let result = event.type === "test:pass" ? "pass" : failureType === "testCodeFailure" ? "fail" : failureType === "testTimeoutFailure" ? "timeout" : failureType === "cancelledByParent" ? "cancelled" : "error";
    if (d.skip || d.todo) result = "skip";
    const file = typeof d.file === "string" ? relative(process.cwd(), d.file) : "unknown";
    const name = String(d.name || "Unnamed test").slice(0, 350);
    const elapsed = d.details?.duration_ms;
    const id = (file + ":" + (d.line || 0) + ":" + (d.column || 0) + "::" + name).slice(0, 500);
    yield JSON.stringify({ type: "result", id, name, result, durationMs: Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= 86400000 ? Math.round(elapsed) : null, error: ["fail", "error", "timeout", "cancelled"].includes(result) ? String(failureType || "test-process-error").slice(0, 200) : "" }) + "\n";
  }
}
