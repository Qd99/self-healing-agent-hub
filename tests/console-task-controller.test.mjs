import test from "node:test";
import assert from "node:assert/strict";
import { createDemoSnapshot } from "../apps/console/public/data.js";
import { createTaskController } from "../apps/console/public/task-controller.js";
import {
  getTaskList,
  DEFAULT_TASK_FILTERS,
} from "../apps/console/public/task-model.js";

function harness(t, status = "failed") {
  class Control {
    constructor({
      id = "",
      dataset = {},
      value = "",
      tagName = "BUTTON",
    } = {}) {
      Object.assign(this, { id, dataset, value, tagName, disabled: false });
    }
    closest(selector) {
      return selector === ".tl-workspace" ? this : null;
    }
    focus() {
      document.activeElement = this;
    }
  }
  const controls = new Map();
  const globals = {
    Element: Control,
    HTMLInputElement: class extends Control {},
    CSS: { escape: (value) => value },
    localStorage: { getItem: () => null },
    document: {
      activeElement: null,
      querySelector: (selector) => controls.get(selector) || null,
    },
  };
  for (const [key, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, key, original);
      else delete globalThis[key];
    });
  }
  const snapshot = createDemoSnapshot();
  const failed = snapshot.tasks.find(
    (entry) => entry.status.status === "failed",
  );
  snapshot.tasks = Array.from({ length: 30 }, (_, index) => {
    const entry = structuredClone(failed);
    entry.task.id = `task-${index + 1}`;
    return entry;
  });
  const state = { view: "tasks", mode: "demo", snapshot };
  const messages = [];
  const renders = [];
  const controller = createTaskController({
    state,
    render() {
      controller.reconcile();
      document.activeElement = null;
      for (const [selector, control] of controls)
        controls.set(selector, new Control(control));
      renders.push({
        displayOpen: state.taskDisplayOpen,
        rowMenu: state.taskRowMenu,
      });
    },
    toast: (message) => messages.push(message),
    bulkDialog: { addEventListener() {} },
    setSnapshot: (next) => (state.snapshot = next),
  });
  state.taskFilters.status = status;
  state.taskPage = 2;
  state.selectedTaskIds = ["task-11", "task-12"];
  state.bulkResult = {
    type: "retry",
    applied: [{ id: "previous-task", newId: "retry-task" }],
    skipped: [],
  };
  return {
    state,
    controller,
    messages,
    renders,
    controls,
    control: (options) => new Control(options),
  };
}

for (const scenario of [
  {
    name: "reselecting the active status preserves task selection, page and result",
    status: "failed",
    control: { dataset: { action: "task-status-tab", status: "failed" } },
    focus: '[data-action="task-status-tab"][data-status="failed"]',
  },
  {
    name: "an unchanged detailed filter preserves task selection, page and result",
    status: "failed",
    control: { id: "task-filter-engine", value: "all", tagName: "SELECT" },
    focus: "#task-filter-engine",
    change: true,
  },
  {
    name: "resetting already-clear filters preserves task selection, page and result",
    status: "all",
    control: { dataset: { action: "task-filter-reset" } },
    focus: '[data-action="task-filter-toggle"]',
  },
]) {
  test(scenario.name, (t) => {
    const h = harness(t, scenario.status);
    const result = h.state.bulkResult;
    const target = h.control(scenario.control);
    h.controls.set(scenario.focus, h.control(scenario.control));
    document.activeElement = target;
    h.state.taskFilterOpen = true;
    if (!scenario.change) h.state.taskDisplayOpen = true;

    const handled = scenario.change
      ? h.controller.handleChange({ target })
      : h.controller.handleClick({ target }, target);

    assert.equal(handled, true);
    assert.deepEqual(h.state.selectedTaskIds, ["task-11", "task-12"]);
    assert.equal(h.state.taskPage, 2);
    assert.equal(h.state.bulkResult, result);
    assert.deepEqual(h.messages, []);
    assert.equal(h.state.taskFilterOpen, true);
    assert.deepEqual(h.renders, [{ displayOpen: false, rowMenu: "" }]);
    assert.equal(document.activeElement, h.controls.get(scenario.focus));
  });
}

