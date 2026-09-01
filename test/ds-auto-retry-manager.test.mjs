import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { classifyDsFailureType } from "../src/ds-failure-log-monitor.mjs";
import { createDsAutoRetryManager } from "../src/ds-auto-retry-manager.mjs";

const fixedNow = new Date("2026-08-18T10:00:00+08:00");

function resultWith(failure) {
  return {
    totalFailures: 1,
    countries: [{ country: "cn", failures: [{
      projectCode: "1001", workflowCode: "2001", instanceId: "3001",
      instanceState: "FAILURE", startTime: "2026-08-18 09:00:00",
      repairStatus: "unresolved", ...failure,
    }] }],
  };
}

async function enableAndWait(manager) {
  manager.enable({ intervalMinutes: 30 });
  await manager.scan();
  await Promise.all([...manager.active.values()]);
}

test("retries every failure except SQL/code and permission errors", () => {
  assert.equal(classifyDsFailureType({ failureMessage: "SQL syntax error near FROM" }).failureType, "sql_code_error");
  assert.equal(classifyDsFailureType({ failureMessage: "not defined var: v_start_dt" }).failureType, "sql_code_error");
  assert.equal(classifyDsFailureType({ taskName: "etl", failureMessage: "Container killed: out of memory" }).failureType, "retryable");
  assert.equal(classifyDsFailureType({ taskName: "etl", failureMessage: "Connection reset by peer" }).retryable, true);
  assert.deepEqual(classifyDsFailureType({ failureMessage: "Permission denied for table ads.orders" }), {
    failureType: "permission_error",
    retryable: false,
    retryDecision: "权限不足，需人工处理",
  });
  assert.equal(classifyDsFailureType({ failureMessage: "用户没有权限访问该表" }).failureType, "permission_error");
  assert.equal(classifyDsFailureType({ taskName: "etl", failureMessage: "business validation failed" }).retryable, true);
  assert.equal(classifyDsFailureType({ failureMessage: "business validation failed" }).failureType, "suspected_empty_run");
});

test("does not start retry loop for SQL code errors", async () => {
  let actions = 0;
  const manager = createDsAutoRetryManager({
    rootDir: "/unused",
    inspectFn: async () => resultWith({ ...classifyDsFailureType({ failureMessage: "Unknown column bad_id" }) }),
    actionFn: async () => { actions += 1; return {}; },
    now: () => fixedNow,
  });
  await enableAndWait(manager);
  assert.equal(actions, 0);
  assert.equal(manager.active.size, 0);
  assert.equal([...manager.statuses.values()][0].autoRetryStatus, "sql_code_error");
});

test("does not start retry loop for permission errors", async () => {
  let actions = 0;
  const manager = createDsAutoRetryManager({
    rootDir: "/unused",
    inspectFn: async () => resultWith({ ...classifyDsFailureType({ failureMessage: "Access denied for table dw.orders" }) }),
    actionFn: async () => { actions += 1; return {}; },
    now: () => fixedNow,
  });
  await enableAndWait(manager);
  assert.equal(actions, 0);
  assert.equal(manager.active.size, 0);
  assert.equal([...manager.statuses.values()][0].autoRetryStatus, "permission_error");
});

test("keeps retryable failures running until the instance succeeds", async () => {
  const actions = [];
  const retryPayloads = [];
  let instanceChecks = 0;
  const manager = createDsAutoRetryManager({
    rootDir: "/unused",
    inspectFn: async () => resultWith({ ...classifyDsFailureType({ failureMessage: "Memory limit exceeded" }) }),
    configLoader: async () => ({ n8nWebhookUrl: "https://gateway.example", countries: { cn: { token: "token" } } }),
    actionFn: async ({ action, payload }) => {
      actions.push(action);
      if (action === "get_instance") return { state: ++instanceChecks === 1 ? "FAILURE" : "SUCCESS" };
      if (action === "get_workflow") return { releaseState: "ONLINE" };
      if (action === "retry_instance") retryPayloads.push(payload);
      return { success: true };
    },
    now: () => fixedNow,
    sleep: async () => {},
  });
  await enableAndWait(manager);
  assert.deepEqual(actions, ["get_instance", "get_workflow", "retry_instance", "get_instance"]);
  assert.equal(retryPayloads[0].execution_type, "START_FAILURE_TASK_PROCESS");
  assert.equal([...manager.statuses.values()][0].autoRetryStatus, "recovered");
  assert.equal([...manager.statuses.values()][0].attempts, 1);
});

