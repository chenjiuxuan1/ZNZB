# Unified Inventory and DS Monitor Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every configured Metabase dashboard visible across the platform and redesign the DS monitor as a Metabase-style single page with project-scoped scheduled checks.

**Architecture:** The platform API will return one normalized dashboard collection that merges executable inventory with pending panel sources. Frontend consumers will use the normalized status fields rather than maintaining separate source logic. DS scheduling will persist project scope and schedule state separately while inheriting notification targets from the Metabase batch schedule.

**Tech Stack:** Node.js ES modules, native HTTP server, JSON persistence, vanilla JavaScript templates, CSS, Node test runner.

---

### Task 1: Normalize Metabase inventory and pending sources

**Files:**
- Modify: `src/platform-api.mjs`
- Test: `test/platform-api.test.mjs`

- [ ] **Step 1: Write failing merge tests**

Add tests that create one executable dashboard and two source panels, then assert:

```js
const inventory = await api.getInventory();
assert.equal(inventory.dashboards.length, 2);
assert.equal(inventory.dashboards.find((item) => item.uuid === "dash-1").availability, "ready");
assert.equal(inventory.dashboards.find((item) => item.dashboardId === 1206).availability, "pending_discovery");
assert.equal(inventory.dashboards.find((item) => item.dashboardId === 1206).executable, false);
```

Add a duplicate test where the source URL matches an executable internal dashboard and assert only one dashboard is returned.

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
node --test test/platform-api.test.mjs
```

Expected: the new tests fail because pending source panels are only returned through `panelSources`.

- [ ] **Step 3: Implement normalized dashboard helpers**

In `src/platform-api.mjs`, add focused helpers:

```js
function normalizeReadyDashboard(dashboard) {
  return {
    ...dashboard,
    availability: "ready",
    executable: Array.isArray(dashboard.cards) && dashboard.cards.length > 0,
    pendingReason: "",
  };
}

function panelSourceToDashboard(source, panel) {
  const link = (panel.links || [])[0] || {};
  const internal = parseInternalMetabaseUrl(link.url || "");
  return {
    countryCode: source.countryCode,
    countryName: source.countryName,
    timezone: source.timezone,
    sourcePanelId: panel.id,
    sourcePanelTitle: panel.title,
    title: panel.title,
    url: link.url || "",
    access: "internal",
    dashboardId: internal?.dashboardId || null,
    uuid: internal?.dashboardId ? `internal:${internal.dashboardId}` : "",
    cards: [],
    availability: "pending_discovery",
    executable: false,
    pendingReason: "尚未取得 Metabase 卡片清单",
  };
}
```

Add `mergeDashboardSources(inventory, panelSources)` using country + dashboard ID/UUID/URL/sourcePanelId as identity. Ready dashboards win and source data only fills missing metadata.

- [ ] **Step 4: Return the unified model**

Update `getInventory()` so `dashboards`, counts, and `panelSources` are derived from the merged collection:

```js
const panelSources = await loadPanelSources(rootDir, countries.countries || [], filters);
return filterInventory(mergeDashboardSources(inventory, panelSources), filters);
```

Keep `panelSources` temporarily for API compatibility.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
node --test test/platform-api.test.mjs
npm test
```

Expected: all tests pass.

Commit:

```bash
git add src/platform-api.mjs test/platform-api.test.mjs
git commit -m "feat: unify executable and pending dashboards"
```

### Task 2: Update all inventory consumers

**Files:**
- Modify: `web/src/views/inventory.js`
- Modify: `web/src/views/sandbox.js`
- Modify: `web/src/views/batch-check.js`
- Modify: `web/src/views/dashboard.js`
- Modify: `web/src/state.js`
- Test: `test/platform-api.test.mjs`

- [ ] **Step 1: Add common state selectors**

In `web/src/state.js`, add:

