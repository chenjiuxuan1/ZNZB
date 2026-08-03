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

test("creates one deep-analysis job for every metric not proven normal", () => {
  const [screening] = buildDashboardScreeningJobs([
    { countryCode: "PH", dashboardUuid: "dash-1", anomalyIndex: 0 },
    { countryCode: "PH", dashboardUuid: "dash-1", anomalyIndex: 1 },
    { countryCode: "PH", dashboardUuid: "dash-1", anomalyIndex: 2 },
  ]);
  const jobs = buildMetricDeepAnalysisJobs(screening, [
    { anomalyIndex: 0, screeningVerdict: "verified_normal" },
    { anomalyIndex: 1, screeningVerdict: "suspected_issue" },
    { anomalyIndex: 2, screeningVerdict: "needs_deep_analysis" },
  ]);

  assert.deepEqual(jobs.map((job) => job.cases[0].anomalyIndex), [1, 2]);
  assert.ok(jobs.every((job) => job.stage === "metric_deep_analysis" && job.cases.length === 1));
});

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
  }), { maxConcurrentBatches: 2, maxCasesPerBatch: 3, timeoutMs: 600000, targetDurationMs: 1200000, deadlineMs: 1800000 });
});

test("bounded investigation queue never submits a third Dify batch before one callback settles", async () => {
  const submitted = [];
  const releases = new Map();
  const queue = runBoundedInvestigationQueue({
    batches: [{ batchId: "a" }, { batchId: "b" }, { batchId: "c" }],
    submit: async (batch) => { submitted.push(batch.batchId); },
    waitForSettlement: (batch) => new Promise((resolve) => releases.set(batch.batchId, resolve)),
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(submitted, ["a", "b"]);
  releases.get("a")({ status: "completed" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(submitted, ["a", "b", "c"]);
  releases.get("b")({ status: "completed" });
  releases.get("c")({ status: "completed" });
  const result = await queue;
  assert.equal(result.completed, 3);
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
