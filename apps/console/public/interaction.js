/** Visual acknowledgement only. Business results remain in their own controllers. */
export function installInteractionFeedback() {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const feedbackTimers = new WeakMap();
  const identityAttributes = new Set([
    "id",
    "data-action",
    "data-id",
    "data-nav",
    "data-tab",
    "data-value",
    "data-view",
    "data-filter",
    "data-mode",
    "data-command",
    "data-direction",
    "data-status",
    "data-column",
    "data-density",
    "data-format",
    "data-page",
    "data-scope",
  ]);
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target.closest("button, a[data-nav], summary");
      if (
        !target ||
        target.disabled ||
        target.getAttribute("aria-disabled") === "true"
      )
        return;
      const attributes = [...target.attributes].filter(({ name }) =>
        identityAttributes.has(name),
      );
      const selector = attributes.length
        ? target.tagName.toLowerCase() +
          attributes
            .map(
              ({ name, value }) =>
                `[${CSS.escape(name)}="${CSS.escape(value)}"]`,
            )
            .join("")
        : null;
      const label = target.textContent;
      // Resolve after the application handlers have replaced their DOM.
      requestAnimationFrame(() => {
        const candidates = selector
          ? [...document.querySelectorAll(selector)]
          : [];
        const element = target.isConnected
          ? target
          : candidates.find((candidate) => candidate.textContent === label) ||
            candidates[0];
        if (
          !element ||
          element.disabled ||
          element.getAttribute("aria-disabled") === "true"
        )
          return;
        clearTimeout(feedbackTimers.get(element));
        if (element.classList.contains("ui-click-feedback")) {
          element.classList.remove("ui-click-feedback");
          void element.offsetWidth;
        }
        element.classList.add("ui-click-feedback");
        feedbackTimers.set(
          element,
          setTimeout(
            () => element.classList.remove("ui-click-feedback"),
            reducedMotion.matches ? 180 : 420,
          ),
        );
      });
    },
    true,
  );
}
