import assert from "node:assert/strict";
import test from "node:test";
import { detectMetricFluctuation, ewmaForecast, median, robustSigma } from "../src/metric-fluctuation-detector.mjs";
import { evaluateRowsAgainstRule } from "../src/metabase-public-monitor.mjs";

test("median and robust sigma ignore non numeric values", () => {
  assert.equal(median([3, 1, 2, null, "x"]), 2);
  assert.equal(Number(robustSigma([10, 10, 12, 12], 11).toFixed(4)), 1.4826);
});

test("detectMetricFluctuation flags a large robust residual", () => {
  const result = detectMetricFluctuation(180, [98, 101, 100, 102, 99, 100, 101, 98, 102, 100, 99, 101, 100, 102], {
    minHistory: 14,
    minAbsDelta: 10,
    minRelativeDelta: 0.2,
  });

  assert.equal(result.isAnomaly, true);
  assert.equal(result.reason, "robust_residual_check");
  assert.ok(result.anomalyScore >= 3);
});

test("detectMetricFluctuation accepts smooth trend continuation", () => {
  const history = [100, 102, 104, 106, 108, 110, 112, 114, 116, 118, 120, 122, 124, 126];
  const result = detectMetricFluctuation(128, history, {
    minHistory: 14,
    minAbsDelta: 10,
    minRelativeDelta: 0.2,
  });

  assert.equal(result.isAnomaly, false);
});

test("detectMetricFluctuation flags latest nonzero-to-zero for stable volume", () => {
  const result = detectMetricFluctuation(0, [95, 100, 103, 98, 101, 99, 102, 100, 101, 97, 99, 102, 100, 101], {
    minHistory: 14,
    minAbsDelta: 10,
  });

  assert.equal(result.isAnomaly, true);
  assert.equal(result.reason, "latest_nonzero_to_zero");
});

test("detectMetricFluctuation uses stricter thresholds for short history", () => {
  const result = detectMetricFluctuation(0.45, [0.24, 0.23, 0.22, 0.24, 0.24, 0.25, 0.26], {
    minHistory: 14,
    shortMinHistory: 7,
    shortMinScore: 5,
    shortMinRelativeDelta: 0.3,
    minAbsDelta: 0.01,
  });

  assert.equal(result.isAnomaly, true);
  assert.equal(result.reason, "short_history_robust_residual_check");
  assert.equal(result.isShortHistory, true);
  assert.equal(result.minScore, 5);
});

test("detectMetricFluctuation still skips very short history", () => {
  const result = detectMetricFluctuation(0.45, [0.24, 0.23, 0.22, 0.24, 0.24, 0.25], {
    minHistory: 14,
    shortMinHistory: 7,
  });

  assert.equal(result.isAnomaly, false);
  assert.equal(result.reason, "history_not_enough");
});

test("ewmaForecast follows recent values without mutating history", () => {
  const history = [100, 110, 120];
  assert.equal(Number(ewmaForecast(history, 0.5).toFixed(2)), 112.5);
  assert.deepEqual(history, [100, 110, 120]);
});

test("evaluateRowsAgainstRule supports robustCompleteDayChange", () => {
  const rows = [
    ...Array.from({ length: 14 }, (_, index) => ({
      stat_date: `2026-06-${String(index + 1).padStart(2, "0")}`,
      metric: index % 2 ? 102 : 100,
    })),
    { stat_date: "2026-06-15", metric: 180 },
  ];

  const result = evaluateRowsAgainstRule(rows, {
    type: "robustCompleteDayChange",
    dateColumn: "stat_date",
    column: "metric",
    timezone: "Asia/Jakarta",
    now: "2026-06-16T06:00:00Z",
    minHistory: 14,
    minAbsDelta: 10,
    minRelativeDelta: 0.2,
  });

  assert.equal(result.length, 1);
  assert.match(result[0], /metric/);
  assert.match(result[0], /180/);
});

test("evaluateRowsAgainstRule robustCompleteDayChange returns no anomaly for smooth trend", () => {
  const rows = Array.from({ length: 15 }, (_, index) => ({
    stat_date: `2026-06-${String(index + 1).padStart(2, "0")}`,
    metric: 100 + index * 2,
  }));

  const result = evaluateRowsAgainstRule(rows, {
    type: "robustCompleteDayChange",
    dateColumn: "stat_date",
    column: "metric",
    timezone: "Asia/Jakarta",
    now: "2026-06-16T06:00:00Z",
    minHistory: 14,
    minAbsDelta: 10,
    minRelativeDelta: 0.2,
  });

  assert.deepEqual(result, []);
});

test("evaluateRowsAgainstRule robustCompleteDayChange reports short history anomalies", () => {
  const rows = [
    ...Array.from({ length: 7 }, (_, index) => ({
      stat_date: `2026-06-${String(index + 1).padStart(2, "0")}`,
      metric: index % 2 ? 0.24 : 0.23,
    })),
    { stat_date: "2026-06-08", metric: 0.45 },
  ];

  const result = evaluateRowsAgainstRule(rows, {
    type: "robustCompleteDayChange",
    dateColumn: "stat_date",
    column: "metric",
    timezone: "Asia/Jakarta",
    now: "2026-06-09T06:00:00Z",
    minHistory: 14,
    shortMinHistory: 7,
    shortMinAnomalyScore: 5,
    shortMinRelativeDelta: 0.3,
    minAbsDelta: 0.01,
  });

  assert.equal(result.length, 1);
  assert.match(result[0], /短历史样本/);
});
