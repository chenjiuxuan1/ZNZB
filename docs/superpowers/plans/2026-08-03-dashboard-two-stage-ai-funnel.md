# Dashboard Two-Stage AI Funnel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace source-table batches with one dashboard-wide screening request, then run one deep-analysis request for each metric that is suspicious or not proven normal.

**Architecture:** A pure planner builds dashboard screening jobs and single-metric follow-up jobs. The existing callback-gated queue runs both phases with one shared concurrency limit of two and a 30-minute deadline. Protocol v4 distinguishes `dashboard_screening` from `metric_deep_analysis`; notification and history remain blocked until both phases settle.

**Tech Stack:** Node.js ES modules, JSON-file persistence, n8n workflow JSON, Dify workflow YAML, Node test runner, browser-rendered JavaScript.

---

### Task 1: Dashboard screening planner

**Files:**
- Modify: `src/metabase-anomaly-batch.mjs`
- Modify: `test/metabase-anomaly-batch.test.mjs`

- [ ] **Step 1: Write the failing grouping test**

```js
test("groups every anomaly from one dashboard into one screening job", () => {
  const jobs = buildDashboardScreeningJobs([
    { countryCode: "PH", dashboardUuid: "dash-1", anomalyIndex: 0 },
    { countryCode: "PH", dashboardUuid: "dash-1", anomalyIndex: 1 },
    { countryCode: "PH", dashboardUuid: "dash-2", anomalyIndex: 2 },
  ]);
  assert.deepEqual(jobs.map((job) => job.cases.map((item) => item.anomalyIndex)), [[0, 1], [2]]);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test test/metabase-anomaly-batch.test.mjs`

Expected: FAIL because `buildDashboardScreeningJobs` is not exported.

- [ ] **Step 3: Implement dashboard grouping and payload protection**

```js
export const MAX_DASHBOARD_SCREENING_BYTES = 512 * 1024;

export function buildDashboardScreeningJobs(cases = []) {
  const groups = new Map();
  for (const item of cases) {
    const countryCode = String(item.countryCode || "").toUpperCase();
    const dashboardUuid = String(item.dashboardUuid || item.anomaly?.dashboardUuid || "");
    if (!countryCode || !dashboardUuid) continue;
    const key = `${countryCode}:${dashboardUuid}`;
    const group = groups.get(key) || { groupKey: key, countryCode, dashboardUuid, dashboardTitle: item.dashboardTitle || item.anomaly?.dashboardTitle || "", cases: [] };
    group.cases.push(item);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function buildMetricDeepAnalysisJobs(screeningJob, verdicts) {
  const byIndex = new Map(verdicts.map((item) => [Number(item.anomalyIndex), item]));
  return screeningJob.cases
    .filter((item) => byIndex.get(Number(item.anomalyIndex))?.screeningVerdict !== "verified_normal")
    .map((item) => ({ ...screeningJob, stage: "metric_deep_analysis", cases: [item], screeningVerdict: byIndex.get(Number(item.anomalyIndex)) || null }));
}
```

- [ ] **Step 4: Run the focused tests**

Run: `node --test test/metabase-anomaly-batch.test.mjs`

Expected: PASS, including the existing hard concurrency and deadline tests.

- [ ] **Step 5: Commit**

```bash
git add src/metabase-anomaly-batch.mjs test/metabase-anomaly-batch.test.mjs
git commit -m "feat: plan dashboard AI screening jobs"
```

### Task 2: Persist two-stage jobs and callbacks

**Files:**
- Modify: `src/platform-api.mjs`
- Modify: `src/server.mjs`
- Modify: `test/platform-api.test.mjs`

- [ ] **Step 1: Write failing tests for screening and follow-up callbacks**

