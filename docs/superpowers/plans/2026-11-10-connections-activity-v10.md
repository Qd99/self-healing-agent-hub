# Connections and Activity v10 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for root integration. Bounded independent activity work is delegated; the root owns Site synchronization and publication.

**Goal:** Unify connection settings and activity history, remove global task search and default fictional data.

**Architecture:** Retain the existing vanilla JS controller/render split, shared UI helpers and dialog. Add a focused connection view; replace activity presentation and extend only the related filtering/paging/detail behavior.

**Tech Stack:** Existing ES modules, CSS, Lucide icons, Node test runner, managed Sites preview.

**Spec:** `docs/superpowers/specs/2026-11-10-connections-activity-v10-design.md`

## Global Constraints

- No new dependencies or backend write capabilities.
- Preserve original Site identity, access and original Draft PR.
- Default published output uses live same-origin API mode; absent API retains null snapshot.
- Do not infer success from an info log or connection from a saved monitoring draft.
- Shared UI tokens and meaningful focus/pressed feedback remain intact.

## Review Focus

- Missing API and malformed snapshots must not cause synthetic fallback or an exception.
- Unknown log metadata and HTML-like strings remain escaped and accurately described.
- Filtering while on a later page resets the visible page; export covers all filtered rows.
- Drawer navigation and return focus work for records with and without related tasks.
- Local monitoring drafts remain distinguishable from server configuration.

## Task 1 · Settings and shell

**Files:** `connection-views.js`, `settings.css`, `navigation.js`, `views.js`, `app.js`.

- [x] Replace settings renderer with a shared service-list surface and on-demand details.
- [x] Remove global task search and mode badge; retain task-local search.
- [x] Remove demo selection from normal UI and use clear disconnected empty states.
- [x] Verify actual configuration provenance and missing-service states in browser.

## Task 2 · Activity workspace

**Files:** `administration-views.js`, `administration-model.js`, `administration-controller.js`, `administration.css`, `tests/console-administration.test.mjs`.

**Interfaces:** `renderActivityDetail(entry, state)` returns dialog body; controller receives optional `openActivity(id)` callback. Root registers and opens the shared dialog. Filters add `level` and pagination uses `activityPage` with 15 visible records. Export retains all filtered records, not only the page.

- [x] First pin level filtering, page boundaries, missing/escaped detail data and controller page reset in meaningful tests.
- [x] Implement compact record columns and current-filter counts with no duplicate row explanation.
- [x] Implement accessible detail opening, level/time/category/search filters and pagination.
- [x] Run targeted administration tests, then integrate callback into app.

## Task 3 · Verify and deliver

- [x] Run existing full suite, production build and formatting checks on changed sources.
- [x] Check connected fixture, empty/unconnected, filtered empty, dark, narrow layouts and keyboard behavior.
- [x] Independent review; fix concrete findings, capture actual final screenshots and update documentation.
- [x] Publish live-default output to the original private Site.
- [x] Prepare the reviewed source tree and screenshots for the original Draft PR; record exact remote commit/tree verification in its delivery section.

## Execution notes

Pre-flight: root owns settings, shell, app and publication; delegated activity task owns administration files. Shared interface is `openActivity(id)` / `renderActivityDetail(entry, state)`. Existing controllers are initialized before render, so the injected callback must be a function declaration. CSS-only refinements use visual QA; meaningful behavior changes use tests.

Task 1 and Task 2 complete. Task 3 checks: 180/180 tests; production build and formatting passed. Browser verified 390px, 1024px and desktop/dark layouts, record keyboard/related-log navigation, 16-record pagination and cross-page export. Independent review found a null activity entry lookup, fixed and exercised with the actual callback. Existing explicit success-level contract is now recognized. Screenshot capture uses the supported viewport API after full-page capture timed out; all four saved images were visually inspected.

Original private Site publication succeeded for source `507046c384587fb12475e0da49232b3523d54455`, deployment `appgdep_6af285680f9c8191b153304a542b6c88`. The standard build retains `console-default-mode=live`; the temporary QA harness is excluded. Final GitHub commit and exact tree equality are recorded in the original Draft PR rather than self-referentially embedded in this source commit.
