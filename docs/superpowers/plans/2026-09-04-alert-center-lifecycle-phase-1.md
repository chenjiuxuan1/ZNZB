# 告警中心生命周期化第一阶段实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立告警中心五段生命周期导航、兼容子路由和旧页面迁移入口，在不改动现有生产写接口的前提下保留全部现有功能。

**Architecture:** 使用纯函数模块定义生命周期分区和旧功能映射；应用路由支持 `/alerts/*` 前缀；现有 `alert-center.js` 继续承载成熟功能，通过适配层按生命周期分区调用；其他旧页面保留并显示迁移提示。第一阶段不复制后端业务逻辑，也不删除任何旧路由。

**Tech Stack:** Node.js ESM、原生 JavaScript、HTML 模板字符串、CSS、`node:test`。

---

### Task 1: 生命周期路由模型

**Files:**
- Create: `web/src/views/alert-center/lifecycle-model.js`
- Create: `test/alert-center-lifecycle-view.test.mjs`

- [ ] **Step 1: Write the failing test**

覆盖五个分区、默认路由、未知路由回退，以及每个旧功能只有一个主要归属：

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  ALERT_LIFECYCLE_SECTIONS,
  normalizeAlertLifecycleSection,
  lifecycleSectionForPath,
  legacyCapabilitiesForSection,
} from "../web/src/views/alert-center/lifecycle-model.js";

test("alert center exposes five lifecycle sections", () => {
  assert.deepEqual(ALERT_LIFECYCLE_SECTIONS.map((item) => item.id), [
    "overview", "events", "rules", "notifications", "operations",
  ]);
});

test("alert lifecycle routes default safely", () => {
  assert.equal(lifecycleSectionForPath("/alerts"), "overview");
  assert.equal(lifecycleSectionForPath("/alerts/events"), "events");
  assert.equal(lifecycleSectionForPath("/alerts/unknown"), "overview");
  assert.equal(normalizeAlertLifecycleSection("notifications"), "notifications");
});

test("legacy capabilities have one primary lifecycle owner", () => {
  const owners = ALERT_LIFECYCLE_SECTIONS.flatMap((section) =>
    legacyCapabilitiesForSection(section.id).map((item) => [item.id, section.id]),
  );
  assert.equal(new Set(owners.map(([id]) => id)).size, owners.length);
});
```

- [ ] **Step 2: Run test to verify RED**

Run: `node --test test/alert-center-lifecycle-view.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement minimal model**

Define immutable metadata for `overview`、`events`、`rules`、`notifications`、`operations`. Map DS failures and multi-country results to events; Nightingale/n8n/custom definitions to rules; preview and delivery records to notifications; connection checks, test, code preview, commit and deploy to operations. Unknown input returns `overview`.

- [ ] **Step 4: Verify GREEN**

Run: `node --test test/alert-center-lifecycle-view.test.mjs`

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add web/src/views/alert-center/lifecycle-model.js test/alert-center-lifecycle-view.test.mjs
git commit -m "feat(alert-center): define lifecycle navigation model"
```

### Task 2: 应用兼容子路由

**Files:**
- Modify: `web/src/state.js`
- Modify: `web/src/app.js`
- Modify: `test/alert-center-lifecycle-view.test.mjs`

- [ ] **Step 1: Write failing prefix-route test**

```js
import { findRouteForPath } from "../web/src/state.js";