```js
export function getDashboards(options = {}) {
  const dashboards = state.inventory?.dashboards || [];
  return options.executableOnly
    ? dashboards.filter((item) => item.executable !== false)
    : dashboards;
}

export function isDashboardExecutable(dashboard) {
  return Boolean(dashboard && dashboard.executable !== false && (dashboard.cards || []).length);
}
```

- [ ] **Step 2: Update the inventory page**

Replace separate source fallback rendering with the unified dashboard list. Show:

```js
const status = dashboard.executable
  ? `<span class="badge ok">可执行</span>`
  : `<span class="badge warn">待发现</span>`;
```

Ready rows render cards; pending rows render `pendingReason`, source URL, and a Metabase link.

- [ ] **Step 3: Update sandbox behavior**

Use `getDashboards()` for selectors. If the selected dashboard is pending, retain it in the selector but disable card/rule execution:

```js
const canRun = isDashboardExecutable(dashboard) && Boolean(card && rule);
```

Render an inline explanation instead of silently showing empty selects.

- [ ] **Step 4: Update manual and scheduled Metabase controls**

In `web/src/views/batch-check.js`:

- manual selector shows all dashboards and marks pending items as `（待发现）`;
- single-dashboard execution uses `getDashboards({ executableOnly: true })`;
- country totals use all dashboards;
- schedule dashboard selector only lists executable dashboards;
- the hint states that leaving the dashboard empty discovers and scans the full country source scope.

- [ ] **Step 5: Update summary counts**

In `web/src/views/dashboard.js`, display total, executable, and pending counts from the unified model. Do not include pending dashboards in checked-card statistics.

- [ ] **Step 6: Validate frontend syntax and commit**

Run:

```bash
node --check web/src/state.js
node --check web/src/views/inventory.js
node --check web/src/views/sandbox.js
node --check web/src/views/batch-check.js
node --check web/src/views/dashboard.js
npm test
```

Expected: syntax checks and all tests pass.

Commit:

```bash
git add web/src/state.js web/src/views/inventory.js web/src/views/sandbox.js web/src/views/batch-check.js web/src/views/dashboard.js
git commit -m "fix: use unified dashboards across platform"
```

### Task 3: Add DS project schedule persistence

**Files:**
- Modify: `src/platform-api.mjs`
- Modify: `src/server.mjs`
- Modify: `src/ds-scheduler-monitor.mjs`
- Test: `test/platform-api.test.mjs`
- Test: `test/ds-scheduler-monitor.test.mjs`

- [ ] **Step 1: Write failing DS schedule tests**

Cover:

```js
assert.deepEqual((await api.getDsSchedule()).countryConfigs, [
  { countryCode: "ine", enabled: true, projectCode: "12739141488160" },
]);
assert.equal((await api.getDsSchedule()).alerts.recipientEmails, "owner@example.com");
```

Test validation rejects an enabled country without a project code.

- [ ] **Step 2: Add DS schedule files and defaults**

Add file mappings:

```js
dsSchedule: "config/ds-scheduler-schedule.json",
dsHistory: "config/ds-scheduler-history.json",
```

Use a default schedule with `enabled`, `intervalMinutes`, `countryConfigs`, `nextRunAt`, `lastRunAt`, and `lastResult`.

- [ ] **Step 3: Add API methods**

Implement:

```js
getDsSchedule()
saveDsSchedule(input)
runDueDsSchedule(now)
runDsScheduleNow()
getDsHistory(filters)
```

Each country check passes only its configured `projectCode`. Notification fields are loaded from `getBatchSchedule()` at run time rather than copied into DS files.

- [ ] **Step 4: Add HTTP routes and timer**

Add:

```text
GET  /api/ds-scheduler/schedule
PUT  /api/ds-scheduler/schedule
POST /api/ds-scheduler/schedule/run-now
GET  /api/ds-scheduler/history
```

