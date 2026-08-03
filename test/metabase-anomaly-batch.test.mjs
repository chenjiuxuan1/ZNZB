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
  }), { maxConcurrentBatches: 2, maxCasesPerBatch: 3, timeoutMs: 600000, targetDurationMs: 1200000, deadlineMs: 1800000 });
});