test("a different status clears stale selection and results and returns to page one", (t) => {
  const h = harness(t);
  const target = h.control({
    dataset: { action: "task-status-tab", status: "completed" },
  });
  const focus = '[data-action="task-status-tab"][data-status="completed"]';
  h.controls.set(focus, h.control(target));
  document.activeElement = target;
  h.state.taskRowMenu = "task-11";

  assert.equal(h.controller.handleClick({ target }, target), true);

  assert.equal(h.state.taskFilters.status, "completed");
  assert.deepEqual(h.state.selectedTaskIds, []);
  assert.equal(h.state.taskPage, 1);
  assert.equal(h.state.bulkResult, null);
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0], /清空/);
  assert.deepEqual(h.renders, [{ displayOpen: false, rowMenu: "" }]);
  assert.equal(document.activeElement, h.controls.get(focus));
});

test("a dashboard type drill-down replaces unrelated filters and clears stale bulk context", (t) => {
  const h = harness(t);
  h.state.snapshot = createDemoSnapshot();
  Object.assign(h.state.taskFilters, {
    query: "old search",
    engine: "old-engine",
    branch: "old-branch",
    days: 90,
  });
  h.state.taskFilterOpen = true;
  h.state.taskDisplayOpen = true;
  h.state.taskRowMenu = "old-task";
  h.state.bulkPlan = { ids: ["old-task"] };
  h.state.bulkType = "retry";
  h.state.taskSort = "priority-desc";

  assert.equal(
    h.controller.applyReportFilter({
      dimension: "type",
      value: "type-error",
      days: 7,
    }),
    true,
  );

  assert.deepEqual(h.state.taskFilters, {
    ...DEFAULT_TASK_FILTERS,
    type: "type-error",
    days: 7,
  });
  assert.equal(
    getTaskList(h.state.snapshot.tasks, { filters: h.state.taskFilters }).total,
    10,
  );
  assert.deepEqual(h.state.selectedTaskIds, []);
  assert.equal(h.state.taskPage, 1);
  assert.equal(h.state.taskSort, "created-desc");
  assert.equal(h.state.bulkResult, null);
  assert.equal(h.state.bulkPlan, null);
  assert.equal(h.state.bulkType, "");
  assert.equal(h.state.taskFilterOpen, false);
  assert.equal(h.state.taskDisplayOpen, false);
  assert.equal(h.state.taskRowMenu, "");
  assert.deepEqual(h.renders, []);
});

test("dashboard status and engine drill-downs match the reported task subsets", (t) => {
  const h = harness(t);
  h.state.snapshot = createDemoSnapshot();
  const engine = h.state.snapshot.tasks.find(
    (item) => item.status.status === "running",
  ).engineId;
  assert.equal(
    h.controller.applyReportFilter({
      dimension: "status",
      value: "review",
      days: 7,
    }),
    true,
  );
  let result = getTaskList(h.state.snapshot.tasks, {
    filters: h.state.taskFilters,
  });
  assert.equal(result.total, 2);
  assert.ok(result.filtered.every((item) => item.reviewState === "pending"));
  assert.equal(
    h.controller.applyReportFilter({
      dimension: "engine",
      value: engine,
      days: 30,
    }),
    true,
  );
  result = getTaskList(h.state.snapshot.tasks, {
    filters: h.state.taskFilters,
  });
  assert.equal(result.total, 31);
  assert.ok(result.filtered.every((item) => item.engineId === engine));
  assert.equal(h.state.taskFilters.status, "all");
  assert.equal(h.state.taskFilters.days, 30);
});

test("a dashboard all-tasks entry keeps its time scope and starts a fresh selection", (t) => {
  const h = harness(t, "all");
  h.state.taskFilters.days = 1;
  assert.equal(
    h.controller.applyReportFilter({ dimension: "all", days: 1 }),
    true,
  );
  assert.deepEqual(h.state.taskFilters, { ...DEFAULT_TASK_FILTERS, days: 1 });
  assert.deepEqual(h.state.selectedTaskIds, []);
  assert.equal(h.state.taskPage, 1);
  assert.equal(h.state.bulkResult, null);
  assert.equal(
    h.controller.applyReportFilter({ dimension: "all", days: 999 }),
    true,
  );
  assert.equal(h.state.taskFilters.days, 7);
});

test("unsupported dashboard dimensions or unmatchable groups leave the task workspace untouched", (t) => {
  const h = harness(t);
  const before = structuredClone(h.state);
  for (const input of [
    { dimension: "query", value: "anything", days: 7 },
    { dimension: "status", value: "unknown", days: 7 },
    { dimension: "engine", value: "not-in-snapshot", days: 7 },
    { dimension: "type", value: "all", days: 7 },
    { dimension: "type", value: "unknown", days: 7 },
  ])
    assert.equal(h.controller.applyReportFilter(input), false);
  assert.deepEqual(h.state, before);
});
