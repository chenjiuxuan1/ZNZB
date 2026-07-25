# DS Notification and Hourly Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make six-country hourly dashboards visibly and truthfully monitored, remove DS project-code input, and add inherited-but-overridable DS notification preview and test controls.

**Architecture:** Keep dashboard discovery in the unified inventory and expose discovery status in the UI. Store DS notification overrides separately from Metabase defaults, resolve project names to internal codes on the server, and make scheduled/manual DS runs use the effective DS notification configuration.

**Tech Stack:** Node.js ES modules, native HTTP server, JSON persistence, vanilla JavaScript templates, CSS, Node test runner.

---

### Task 1: Harden hourly dashboard visibility and status

**Files:**
- Modify: `src/platform-api.mjs`
- Modify: `web/src/views/inventory.js`
- Test: `test/platform-api.test.mjs`

- [ ] Add a failing fixture containing one ready dashboard and one internal “提前还款监控” source, then assert the source remains visible with `availability: "pending_discovery"`, `executable: false`, and a non-empty `pendingReason`.
- [ ] Run `node --test --test-name-pattern='pending hourly' test/platform-api.test.mjs` and verify it fails before implementation.
- [ ] Add discovery metadata (`discoveryStatus`, `lastDiscoveryAt`, `pendingReason`) without counting pending cards as checked cards.
- [ ] Render “每小时监控” as a secondary label when the title matches `提前还款监控`, plus the execution status and reason.
- [ ] Run `node --test test/platform-api.test.mjs` and frontend syntax checks.

### Task 2: Add DS notification override API

**Files:**
- Modify: `src/platform-api.mjs`
- Modify: `src/server.mjs`
- Test: `test/platform-api.test.mjs`

- [ ] Add failing tests for default inheritance, independent override persistence, preview generation, and test-send routing.
- [ ] Add `config/ds-scheduler-notification.json` to platform files with no required checked-in instance.
- [ ] Implement `getDsNotificationConfig()`, `saveDsNotificationConfig(input)`, `previewDsNotification(input)`, and `sendDsNotificationTest(input)`.
- [ ] Merge Metabase defaults only when a DS override field is absent, and return `inherited` plus an effective channel/target summary.
- [ ] Add GET/PUT `/api/ds-scheduler/notification`, POST `/api/ds-scheduler/notification/preview`, and POST `/api/ds-scheduler/notification/test`.
- [ ] Change manual and scheduled DS runs to use the effective DS notification configuration and include the used channel/targets in the result.
- [ ] Run targeted platform tests.

### Task 3: Remove project-code input while preserving internal execution

**Files:**
- Modify: `src/ds-scheduler-monitor.mjs`
- Modify: `src/platform-api.mjs`
- Modify: `web/src/views/ds-scheduler.js`
- Test: `test/ds-scheduler-monitor.test.mjs`
- Test: `test/platform-api.test.mjs`

- [ ] Add a failing test showing that saving an unchanged project name preserves its resolved code, while changing the name requires resolution.
- [ ] Keep `projectCodes` server-side but remove it from editable frontend form data.
- [ ] Expose per-country `projectStatus` with `resolved`, `unresolved`, and error text.
- [ ] Make DS schedule country switches depend on resolved status rather than a user-entered code.
- [ ] Run DS and platform tests.

### Task 4: Add Metabase-style DS notification panel

**Files:**
- Modify: `web/src/views/ds-scheduler.js`
- Modify: `web/src/styles.css`

- [ ] Load config, schedule, notification, and history concurrently.
- [ ] Render channel selector, KN/TV target fields, healthy-notification switch, effective recipients, inheritance notice, preview box, “预览消息”, and “发送测试”.
- [ ] Use existing `schedule-config-card`, `notice`, `sandbox-status`, `button-group`, and form classes; do not restore large icon cards or tabs.
- [ ] Bind save/preview/test actions and show explicit success/error feedback.
- [ ] Verify there is no project-code input in the DOM.
- [ ] Run frontend syntax checks.

### Task 5: Regression, browser acceptance, and delivery

**Files:**
- Modify only files requiring acceptance fixes.

- [ ] Run `npm test`, all changed-file `node --check` commands, and `git diff --check`.
- [ ] Start the local server and verify six countries show the hourly dashboard, DS has six project-name cards, no project-code input, and the notification panel identifies channel and targets.
- [ ] Verify pending hourly dashboards cannot run rules while discovered dashboards participate in scheduled checks.
- [ ] Commit implementation to `codex-show-scanned-dashboards`.
- [ ] Push the branch because the server screenshot proves the remote deployment is behind the local branch.
