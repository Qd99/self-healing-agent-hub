import test from "node:test";
import assert from "node:assert/strict";
import { installInteractionFeedback } from "../apps/console/public/interaction.js";

function control(attributes, label = "筛选") {
  const classes = new Set();
  return {
    tagName: "BUTTON",
    textContent: label,
    isConnected: true,
    disabled: false,
    attributes: Object.entries(attributes).map(([name, value]) => ({
      name,
      value,
    })),
    classList: {
      add: (value) => classes.add(value),
      remove: (value) => classes.delete(value),
      contains: (value) => classes.has(value),
    },
    closest() {
      return this;
    },
    getAttribute() {
      return null;
    },
    offsetWidth: 100,
  };
}

function harness(t, query) {
  const frames = [],
    microtasks = [],
    timers = [];
  let click;
  const values = {
    window: { matchMedia: () => ({ matches: false }) },
    document: {
      addEventListener(name, callback) {
        if (name === "click") click = callback;
      },
      querySelectorAll: query,
    },
    CSS: { escape: (value) => value },
    requestAnimationFrame: (callback) => frames.push(callback),
    queueMicrotask: (callback) => microtasks.push(callback),
    setTimeout: (callback) => timers.push(callback),
    clearTimeout: () => {},
  };
  for (const [key, value] of Object.entries(values)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
    t.after(() =>
      previous
        ? Object.defineProperty(globalThis, key, previous)
        : delete globalThis[key],
    );
  }
  installInteractionFeedback();
  return {
    click: (target) => click({ target }),
    checkpoint: () => {
      while (microtasks.length) microtasks.shift()();
    },
    paint: () => {
      while (frames.length) frames.shift()();
    },
    frames,
  };
}

test("pointer acknowledgement resolves the replacement after a capture/bubble microtask checkpoint", (t) => {
  const original = control({
    "data-action": "overview-tab",
    "data-tab": "running",
  });
  const replacement = control({
    "data-action": "overview-tab",
    "data-tab": "running",
  });
  const h = harness(t, () => [replacement]);
  h.click(original);
  h.checkpoint();
  original.isConnected = false;
  h.paint();
  assert.equal(replacement.classList.contains("ui-click-feedback"), true);
  assert.equal(original.classList.contains("ui-click-feedback"), false);
});

test("theme acknowledgement uses stable identity when the next theme changes", (t) => {
  const original = control(
    { "data-action": "theme", "data-theme": "dark" },
    "深色",
  );
  const replacement = control(
    { "data-action": "theme", "data-theme": "light" },
    "浅色",
  );
  let selector;
  const h = harness(t, (value) => {
    selector = value;
    return value.includes("data-theme") ? [] : [replacement];
  });
  h.click(original);
  h.checkpoint();
  original.isConnected = false;
  h.paint();
  assert.doesNotMatch(selector, /data-theme/);
  assert.equal(replacement.classList.contains("ui-click-feedback"), true);
});

test("disabled controls do not schedule acknowledgement", (t) => {
  const target = control({ "data-action": "refresh" });
  target.disabled = true;
  const h = harness(t, () => []);
  h.click(target);
  h.checkpoint();
  assert.equal(h.frames.length, 0);
});

test("a removed control without a replacement is ignored", (t) => {
  const target = control({ "data-action": "open-task", "data-id": "gone" });
  const h = harness(t, () => []);
  h.click(target);
  h.checkpoint();
  target.isConnected = false;
  assert.doesNotThrow(() => h.paint());
  assert.equal(target.classList.contains("ui-click-feedback"), false);
});
