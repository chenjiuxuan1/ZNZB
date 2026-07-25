# DS Adaptive Summary and Incremental Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent false DS absence alerts, include DS status in the single duty summary, and make six-country discovery incremental.

**Architecture:** The DS gateway remains the source of truth for schedule semantics and returns only workflows that have missed a complete configured cycle. The platform transports that normalized result into the existing aggregate duty notification. Inventory discovery derives missing sources before invoking Metabase and merges only refreshed records.

**Tech Stack:** Node.js ESM, node:test, n8n webhook contract, JSON inventory files.

---

### Task 1: Define and consume the adaptive DS gateway contract

**Files:**
- Modify: `src/ds-scheduler-monitor.mjs:252-340`
- Modify: `test/ds-scheduler-monitor.test.mjs:201-235`
- Create: `docs/n8n-ds-scheduler-gateway.md`

- [ ] **Step 1: Write the failing contract test**

```js
test("DS check accepts only ONLINE workflows that missed a complete schedule cycle", async () => {
  // Gateway response contains missed_schedule_cycle and schedule metadata.
  assert.deepEqual(result.countries[0].staleWorkflows, [{
    workflowName: "daily-wf", scheduleCycle: "每天 09:00", lastRunAt: "2026-07-23T01:00:00Z",
  }]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/ds-scheduler-monitor.test.mjs`

Expected: FAIL because `scheduleCycle` and `lastRunAt` are not preserved and legacy `no_recent_run` is accepted.

- [ ] **Step 3: Implement the minimal consumer change**

```js
payload: { consecutive_failures: 3, page_size: 20, project_code: project.code,
  stale_policy: "one_full_schedule_cycle" }

const staleWorkflows = (data.stale_workflows || [])
  .filter((wf) => wf.schedule_status === "ONLINE" && wf.stale_reason === "missed_schedule_cycle")
  .map((wf) => ({ ...mapExistingWorkflow(wf), scheduleCycle: wf.schedule_cycle,
    lastRunAt: wf.last_run_at, nextRunAt: wf.next_run_at }));
```

- [ ] **Step 4: Document the required n8n implementation**

Document the request field and response fields `schedule_cycle`, `last_run_at`, `next_run_at`, and `missed_schedule_cycle`, including that the gateway must obtain DS schedule configuration and evaluate it in the schedule timezone.

- [ ] **Step 5: Run the DS tests**

Run: `node --test test/ds-scheduler-monitor.test.mjs`

Expected: PASS.

### Task 2: Include DS in the sole scheduled duty notification

**Files:**
- Modify: `src/platform-api.mjs:100-170, 920-950, 2240-2310`
- Modify: `src/notifier.mjs:255-270`
- Modify: `test/platform-api.test.mjs:1095-1230`

- [ ] **Step 1: Write the failing scheduled notification test**

```js
assert.equal(captured.length, 1);
assert.match(captured[0].message, /2\.DS调度：印尼：3 个任务，卡死 0、旷工 1（daily-wf）/);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/platform-api.test.mjs`

Expected: FAIL because `dsScheduleSummary` is calculated after notifications and not passed to `buildPublicCheckMessages`.

- [ ] **Step 3: Implement the minimal notification flow**

```js
const dsSchedulerSummary = schedule.includeDsScheduler
  ? await runIntegratedDsCheck(schedule)
  : null;
await sendScheduledAggregateNotifications({ ..., dsSchedulerSummary });
```

Pass `dsScheduleSummary` through `buildPublicCheckMessages` and render successful countries as `国家：任务数，卡死 X、旷工 Y`; include failed countries as `国家：检查失败`.

- [ ] **Step 4: Remove automatic standalone DS alert delivery**

```js
return { ...result, notification: { sent: false, skipped: true, reason: "included in duty summary" } };
```

Keep the explicit DS notification test endpoint, but do not call `notifyDsSchedulerCheck` for batch or manual integrated checks.

- [ ] **Step 5: Run the platform API tests**

Run: `node --test test/platform-api.test.mjs`

Expected: PASS.

### Task 3: Make six-country discovery skip ready inventories

**Files:**
- Modify: `src/platform-api.mjs:629-645, 2620-2655`
- Modify: `web/src/views/inventory.js:100-115`
- Modify: `test/platform-api.test.mjs:185-214`

- [ ] **Step 1: Write the failing incremental discovery test**

```js
const result = await api.discoverAllCountryDashboards();
assert.equal(attempts, 1);
assert.equal(result.skipped, 1);
assert.equal(result.results.find((item) => item.countryCode === "INE").skipped, true);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/platform-api.test.mjs`

Expected: FAIL because every country calls `discoverCountryDashboards`.

- [ ] **Step 3: Implement ready-source filtering**

```js
const pending = await hasPendingCountryDashboardSources(rootDir, country.code);
if (!pending) return { ok: true, skipped: true, countryCode: country.code };
return this.discoverCountryDashboards(country.code);
```

Merge only the discovered pending dashboards into the country inventory and return `{ succeeded, skipped, failed }` counts.

- [ ] **Step 4: Update the UI status copy**

Render successful batch results as `新增/刷新 X 个国家，跳过 Y 个已发现国家`; retain failure details only for failed countries.

- [ ] **Step 5: Run API and UI-adjacent tests**

Run: `node --test test/platform-api.test.mjs test/view-utils.test.mjs`

Expected: PASS.

### Task 4: Perform focused reliability and security verification

**Files:**
- Modify as proven necessary: `src/platform-api.mjs`, `src/ds-scheduler-monitor.mjs`
- Test: relevant `test/*.test.mjs`

- [ ] **Step 1: Inspect external requests and API boundaries**

Check DS request timeout, batch concurrency, malformed gateway responses, inventory writes, and whether API responses expose tokens or webhook secrets.

- [ ] **Step 2: Add a failing regression test for each confirmed defect**

Use `node --test <affected test file>` and confirm the failure is behavioral.

- [ ] **Step 3: Apply the smallest repair**

Preserve existing secret-redaction and atomic-write helpers; do not change external API shapes unnecessarily.

- [ ] **Step 4: Run the full suite**

Run: `npm test`

Expected: PASS with no failing tests.
