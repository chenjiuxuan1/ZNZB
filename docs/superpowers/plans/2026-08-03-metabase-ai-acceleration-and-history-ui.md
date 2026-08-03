# Metabase AI Acceleration and History UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep all existing anomaly investigations and patrol behavior intact while hiding only AI-verified-normal points from the fluctuation chart, lazily loading history, and introducing an opt-in acceleration path for automatic patrol analyses.

**Architecture:** The chart reads an analysis-display index rather than guessing from prose; missing, pending, failed, and unknown analyses default to visible. History becomes explicit user-driven loading except for one-record deep links. The acceleration feature remains isolated behind disabled-by-default settings and a separate queue/snapshot store, so normal patrol completion, notifications, manual Agent use, and the current five-tool ReAct route do not depend on it.

**Tech Stack:** Node.js ESM HTTP server, JSON stores, n8n/Dify webhooks, vanilla JavaScript frontend, `node:test`.

---

## File structure

- `src/metabase-anomaly-agent.mjs`: normalize the display contract conservatively; every unknown value becomes visible.
- `src/platform-api.mjs`: expose a small run-scoped analysis-display index and later host the opt-in acceleration dispatch; do not change the current history schema or patrol result semantics.
- `src/server.mjs`: add only the read-only display-index route.
- `web/src/app.js`, `web/src/state.js`, `web/src/views/batch-check.js`: remove startup history fetching and make recent history an explicit, bounded request.
- `web/src/views/fluctuation-visual.js`: join a lightweight display index to source anomalies, filter only verified-normal points, and require a user click before history loading.
- `test/platform-api.test.mjs`, `test/batch-check-view.test.mjs`: verify API, safety defaults, filtering, and lazy-loading behavior.
- `Metabase-数据侧根因分析-Agent-react.yml`, `docs/dify-evidence-tools-openapi.yaml`, n8n template: deferred to the opt-in acceleration task; these files are untouched by the UI/history release.

### Task 1: Add the conservative AI chart-visibility contract

**Files:**
- Modify: `src/metabase-anomaly-agent.mjs:400-416`
- Test: `test/platform-api.test.mjs`

- [ ] **Step 1: Write failing normalization tests**

```js
assert.equal(normalizeMetabaseAnomalyAnalysis({
  chartVisibility: "hide_verified_normal",
  verificationReason: "2026-08-03 15:31 底表数据已存在，DS 15:20 完成",
}).chartVisibility, "hide_verified_normal");
assert.equal(normalizeMetabaseAnomalyAnalysis({ chartVisibility: "hide" }).chartVisibility, "show");
```

- [ ] **Step 2: Run the focused test**

Run: `node --test test/platform-api.test.mjs`

Expected: fail because the normalizer does not yet expose `chartVisibility`.

- [ ] **Step 3: Implement explicit allow-list normalization**

```js
const chartVisibility = source.chartVisibility === "hide_verified_normal"
  ? "hide_verified_normal"
  : "show";
const verificationReason = chartVisibility === "hide_verified_normal"
  ? text(source.verificationReason, 600)
  : "";
```

Return these fields alongside the existing `dataSideVerdict` and `notificationAction`; do not infer them from other fields.

- [ ] **Step 4: Re-run the focused test**

Run: `node --test test/platform-api.test.mjs`

Expected: PASS.

### Task 2: Serve a read-only per-run analysis-display index

**Files:**
- Modify: `src/platform-api.mjs:357-393, 2995-3048`
- Modify: `src/server.mjs:89-109`
- Test: `test/platform-api.test.mjs`

- [ ] **Step 1: Write failing API tests**

```js
const index = await api.getMetabaseAnomalyAnalysisDisplayIndex({ runId: "run-agent-callback" });
assert.deepEqual(index.items, [{
  countryCode: "INE", anomalyIndex: 0, verificationStatus: "completed",
  chartVisibility: "hide_verified_normal", verificationReason: "底表已于 06:20 产出",
}]);
assert.equal((await api.getMetabaseAnomalyAnalysisDisplayIndex({ runId: "missing" })).items.length, 0);
```

- [ ] **Step 2: Run the focused test**

Run: `node --test test/platform-api.test.mjs`

Expected: fail because no display-index API exists.

- [ ] **Step 3: Implement a bounded, read-only index**

Add `getMetabaseAnomalyAnalysisDisplayIndex({ runId })`. It reads `metabase-anomaly-analyses.json`, selects only completed entries with the exact `runId`, and returns only identity, status, `chartVisibility`, and `verificationReason`. Pending/failed/missing entries are intentionally absent so the frontend defaults to visible. Add `GET /api/metabase-anomaly-analysis/display-index?runId=...` before the identity-required analysis route.

- [ ] **Step 4: Re-run the focused test**

Run: `node --test test/platform-api.test.mjs`

Expected: PASS.

### Task 3: Make global and batch-history loading explicit

**Files:**
- Modify: `web/src/app.js:36-103`
- Modify: `web/src/state.js:24-35`
- Modify: `web/src/views/batch-check.js:107-120, 440-475, 690-740`
- Test: `test/batch-check-view.test.mjs`

- [ ] **Step 1: Write failing UI-state tests**

```js
state.batchHistory = null;
state.batchHistoryLoaded = false;
renderBatchCheck(root);
assert.match(root.innerHTML, /加载最近 3 次巡检记录/);
assert.doesNotMatch(root.innerHTML, /<table/);
```

- [ ] **Step 2: Run the focused test**

Run: `node --test test/batch-check-view.test.mjs`

