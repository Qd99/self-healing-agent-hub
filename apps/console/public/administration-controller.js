import { applyDemoAction } from "./data.js";
import {
  DEFAULT_ACTIVITY_FILTERS,
  DEFAULT_RULE_FILTERS,
  ACTIVITY_CATEGORIES,
  canUpdateRules,
  exportActivitiesJSON,
  filterActivities,
} from "./administration-model.js";

const searchFields = {
  "activity-search": "activityFilters",
  "rules-search": "ruleFilters",
};

export function createAdministrationController({
  state,
  render,
  toast,
  openRule,
  setSnapshot,
}) {
  function reconcile() {
    state.activityFilters = {
      ...DEFAULT_ACTIVITY_FILTERS,
      ...state.activityFilters,
    };
    state.ruleFilters = { ...DEFAULT_RULE_FILTERS, ...state.ruleFilters };
  }
  reconcile();

  // Keep the original search node across renders so CJK composition and the caret survive.
  function redraw(preferredId = "") {
    const active =
      typeof document === "undefined" ? null : document.activeElement;
    const searchNode =
      active && Object.hasOwn(searchFields, active.id) ? active : null;
    const id = preferredId || active?.id;
    const selection = searchNode
      ? [searchNode.selectionStart, searchNode.selectionEnd]
      : null;
    render();
    if (typeof document === "undefined") return;
    if (searchNode)
      document.getElementById(searchNode.id)?.replaceWith(searchNode);
    const target = id ? document.getElementById(id) : null;
    target?.focus({ preventScroll: true });
    if (selection && target === searchNode)
      try {
        target.setSelectionRange(...selection);
      } catch {}
  }

  function handleInput(event) {
    const key = searchFields[event.target?.id];
    if (!key || !Object.hasOwn(searchFields, event.target.id)) return false;
    state[key].query = String(event.target.value || "");
    if (!event.isComposing) redraw(event.target.id);
    return true;
  }

  function handleChange(event) {
    const id = event.target?.id,
      value = event.target?.value;
    if (id === "activity-category") {
      state.activityFilters.category = ACTIVITY_CATEGORIES.some(
        (x) => x.value === value,
      )
        ? value
        : "all";
    } else if (id === "activity-days") {
      state.activityFilters.days = [0, 1, 7, 30, 90].includes(Number(value))
        ? Number(value)
        : 0;
    } else if (id === "rules-status") {
      state.ruleFilters.status = ["all", "enabled", "disabled"].includes(value)
        ? value
        : "all";
    } else if (id === "rules-engine") {
      state.ruleFilters.engine =
        value === "all" ||
        state.snapshot?.rules.some((x) => x.processor?.engine === value)
          ? value
          : "all";
    } else return false;
    redraw(id);
    return true;
  }

  function handleClick(event, button) {
    if (!button || button.disabled) return false;
    const { action, id } = button.dataset || {};
    if (action === "rule-detail") {
      if (state.snapshot?.rules.some((rule) => rule.id === id)) openRule(id);
      else toast("这条路由规则已不存在。");
    } else if (action === "toggle-rule") {
      if (!canUpdateRules(state)) {
        toast("当前规则只读，请在服务端配置中修改。");
        return true;
      }
      try {
        const fromDetail = Boolean(button.closest?.("#detail-dialog"));
        const next = applyDemoAction(state.snapshot, {
          type: "toggle-rule",
          id,
        });
        setSnapshot(next);
        redraw();
        if (fromDetail) openRule(id);
        else if (typeof document !== "undefined") {
          const matching = [
            ...document.querySelectorAll('[data-action="toggle-rule"]'),
          ].find((node) => node.dataset.id === id);
          (matching || document.getElementById("rules-status"))?.focus({
            preventScroll: true,
          });
        }
        toast(next.activity[0].message);
      } catch (error) {
        toast(error.message || "无法更新演示规则。");
      }
    } else if (action === "activity-reset") {
      state.activityFilters = { ...DEFAULT_ACTIVITY_FILTERS };
      redraw("activity-search");
    } else if (action === "rules-reset") {
      state.ruleFilters = { ...DEFAULT_RULE_FILTERS };
      redraw("rules-search");
    } else if (
      action === "administration-export" ||
      (action === "export" && state.view === "activity")
    ) {
      if (!state.snapshot) return true;
      const now = Date.now();
      const count = filterActivities(state.snapshot.activity, {
        ...state.activityFilters,
        now,
      }).length;
      if (!count) {
        toast("当前筛选下没有可导出的操作记录。");
        return true;
      }
      const blob = new Blob(
        [exportActivitiesJSON(state.snapshot, state.activityFilters, { now })],
        { type: "application/json;charset=utf-8" },
      );
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `heal-operations-${state.mode}-${new Date(now).toISOString().slice(0, 10)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast(`已导出当前筛选的 ${count} 条操作记录。`);
    } else return false;
    event.preventDefault?.();
    return true;
  }

  function reset() {
    state.activityFilters = { ...DEFAULT_ACTIVITY_FILTERS };
    state.ruleFilters = { ...DEFAULT_RULE_FILTERS };
  }

  return {
    handleClick,
    handleInput,
    handleCompositionEnd: handleInput,
    handleChange,
    reconcile,
    onNavigate: reconcile,
    reset,
  };
}
