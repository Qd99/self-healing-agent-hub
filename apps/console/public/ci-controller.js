/** CI actions use the application's mutation guard; feedback follows its task/draft. */
export function createCiController({
  state,
  api,
  runMutation,
  refreshWorkspace,
}) {
  const can = (key) =>
    state.mode === "live" &&
    !state.authRequired &&
    !state.pendingAction &&
    state.snapshot?.capabilities?.[key] === true;
  const project = () => state.snapshot?.project?.id;
  function importBuild(values) {
    const source = state.snapshot?.integrations?.jenkins;
    if (!can("importCi") || !source?.configured) return;
    if (
      state.ciImportDraft?.sourceId &&
      state.ciImportDraft.sourceId !== source.sourceId
    ) {
      state.ciImportError = "Jenkins 来源已更新，请重新打开导入窗口后核对。";
      refreshWorkspace();
      return;
    }
    const raw = String(values.buildNumber ?? "").trim(),
      buildNumber = Number(raw);
    state.ciImportDraft = { sourceId: source.sourceId, buildNumber: raw };
    state.ciImportResult = null;
    if (
      !/^[0-9]+$/.test(raw) ||
      !Number.isSafeInteger(buildNumber) ||
      buildNumber < 1
    ) {
      state.ciImportError = "请输入大于 0 的整数构建号。";
      refreshWorkspace();
      return;
    }
    state.ciImportError = "";
    const submitted = JSON.stringify(state.ciImportDraft),
      projectId = project();
    const current = () =>
      state.mode === "live" &&
      project() === projectId &&
      JSON.stringify(state.ciImportDraft) === submitted;
    void runMutation(
      "ci-import",
      () => api.importCiBuild({ sourceId: source.sourceId, buildNumber }),
      {
        onSuccess(result) {
          if (!current()) return false;
          state.ciImportError = "";
          state.ciImportResult = {
            outcome: result.outcome,
            taskId: result.taskId,
            message: result.message,
          };
          return false;
        },
        onError(error) {
          if (current()) state.ciImportError = error.message;
        },
      },
    );
  }
  function verifyTask(id) {
    const item = state.snapshot?.tasks.find((entry) => entry.task.id === id);
    if (
      !can("verifyResult") ||
      state.selectedTask !== id ||
      !state.snapshot.integrations?.verification?.configured ||
      item?.proposal?.version !== 2 ||
      !Number.isSafeInteger(item.result?.changes?.pr) ||
      item.result.changes.pr < 1 ||
      !/^[a-f0-9]{40}$/i.test(item.result?.changes?.commit || "")
    )
      return;
    const projectId = project(),
      proposalId = item.proposal.id;
    const current = () =>
      state.mode === "live" &&
      project() === projectId &&
      state.selectedTask === id &&
      state.snapshot.tasks.find((entry) => entry.task.id === id)?.proposal
        ?.id === proposalId;
    state.ciVerificationFeedback = { taskId: id, error: "", message: "" };
    void runMutation(
      `verify:${id}`,
      () => api.verifyTask(id, { expectedRevision: item.revision }),
      {
        onSuccess(result) {
          if (!current()) return false;
          const latest = state.snapshot.tasks.find(
            (entry) => entry.task.id === id,
          )?.verification;
          const received = result.snapshot?.tasks?.find(
            (entry) => entry.task.id === id,
          )?.verification;
          // The application's revision gate owns evidence; this controller only sets text.
          const matching =
            latest &&
            received &&
            JSON.stringify(latest) === JSON.stringify(received);
          state.ciVerificationFeedback = {
            taskId: id,
            error: "",
            message: matching
              ? "已读取最新 PR 与 CI 证据。"
              : "任务记录已更新，请以最新证据为准，需要时重新核验。",
          };
          return false; // HTTP 200 can report pending/failed; do not imply success.
        },
        onError(error) {
          if (current())
            state.ciVerificationFeedback = {
              taskId: id,
              error: error.message,
              message: "",
            };
        },
      },
    );
  }
  function reset() {
    state.ciImportDraft = null;
    state.ciImportError = "";
    state.ciImportResult = null;
    state.ciVerificationFeedback = null;
    state.createMode = "task";
  }
  return { importBuild, verifyTask, reset };
}
