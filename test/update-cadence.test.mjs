import test from "node:test";
import assert from "node:assert/strict";
import {
  formatUpdateCadence,
  inferUpdateCadence,
  isCadenceUpdateDue,
} from "../src/update-cadence.mjs";

const defaults = {
  anchorDate: "2026-07-20",
  lookbackDays: 130,
  minIntervals: 3,
  minConfidence: 0.75,
  maxIntervalDays: 31,
  maxIntervalMonths: 3,
};

test("inferUpdateCadence recognizes daily data with weekend gaps", () => {
  const cadence = inferUpdateCadence([
    "2026-07-06",
    "2026-07-07",
    "2026-07-08",
    "2026-07-09",
    "2026-07-10",
    "2026-07-13",
    "2026-07-14",
    "2026-07-15",
  ], defaults);

  assert.equal(cadence.unit, "day");
  assert.equal(cadence.interval, 1);
  assert.equal(cadence.nextExpectedDate, "2026-07-16");
  assert.equal(formatUpdateCadence(cadence), "每天");
});

test("inferUpdateCadence recognizes every two days", () => {
  const cadence = inferUpdateCadence([
    "2026-07-08",
    "2026-07-10",
    "2026-07-12",
    "2026-07-14",
    "2026-07-16",
  ], defaults);

  assert.equal(cadence.unit, "day");
  assert.equal(cadence.interval, 2);
  assert.equal(cadence.nextExpectedDate, "2026-07-18");
  assert.equal(formatUpdateCadence(cadence), "每2天");
});

test("inferUpdateCadence recognizes weekly data", () => {
  const cadence = inferUpdateCadence([
    "2026-06-20",
    "2026-06-27",
    "2026-07-04",
    "2026-07-11",
    "2026-07-18",
  ], defaults);

  assert.equal(cadence.unit, "week");
  assert.equal(cadence.interval, 1);
  assert.equal(cadence.nextExpectedDate, "2026-07-25");
  assert.equal(formatUpdateCadence(cadence), "每周");
  assert.equal(isCadenceUpdateDue(cadence, "2026-07-24"), false);
  assert.equal(isCadenceUpdateDue(cadence, "2026-07-25"), true);
});

test("inferUpdateCadence recognizes monthly data across variable month lengths", () => {
  const cadence = inferUpdateCadence([
    "2026-03-31",
    "2026-04-30",
    "2026-05-31",
    "2026-06-30",
  ], defaults);

  assert.equal(cadence.unit, "month");
  assert.equal(cadence.interval, 1);
  assert.equal(cadence.nextExpectedDate, "2026-07-31");
  assert.equal(formatUpdateCadence(cadence), "每月");
});

test("inferUpdateCadence recognizes fixed day-of-month data", () => {
  const cadence = inferUpdateCadence([
    "2026-03-20",
    "2026-04-20",
    "2026-05-20",
    "2026-06-20",
  ], defaults);

  assert.equal(cadence.unit, "month");
  assert.equal(cadence.nextExpectedDate, "2026-07-20");
});

test("inferUpdateCadence rejects irregular sparse dates", () => {
  const cadence = inferUpdateCadence([
    "2026-06-21",
    "2026-06-29",
    "2026-07-06",
    "2026-07-18",
  ], defaults);

  assert.equal(cadence, null);
});