test("alert child routes resolve to the alert sidebar entry", () => {
  const routes = [{ path: "/dashboard" }, { path: "/alerts", matchPrefix: true }];
  assert.equal(findRouteForPath(routes, "/alerts/events").path, "/alerts");
  assert.equal(findRouteForPath(routes, "/alerts/notifications").path, "/alerts");
  assert.equal(findRouteForPath(routes, "/missing").path, "/dashboard");
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test test/alert-center-lifecycle-view.test.mjs`

Expected: FAIL because `findRouteForPath` is missing.

- [ ] **Step 3: Implement route matching**

Add this pure helper to `web/src/state.js`:

```js
export function findRouteForPath(routes, path) {
  return routes.find((item) => item.path === path)
    || routes.find((item) => item.matchPrefix && path.startsWith(`${item.path}/`))
    || routes[0];
}
```

In `web/src/app.js`, mark `/alerts` with `matchPrefix: true`, use `findRouteForPath`, and include `state.route` in `routeRenderKey`. Child sections keep one active sidebar item.

- [ ] **Step 4: Verify**

```bash
node --test test/alert-center-lifecycle-view.test.mjs
node --check web/src/state.js
node --check web/src/app.js
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add web/src/state.js web/src/app.js test/alert-center-lifecycle-view.test.mjs
git commit -m "feat(alert-center): route lifecycle sections"
```

### Task 3: 生命周期导航与现有功能适配

**Files:**
- Create: `web/src/views/alert-center/lifecycle-nav.js`
- Modify: `web/src/views/alert-center.js`
- Modify: `web/src/styles.css`
- Modify: `test/alert-center-lifecycle-view.test.mjs`

- [ ] **Step 1: Write failing preservation test**

Read `alert-center.js` and `styles.css`; require `renderLifecycleNavigation`, `renderLifecycleBridge`, `.alert-lifecycle-nav`, and the existing `loadDashboard`、`loadHistoryTab`、`loadConfigTab`、`loadInventoryTab` functions.

- [ ] **Step 2: Verify RED**

Run: `node --test test/alert-center-lifecycle-view.test.mjs`

Expected: FAIL because navigation and bridge do not exist.

- [ ] **Step 3: Implement lifecycle adapter**

Use this mapping without copying backend logic:

```text
overview      -> existing loadDashboard
events        -> existing loadHistoryTab + DS failure/multi-country links
rules         -> existing loadConfigTab + custom registry link
notifications -> existing loadInventoryTab + notification preview link
operations    -> compatibility workspace for sandbox, DS monitor, registry test,
                 script preview, commit and deployment
```

Remove the old four-tab navigation on the main path but retain its loader functions. Keep `?variant=A|B|C` reachable only from overview during compatibility.

- [ ] **Step 4: Add accessible responsive styles**

Desktop uses a five-column navigation strip; below 900px it scrolls horizontally; below 600px it becomes a vertical list. Focus is visible, controls are at least 44px, and `prefers-reduced-motion` disables transitions.

- [ ] **Step 5: Verify**

```bash
node --test test/alert-center-lifecycle-view.test.mjs
node --check web/src/views/alert-center.js
node --check web/src/views/alert-center/lifecycle-nav.js
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add web/src/views/alert-center/lifecycle-nav.js web/src/views/alert-center.js web/src/styles.css test/alert-center-lifecycle-view.test.mjs
git commit -m "feat(alert-center): add lifecycle workspace navigation"
```

### Task 4: 旧页面迁移提示

**Files:**
- Create: `web/src/views/alert-center/legacy-migration-banner.js`
- Modify: `web/src/views/alert-registry.js`
- Modify: `web/src/views/rules.js`
- Modify: `web/src/views/sandbox.js`
- Modify: `web/src/views/notify-preview.js`
- Modify: `web/src/views/ds-scheduler.js`
- Modify: `web/src/views/ds-failure-logs.js`
- Modify: `web/src/styles.css`
- Modify: `test/alert-center-lifecycle-view.test.mjs`

- [ ] **Step 1: Write failing migration coverage test**

Require every legacy page to invoke `renderLegacyMigrationBanner`, and verify its target is one of the five lifecycle routes.

- [ ] **Step 2: Verify RED**

Run: `node --test test/alert-center-lifecycle-view.test.mjs`

Expected: FAIL because the shared banner is missing.

- [ ] **Step 3: Implement banner and integrations**

Use these destinations:

```text
alert-registry -> /alerts/rules
rules          -> /alerts/rules
sandbox        -> /alerts/operations
notify-preview -> /alerts/notifications
ds-scheduler   -> /alerts/rules
ds-failure-logs-> /alerts/events
```

The banner says the old capability remains available and names its new destination. It must not claim removal is imminent.

- [ ] **Step 4: Verify**

```bash
node --test test/alert-center-lifecycle-view.test.mjs
node --check web/src/views/alert-registry.js
node --check web/src/views/rules.js
node --check web/src/views/sandbox.js
node --check web/src/views/notify-preview.js
node --check web/src/views/ds-scheduler.js
node --check web/src/views/ds-failure-logs.js
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add web/src/views/alert-center/legacy-migration-banner.js web/src/views/alert-registry.js web/src/views/rules.js web/src/views/sandbox.js web/src/views/notify-preview.js web/src/views/ds-scheduler.js web/src/views/ds-failure-logs.js web/src/styles.css test/alert-center-lifecycle-view.test.mjs
git commit -m "feat(alert-center): link legacy alert workspaces"
```

### Task 5: 第一阶段完整验证

**Files:** Modify only if verification exposes a defect in Phase 1 files.

- [ ] **Step 1: Run focused tests**

```bash
node --test test/alert-center-lifecycle-view.test.mjs test/alert-registry.test.mjs test/alert-script-template.test.mjs test/ds-failure-log-view.test.mjs
```

Expected: zero failures.

- [ ] **Step 2: Run the complete suite**

Run: `npm test`

Expected: zero failures.

- [ ] **Step 3: Verify repository safety**

```bash
git diff --check
git status --short
git diff --name-only HEAD~4..HEAD
```

Expected: no conflict markers or whitespace errors; only Phase 1 files are committed; pre-existing data-governance and local files remain uncommitted.

- [ ] **Step 4: Verify the functional map**

Confirm every current capability remains available from a lifecycle page or explicit compatibility link. Do not trigger production notification, phone, n8n activation, code push, or deployment during testing.
