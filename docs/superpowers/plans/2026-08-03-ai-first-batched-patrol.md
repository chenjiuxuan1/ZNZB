# AI-First Batched Patrol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make scheduled Metabase patrols collect shared source-table evidence once, submit at most two Dify batch investigations at a time with at most three anomaly metrics each, and only notify after final AI verdicts are available.

**Architecture:** A new batch-orchestration module owns the bounded queue, pending-run persistence, timeout state and verdict filtering. `platform-api` remains the owner of patrol scans, history and notifications; it delegates only the AI-first phase. n8n receives one bounded batch payload and calls Dify once per batch; Dify returns a structured verdict for every case in that batch. The existing single-anomaly API remains for manual investigation.

**Tech Stack:** Node.js ESM, native `node:test`, JSON files with `writeJsonAtomic`, n8n workflow JSON, Dify DSL/OpenAPI 3.0.

---

### Task 1: Add immutable batch limits and deterministic group construction

**Files:**
- Create: `src/metabase-anomaly-batch.mjs`
- Test: `test/metabase-anomaly-batch.test.mjs`

- [ ] **Step 1: Write failing grouping and limit tests**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { buildInvestigationBatches, getBatchInvestigationLimits } from "../src/metabase-anomaly-batch.mjs";

test("batch investigation groups same source and limits every Dify payload to three cases", () => {
  const batches = buildInvestigationBatches([
    { countryCode: "INE", sourceTable: "ads.loan_d", anomalyIndex: 0 },
    { countryCode: "INE", sourceTable: "ads.loan_d", anomalyIndex: 1 },
    { countryCode: "INE", sourceTable: "ads.loan_d", anomalyIndex: 2 },
    { countryCode: "INE", sourceTable: "ads.loan_d", anomalyIndex: 3 },
  ]);
  assert.deepEqual(batches.map((batch) => batch.cases.map((item) => item.anomalyIndex)), [[0, 1, 2], [3]]);
});

