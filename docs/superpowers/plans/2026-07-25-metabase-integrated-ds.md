# Metabase Integrated DS Checks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move DS scheduling and notification into the Metabase batch schedule while adding explicit internal-dashboard discovery and fixing inventory layout.

**Architecture:** Add a scoped discovery endpoint that persists discovered country inventory. Extend the existing batch schedule with one global DS flag and attach DS results to the same run/history, using Metabase alert configuration. Reduce the DS page to project configuration and read-only testing.

**Tech Stack:** Node.js ES modules, JSON persistence, vanilla JavaScript, CSS, Node test runner.

---

### Task 1: Explicit country dashboard discovery

**Files:** `src/platform-api.mjs`, `src/server.mjs`, `test/platform-api.test.mjs`, `web/src/views/inventory.js`, `web/src/styles.css`

- [ ] Write a failing API test for `discoverCountryDashboards("INE")`.
- [ ] Implement discovery, persistence, result metadata, and POST `/api/inventory/discover`.
- [ ] Add current-country “重新发现看板” UI with success/error state.
- [ ] Fix dashboard-row text/status sizing and overflow.
- [ ] Run platform tests and syntax checks.

### Task 2: Batch schedule DS global switch

**Files:** `src/platform-api.mjs`, `test/platform-api.test.mjs`, `web/src/views/batch-check.js`

- [ ] Write failing tests proving `includeDsScheduler` defaults false and persists.
- [ ] Add the global switch to batch schedule normalization and UI serialization.
- [ ] Verify existing schedules remain compatible.

### Task 3: Execute DS inside Metabase scheduled runs

**Files:** `src/platform-api.mjs`, `test/platform-api.test.mjs`

- [ ] Write tests proving DS is skipped when disabled and executed when enabled.
- [ ] Filter DS countries to resolved projects with configured tokens.
- [ ] Run DS after Metabase country checks, using the Metabase alert configuration.
- [ ] Store `dsSchedulerSummary` in schedule result and batch history.
- [ ] Preserve Metabase results when DS fails and mark partial failure.

### Task 4: Simplify DS page

**Files:** `web/src/views/ds-scheduler.js`, `web/src/styles.css`, `src/server.mjs`

- [ ] Remove DS schedule and notification sections from the template and loader.
- [ ] Keep six project-name cards, advanced tokens, one “执行 DS 测试” button, and result rendering.
- [ ] Ensure the test calls `/api/ds-scheduler/check` and never sends notification.
- [ ] Stop starting the standalone DS timer in `server.mjs`; retain legacy endpoints.
- [ ] Run frontend syntax checks.

### Task 5: Full verification and delivery

- [ ] Run `npm test`, changed-file syntax checks, and `git diff --check`.
- [ ] Browser-verify discovery controls, no row overflow, Metabase DS switch, and simplified DS page.
- [ ] Commit and push `codex-show-scanned-dashboards`.
