# Runtime Functional Risk Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep BI, DS, and HIVE scheduled patrols reliable by connecting the DS timer, preventing duplicate runs, advancing failed schedules, and making shared JSON persistence concurrency-safe.

**Architecture:** Preserve the existing API and file schemas. Add process-local scheduler guards inside `createPlatformApi`, use unique atomic-write temporary paths, and introduce a per-file update queue for read-modify-write stores. Route DS and HIVE configuration saves through the shared atomic writer.

**Tech Stack:** Node.js ES modules, `node:test`, filesystem JSON stores, raw Node HTTP server.

---

### Task 1: Collision-safe atomic JSON writes

**Files:**
- Modify: `src/utils.mjs`
- Modify: `src/platform-api.mjs`
- Test: `test/utils.test.mjs`
- Test: `test/platform-api.test.mjs`

- [x] **Step 1: Write failing atomic-write concurrency tests**

Add a test that calls the utility atomic writer concurrently 100 times for one destination and asserts that every promise fulfills and the final file parses as JSON. Add a platform updater test that performs concurrent keyed additions and asserts that all keys survive.

- [x] **Step 2: Verify the tests fail for the expected collision or lost-update reason**

Run: `node --test test/utils.test.mjs test/platform-api.test.mjs --test-name-pattern="concurrent atomic|serializes concurrent"`

Expected: at least one `ENOENT` or a final item count below the submitted count.

- [x] **Step 3: Implement unique temporary names and per-file update serialization**

Use `randomUUID()` in temporary paths and clean up only that path on failure. Export a focused `updateJsonAtomic(filePath, fallback, transform)` helper from `platform-api.mjs`; its promise tail must recover after rejection and the transform must run after the latest disk read.

- [x] **Step 4: Convert shared read-modify-write stores**

Use the updater for pending patrol runs, anomaly analyses, evidence snapshots, batch history, DS history, and HIVE history. Keep existing retention and deduplication transformations unchanged.

- [x] **Step 5: Run focused tests**

Run: `node --test test/utils.test.mjs test/platform-api.test.mjs`

Expected: all focused tests pass.

### Task 2: Scheduler startup and mutual exclusion

**Files:**
- Modify: `src/server.mjs`
- Modify: `src/platform-api.mjs`
- Test: `test/server-startup.test.mjs`
- Test: `test/platform-api.test.mjs`

- [x] **Step 1: Write failing startup and overlap tests**

Add a source-level startup regression test that asserts `startBatchScheduler()`, `startDsScheduler()`, and `startHiveScheduler()` are invoked once. Add API tests that hold the first DS or HIVE run open, invoke a second manual/due run, and assert the second call performs no external check or notification.

- [x] **Step 2: Verify the tests fail because DS is not started and overlap is allowed**

Run: `node --test test/server-startup.test.mjs test/platform-api.test.mjs --test-name-pattern="starts all schedulers|overlapping"`

Expected: DS startup assertion fails; overlap tests observe duplicate execution.

- [x] **Step 3: Start DS and add process-local scheduler guards**

Invoke `startDsScheduler()` at server startup. Add `dsScheduleRunning` and `hiveScheduleRunning` flags in `createPlatformApi()`. Manual entry points throw the existing bad-request shape when busy; due entry points return `{ ran: false, reason: "already running", schedule }`. Clear each flag in `finally`.

- [x] **Step 4: Preserve integrated patrol behavior**

Keep DS due checks blocked during the BI batch patrol and add the same batch-running check for HIVE. Do not change `runIntegratedDsCheck` or `runIntegratedHiveCheck`.

- [x] **Step 5: Run focused scheduler tests**

Run: `node --test test/server-startup.test.mjs test/platform-api.test.mjs --test-name-pattern="scheduler|overlapping|schedule"`

Expected: all selected tests pass.

### Task 3: Failure schedule progression

**Files:**
- Modify: `src/platform-api.mjs`
- Test: `test/platform-api.test.mjs`

- [x] **Step 1: Write failing DS and HIVE failure tests**

Create enabled, already-due schedules and force the external checks to fail. Assert that a scheduled attempt records `lastError`, appends one failed history entry, and persists `nextRunAt` later than the failed attempt. Assert a manual failure preserves an existing future `nextRunAt`.

- [x] **Step 2: Verify failures retain the stale due time**

Run: `node --test test/platform-api.test.mjs --test-name-pattern="scheduled failure advances|manual failure preserves"`

Expected: scheduled `nextRunAt` remains equal to the old due time.

- [x] **Step 3: Centralize next-run calculation by trigger**

Add a helper that returns a future interval time only for `trigger === "schedule"`; otherwise it returns the saved value. Use it in success and failure branches for DS and HIVE. Move preflight validation into each runner's `try` so failures are persisted consistently.

- [x] **Step 4: Run focused failure tests**

Run: `node --test test/platform-api.test.mjs --test-name-pattern="scheduled failure advances|manual failure preserves|saves schedule and runs it when due"`

Expected: all selected tests pass.

### Task 4: Atomic DS and HIVE configuration saves

**Files:**
- Modify: `src/ds-scheduler-monitor.mjs`
- Modify: `src/hive-scheduler-monitor.mjs`
- Test: `test/ds-scheduler-monitor.test.mjs`
- Test: `test/hive-scheduler-monitor.test.mjs`

- [x] **Step 1: Write failing atomic-writer usage tests**

Exercise concurrent configuration saves and assert every completed file is valid JSON with the existing top-level keys and no leftover `.tmp` files.

- [x] **Step 2: Verify the direct-write implementation does not satisfy the atomic contract**

Run: `node --test test/ds-scheduler-monitor.test.mjs test/hive-scheduler-monitor.test.mjs --test-name-pattern="atomic"`

Expected: the new atomic-contract assertion fails.

- [x] **Step 3: Use the shared atomic JSON writer**

Import `writeJsonFileAtomic` from `src/utils.mjs` in both monitor modules and replace direct `fs.writeFile` calls. Preserve formatting and returned config objects.

- [x] **Step 4: Run monitor tests**

Run: `node --test test/ds-scheduler-monitor.test.mjs test/hive-scheduler-monitor.test.mjs`

Expected: all monitor tests pass.

### Task 5: Full verification and delivery

**Files:**
- Modify only if verification exposes a regression in files already in scope.

- [x] **Step 1: Check formatting and accidental changes**

Run: `git diff --check && git status --short`

Expected: no whitespace errors; only intentional files plus the user's pre-existing untracked files appear.

- [x] **Step 2: Run the complete suite**

Run: `npm test`

Expected: zero failures, including all existing 366 tests and the new regression tests.

- [x] **Step 3: Re-run the original concurrent atomic-write reproducer**

Run 100 concurrent writes to a temporary file through `writeJsonAtomic` and assert 100 fulfilled, zero rejected, and valid final JSON.

- [x] **Step 4: Inspect the final diff against the design**

Confirm no API path, response schema, patrol algorithm, notification content, credential behavior, or retention setting changed.

- [ ] **Step 5: Commit the verified implementation**

Stage only the plan, tests, and implementation files. Commit with `fix: harden scheduler and json persistence`.
