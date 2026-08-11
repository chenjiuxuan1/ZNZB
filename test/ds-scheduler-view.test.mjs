import test from "node:test";
import assert from "node:assert/strict";
import { summarizeDsCountryCheck } from "../web/src/views/ds-scheduler.js";

test("DS result summary treats a failed scheduled execution as an anomaly", () => {
  const result = summarizeDsCountryCheck({
    success: true,
    checkedWorkflows: 12,
    stuckCount: 0,
    staleCount: 0,
    failedCount: 1,
  });

  assert.equal(result.hasIssue, true);
  assert.equal(result.badgeClass, "warn");
  assert.match(result.summary, /执行失败 1/);
});
