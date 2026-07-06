import test from "node:test";
import assert from "node:assert/strict";
import { parseDashboardUrl, resolveTimeRange } from "../src/config.mjs";

test("parseDashboardUrl extracts uid org and vars", () => {
  const parsed = parseDashboardUrl(
    "https://example.com/d/abc123/report?orgId=2&var-country=cn&from=now-7d&to=now",
  );

  assert.equal(parsed.baseUrl, "https://example.com");
  assert.equal(parsed.dashboardUid, "abc123");
  assert.equal(parsed.orgId, 2);
  assert.deepEqual(parsed.variables, { country: "cn" });
  assert.deepEqual(parsed.timeRange, { from: "now-7d", to: "now" });
});

test("resolveTimeRange supports relative times", () => {
  const range = resolveTimeRange({ from: "now-1h", to: "now" }, 10_000_000);
  assert.equal(range.fromMs, 10_000_000 - 3_600_000);
  assert.equal(range.toMs, 10_000_000);
});