test("does not notify the owner when an over-one-hour suspected empty run is stopped", async () => {
  const actions = [];
  const notifications = [];
  let current = new Date(fixedNow);
  const failure = classifyDsFailureType({ failureMessage: "workflow failed without a task node" });
  const manager = createDsAutoRetryManager({
    rootDir: "/unused",
    inspectFn: async () => resultWith({ ...failure, startTime: "2026-08-18 08:30:00" }),
    configLoader: async () => ({ n8nWebhookUrl: "https://gateway.example", countries: { cn: { token: "token" } } }),
    ownerConfigLoader: async () => ({ countryConfigs: [{ countryCode: "CN", ownerEmails: "cn-owner@kn.group" }] }),
    notifyFn: async (config, message, metadata) => {
      notifications.push({ config, message, metadata });
      return { sent: true };
    },
    actionFn: async ({ action }) => {
      actions.push(action);
      if (action === "get_instance") return { state: "STOP" };
      if (action === "get_workflow") return { releaseState: "ONLINE" };
      return { success: true };
    },
    now: () => current,
    sleep: async () => { current = new Date(current.getTime() + 60 * 60 * 1000); },
  });
  await enableAndWait(manager);
  assert.deepEqual(actions, ["get_instance"]);
  const status = [...manager.statuses.values()][0];
  assert.equal(status.autoRetryStatus, "safety_stopped");
  assert.match(status.stopReason, /1 小时/);
  assert.ok(manager.getLogs().some((item) => item.event === "empty_run_confirmed"));
  assert.equal(notifications.length, 0);
  assert.ok(manager.getLogs().some((item) => item.event === "owner_notification_skipped" && /不是运行中/.test(item.message)));
});

test("notifies the country owner only when a suspected empty run is still running after one hour", async () => {
  const notifications = [];
  const failure = classifyDsFailureType({ failureMessage: "workflow failed without a task node" });
  const manager = createDsAutoRetryManager({
    rootDir: "/unused",
    inspectFn: async () => resultWith({ ...failure, startTime: "2026-08-18 08:30:00" }),
    configLoader: async () => ({ n8nWebhookUrl: "https://gateway.example", countries: { cn: { token: "token" } } }),
    ownerConfigLoader: async () => ({ countryConfigs: [{ countryCode: "CN", ownerEmails: "cn-owner@kn.group" }] }),
    notifyFn: async (config, message, metadata) => {
      notifications.push({ config, message, metadata });
      return { sent: true };
    },
    actionFn: async ({ action }) => action === "get_instance" ? { state: "RUNNING_EXECUTION" } : {},
    now: () => fixedNow,
  });
  await enableAndWait(manager);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].config.alerts.recipientEmails, "cn-owner@kn.group");
  assert.match(notifications[0].message, /实例 ID：3001/);
  assert.ok(manager.getLogs().some((item) => item.event === "owner_notification_sent"));
});

test("tests country-owner notifications and persists the result in retry logs", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ds-owner-notification-test-"));
  await fs.mkdir(path.join(rootDir, "config"), { recursive: true });
  const sent = [];
  const manager = createDsAutoRetryManager({
    rootDir,
    ownerConfigLoader: async () => ({
      countryConfigs: [{ countryCode: "MX", ownerEmails: "mx-owner@kn.group" }],
    }),
    notifyFn: async (config, message) => {
      sent.push({ config, message });
      return { sent: true, status: 200 };
    },
    now: () => fixedNow,
  });

  const result = await manager.testOwnerNotification({ country: "mx" });
  assert.equal(result.sent, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /不代表真实生产故障/);
  assert.ok(manager.getLogs().some((item) => item.event === "owner_notification_test_sent"));
  const persisted = JSON.parse(await fs.readFile(path.join(rootDir, "config", "ds-failure-retry-state.json"), "utf8"));
  assert.ok(persisted.logs.some((item) => item.event === "owner_notification_test_sent"));
});

