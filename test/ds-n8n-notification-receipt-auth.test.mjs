import assert from "node:assert/strict";
import test from "node:test";
import { assertDsN8nNotificationReceiptAuthorized, safeTokenEquals } from "../src/ds-n8n-notification-receipt-auth.mjs";

test("DS n8n notification receipt requires the matching country DS token", () => {
  assert.doesNotThrow(() => assertDsN8nNotificationReceiptAuthorized("Bearer country-token", "country-token"));
  for (const value of ["", "Bearer wrong-token", "country-token-extra"]) {
    assert.throws(() => assertDsN8nNotificationReceiptAuthorized(value, "country-token"), (error) => error.statusCode === 401);
  }
  assert.throws(() => assertDsN8nNotificationReceiptAuthorized("Bearer country-token", ""), (error) => error.statusCode === 401);
});

test("DS n8n notification receipt token comparison handles unequal lengths", () => {
  assert.equal(safeTokenEquals("same", "same"), true);
  assert.equal(safeTokenEquals("short", "longer"), false);
});
