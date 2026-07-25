import assert from "node:assert/strict";
import test from "node:test";
import { compactDashboardUrl } from "../web/src/view-utils.js";

test("compactDashboardUrl hides long query parameters", () => {
  assert.equal(
    compactDashboardUrl("https://data.kuainiu.io/dashboard/994?日期=past30days~&app=fox"),
    "data.kuainiu.io/dashboard/994",
  );
});

test("compactDashboardUrl keeps a readable fallback for invalid URLs", () => {
  assert.equal(compactDashboardUrl("dashboard/994?foo=bar"), "dashboard/994");
});
