import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("DS failure log page exposes repair states and failure reasons", async () => {
  const [source, monitor, platformApi] = await Promise.all([
    fs.readFile(new URL("../web/src/views/ds-failure-logs.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/ds-failure-log-monitor.mjs", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/platform-api.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(source, /DS 失败任务日志/);
  assert.match(source, /已自动修复/);
  assert.match(source, /修复中/);
  assert.match(source, /待修复/);
  assert.match(source, /失败原因/);
  assert.match(source, /\/api\/ds-failure-logs/);
  assert.match(source, /DS调度监控/);
  assert.match(source, /查询当天失败任务/);
  assert.match(source, /尚未查询/);
  assert.doesNotMatch(source, /type="date"/);
  assert.doesNotMatch(source, /\?date=/);
  assert.match(source, /renderDsFailureLogs\(root\) \{\s*paint\(root\);\s*\}/);
  assert.match(monitor, /const targetDate = todayInTimeZone\(timeZone, now\)/);
  assert.match(monitor, /dateMode: "country-local-today"/);
  assert.match(platformApi, /getDsFailureLogs\(\) \{\s*return inspectDsFailureLogs\(rootDir\)/);
});

test("sidebar and server expose the independent DS failure log module", async () => {
  const [app, server] = await Promise.all([
    fs.readFile(new URL("../web/src/app.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/server.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(app, /path: "\/ds-failure-logs", label: "DS失败任务日志"/);
  assert.match(server, /url\.pathname === "\/api\/ds-failure-logs"/);
});
