import assert from "node:assert/strict";
import test from "node:test";
import { buildInvestigationBatches, getBatchInvestigationLimits, runBoundedInvestigationQueue } from "../src/metabase-anomaly-batch.mjs";

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