```js
test("dashboard screening callback creates follow-ups only for non-normal metrics", async () => {
  const screening = await api.completeMetabaseDashboardScreening({
    runId: "run-1", countryCode: "PH", dashboardUuid: "dash-1", jobId: "job-1",
    dashboardSummary: "公共证据已核查",
    verdicts: [
      { anomalyIndex: 0, screeningVerdict: "verified_normal", summary: "实时值正常" },
      { anomalyIndex: 1, screeningVerdict: "suspected_issue", summary: "分区缺失" },
    ],
  });
  assert.deepEqual(screening.followUps.map((item) => item.cases[0].anomalyIndex), [1]);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test --test-name-pattern="dashboard screening" test/platform-api.test.mjs`

Expected: FAIL because the screening callback is absent.

- [ ] **Step 3: Add stage-aware records and callback endpoint**

Store `stage`, `dashboardUuid`, `dashboardSummary`, `screeningVerdict`, and `parentJobId` in the existing analysis cache. Add `POST /api/metabase-anomaly-analysis/screening-callback`, authenticated by the existing callback token. Validate that verdict indexes exactly equal the submitted case indexes; invalid responses produce follow-ups for every case.

- [ ] **Step 4: Run focused platform tests**

Run: `node --test test/platform-api.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/platform-api.mjs src/server.mjs test/platform-api.test.mjs
git commit -m "feat: persist dashboard screening verdicts"
```

### Task 3: Run both phases through one bounded queue

**Files:**
- Modify: `src/platform-api.mjs`
- Modify: `test/platform-api.test.mjs`

- [ ] **Step 1: Write a failing end-to-end ordering test**

```js
assert.deepEqual(order, ["screen:dash-1", "screen:dash-2", "deep:1", "notify"]);
assert.ok(maxObservedConcurrency <= 2);
assert.equal(historyBeforeCallbacks.runs.length, 0);
```

- [ ] **Step 2: Run the test and verify old source-table batching fails it**

Run: `node --test --test-name-pattern="two-stage AI patrol" test/platform-api.test.mjs`

Expected: FAIL with source-table jobs or notification before deep analysis.

- [ ] **Step 3: Implement phase orchestration**

Build dashboard snapshots once, run all screening jobs through `runBoundedInvestigationQueue`, derive follow-up jobs, then run those jobs through the same queue and same deadline. Mark oversized screening payloads and unfinished jobs `AI 未核验`. Call `buildAiFinalizedCountryRuns`, notification, and history only after both queues settle.

- [ ] **Step 4: Run focused tests**

Run: `node --test test/platform-api.test.mjs test/metabase-anomaly-batch.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/platform-api.mjs test/platform-api.test.mjs
git commit -m "feat: orchestrate two-stage dashboard AI patrol"
```

### Task 4: Protocol v4 n8n workflow

**Files:**
- Modify: `src/metabase-anomaly-agent.mjs`
- Modify: `n8n-metabase-anomaly-dynamic-evidence-agent.template.json`
- Modify: `test/metabase-anomaly-agent.test.mjs`
- Modify: `test/n8n-workflow-template.test.mjs`

- [ ] **Step 1: Write failing protocol tests**

```js
assert.equal(body.protocolVersion, 4);
assert.equal(body.job.stage, "dashboard_screening");
assert.equal(body.job.cases.length, 12);
assert.match(screeningCallbackUrl, /screening-callback$/);
```

- [ ] **Step 2: Run tests and verify protocol v3 fails**

Run: `node --test test/metabase-anomaly-agent.test.mjs test/n8n-workflow-template.test.mjs`

Expected: FAIL on protocol and three-case validation.

- [ ] **Step 3: Implement stage-aware protocol**

Send `{ protocolVersion: 4, job: { stage, runId, countryCode, dashboardUuid, snapshotId, cases }, callback }`. n8n validates a 512 KiB maximum body, accepts all dashboard cases for screening, requires exactly one case for deep analysis, calls Dify once, validates all returned indexes, and routes the callback by stage.

- [ ] **Step 4: Run protocol tests**

