import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDashboardAnalysisJobs,
  getBatchInvestigationLimits,
  runBoundedInvestigationQueue,
} from "../src/metabase-anomaly-batch.mjs";

test("groups every anomaly from one dashboard into one analysis job", () => {
  const jobs = buildDashboardAnalysisJobs([
    { countryCode: "PH", dashboardUuid: "dash-1", dashboardTitle: "OKR", anomalyIndex: 0 },
    { countryCode: "PH", dashboardUuid: "dash-1", dashboardTitle: "OKR", anomalyIndex: 1 },
    { countryCode: "PH", dashboardUuid: "dash-2", dashboardTitle: "资产", anomalyIndex: 2 },
  ]);

  assert.deepEqual(jobs.map((job) => job.cases.map((item) => item.anomalyIndex)), [[0, 1], [2]]);
  assert.equal(jobs[0].stage, "dashboard_analysis");
  assert.equal(jobs[0].dashboardUuid, "dash-1");
});

test("single-stage limits allow three concurrent workers", () => {
  assert.deepEqual(getBatchInvestigationLimits(), {
    maxConcurrentBatches: 3,
    timeoutMs: 360000,
    targetDurationMs: 1200000,
    deadlineMs: 2700000,
  });
});

test("bounded investigation queue never submits a fourth batch before one settles", async () => {
  const submitted = [];
  const releases = new Map();
  const queue = runBoundedInvestigationQueue({
    batches: [{ batchId: "a" }, { batchId: "b" }, { batchId: "c" }, { batchId: "d" }],
    submit: async (batch) => { submitted.push(batch.batchId); },
    waitForSettlement: (batch) => new Promise((resolve) => releases.set(batch.batchId, resolve)),
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(submitted, ["a", "b", "c"]);
  releases.get("a")({ status: "completed" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(submitted, ["a", "b", "c", "d"]);
  releases.get("b")({ status: "completed" });
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
