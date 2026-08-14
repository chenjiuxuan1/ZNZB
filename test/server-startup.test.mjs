import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("server starts all three patrol schedulers", async () => {
  const source = await fs.readFile(new URL("../src/server.mjs", import.meta.url), "utf8");
  const startup = source.slice(0, source.indexOf("async function handleApi"));

  assert.equal((startup.match(/startBatchScheduler\(\);/g) || []).length, 1);
  assert.equal((startup.match(/startDsScheduler\(\);/g) || []).length, 1);
  assert.equal((startup.match(/startHiveScheduler\(\);/g) || []).length, 1);
});