Run: `node --test test/metabase-anomaly-agent.test.mjs test/n8n-workflow-template.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/metabase-anomaly-agent.mjs n8n-metabase-anomaly-dynamic-evidence-agent.template.json test/metabase-anomaly-agent.test.mjs test/n8n-workflow-template.test.mjs
git commit -m "feat: add two-stage n8n AI protocol"
```

### Task 5: Dify screening and deep-analysis instructions

**Files:**
- Modify: `Metabase-数据侧根因分析-Agent-react.yml`
- Modify: `test/dify-agent-dsl.test.mjs`

- [ ] **Step 1: Write failing DSL assertions**

```js
assert.match(dsl, /dashboard_screening/);
assert.match(dsl, /metric_deep_analysis/);
assert.match(dsl, /只有实时证据明确证明/);
assert.match(dsl, /screeningVerdict/);
```

- [ ] **Step 2: Run the DSL test and verify it fails**

Run: `node --test test/dify-agent-dsl.test.mjs`

Expected: FAIL.

- [ ] **Step 3: Update inputs and instruction**

Add `analysis_stage`, `dashboard_uuid`, `dashboard_title`, `dashboard_summary`, and `screening_json`. In screening mode, summarize the dashboard and return one conservative `screeningVerdict` per case. In deep mode, investigate exactly one case and return the existing complete evidence verdict. Keep max iterations at 8 and tool-call budget at 6.

- [ ] **Step 4: Run the DSL test**

Run: `node --test test/dify-agent-dsl.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add Metabase-数据侧根因分析-Agent-react.yml test/dify-agent-dsl.test.mjs
git commit -m "feat: teach Dify two-stage dashboard analysis"
```

### Task 6: Progress and history UI

**Files:**
- Modify: `web/src/views/batch-check.js`
- Modify: `web/src/styles.css`
- Modify: `test/batch-check-view.test.mjs`

- [ ] **Step 1: Write failing rendering tests**

```js
assert.match(html, /看板初筛 2\/5/);
assert.match(html, /指标深度分析 1\/3/);
assert.match(historyHtml, /看板 AI 总结/);
assert.match(historyHtml, /AI 核验无异常/);
```

- [ ] **Step 2: Run the view test and verify it fails**

Run: `node --test test/batch-check-view.test.mjs`

Expected: FAIL.

- [ ] **Step 3: Render phase progress and audit results**

Show screening and deep-analysis counters in the AI stage. In history, render one dashboard summary followed by per-metric final status and reason. Preserve explicit button feedback and the existing non-collapsing country details behavior.

- [ ] **Step 4: Run the view test**

Run: `node --test test/batch-check-view.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/views/batch-check.js web/src/styles.css test/batch-check-view.test.mjs
git commit -m "feat: show two-stage AI patrol progress"
```

### Task 7: Documentation and full regression

**Files:**
- Modify: `docs/metabase-anomaly-agent.md`
- Modify: `docs/superpowers/specs/2026-08-03-ai-first-notification-design.md`

- [ ] **Step 1: Update deployment order and safety limits**

Document protocol v4, one-screening-request-per-dashboard, single-metric follow-ups, shared concurrency two, 512 KiB payload protection, and the required import order.

- [ ] **Step 2: Run static validation**

Run: `git diff --check`

Expected: no output.

- [ ] **Step 3: Run the complete test suite**

Run: `npm test`

Expected: all tests pass with zero failures.

- [ ] **Step 4: Review secrets and placeholders**

Run: `rg -n "REPLACE_WITH_|fuxi_backend_query_all|49eda533" n8n-metabase-anomaly-dynamic-evidence-agent.template.json docs/dify-evidence-tools-openapi.yaml`

Expected: only documented `REPLACE_WITH_` placeholders; no real tokens.

- [ ] **Step 5: Commit**

```bash
git add docs/metabase-anomaly-agent.md docs/superpowers/specs/2026-08-03-ai-first-notification-design.md
git commit -m "docs: explain two-stage dashboard AI patrol"
```
