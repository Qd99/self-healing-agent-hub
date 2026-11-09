# Agent Console Implementation Plan

> **For agentic workers:** use superpowers:executing-plans for the main UI; independent gateway work is delegated with explicit file boundaries.

**Goal:** deliver a polished, interactive management console aligned with the existing framework, plus screenshots and an honest connection boundary.

**Architecture:** same-origin browser ES modules consume one snapshot contract. A Node HTTP gateway reads existing config and exposes capabilities. A separate, explicit in-memory demo provider permits design review without an execution engine.

**Tech Stack:** Node >=18 built-ins, browser JavaScript/CSS, existing TypeScript model contracts.

**Spec:** `docs/superpowers/specs/2026-11-09-agent-console-design.md`

## 2026-11-09 implementation status and v2 direction

The gateway, transport types, interactive frontend, demo model, package commands, and Chinese usage guide are implemented. The complete Node test suite has 40 passing tests. Dependencies are installed; final typecheck, build, and syntax checks pass.

The user's visual correction supersedes the initial KPI-card direction: v2 uses a task inbox, inline diff previews, restrained graphite/gray styling, and a narrow summary rail. The primary workflow is reviewing work that needs attention. It avoids large gradient charts and rows of dashboard cards. See `docs/console-guide.md` for the current design and runtime boundaries.

Browser QA, captured UI images, independent final review and private preview publication are complete. Branch push and Draft PR delivery are recorded at handoff. No execution engine, queue, GitHub writes, real approval, or rollback has been connected.

## Global constraints

- Preserve original framework types and configuration templates.
- Never send credentials to the browser; publish only allowlisted config fields.
- Real mode cannot silently substitute demo data.
- No execution engine means no real trigger/cancel/approval; return 501.
- Use a feature branch and Draft PR; no merge and no CI configuration changes.

## Review focus

- Missing or invalid actual config must have an explicit error or example-source label.
- Malformed or untrusted task text must not become active HTML.
- A failed connection or mutation must not report success.
- Filters and time ranges must affect the displayed data consistently.
- Keyboard dialogs and narrow screens must remain usable.

## Task 1: Management gateway and model contract

Files: `apps/healing-hub/src/index.mjs`, `apps/healing-hub/src/console-server.mjs`, `packages/framework/src/types/console.ts`, `tests/console-server.test.mjs`.

- [x] Add meaningful HTTP tests for safe snapshot projection, missing config, blocked writes, and static path isolation.
- [x] Implement `createConsoleServer({ rootDir, publicDir })`, default localhost startup, GET snapshot, and 501 responses for unimplemented writes.
- [x] Reuse existing types in `console.ts`; define the serialized transport and UI extension fields separately.
- [x] Run `node --test tests/console-server.test.mjs` to GREEN (21 tests).

## Task 2: Design and interactive frontend

Files: `apps/console/public/index.html`, `styles.css`, `app.js`, `views.js`, `data.js`, `icons.js`, `model.js`, `tests/console-model.test.mjs`.

- [x] Write and run RED tests for derived statistics, filtering, and safe text rendering.
- [x] Build the v2 task-inbox shell, overview, tasks/detail, engines, rules, safety, activity, and settings.
- [x] Add explicit demo provider, same-origin live provider, and error/empty/loading feedback.
- [x] Add theme, search, keyboard shortcuts, detail drawer and simulated task actions.
- [x] Run model tests to GREEN (19 tests), including live-mode write rejection and immutable retry/cancel behavior.
- [x] Verify actual browser interactions, dialog focus, keyboard navigation, dark mode, and 390px narrow-screen behavior.

## Task 3: Delivery and verification

Files: `scripts/build-console.mjs`, `docs/console-guide.md`, package scripts, screenshots under `docs/design/`.

- [x] Add portable zero-dependency static packaging commands, npm scripts, a README entry point, and Chinese integration/usage documentation.
- [x] Run `node --test tests/*.test.mjs` with 40 passing tests.
- [x] Run final `npm run typecheck` and `npm run build` and record results.
- [x] Review independently; resolve material findings and run relevant tests.
- [x] Capture actual UI images at desktop, detail and dark mode; inspect visually.
- [ ] Publish private static preview, push feature branch and create Draft PR.
- [ ] Report verified behavior, baseline SHA, limitations and next integration steps.
