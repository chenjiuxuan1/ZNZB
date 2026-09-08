import assert from "node:assert/strict";
import test from "node:test";

import {
  HIDDEN_SCHEDULER_SECRET,
  preserveSchedulerSecrets,
  redactSchedulerSecrets,
} from "../src/scheduler-secrets.mjs";

test("scheduler configs expose token presence without exposing token values", () => {
  const redacted = redactSchedulerSecrets({
    countries: {
      cn: { enabled: true, token: "cn-secret" },
      pk: { enabled: false, token: "" },
    },
  });

  assert.equal(redacted.countries.cn.token, HIDDEN_SCHEDULER_SECRET);
  assert.equal(redacted.countries.cn.tokenConfigured, true);
  assert.equal(redacted.countries.pk.token, "");
  assert.equal(redacted.countries.pk.tokenConfigured, false);
});

test("saving a redacted scheduler config preserves existing tokens", () => {
  const merged = preserveSchedulerSecrets(
    { countries: { cn: { enabled: false, token: HIDDEN_SCHEDULER_SECRET } } },
    { countries: { cn: { enabled: true, token: "cn-secret" } } },
  );

  assert.equal(merged.countries.cn.token, "cn-secret");
  assert.equal(merged.countries.cn.enabled, false);
});