Start a 60-second timer that calls `runDueDsSchedule()` with a re-entry guard.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
node --test test/ds-scheduler-monitor.test.mjs test/platform-api.test.mjs
npm test
```

Expected: all DS and platform tests pass.

Commit:

```bash
git add src/platform-api.mjs src/server.mjs src/ds-scheduler-monitor.mjs test/platform-api.test.mjs test/ds-scheduler-monitor.test.mjs
git commit -m "feat: add project-scoped DS scheduling"
```

### Task 4: Redesign the DS single page using Metabase components

**Files:**
- Modify: `web/src/views/ds-scheduler.js`
- Modify: `web/src/styles.css`

- [ ] **Step 1: Replace the page composition**

Keep one route and render four continuous sections:

```js
root.innerHTML = `
  ${renderDsHero(model)}
  ${renderDsProjectConfig(model)}
  ${renderDsScheduleConfig(model)}
  ${renderDsLatestResult(model)}
`;
```

Fetch config, schedule, and history together with `Promise.allSettled`, show a loading state once, and preserve partial data if one endpoint fails.

- [ ] **Step 2: Reuse Metabase visual classes**

Use existing classes such as `batch-hero`, `hero-stats`, `schedule-config-card`, `schedule-country-grid`, `schedule-country-card`, `switch-field`, `mini-switch`, `detail-header`, `badge`, and `sandbox-status`.

Remove DS-specific oversized metric/icon presentation from the template. Add only scoped layout rules required for project fields:

```css
.ds-project-fields {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 10px;
}
```

- [ ] **Step 3: Implement project configuration interactions**

Each country card contains enabled, project name, project code, and status. Token inputs stay in one `<details class="advanced">`. Save shows per-country resolve errors without discarding valid codes.

- [ ] **Step 4: Implement schedule interactions**

The schedule section contains total enabled state, interval minutes, next/last run, country project switches, “保存配置”, and “立即运行测试”. Disable a country switch when no project code exists and show the reason.

- [ ] **Step 5: Display inherited notification summary**

Render a compact read-only notice:

```text
通知配置继承自 Metabase 定时巡检：KN Chat · owner@example.com
```

Link to `#/batch-check` for changes.

- [ ] **Step 6: Validate responsive behavior and commit**

Run:

```bash
node --check web/src/views/ds-scheduler.js
npm test
```

Verify at desktop and narrow widths that country cards remain readable and no horizontal overflow appears.

Commit:

```bash
git add web/src/views/ds-scheduler.js web/src/styles.css
git commit -m "feat: redesign DS monitor as Metabase-style single page"
```

### Task 5: End-to-end regression and delivery

**Files:**
- Modify if needed: files changed in Tasks 1-4

- [ ] **Step 1: Run complete automated verification**

Run:

```bash
npm test
node --check src/platform-api.mjs
node --check src/server.mjs
node --check web/src/views/ds-scheduler.js
git diff --check
```

Expected: zero failures and zero diff whitespace errors.

- [ ] **Step 2: Verify requirements against local API**

Start the server and confirm:

```bash
curl -s http://127.0.0.1:8787/api/inventory
curl -s http://127.0.0.1:8787/api/ds-scheduler/config
curl -s http://127.0.0.1:8787/api/ds-scheduler/schedule
```

Expected:

- inventory includes all six pending/ready hourly dashboards;
- DS config includes project mappings and inherited alert summary;
- DS schedule includes project-scoped country configs.

- [ ] **Step 3: Perform browser acceptance**

Verify:

- six country hourly dashboards appear in 看板与卡片;
- pending dashboards appear but cannot incorrectly run rules;
- Metabase manual/schedule selectors use unified inventory;
- DS project save, schedule save, and manual run provide visible feedback;
- DS page matches the existing Metabase panel/card/switch visual system.

- [ ] **Step 4: Final commit**

If acceptance required fixes:

```bash
git add <only-files-fixed-during-acceptance>
git commit -m "fix: complete inventory and DS acceptance"
```

Otherwise no additional commit is needed.