test("uses the shared n8n and scheduled-retry country owner configuration", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ds-shared-owner-test-"));
  await fs.mkdir(path.join(rootDir, "config"), { recursive: true });
  await fs.writeFile(path.join(rootDir, "config", "ds-scheduled-failure-watch.json"), JSON.stringify({ owners: { ph: "ph-owner@kn.group" }, groupChatIds: { ph: "-100-ph-group" } }));
  const sent = [];
  const manager = createDsAutoRetryManager({
    rootDir,
    notifyFn: async (config) => {
      sent.push(config);
      return { sent: true };
    },
    now: () => fixedNow,
  });

  const result = await manager.testOwnerNotification({ country: "ph" });
  assert.equal(result.sent, true);
  assert.equal(sent[0].alerts.recipientEmails, "ph-owner@kn.group");
  assert.equal(sent[0].alerts.chatId, "-100-ph-group");
  await fs.rm(rootDir, { recursive: true, force: true });
});

test("keeps complete retry runs for seven days and removes older history", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ds-retry-retention-test-"));
  await fs.mkdir(path.join(rootDir, "config"), { recursive: true });
  await fs.writeFile(path.join(rootDir, "config", "ds-failure-retry-state.json"), JSON.stringify({
    logs: [
      { id: "old-1", runId: "old-run", time: "2026-08-10T10:00:00.000Z", event: "manual_run" },
      { id: "recent-1", runId: "recent-run", time: "2026-08-17T02:01:00.000Z", event: "manual_run" },
      { id: "recent-2", runId: "recent-run", time: "2026-08-18T01:00:00.000Z", event: "manual_run_completed" },
    ],
  }));
  const manager = createDsAutoRetryManager({ rootDir, now: () => fixedNow });
  const logs = manager.getLogs();
  assert.equal(logs.some((item) => item.runId === "old-run"), false);
  assert.equal(logs.filter((item) => item.runId === "recent-run").length, 2);
});

test("stops without retry when the workflow is offline", async () => {
  const actions = [];
  const manager = createDsAutoRetryManager({
    rootDir: "/unused",
    inspectFn: async () => resultWith({ ...classifyDsFailureType({ failureMessage: "CPU limit exceeded" }) }),
    configLoader: async () => ({ n8nWebhookUrl: "https://gateway.example", countries: { cn: { token: "token" } } }),
    actionFn: async ({ action }) => {
      actions.push(action);
      if (action === "get_instance") return { state: "FAILURE" };
      if (action === "get_workflow") return { releaseState: "OFFLINE" };
      return {};
    },
    now: () => fixedNow,
    sleep: async () => {},
  });
  await enableAndWait(manager);
  assert.deepEqual(actions, ["get_instance", "get_workflow"]);
  assert.match([...manager.statuses.values()][0].stopReason, /工作流已下线/);
});

test("continues retrying a recoverable instance even when its current state is stopped", async () => {
  const actions = [];
  const retryPayloads = [];
  let checks = 0;
  const manager = createDsAutoRetryManager({
    rootDir: "/unused",
    inspectFn: async () => resultWith({
      instanceState: "STOP",
      taskName: "load_orders",
      failureMessage: "Connection reset by peer",
      ...classifyDsFailureType({ instanceState: "STOP", taskName: "load_orders", failureMessage: "Connection reset by peer" }),
    }),
    configLoader: async () => ({ n8nWebhookUrl: "https://gateway.example", countries: { cn: { token: "token" } } }),
    actionFn: async ({ action, payload }) => {
      actions.push(action);
      if (action === "get_instance") return { state: ++checks === 1 ? "STOP" : "SUCCESS" };
      if (action === "get_workflow") return { releaseState: "ONLINE" };
      if (action === "retry_instance") retryPayloads.push(payload);
      return { success: true };
    },
    now: () => fixedNow,
    sleep: async () => {},
  });
  await enableAndWait(manager);
  assert.deepEqual(actions, ["get_instance", "get_workflow", "retry_instance", "get_instance"]);
  assert.equal(retryPayloads[0].execution_type, "REPEAT_RUNNING");
  assert.equal([...manager.statuses.values()][0].autoRetryStatus, "recovered");
});

