import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("HIVE view is isolated and exposes country/project monitoring controls", async () => {
  const source = await fs.readFile(new URL("../web/src/views/hive-scheduler.js", import.meta.url), "utf8");
  assert.match(source, /HIVE 调度监控/);
  assert.match(source, /监控该国家/);
  assert.match(source, /项目名称（可多个）/);
  assert.match(source, /国家负责人邮箱/);
  assert.match(source, /\/api\/hive-scheduler\/config/);
  assert.doesNotMatch(source, /\/api\/ds-scheduler\/config/);
  assert.doesNotMatch(source, /\/api\/batch-check/);
});

test("sidebar contains a separate HIVE scheduler route", async () => {
  const source = await fs.readFile(new URL("../web/src/app.js", import.meta.url), "utf8");
  assert.match(source, /path: "\/hive-scheduler", label: "HIVE调度监控"/);
});
