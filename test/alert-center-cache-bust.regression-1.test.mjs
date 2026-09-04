import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Regression: ISSUE-002 — production could retain the pre-lifecycle JS and CSS assets.
// Found by /qa on 2026-09-04.
// Report: .gstack/qa-reports/qa-report-localhost-2026-09-04.md
test("alert lifecycle assets use the current release cache key", () => {
  const releaseKey = "20260904-alert-lifecycle-v1";
  const app = fs.readFileSync(new URL("../web/src/app.js", import.meta.url), "utf8");
  const index = fs.readFileSync(new URL("../web/index.html", import.meta.url), "utf8");

  assert.match(app, new RegExp(`alert-center\\.js\\?v=${releaseKey}`));
  assert.match(index, new RegExp(`styles\\.css\\?v=${releaseKey}`));
  assert.match(index, new RegExp(`app\\.js\\?v=${releaseKey}`));
});