test("terminates a retryable instance when its failure date is no longer today", async () => {
  const actions = [];
  const manager = createDsAutoRetryManager({
    rootDir: "/unused",
    inspectFn: async () => resultWith({ startTime: "2026-08-17 23:00:00", taskName: "load_orders", ...classifyDsFailureType({ taskName: "load_orders", failureMessage: "Connection reset by peer" }) }),
    configLoader: async () => ({ n8nWebhookUrl: "https://gateway.example", countries: { cn: { token: "token" } } }),
    actionFn: async ({ action }) => { actions.push(action); return action === "get_instance" ? { state: "FAILURE" } : {}; },
    now: () => fixedNow,
    sleep: async () => {},
  });
  await enableAndWait(manager);
  assert.deepEqual(actions, ["get_instance"]);
  const status = [...manager.statuses.values()][0];
  assert.match(status.stopReason, /DS 最新实例状态为 FAILURE/);
  assert.match(status.stopReason, /失败实例日期 2026-08-17/);
  assert.match(status.stopReason, /当前业务日期 2026-08-18/);
});

test("marks a cross-day instance recovered when DS reports the latest state as successful", async () => {
  const actions = [];
  const manager = createDsAutoRetryManager({
    rootDir: "/unused",
    inspectFn: async () => resultWith({ startTime: "2026-08-17 23:00:00", taskName: "load_orders", ...classifyDsFailureType({ taskName: "load_orders", failureMessage: "Connection reset by peer" }) }),
    configLoader: async () => ({ n8nWebhookUrl: "https://gateway.example", countries: { cn: { token: "token" } } }),
    actionFn: async ({ action }) => { actions.push(action); return action === "get_instance" ? { state: "SUCCESS" } : {}; },
    now: () => fixedNow,
    sleep: async () => {},
  });
  await enableAndWait(manager);
  assert.deepEqual(actions, ["get_instance"]);
  const status = [...manager.statuses.values()][0];
  assert.equal(status.autoRetryStatus, "recovered");
  assert.equal(status.stopReason, "重跑成功");
  assert.equal(manager.getLogs().some((item) => item.event === "safety_stopped"), false);
});

