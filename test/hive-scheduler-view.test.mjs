import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("HIVE view is isolated and exposes country/project monitoring controls", async () => {
  const source = await fs.readFile(new URL("../web/src/views/hive-scheduler.js", import.meta.url), "utf8");
  assert.match(source, /HIVE 调度监控/);
  assert.match(source, /开启监控/);
  assert.match(source, /HIVE 项目范围（可多个）/);
  assert.match(source, /项目名称说明/);
  assert.match(source, /不需要手动填写项目编码/);
  assert.doesNotMatch(source, /模块隔离/);
  assert.match(source, /国家负责人邮箱/);
  assert.match(source, /class="mini-switch"/);
  assert.match(source, /hive-country-state/);
  assert.match(source, /\/api\/hive-scheduler\/config/);
  assert.doesNotMatch(source, /\/api\/ds-scheduler\/config/);
  assert.doesNotMatch(source, /\/api\/batch-check/);
  assert.doesNotMatch(source, /独立定时巡检/);
  assert.doesNotMatch(source, /hive-save-schedule/);
  assert.doesNotMatch(source, /hive-run-now/);
  assert.match(source, /let loadPromise = null/);
  assert.match(source, /if \(loaded\)/);
});

test("sidebar contains a separate HIVE scheduler route", async () => {
  const source = await fs.readFile(new URL("../web/src/app.js", import.meta.url), "utf8");
  assert.match(source, /path: "\/hive-scheduler", label: "HIVE调度监控"/);
});