test("batch investigation limits never exceed two Dify workers or three cases", () => {
  assert.deepEqual(getBatchInvestigationLimits({
    METABASE_ANOMALY_BATCH_CONCURRENCY: "99",
    METABASE_ANOMALY_BATCH_SIZE: "99",
  }), { maxConcurrentBatches: 2, maxCasesPerBatch: 3, timeoutMs: 600000 });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/metabase-anomaly-batch.test.mjs`  
Expected: FAIL because the batch module does not exist.

- [ ] **Step 3: Implement the pure batching boundary**

```js
const MAX_CONCURRENT_BATCHES = 2;
const MAX_CASES_PER_BATCH = 3;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export function getBatchInvestigationLimits(env = process.env) {
  return { maxConcurrentBatches: MAX_CONCURRENT_BATCHES, maxCasesPerBatch: MAX_CASES_PER_BATCH, timeoutMs: DEFAULT_TIMEOUT_MS };
}

export function buildInvestigationBatches(cases, { maxCasesPerBatch = MAX_CASES_PER_BATCH } = {}) {
  const groups = new Map();
  for (const item of cases) {
    const key = `${item.countryCode}:${item.sourceTable}`;
    groups.set(key, [...(groups.get(key) || []), item]);
  }
  return [...groups.entries()].flatMap(([groupKey, items]) =>
    items.reduce((batches, item, index) => {
      const batchIndex = Math.floor(index / maxCasesPerBatch);
      (batches[batchIndex] ||= { groupKey, cases: [] }).cases.push(item);
      return batches;
    }, []));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/metabase-anomaly-batch.test.mjs`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/metabase-anomaly-batch.mjs test/metabase-anomaly-batch.test.mjs
git commit -m "feat: bound Metabase AI investigation batches"
```

### Task 2: Persist pending patrol evidence without exposing it as final history

**Files:**
- Modify: `src/platform-api.mjs:55-105,294-570`
- Modify: `src/server.mjs:105-145`
- Test: `test/platform-api.test.mjs`

- [ ] **Step 1: Write a failing test for pending-run lookup before final history**

```js
test("batch evidence callback can resolve an anomaly from a pending patrol run", async () => {
  const api = createPlatformApi({ rootDir });
  await api.savePendingMetabasePatrolRun({ id: "pending-1", runs: fixtureCountryRuns });
  const result = await api.getMetabaseAnomalyCardSql({ runId: "pending-1", countryCode: "INE", anomalyIndex: 0 });
  assert.equal(result.card.id, 1);
  assert.equal((await api.getBatchHistory()).runs.length, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/platform-api.test.mjs`  
Expected: FAIL because pending patrol runs have no storage or lookup path.

- [ ] **Step 3: Add dedicated pending-run storage and shared anomaly lookup**

Add `config/metabase-anomaly-pending-runs.json` to `FILES`, with a bounded retention helper. Extract a private `findMetabasePatrolAnomaly({ runId, countryCode, anomalyIndex })` that checks final batch history first, then pending runs. Use it from `analyzeMetabaseAnomaly`, `getMetabaseAnomalyCardSql`, `completeMetabaseAnomalyAnalysis`, and evidence-snapshot access. Keep `getBatchHistory` reading only final history.

- [ ] **Step 4: Add protected batch callback endpoint**

```js
if (method === "POST" && url.pathname === "/api/metabase-anomaly-analysis/batch-callback") {
  const body = await readBody(request, {});
  assertMetabaseAgentCallbackAuthorized(request, body);
  return sendJson(response, 200, await api.completeMetabaseAnomalyBatch(body));
}
```

`completeMetabaseAnomalyBatch` must reject a missing `jobId`, more than three results, duplicate anomaly indices, or results not belonging to its pending batch. It writes one existing-format analysis cache record per returned case.

- [ ] **Step 5: Run platform tests and commit**

Run: `node --test test/platform-api.test.mjs`  
Expected: PASS.

```bash
git add src/platform-api.mjs src/server.mjs test/platform-api.test.mjs
git commit -m "feat: persist pending AI-first patrol evidence"
```

### Task 3: Collect one shared evidence snapshot per source table

**Files:**
- Modify: `src/platform-api.mjs:294-570,1378-1465`
- Modify: `src/metabase-anomaly-batch.mjs`
- Test: `test/platform-api.test.mjs`

- [ ] **Step 1: Write a failing test proving a same-table group reads Card SQL once**

```js
test("AI-first patrol stores one shared evidence snapshot for same-table anomalies", async () => {
  const cardsRead = [];
  const api = createPlatformApi({ rootDir, metabaseInternalClientFactory: () => ({
    getCard: async (id) => { cardsRead.push(id); return { id, name: "放款", dataset_query: { native: { query: "select * from ads.loan_d" } } }; },
  }) });
  const prepared = await api.prepareMetabaseInvestigationBatches("pending-1", fixtureCountryRuns);
  assert.equal(prepared.batches.length, 1);
  assert.equal(prepared.batches[0].cases.length, 2);
  assert.equal(cardsRead.length, 1);
  assert.match(prepared.batches[0].snapshotId, /^snapshot-/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/platform-api.test.mjs`  
Expected: FAIL because batch preparation is absent.

- [ ] **Step 3: Implement source-table preparation**

For every unique card ID, read card SQL once through the existing readonly internal client, parse `FROM`/`JOIN` tables with the existing n8n parser-compatible helper, then group by `countryCode + primarySourceTable`. Build a compact snapshot `{ cardSql, sourceTables, wattrelSummaryForCountry, dsSchedulerSummary, cases }`, persist it with a generated snapshot ID, and pass only the shared summary plus three case descriptors to Dify. If SQL cannot yield a table, use a unique `card:<id>` source key so unrelated cards are never merged.

- [ ] **Step 4: Expand the snapshot read contract**

Make `getMetabaseAnomalyEvidenceSnapshot` accept `{ runId, countryCode, snapshotId }`; `anomalyIndex` is optional for legacy manual requests. It must return only the matching group snapshot and must not expose another country or run.

- [ ] **Step 5: Run tests and commit**

Run: `node --test test/platform-api.test.mjs test/metabase-anomaly-batch.test.mjs`  
Expected: PASS.

```bash
git add src/platform-api.mjs src/metabase-anomaly-batch.mjs test/platform-api.test.mjs test/metabase-anomaly-batch.test.mjs
git commit -m "feat: collect shared source-table evidence once"
```

### Task 4: Replace fire-and-forget dispatch with a callback-gated queue

**Files:**
- Modify: `src/metabase-anomaly-agent.mjs`
- Modify: `src/platform-api.mjs:752-870,1378-1465,1466-1585,2918-2960`
- Modify: `src/metabase-anomaly-batch.mjs`
- Test: `test/platform-api.test.mjs`

- [ ] **Step 1: Write failing ordering and concurrency tests**

```js
test("AI-first patrol never notifies before every batch settles", async () => {
  const order = [];
  const api = createPlatformApi({ rootDir,
    metabaseAnomalyBatchAgentFn: async (batch) => { order.push(`submit:${batch.batchId}`); return { pending: true, jobId: batch.batchId }; },
    notifyTextFn: async () => { order.push("notify"); return { sent: true }; },
  });
  const run = api.runBatchScheduleNow(now);
  await waitForSubmittedBatches(2);
  assert.equal(order.includes("notify"), false);
  await completeAllBatchCallbacks(api);
  await run;
  assert.equal(order.at(-1), "notify");
});

test("AI-first patrol never submits more than two unfinished Dify batches", async () => {
  // Hold the first two callbacks and assert the third submission has not occurred.
});

test("AI-first patrol stops submitting batches at the thirty-minute global deadline", async () => {
  // Advance the injected clock beyond 30 minutes and assert queued cases become timed_out without a third submit.
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/platform-api.test.mjs`  
Expected: FAIL because scheduling currently sends notifications and history before `dispatchDashboardGroupedAnalysis`.

- [ ] **Step 3: Add a dedicated batch transport**

Add `analyzeMetabaseAnomalyBatch({ batch, env, fetchFn })` in `src/metabase-anomaly-agent.mjs`. Its n8n body must include `protocolVersion: 3`, `jobId`, `batchId`, `snapshotId`, and at most three `cases`. It must use the existing ingress token/callback credentials and return pending only after n8n accepts the batch; the legacy `analyzeMetabaseAnomaly` remains unchanged for manual analysis.

- [ ] **Step 4: Run the callback-gated scheduler**

Extract the duplicated manual/due patrol body into `runAiFirstScheduledPatrol({ trigger, now, schedule })`.

```js
const batches = await prepareMetabaseInvestigationBatches(historyRunId, countryRuns, summaries);
const settled = await runBoundedBatchQueue(batches, {
  concurrency: 2,
  submit: (batch) => submitMetabaseAnomalyBatch(batch),
  waitForCallback: (batch) => waitForBatchSettlement(batch, { timeoutMs: 600000, intervalMs: 2000 }),
  onProgress: updateBatchScheduleAiProgress,
});
const finalRuns = applyAiVerdictsToCountryRuns(countryRuns, settled);
const notificationSentCount = await sendScheduledAggregateNotifications({ countryRuns: finalRuns, ... });
```

`waitForBatchSettlement` polls the locally persisted result records every two seconds. A per-batch timeout creates one `status: "timed_out"`, `dataSideVerdict: "insufficient_evidence"`, `notificationAction: "send"` record per unfinished case. The queue receives an injected patrol deadline of `startedAt + 30 minutes`: at that deadline it submits no further batches, marks every queued/unfinished case timed out, and proceeds to conservative notification. At 20 minutes, progress reports `approaching_deadline`. This permits conservative notification and never leaves `batchScheduleRunning` locked.

- [ ] **Step 5: Update progress order**

Set notification stage to `queued` before AI starts; during the queue show `groups`, `batches`, `caseCount`, `submitted`, `completed`, `timedOut`, and `failed`. Only mark notification `running` after the queue settles. Move `finishedAt` and final stage success assignment after notification and history persistence.

- [ ] **Step 6: Run tests and commit**

Run: `node --test test/platform-api.test.mjs test/metabase-anomaly-agent.test.mjs test/metabase-anomaly-batch.test.mjs`  
Expected: PASS.

```bash
git add src/platform-api.mjs src/metabase-anomaly-agent.mjs src/metabase-anomaly-batch.mjs test/platform-api.test.mjs test/metabase-anomaly-agent.test.mjs test/metabase-anomaly-batch.test.mjs
git commit -m "feat: gate patrol notifications on bounded AI batches"
```

### Task 5: Filter final notifications and keep full per-metric audit history

**Files:**
- Modify: `src/platform-api.mjs:2963-3270`
- Modify: `src/notifier.mjs`
- Test: `test/platform-api.test.mjs`
- Test: `test/notifier.test.mjs`

- [ ] **Step 1: Write failing final-verdict filtering tests**

```js
test("final patrol notification excludes AI-verified business changes and normal values", async () => {
  const finalRuns = applyAiVerdictsToCountryRuns(fixtureCountryRuns, verdicts);
  const messages = buildPublicCheckMessages(combineScheduledCountryResults(finalRuns), alerts);
  assert.doesNotMatch(messages[0].body, /业务变化指标/);
  assert.match(finalRuns[0].result.aiAudit[0].statusLabel, /AI 核验为业务变化/);
});

test("AI timeout remains in final notification with an unverified marker", () => {
  // Assert `AI 未核验，请人工确认` is rendered.
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/platform-api.test.mjs test/notifier.test.mjs`  
Expected: FAIL because notification currently consumes raw anomalies only.

- [ ] **Step 3: Implement final view versus audit view**

Keep raw `result.anomalies` unchanged. Add `result.aiAudit` with one record per anomaly and `result.notifiableAnomalies` for the final notification projection. `buildPublicCheckMessages` receives a cloned result whose `anomalies` are only notifiable items. `buildBatchHistoryEntry` retains raw count, adds `notifiableAnomalyCount`, `aiVerdictCounts`, and all `aiAudit` records. Do not remove raw anomalies.

- [ ] **Step 4: Run tests and commit**

Run: `node --test test/platform-api.test.mjs test/notifier.test.mjs`  
Expected: PASS.

```bash
git add src/platform-api.mjs src/notifier.mjs test/platform-api.test.mjs test/notifier.test.mjs
git commit -m "feat: notify only AI-finalized Metabase anomalies"
```

### Task 6: Upgrade n8n, Dify DSL and OpenAPI for batch verdicts

**Files:**
- Modify: `n8n-metabase-anomaly-dynamic-evidence-agent.template.json`
- Modify: `Metabase-数据侧根因分析-Agent-react.yml`
- Modify: `docs/dify-evidence-tools-openapi.yaml`
- Modify: `docs/metabase-anomaly-agent.md`
- Test: `test/n8n-workflow-template.test.mjs`
- Test: `test/dify-agent-dsl.test.mjs`

- [ ] **Step 1: Write failing template/DSL assertions**

```js
assert.match(JSON.stringify(workflow), /protocolVersion: 3/);
assert.match(JSON.stringify(workflow), /batch-callback/);
assert.match(dsl, /value: 8/);
assert.match(dsl, /最多 3 条异常指标/);
assert.doesNotMatch(dsl, /必须完成步骤 2–7/);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/n8n-workflow-template.test.mjs test/dify-agent-dsl.test.mjs`  
Expected: FAIL because the template is protocol v2 and has one-case callbacks.

- [ ] **Step 3: Make n8n batch-native**

Replace the single-case normalizer with a validator that rejects more than three cases. Remove its independent Card SQL fetch because ZNZB supplies `snapshotId` and compact `state_json`. Send Dify one blocking request with `cases_json`. Parse `verdicts` as an array, validate exactly one result per input anomaly index, and call `/api/metabase-anomaly-analysis/batch-callback` once. Preserve placeholder-only authentication values in the checked-in template.

- [ ] **Step 4: Make Dify output bounded verdict arrays**

Add start inputs `batch_id`, `snapshot_id`, and `cases_json`. Set `max_iterations` to 8. In the instruction: read the snapshot first, handle at most three cases, reuse shared evidence, use tools only for missing evidence, never repeat snapshot facts, and return:

```json
{"action":"finish","verdicts":[{"anomalyIndex":0,"summary":"...","dataSideVerdict":"data_issue","notificationAction":"send","chartVisibility":"show","confidence":"high","limitations":"..."}]}
```

Update OpenAPI snapshot schema to accept group-level snapshots while retaining legacy single anomaly compatibility.

- [ ] **Step 5: Update deployment documentation**

Document the import order, the two fixed limits, the batch callback endpoint, the required Dify app API key and the fact that existing queued workflow executions should be drained/cancelled before enabling protocol v3.

- [ ] **Step 6: Run tests and commit**

Run: `node --test test/n8n-workflow-template.test.mjs test/dify-agent-dsl.test.mjs`  
Expected: PASS.

```bash
git add n8n-metabase-anomaly-dynamic-evidence-agent.template.json Metabase-数据侧根因分析-Agent-react.yml docs/dify-evidence-tools-openapi.yaml docs/metabase-anomaly-agent.md test/n8n-workflow-template.test.mjs test/dify-agent-dsl.test.mjs
git commit -m "feat: batch bounded Dify evidence verdicts"
```

### Task 7: Render AI-first progress and final per-metric status

**Files:**
- Modify: `web/batch-check-view.mjs`
- Test: `test/batch-check-view.test.mjs`

- [ ] **Step 1: Write failing UI tests**

```js
test("scheduled progress keeps notification waiting until AI batches settle", () => {
  root.innerHTML = renderBatchScheduleRunProgress({
    stages: [{ key: "ai_analysis", status: "running", batchCount: 8, completed: 2, caseCount: 21 }, { key: "notification", status: "queued" }],
  });
  assert.match(root.innerHTML, /调查组/);
  assert.match(root.innerHTML, /裁决批次 2\/8/);
  assert.match(root.innerHTML, /告警通知.*等待 AI 取证/);
});

test("history anomaly card renders AI-verified normal and unverified timeout labels", () => {
  // Assert both labels and details are visible without hiding raw audit data.
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/batch-check-view.test.mjs`  
Expected: FAIL because the current view only uses dashboard count and has no final audit labels.

- [ ] **Step 3: Render explicit AI status**

Display group/batch/case counters, timeouts and failures in AI stage; hold notification as waiting until settlement. In history, render `AI 已核验数据故障`, `AI 核验为业务变化`, `AI 查数正常`, or `AI 未核验` from `aiAudit`; only hide verified-normal items from the fluctuation chart, never from the history audit.

- [ ] **Step 4: Run tests and commit**

Run: `node --test test/batch-check-view.test.mjs`  
Expected: PASS.

```bash
git add web/batch-check-view.mjs test/batch-check-view.test.mjs
git commit -m "feat: show AI-first patrol progress and verdict status"
```

### Task 8: Full regression and safe rollout guard

**Files:**
- Modify: `docs/metabase-anomaly-agent.md`
- Test: `test/*.test.mjs`

- [ ] **Step 1: Add a startup-safe default**

Keep `METABASE_ANOMALY_AGENT_AUTO_TRIGGER=0` documented as the temporary circuit breaker. Add a separate explicit `METABASE_ANOMALY_BATCH_MODE=1` gate; protocol v3 remains disabled until the new n8n JSON, OpenAPI provider and Dify DSL are imported and published.

- [ ] **Step 2: Run complete regression**

Run: `npm test`  
Expected: all tests pass with no skipped failures.

- [ ] **Step 3: Validate generated delivery artifacts**

Run: `git diff --check && git status --short`  
Expected: no whitespace errors; only intended implementation files changed.

- [ ] **Step 4: Commit rollout documentation**

```bash
git add docs/metabase-anomaly-agent.md
git commit -m "docs: add safe AI-first patrol rollout"
```

## Plan self-review

- Spec coverage: Tasks 1–3 implement source grouping, one shared snapshot and three-case batch payloads; Task 4 enforces two callback-gated in-flight batches and AI-before-notification; Task 5 preserves audit while filtering final notifications; Task 6 changes n8n/Dify/OpenAPI; Task 7 exposes all states; Task 8 provides an explicit circuit breaker and full regression.
- Placeholder scan: no TBD/TODO markers or unspecified code paths remain; every implementation task names files, tests and commands.
- Type consistency: batch identity is consistently `{ runId, batchId, snapshotId, cases[] }`; cases always carry `{ countryCode, anomalyIndex }`; individual output remains the existing analysis-cache record shape.
