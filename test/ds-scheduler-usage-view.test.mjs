import test from "node:test";
import assert from "node:assert/strict";
import { fmtDuration } from "../web/src/views/ds-scheduler-usage.js";

test("gateway usage duration formatter", () => {
  assert.equal(fmtDuration(0), "-");
  assert.equal(fmtDuration(500), "500ms");
  assert.equal(fmtDuration(1500), "1.5s");
  assert.equal(fmtDuration(), "-");
});
