import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFreshness,
  buildNextExpectedAt,
  findHistoricalDateGaps,
  inferRefreshCadence,
  observeCardResult,
  pruneObservationCache,
  resolveResultSchema,
} from "../src/cadence-observation.mjs";

function events(dates, hour = "02:00:00Z") {
  return dates.map((date) => ({ observedAt: `${date}T${hour}`, latestBusinessDate: date }));
}

test("weekly batch backfill stays daily data but learns weekly refresh", () => {
  const rows = Array.from({ length: 29 }, (_, index) => ({
    stat_date: new Date(Date.UTC(2026, 5, 20 + index)).toISOString().slice(0, 10),
    value: index,
  }));
  const entry = {
    timezone: "Asia/Shanghai", dateColumn: "stat_date", metricColumns: ["value"],
    latestBusinessDate: "2026-07-18", schemaMismatch: false,
    events: events(["2026-06-20", "2026-06-27", "2026-07-04", "2026-07-11", "2026-07-18"]),
  };
  const freshness = buildFreshness(entry, rows, [], "2026-07-20T04:00:00Z");
  assert.equal(freshness.dataCadence.label, "每天");
  assert.equal(freshness.refreshCadence.label, "每周");
  assert.equal(freshness.status, "healthy");
});

test("refresh cadence needs four change events", () => {
  assert.equal(inferRefreshCadence(events(["2026-07-01", "2026-07-08", "2026-07-15"])), null);
});

test("refresh cadence recognizes calendar days and business days", () => {
  const calendar = inferRefreshCadence(events(["2026-07-03", "2026-07-04", "2026-07-05", "2026-07-06"]));
  const business = inferRefreshCadence(events(["2026-07-03", "2026-07-06", "2026-07-07", "2026-07-08"]));
  assert.equal(calendar.kind, "calendar_day");
  assert.equal(business.unit, "business_day");
  assert.equal(business.nextExpectedDate, "2026-07-09");
});

test("refresh cadence recognizes every two days, monthly and quarterly", () => {
  assert.equal(inferRefreshCadence(events(["2026-07-01", "2026-07-03", "2026-07-05", "2026-07-07"]))?.interval, 2);
  assert.equal(inferRefreshCadence(events(["2026-03-31", "2026-04-30", "2026-05-31", "2026-06-30"]))?.unit, "month");
  assert.equal(inferRefreshCadence(events(["2025-09-30", "2025-12-31", "2026-03-31", "2026-06-30"]))?.interval, 3);
});

test("irregular refresh remains learning", () => {
  assert.equal(inferRefreshCadence(events(["2026-06-01", "2026-06-06", "2026-06-15", "2026-07-01"])), null);
});

test("schema resolver falls back from missing Chinese metrics to card English metrics", () => {
  const rows = [{ finish_date: "2026-07-21", repay_cnt: 0, freeze_rate_7: 0.2 }];
  const schema = resolveResultSchema(rows, {
    dimensions: ["finish_date"], metrics: ["repay_cnt", "freeze_rate_7"],
  }, [{ dateColumn: "统计日期", columns: ["还款数", "还款~复借"] }]);
  assert.equal(schema.dateColumn, "finish_date");
  assert.deepEqual(schema.metricColumns, ["repay_cnt", "freeze_rate_7"]);
  assert.equal(schema.schemaMismatch, true);
});

test("zero is a valid metric while null and empty string are empty", () => {
  const cache = { entries: {} };
  const base = {
    cache, dashboard: { countryCode: "TH", uuid: "d", timezone: "Asia/Bangkok" },
    card: { cardId: 376, dashcardId: 387, dimensions: ["finish_date"], metrics: ["repay_cnt"] },
    checkedAt: "2026-07-21T03:00:00Z",
  };
  const zero = observeCardResult({ ...base, rows: [{ finish_date: "2026-07-21", repay_cnt: 0 }] });
  assert.equal(zero.freshness.emptyMetrics, false);
  const empty = observeCardResult({ ...base, context: "empty", rows: [{ finish_date: "2026-07-21", repay_cnt: "" }] });
  assert.equal(empty.freshness.metricColumns.length, 1);
  assert.equal(empty.freshness.emptyMetrics, true);
});

test("daily cadence detects a missing date inside the latest seven expected points", () => {
  const dates = ["2026-07-14", "2026-07-15", "2026-07-17", "2026-07-18", "2026-07-19", "2026-07-20", "2026-07-21"];
  assert.deepEqual(findHistoricalDateGaps(dates, { unit: "day", interval: 1 }), ["2026-07-16"]);
});

test("P90 arrival plus grace is converted using dashboard timezone", () => {
  const cadence = { unit: "week", interval: 1, nextExpectedDate: "2026-07-25" };
  const arrivalEvents = events(["2026-07-04", "2026-07-11", "2026-07-18", "2026-07-25"], "03:00:00Z");
  assert.equal(buildNextExpectedAt("2026-07-18", cadence, arrivalEvents, "Asia/Bangkok"), "2026-07-25T05:00:00.000Z");
});

test("observation cache keeps at most 500 recent events and drops expired cards", () => {
  const recent = Array.from({ length: 510 }, (_, index) => ({
    observedAt: new Date(Date.UTC(2026, 6, 1, 0, index)).toISOString(),
    latestBusinessDate: "2026-07-01",
  }));
  const cache = { entries: {
    recent: { lastObservedAt: "2026-07-21T00:00:00Z", events: recent },
    expired: { lastObservedAt: "2024-01-01T00:00:00Z", events: [] },
  } };
  pruneObservationCache(cache, "2026-07-21T00:00:00Z");
  assert.equal(cache.entries.recent.events.length, 500);
  assert.equal(cache.entries.expired, undefined);
});