test("automatic retry starts its interval clock without running immediately", async () => {
  let inspected = 0;
  let current = new Date(fixedNow);
  const manager = createDsAutoRetryManager({
    rootDir: "/unused",
    inspectFn: async () => { inspected += 1; return { totalFailures: 0, countries: [] }; },
    now: () => current,
  });
  assert.deepEqual(await manager.scan(), { skipped: true, reason: "disabled" });
  manager.enable({ intervalMinutes: 30 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(inspected, 0);
  assert.equal(manager.control().intervalMinutes, 30);
  await manager.scan();
  assert.equal(inspected, 1);
  manager.disable();
  assert.equal(manager.control().enabled, false);
  assert.equal(manager.getLogs().some((item) => ["control_enabled", "control_disabled"].includes(item.event)), false);
});

test("automatic retry aligns the first run to the selected minute and then uses the hour interval", () => {
  const current = new Date("2026-08-20T16:40:00+08:00");
  const manager = createDsAutoRetryManager({ rootDir: "/unused", now: () => current });
  manager.enable({ intervalMinutes: 120, retryMinute: 30 });
  assert.equal(manager.control().retryMinute, 30);
  assert.equal(manager.control().intervalMinutes, 120);
  assert.equal(manager.control().nextRunAt, "2026-08-20T09:30:00.000Z");
  manager.disable();
});

test("manual run starts immediately without enabling automatic retry", async () => {
  let inspected = 0;
  const manager = createDsAutoRetryManager({
    rootDir: "/unused",
    inspectFn: async () => { inspected += 1; return { totalFailures: 0, countries: [] }; },
    now: () => fixedNow,
  });
  manager.runNow();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(inspected, 1);
  assert.equal(manager.control().enabled, false);
  assert.equal(manager.control().manualRunning, false);
  assert.ok(manager.getLogs().some((item) => item.event === "manual_run"));
  assert.ok(manager.getLogs().some((item) => item.event === "manual_run_completed"));
});

test("manual run can be stopped independently from automatic retry", async () => {
  let releaseInspect;
  const manager = createDsAutoRetryManager({
    rootDir: "/unused",
    inspectFn: () => new Promise((resolve) => { releaseInspect = resolve; }),
    now: () => fixedNow,
  });
  manager.enable({ intervalMinutes: 60, retryMinute: 0 });
  manager.runNow();
  assert.equal(manager.control().manualRunning, true);
  manager.stopManualRun();
  assert.equal(manager.control().manualRunning, false);
  assert.equal(manager.control().enabled, true);
  releaseInspect({ totalFailures: 0, countries: [] });
});

test("manual run submits at most one retry while automatic retry is disabled", async () => {
  const actions = [];
  const manager = createDsAutoRetryManager({
    rootDir: "/unused",
    inspectFn: async () => resultWith({
      ...classifyDsFailureType({ failureMessage: "Connection reset by peer" }),
      failureMessage: "Connection reset by peer",
    }),
    configLoader: async () => ({ n8nWebhookUrl: "https://gateway.example", countries: { cn: { token: "token" } } }),
    actionFn: async ({ action }) => {
      actions.push(action);
      if (action === "get_instance") return { state: "FAILURE" };
      if (action === "get_workflow") return { releaseState: "ONLINE" };
      return { success: true };
    },
    now: () => fixedNow,
    sleep: async () => {},
  });
  manager.runNow({ countries: ["cn"] });
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.all([...manager.active.values()]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(actions.filter((action) => action === "retry_instance").length, 1);
  assert.ok(manager.getLogs().some((item) => item.event === "retry_not_recovered"));
  assert.equal(manager.control().enabled, false);
  assert.equal(manager.control().manualRunning, false);
  assert.ok(manager.getLogs().some((item) => item.event === "manual_run_completed"));
});

test("privately notifies the country owner when a submitted retry is not recovered", async () => {
  const sent = [];
  const manager = createDsAutoRetryManager({
    rootDir: "/unused",
    inspectFn: async () => resultWith({ failureMessage: "Connection reset by peer", retryable: true, projectName: "国内数仓", workflowName: "hourly_etl", taskName: "load_orders" }),
    configLoader: async () => ({ n8nWebhookUrl: "https://gateway.example", countries: { cn: { token: "token" } } }),
    ownerConfigLoader: async () => ({ sharedOwners: { cn: "cn-owner@kn.group" }, sharedGroupChatIds: { cn: "-100-cn-group" } }),
    notifyFn: async (config, message) => { sent.push({ config, message }); return { sent: true }; },
    actionFn: async ({ action }) => action === "get_workflow" ? { releaseState: "ONLINE" } : action === "retry_instance" ? { success: true } : { state: "FAILURE" },
    now: () => fixedNow,
    sleep: async () => {},
  });
  manager.runNow({ countries: ["cn"] });
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.all([...manager.active.values()]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].config.alerts.recipientEmails, "cn-owner@kn.group");
  assert.equal(sent[0].config.alerts.chatId, undefined);
  assert.equal(sent[0].config.alerts.mentions, undefined);
  assert.match(sent[0].message, /load_orders/);
  assert.match(sent[0].message, /仍为 FAILURE/);
  assert.ok(manager.getLogs().some((item) => item.event === "retry_failure_notification_sent"));
});

test("only scans START_PROCESS failures and never submits a retry", async () => {
  let actions = 0;
  const classified = classifyDsFailureType({
    commandType: "START_PROCESS",
    taskName: "dwd_orders",
    failureMessage: "Connection reset by peer",
  });
  assert.deepEqual(classified, {
    failureType: "start_workflow_scan_only",
    retryable: false,
    retryDecision: "运行类型为启动工作流，仅记录失败扫描结果，不执行自动重跑",
  });
  const manager = createDsAutoRetryManager({
    rootDir: "/unused",
    inspectFn: async () => resultWith({ commandType: "START_PROCESS", taskName: "dwd_orders", ...classified }),
    actionFn: async () => { actions += 1; return {}; },
    now: () => fixedNow,
  });
  await enableAndWait(manager);
  assert.equal(actions, 0);
  assert.equal([...manager.statuses.values()][0].autoRetryStatus, "start_workflow_scan_only");
  assert.ok(manager.getLogs().some((item) => item.event === "skipped" && /仅记录失败扫描结果/.test(item.message)));
});

test("notifies the country owner when retry submission fails", async () => {
  const sent = [];
  const manager = createDsAutoRetryManager({
    rootDir: "/unused",
    inspectFn: async () => resultWith({ failureMessage: "Lost connection", retryable: true, taskName: "sync_customer" }),
    configLoader: async () => ({ n8nWebhookUrl: "https://gateway.example", countries: { cn: { token: "token" } } }),
    ownerConfigLoader: async () => ({ sharedOwners: { cn: "cn-owner@kn.group" } }),
    notifyFn: async (config, message) => { sent.push({ config, message }); return { sent: true }; },
    actionFn: async ({ action }) => {
      if (action === "get_instance") return { state: "FAILURE" };
      if (action === "get_workflow") return { releaseState: "ONLINE" };
      throw new Error("DS gateway returned 500");
    },
    now: () => fixedNow,
  });
  await enableAndWait(manager);
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /重跑请求提交失败：DS gateway returned 500/);
  assert.ok(manager.getLogs().some((item) => item.event === "retry_failure_notification_sent"));
});

test("control counts persisted retry tasks while automatic retry is enabled", () => {
  const manager = createDsAutoRetryManager({ rootDir: "/unused", now: () => fixedNow });
  manager.enable({ intervalMinutes: 60, retryMinute: 10 });
  manager.statuses.set("cn:1001:3001", { autoRetryStatus: "retry_wait", runId: manager.control().currentRunId });
  manager.statuses.set("cn:old:task", { autoRetryStatus: "retry_wait", runId: "older-run" });
  assert.equal(manager.control().activeCount, 1);
  manager.disable();
  assert.equal(manager.control().activeCount, 0);
});

test("deletes every persisted log belonging to one retry run", () => {
  const manager = createDsAutoRetryManager({ rootDir: "/unused", now: () => fixedNow });
  manager.runNow();
  const runId = manager.control().currentRunId;
  assert.ok(manager.getLogs().some((item) => item.runId === runId));
  const result = manager.deleteRunLogs(runId);
  assert.ok(result.deleted > 0);
  assert.equal(manager.getLogs().some((item) => item.runId === runId), false);
  manager.disable();
});

test("skips every workflow in a country project configured as excluded", async () => {
  let actions = 0;
  const failure = {
    ...classifyDsFailureType({ failureMessage: "Connection reset by peer" }),
    projectCode: "1001",
    projectName: "Daily Warehouse",
    workflowName: "daily_order_workflow",
    taskName: "daily_order_sync",
    failureMessage: "Connection reset by peer",
  };
  const manager = createDsAutoRetryManager({
    rootDir: "/unused",
    inspectFn: async () => resultWith(failure),
    actionFn: async () => { actions += 1; return {}; },
    now: () => fixedNow,
  });
  manager.configure({ excludedProjects: { cn: ["1001"] } });
  await enableAndWait(manager);
  assert.equal(actions, 0);
  assert.match([...manager.statuses.values()][0].stopReason, /排除配置/);
  const excludedLog = manager.getLogs().find((item) => item.event === "excluded");
  assert.equal(excludedLog.failureReason, "Connection reset by peer");
});

test("updates selected countries while automatic retry remains enabled", () => {
  const manager = createDsAutoRetryManager({ rootDir: "/unused", now: () => fixedNow });
  manager.enable({ countries: ["cn"], intervalMinutes: 60, retryMinute: 10 });
  manager.configure({ countries: ["mx", "th"] });
  assert.equal(manager.control().enabled, true);
  assert.deepEqual(manager.control().countries, ["mx", "th"]);
  manager.disable();
});

test("persists enabled control, selected countries, logs, and task identity across restart", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ds-retry-state-"));
  await fs.mkdir(path.join(rootDir, "config"));
  const failure = {
    ...classifyDsFailureType({ failureMessage: "Connection reset by peer" }),
    failureMessage: "Connection reset by peer",
    projectName: "Risk Project",
    workflowName: "daily_risk_etl",
    taskName: "load_risk_result",
  };
  const first = createDsAutoRetryManager({
    rootDir,
    inspectFn: async () => resultWith(failure),
    configLoader: async () => ({ n8nWebhookUrl: "", countries: {} }),
    now: () => fixedNow,
  });
  await enableAndWait(first);

  const second = createDsAutoRetryManager({ rootDir, inspectFn: async () => ({ totalFailures: 0, countries: [] }), now: () => fixedNow });
  assert.equal(second.control().enabled, true);
  assert.deepEqual(second.control().countries, []);
  const taskLog = second.getLogs().find((item) => item.event === "retry_started");
  assert.equal(taskLog.taskName, "load_risk_result");
  assert.equal(taskLog.workflowName, "daily_risk_etl");
  assert.equal(taskLog.projectName, "Risk Project");
  assert.equal(taskLog.failureReason, "Connection reset by peer");
  second.disable();
});
