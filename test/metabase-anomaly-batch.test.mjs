import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDashboardScreeningJobs,
  buildInvestigationBatches,
  buildMetricDeepAnalysisJobs,
  getBatchInvestigationLimits,
  runBoundedInvestigationQueue,
} from "../src/metabase-anomaly-batch.mjs";

test("groups every anomaly from one dashboard into one screening job", () => {
  const jobs = buildDashboardScreeningJobs([
    { countryCode: "PH", dashboardUuid: "dash-1", dashboardTitle: "OKR", anomalyIndex: 0 },
    { countryCode: "PH", dashboardUuid: "dash-1", dashboardTitle: "OKR", anomalyIndex: 1 },
    { countryCode: "PH", dashboardUuid: "dash-2", dashboardTitle: "资产", anomalyIndex: 2 },
  ]);

  assert.deepEqual(jobs.map((job) => job.cases.map((item) => item.anomalyIndex)), [[0, 1], [2]]);
  assert.equal(jobs[0].stage, "dashboard_screening");
  assert.equal(jobs[0].dashboardUuid, "dash-1");
});

test("batches non-verified metrics by source table into deep-analysis jobs", () => {
  const [screening] = buildDashboardScreeningJobs([
    { countryCode: "PH", dashboardUuid: "dash-1", anomalyIndex: 0, sourceTable: "ads.loan_d" },
    { countryCode: "PH", dashboardUuid: "dash-1", anomalyIndex: 1, sourceTable: "ads.loan_d" },
    { countryCode: "PH", dashboardUuid: "dash-1", anomalyIndex: 2, sourceTable: "ads.loan_d" },
    { countryCode: "PH", dashboardUuid: "dash-1", anomalyIndex: 3, sourceTable: "ads.loan_d" },
  ]);
  const jobs = buildMetricDeepAnalysisJobs(screening, [
    { anomalyIndex: 0, screeningVerdict: "verified_normal" },
    { anomalyIndex: 1, screeningVerdict: "suspected_issue" },
    { anomalyIndex: 2, screeningVerdict: "needs_deep_analysis" },
    { anomalyIndex: 3, screeningVerdict: "needs_deep_analysis" },
  ]);

  // 3 non-verified (1,2,3) from same table -> 1 batch of 3
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].cases.map((c) => c.anomalyIndex), [1, 2, 3]);
  assert.equal(jobs[0].stage, "metric_deep_analysis");
});

test("batch investigation groups same source and limits every Dify payload to ten cases", () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ countryCode: "INE", sourceTable: "ads.loan_d", anomalyIndex: i }));
  const batches = buildInvestigationBatches(items);

  assert.deepEqual(batches.map((batch) => batch.cases.map((item) => item.anomalyIndex)), [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [10, 11]]);
});

test("batch investigation limits never exceed two Dify workers or ten cases", () => {
  assert.deepEqual(getBatchInvestigationLimits({
    METABASE_ANOMALY_BATCH_CONCURRENCY: "99",
    METABASE_ANOMALY_BATCH_SIZE: "99",
  }), { maxConcurrentBatches: 2, maxCasesPerBatch: 10, timeoutMs: 360000, targetDurationMs: 1200000, deadlineMs: 2700000 });
});

test("bounded investigation queue never submits a third Dify batch before one callback settles", async () => {
  const submitted = [];
  const releases = new Map();
  const queue = runBoundedInvestigationQueue({
    batches: [{ batchId: "a" }, { batchId: "b" }, { batchId: "c" }, { batchId: "d" }],
    submit: async (batch) => { submitted.push(batch.batchId); },
    waitForSettlement: (batch) => new Promise((resolve) => releases.set(batch.batchId, resolve)),
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(submitted, ["a", "b"]);
  releases.get("a")({ status: "completed" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(submitted, ["a", "b", "c"]);
  releases.get("b")({ status: "completed" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(submitted, ["a", "b", "c", "d"]);
  releases.get("c")({ status: "completed" });
  releases.get("d")({ status: "completed" });
  const result = await queue;
  assert.equal(result.completed, 4);
});

test("bounded investigation queue never submits queued batches after its global deadline", async () => {
  let now = 0;
  const submitted = [];
  const result = await runBoundedInvestigationQueue({
    batches: [{ batchId: "a" }, { batchId: "b" }],
    now: () => now,
    deadlineAt: 1,
    submit: async (batch) => { submitted.push(batch.batchId); now = 1; },
    waitForSettlement: async () => ({ status: "completed" }),
  });

  assert.deepEqual(submitted, ["a"]);
  assert.deepEqual(result.notSubmitted.map((batch) => batch.batchId), ["b"]);
});

test("bounded investigation queue does NOT count timed-out batches as completed", async () => {
  const result = await runBoundedInvestigationQueue({
    batches: [{ batchId: "a" }, { batchId: "b" }, { batchId: "c" }],
    submit: async () => {},
    waitForSettlement: async () => ({ status: "timed_out" }),
  });
  assert.equal(result.total, 3);
  assert.equal(result.completed, 0);
  assert.equal(result.timedOut, 3);
  assert.equal(result.failed, 0);
});

test("bounded investigation queue does NOT count failed batches as completed", async () => {
  const result = await runBoundedInvestigationQueue({
    batches: [{ batchId: "a" }, { batchId: "b" }],
    submit: async () => { throw new Error("n8n unreachable"); },
    waitForSettlement: async () => ({ status: "completed" }),
  });
  assert.equal(result.total, 2);
  assert.equal(result.completed, 0);
  assert.equal(result.failed, 2);
  assert.equal(result.timedOut, 0);
});

test("bounded investigation queue counts only truly completed batches", async () => {
  const result = await runBoundedInvestigationQueue({
    batches: [{ batchId: "a" }, { batchId: "b" }, { batchId: "c" }],
    submit: async () => {},
    waitForSettlement: async (batch) =>
      batch.batchId === "a" ? { status: "completed" }
      : batch.batchId === "b" ? { status: "timed_out" }
      : { status: "failed" },
  });
  assert.equal(result.total, 3);
  assert.equal(result.completed, 1);
  assert.equal(result.timedOut, 1);
  assert.equal(result.failed, 1);
});
