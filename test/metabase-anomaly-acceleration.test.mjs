import assert from "node:assert/strict";
import test from "node:test";
import { createBoundedTaskQueue, getMetabaseAnomalyAccelerationSettings } from "../src/metabase-anomaly-acceleration.mjs";

test("acceleration is disabled by default and serializes Agent requests", () => {
  assert.deepEqual(getMetabaseAnomalyAccelerationSettings({}), { enabled: false, maxConcurrency: 1, snapshotTtlSeconds: 600 });
  assert.deepEqual(getMetabaseAnomalyAccelerationSettings({
    METABASE_ANOMALY_AGENT_ACCELERATION_ENABLED: "true",
    METABASE_ANOMALY_AGENT_ACCELERATION_MAX_CONCURRENCY: "99",
    METABASE_ANOMALY_AGENT_SNAPSHOT_TTL_SECONDS: "1",
  }), { enabled: true, maxConcurrency: 1, snapshotTtlSeconds: 60 });
});

test("bounded queue never exceeds its configured concurrency", async () => {
  const queue = createBoundedTaskQueue({ concurrency: 2 });
  let active = 0;
  let maximum = 0;
  const tasks = Array.from({ length: 5 }, (_, index) => queue.add(async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return index;
  }));
  assert.deepEqual(await Promise.all(tasks), [0, 1, 2, 3, 4]);
  assert.equal(maximum, 1);
});
