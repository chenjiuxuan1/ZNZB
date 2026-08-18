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
  assert.match(source, /工作流实例/);
  assert.doesNotMatch(source, /定位失败任务/);
  assert.match(source, /失败项目/);
  assert.match(source, /失败工作流/);
  assert.match(source, /失败任务/);
  assert.match(source, /出错 SQL/);
  assert.match(source, /\/api\/ds-failure-logs/);
  assert.match(source, /DS调度监控/);
  assert.match(source, /重新查询/);
  assert.match(source, /尚未查询/);
  assert.doesNotMatch(source, /type="date"/);
  assert.doesNotMatch(source, /\?date=/);
  assert.match(source, /renderDsFailureLogs\(root\) \{\s*syncAutoRefresh\(root\);\s*paint\(root\);\s*if \(!model\.retryControlLoaded\) refreshRetryPanel\(root\);\s*\}/);
  assert.doesNotMatch(source, /ds-country-choice/);
  assert.match(source, /\?country=/);
  assert.match(source, /Promise\.all\(selected\.map/);
  assert.match(source, /各国并行查询并在完成后立即显示/);
  assert.match(source, /id="ds-failure-country"/);
  assert.match(source, /<option value="">全部国家<\/option>/);
  assert.match(source, /timeoutMs: 55_000/);
  assert.match(source, /AUTO_REFRESH_INTERVAL_MS = 60 \* 60 \* 1000/);
  assert.match(source, /SQL错误，需人工修改/);
  assert.match(source, /自动重跑中/);
  assert.match(source, /重跑策略/);
  assert.match(source, /启动符合条件任务重跑/);
  assert.match(source, /type="datetime-local"/);
  assert.match(source, /重跑日志/);
  assert.match(source, /repairStatus === "unresolved"/);
  assert.match(source, /每隔 1 小时自动重新查询当前国家/);
  assert.match(source, /查看节点日志/);
  assert.match(source, /工作流状态为失败或停止/);
  assert.match(monitor, /const targetDate = todayInTimeZone\(timeZone, now\)/);
  assert.match(monitor, /dateMode: "country-local-today"/);
  assert.match(monitor, /mapWithConcurrency\(projects, PROJECT_QUERY_CONCURRENCY/);
  assert.match(monitor, /"list_instances"/);
  assert.match(monitor, /state_type: ""/);
  assert.match(monitor, /START_FAILURE_TASK_PROCESS/);
  assert.match(monitor, /runTimes/);
  assert.match(monitor, /"list_task_instances"/);
  assert.match(monitor, /"get_task_log"/);
  assert.match(monitor, /"extract_task_runtime_config"/);
  assert.match(monitor, /PROJECT_QUERY_CONCURRENCY = 3/);
  assert.match(monitor, /自动重试 1 次/);
  assert.doesNotMatch(monitor, /failure_policy: "scheduled_today_final_failure"/);
  assert.match(platformApi, /getDsFailureLogs\(filters = \{\}\)/);
  assert.match(platformApi, /countries: country \|\| undefined/);
  assert.match(platformApi, /dsAutoRetryManager\?\.decorate/);
});

test("sidebar and server expose the independent DS failure log module", async () => {
  const [app, server] = await Promise.all([
    fs.readFile(new URL("../web/src/app.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/server.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(app, /path: "\/ds-failure-logs", label: "DS失败任务日志"/);
  assert.match(server, /url\.pathname === "\/api\/ds-failure-logs"/);
  assert.match(server, /url\.pathname === "\/api\/ds-failure-retry\/start"/);
  assert.match(server, /url\.pathname === "\/api\/ds-failure-retry\/logs"/);
});
