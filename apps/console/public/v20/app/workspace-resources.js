const request = (key, action, query) => ({ key, action, query });

export function monitorSelection(record, configuredNames = []) {
  const [metric, range, namespace] = (record || "").split(":", 3);
  return {
    metric: ["cpu", "memory", "restarts"].includes(metric) ? metric : "cpu",
    range: ["15m", "1h", "6h"].includes(range) ? range : "1h",
    namespace: configuredNames.includes(namespace)
      ? namespace
      : configuredNames[0],
  };
}
export function requirementsSelection(record) {
  const [
    mode = "issues",
    state = "open",
    page = "1",
    number = "",
    commentsPage = "1",
  ] = (record || "").split(":", 5);
  return {
    mode: mode === "prs" ? "prs" : "issues",
    state: ["all", "open", "closed"].includes(state) ? state : "open",
    page: /^[1-9][0-9]?$|^100$/.test(page) ? Number(page) : 1,
    number: /^[1-9][0-9]{0,9}$/.test(number) ? Number(number) : null,
    commentsPage: /^[1-9][0-9]?$|^100$/.test(commentsPage)
      ? Number(commentsPage)
      : 1,
  };
}
export const advancedPage = (record) =>
  /^(?:[1-9][0-9]{0,3}|10000)$/.test(record ?? "") ? Number(record) : 1;
export function workspaceRequests(route, snapshot) {
  if (!snapshot) return [];
  const r = route.record;
  // Autoloop is the live workbench ledger. Pages that show real activity read
  // it directly instead of implying the Hub snapshot already contains it.
  const autoloop = () => [request("autoloop", "autoloopRead")];
  switch (route.page) {
    case "overview":
      return autoloop();
    case "requirements": {
      const { mode, state, page, number, commentsPage } =
        requirementsSelection(r);
      const pr = mode === "prs";
      return [
        request("items", pr ? "githubPrs" : "githubIssues", { state, page }),
        ...(number
          ? [
              request("detail", pr ? "githubPr" : "githubIssue", {
                number,
                page: commentsPage,
              }),
            ]
          : []),
      ];
    }
    case "trace": {
      const job = r?.startsWith("job:") ? r.slice(4) : null;
      const workflow = r?.startsWith("workflow:") ? r.slice(9) : null;
      const valid = (x) =>
        typeof x === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(x);
      return [
        ...autoloop(),
        request("profiles", "profilesRead"),
        request("jobs", "jobsRead"),
        request("trace", "traceRead", valid(workflow) ? { workflow } : {}),
        ...(valid(job) ? [request("job", "jobRead", { id: job })] : []),
      ];
    }
    case "tests": {
      const page = advancedPage(r);
      return [
        request("jobs", "jobsRead", { page }),
        request("evidence", "evidenceRead", { page }),
        request("effects", "effectsRead", { page }),
        request("cases", "zentaoRead", { page: Math.min(page, 100) }),
        request("reports", "recordsRead", { kind: "test-run", page }),
      ];
    }
    case "monitor": {
      const query = monitorSelection(
        r,
        Array.isArray(snapshot.monitoring?.namespaces)
          ? snapshot.monitoring.namespaces
          : [],
      );
      return [
        request("metrics", "metricsRead", query),
        request("alerts", "alertsRead", { namespace: query.namespace }),
      ];
    }
    case "workers":
      return [
        ...autoloop(),
        request("samples", "samplesRead", { page: advancedPage(r) }),
        request("runner", "runnerRead"),
      ];
    case "healing":
      return autoloop();
    case "audit":
      return autoloop();
    case "knowledge":
      return [
        request("knowledge", "recordsRead", {
          kind: "knowledge",
          page: advancedPage(r),
        }),
        request("evaluation", "recordsRead", {
          kind: "evaluation",
          page: advancedPage(r),
        }),
      ];
    case "radar":
      return [
        request("radar", "recordsRead", {
          kind: "radar",
          page: advancedPage(r),
        }),
      ];
    case "settings":
      return [request("runner", "runnerRead"), request("feishu", "feishuRead")];
    default:
      return [];
  }
}
function errorState(error) {
  if (["WORKBENCH_UNCONFIGURED", "ADVANCED_DISABLED"].includes(error?.code))
    return "unconfigured";
  if ([401, 403].includes(error?.status)) return "forbidden";
  if (error?.status === 404) return "missing";
  return "error";
}
export function createWorkspaceLoader({
  api,
  onChange,
  onUnauthorized = () => {},
}) {
  let controller,
    key,
    value = {};
  return {
    state: () => value,
    change(nextKey, specs) {
      if (key === nextKey) return;
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      key = nextKey;
      value = Object.fromEntries(
        specs.map(({ key: item }) => [item, { state: "loading" }]),
      );
      for (const spec of specs) {
        void Promise.resolve()
          .then(() =>
            signal.aborted
              ? null
              : api.readExisting(spec.action, { query: spec.query, signal }),
          )
          .then(
            (data) => {
              if (signal.aborted) return;
              value = { ...value, [spec.key]: { state: "ready", value: data } };
              onChange();
            },
            (error) => {
              if (signal.aborted) return;
              if (
                error?.status === 401 &&
                error.code === "AUTH_REQUIRED" &&
                !["runnerRead", "feishuRead"].includes(spec.action)
              ) {
                onUnauthorized();
                return;
              }
              value = { ...value, [spec.key]: { state: errorState(error) } };
              onChange();
            },
          );
      }
    },
    dispose() {
      controller?.abort();
      value = {};
      key = undefined;
    },
  };
}