Expected: fail because the history panel renders an empty-history message instead of an explicit loader.

- [ ] **Step 3: Implement bounded lazy history loading**

Remove `batch-history` from both startup `Promise.all` paths unless the route contains `historyRunId`. Add `batchHistoryLoaded: false` to state. In the history panel, show a `#load-batch-history` button until loaded; its handler calls `reloadBatchHistory(root, 3)`. Make refresh and filters also request `limit=3`; do not use 50 or 200. Keep `historyRunId` direct links auto-loading one exact record.

- [ ] **Step 4: Re-run the focused test**

Run: `node --test test/batch-check-view.test.mjs`

Expected: PASS.

### Task 4: Filter only verified-normal points in the fluctuation chart

**Files:**
- Modify: `web/src/views/fluctuation-visual.js:20-105, 269-345, 564-580`
- Modify: `web/src/state.js:30-35`
- Test: `test/batch-check-view.test.mjs`

- [ ] **Step 1: Write failing model tests**

```js
const model = buildFluctuationVisualModel(history, countries, {
  displayIndex: new Map([["run-1:CN:0", { chartVisibility: "hide_verified_normal" }]),
});
assert.equal(model.anomalyCount, 0);
assert.equal(model.hiddenVerifiedNormalCount, 1);
```

Also assert that `pending`, missing, and `chartVisibility: "show"` retain the point.

- [ ] **Step 2: Run the focused test**

Run: `node --test test/batch-check-view.test.mjs`

Expected: fail because the model has no display-index join.

- [ ] **Step 3: Implement safe index joining and manual graph loading**

Use the key `${runId}:${countryCode}:${anomalyIndex}`. On explicit “加载最新波动图谱” click, fetch the existing `status=anomaly&limit=1` history and then the display-index endpoint for that run. Filter only exact `hide_verified_normal` entries, show a hidden-count link/message, and default every absent entry to visible. Remove the first-render auto-call to `reloadFluctuationHistory`; render the loader button instead. On a later retry/result refresh, clear the point’s local index entry so it remains visible until a new completed result arrives.

- [ ] **Step 4: Re-run the focused test**

Run: `node --test test/batch-check-view.test.mjs`

Expected: PASS.

### Task 5: Preserve complete audit visibility and run regression tests

**Files:**
- Modify: `web/src/views/batch-check.js:1119-1138`
- Test: `test/batch-check-view.test.mjs`, `test/platform-api.test.mjs`

- [ ] **Step 1: Add audit rendering tests**

```js
assert.match(renderMetabaseAnomalyAnalysis({ analysis: {
  chartVisibility: "hide_verified_normal", verificationReason: "底表已核验",
} }), /AI 已核验正常/);
assert.match(renderMetabaseAnomalyAnalysis({ analysis: {
  chartVisibility: "hide_verified_normal", verificationReason: "底表已核验",
} }), /不展示于波动图谱/);
```

- [ ] **Step 2: Implement the audit marker**

Only for `hide_verified_normal`, append a visible marker and the sanitized `verificationReason` to the existing analysis panel. Retain the existing original message, analysis lists, confidence, limitations, and retry button.

- [ ] **Step 3: Run UI and API regressions**

Run: `node --test test/batch-check-view.test.mjs test/platform-api.test.mjs`

Expected: PASS, including the pre-existing patrol, callback, force-retry, and deep-link tests.

- [ ] **Step 4: Run the full suite**

Run: `npm test`

Expected: all pre-existing tests pass; if the known user-worktree failure remains, report it without changing `src/platform-api.mjs` outside this feature.

### Task 6: Add the opt-in acceleration path only after the UI release is stable

**Files:**
- Create: `src/metabase-anomaly-acceleration.mjs`
- Modify: `src/platform-api.mjs`, `src/server.mjs`, `src/evidence-tool-proxy.mjs`
- Modify: `Metabase-数据侧根因分析-Agent-react.yml`
- Modify: `docs/dify-evidence-tools-openapi.yaml`
- Modify: `n8n-metabase-anomaly-dynamic-evidence-agent.template.json`
- Create: `test/metabase-anomaly-acceleration.test.mjs`

- [ ] **Step 1: Write isolated queue and expiry tests**

Test that the feature flag defaults off, enqueuing never blocks a patrol result, a snapshot identity cannot be read under another `runId`, and expired/incomplete snapshots return `complete:false`.

- [ ] **Step 2: Implement a disabled-by-default dispatcher**

Use `METABASE_ANOMALY_AGENT_ACCELERATION_ENABLED=false` by default. Dispatch after, not inside, normal patrol completion. Persist raw evidence separately from analyses and enforce run/date/TTL identity. Do not change the current five tools or their manual path.

- [ ] **Step 3: Add the sixth Dify tool and fallback contract**

The new tool exposes only raw evidence with `complete`, timestamps, and missing reasons. The Agent must call it only when `snapshotId` is present and must use the five existing tools whenever evidence is incomplete or contradictory.

- [ ] **Step 4: Validate shadow mode before enabling**

Run new tests plus `npm test`; import neither the Dify DSL nor n8n template into production until shadow-mode measurements show safe downstream concurrency and exact factual agreement.

## Self-review

- The UI release has no dependency on Task 6 and is safe to ship first.
- Every chart filtering condition defaults to visible, satisfying the no-false-hide requirement.
- No task alters original history records, notification send behavior, patrol status, manual Agent use, or deep links.
- The acceleration release is separately gated and cannot run without an explicit environment change.
