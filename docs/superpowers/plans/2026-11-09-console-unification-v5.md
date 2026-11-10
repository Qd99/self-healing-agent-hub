# Console v5 Implementation Plan

> **For agentic workers:** Use subagent-driven-development or executing-plans; delegated tasks have disjoint file ownership.

**Goal:** Integrate a Grafana-ready monitor workspace and consistent, understandable console modules.

**Architecture:** Keep the native ESM console and read-only Node gateway. Add pure monitoring and administration models; use shared UI primitives and a single token source. Root integrates controllers, reviews behavior and publishes the existing private preview.

**Tech Stack:** Node.js, native browser ESM, CSS, SVG, node:test.

**Spec:** ../specs/2026-11-09-console-unification-v5-design.md

## Global Constraints

- Real execution remains unavailable and configuration remains read-only.
- Local monitoring drafts never alter backend configuration or actual watched scope.
- No third-party iframe auto-load, no secret fields, no fabricated connectivity.
- Preserve task selection/filter/composition behavior and two-stage approval semantics.
- Same feature branch, same private Site, no main merge.

## Review Focus

- Invalid external URL or credentials must not become a clickable dashboard link.
- Multi-namespace selection must not silently broaden beyond the configured scope.
- Chinese search and text entry must retain focus and composition.
- Context switches must keep demo and real configuration drafts separate.
- Mobile and keyboard controls must remain usable across shared primitives.

## Tasks

- [x] Add monitoring model, safe gateway projection, meaningful contract tests and integration guide.
- [x] Add reusable UI helpers and consolidate all design tokens; migrate existing modules.
- [x] Build monitor layout, configuration form, local draft lifecycle, exports and Grafana URL actions.
- [x] Implement operation records filtering/export and readable routing-rule views with tests.
- [x] Integrate clear navigation names, engine/safety/settings layouts and new controllers.
- [x] Run model tests/build, review implementation, verify actual browser interactions and screenshots.
- [x] Update guides and prepare the verified release source.

## Delivery

Use the existing Draft PR and private Site; record verified commit and deployment IDs in those release records. Do not merge main.
