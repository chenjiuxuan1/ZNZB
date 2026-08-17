import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { classifyWorkflowFailures, extractDsFailureReason, extractTaskScript, inspectDsFailureLogs, normalizeCountrySelection, normalizeGatewayFailures } from "../src/ds-failure-log-monitor.mjs";

test("DS failure log accepts a unique subset of supported countries", () => {
  assert.deepEqual(normalizeCountrySelection("th,cn,th,unknown"), ["cn", "th"]);
  assert.deepEqual(normalizeCountrySelection(["mx", "ine"]), ["ine", "mx"]);
  assert.deepEqual(normalizeCountrySelection(undefined), ["cn", "ine", "ph", "th", "pk", "mx"]);
});

test("DS failure log uses the gateway scheduled-today recovery verdict", () => {
  const failures = normalizeGatewayFailures({
    failed_workflows: [
      { workflow_code: "a", workflow_name: "recovered", schedule_status: "ONLINE", failure_reason: "scheduled_instance_failed", has_later_success: true, instance_id: "a1", instance_state: "FAILURE", start_time: "2026-08-14T01:00:00Z" },
      { workflow_code: "b", workflow_name: "unresolved", schedule_status: "ONLINE", failure_reason: "scheduled_instance_failed", has_later_success: false, instance_id: "b1", instance_state: "FAILURE", start_time: "2026-08-14T02:00:00Z" },
      { workflow_code: "c", workflow_name: "offline", schedule_status: "OFFLINE", failure_reason: "scheduled_instance_failed", instance_id: "c1", instance_state: "FAILURE" },
    ],
  }, { projectName: "DW_DM", projectCode: "1001", targetDate: "2026-08-14", timeZone: "UTC" });
  assert.equal(failures.length, 2);
  assert.equal(failures.find((item) => item.workflowCode === "a").repairStatus, "recovered");
  assert.equal(failures.find((item) => item.workflowCode === "b").repairStatus, "unresolved");
});

test("DS failure log classifies recovered repairing and unresolved workflows", () => {
  const failures = classifyWorkflowFailures([
    { workflow_code: "a", workflow_name: "已恢复任务", instance_id: "a1", state: "FAILURE", start_time: "2026-08-14T01:00:00Z" },
    { workflow_code: "a", workflow_name: "已恢复任务", instance_id: "a2", state: "SUCCESS", start_time: "2026-08-14T02:00:00Z" },
    { workflow_code: "b", workflow_name: "修复中任务", instance_id: "b1", state: "FAILURE", start_time: "2026-08-14T03:00:00Z" },
    { workflow_code: "b", workflow_name: "修复中任务", instance_id: "b2", state: "RUNNING_EXECUTION", start_time: "2026-08-14T04:00:00Z" },
    { workflow_code: "c", workflow_name: "待修复任务", instance_id: "c1", state: "FAILURE", start_time: "2026-08-14T05:00:00Z" },
  ], { projectName: "DW_DM", projectCode: "1001" });

  assert.equal(failures.find((item) => item.workflowCode === "a").repairStatus, "recovered");
  assert.equal(failures.find((item) => item.workflowCode === "a").recoveryInstanceId, "a2");
  assert.equal(failures.find((item) => item.workflowCode === "b").repairStatus, "repairing");
  assert.equal(failures.find((item) => item.workflowCode === "c").repairStatus, "unresolved");
});

test("DS failure log uses the newest failure when a workflow fails again after recovery", () => {
  const [failure] = classifyWorkflowFailures([
    { workflow_code: "a", instance_id: "a1", state: "FAILURE", start_time: "2026-08-14T01:00:00Z" },
    { workflow_code: "a", instance_id: "a2", state: "SUCCESS", start_time: "2026-08-14T02:00:00Z" },
    { workflow_code: "a", instance_id: "a3", state: "FAILURE", start_time: "2026-08-14T03:00:00Z" },
  ]);
  assert.equal(failure.instanceId, "a3");
  assert.equal(failure.repairStatus, "unresolved");
  assert.equal(failure.failureCount, 2);
});

test("DS failure log keeps a scheduled failure after automatic retry changed the instance to success", () => {
  const [failure] = classifyWorkflowFailures([{
    projectCode: 15843450427744,
    workflowInstanceId: 2358171,
    workflowDefinitionCode: 15845044642912,
    workflowInstanceName: "菲律宾-数仓工作流（1/2H）-20260814144800036",
    commandType: "START_FAILURE_TASK_PROCESS",
    workflowExecutionStatus: "SUCCESS",
    runTimes: 3,
    workflowStartTime: "2026-08-14 14:48:00",
    workflowEndTime: "2026-08-14 15:20:00",
  }], { projectName: "菲律宾数仓-正式环境", projectCode: "15843450427744" });

  assert.equal(failure.instanceId, "2358171");
  assert.equal(failure.workflowCode, "15845044642912");
  assert.equal(failure.repairStatus, "recovered");
  assert.equal(failure.recoveryState, "SUCCESS");
  assert.equal(failure.failureCount, 2);
  assert.equal(failure.inferredFromRetry, true);
});

test("DS failure reason extracts the concrete final error line", () => {
  const reason = extractDsFailureReason([
    "INFO task started",
    "ERROR run etl fail",
    "Caused by: StarRocks query failed: Table 'dw.dwd_orders' does not exist",
  ].join("\n"));
  assert.equal(reason, "StarRocks query failed: Table 'dw.dwd_orders' does not exist");
});

test("DS failure reason ignores Java stack frames and task runtime exposes SQL", () => {
  const reason = extractDsFailureReason([
    "ERROR java.sql.SQLException",
    "s.SQLError.createSQLException(SQLError.java:130)",
    "Caused by: errCode = 2, detailMessage = Unknown column 'loan_id'",
    "at org.apache.dolphinscheduler.plugin.task.sql.SqlTask.handle(SqlTask.java:184)",
  ].join("\n"));
  assert.equal(reason, "errCode = 2, detailMessage = Unknown column 'loan_id'");
  assert.equal(extractDsFailureReason("s.SQLError.createSQLException(SQLError.java:130)"), "任务日志只返回了程序调用栈，未解析到明确业务失败原因");
  assert.equal(extractTaskScript({ runtime_config: { sql: "select * from dw.orders" } }), "select * from dw.orders");
});

test("DS failure log queries today's instances before reading failed task logs", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ds-failure-skill-chain-"));
  await fs.mkdir(path.join(rootDir, "config"), { recursive: true });
  await fs.writeFile(path.join(rootDir, "config/ds-scheduler.config.json"), JSON.stringify({
    n8nWebhookUrl: "https://gateway.example/ds",
    countries: { cn: { name: "中国", token: "test-token" } },
    projects: { cn: [{ name: "DW_DM", code: "1001" }] },
  }));

  const originalFetch = globalThis.fetch;
  const actions = [];
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    actions.push(request);
    const responses = {
      list_instances: {
        totalList: [
          { workflowDefinitionCode: "wf-1", workflowInstanceName: "daily_orders", workflowInstanceId: "i-1", commandType: "SCHEDULER", workflowExecutionStatus: "FAILURE", workflowStartTime: "2026-08-14 08:00:00", workflowEndTime: "2026-08-14 08:10:00" },
          { workflowDefinitionCode: "wf-old", workflowInstanceName: "yesterday_job", workflowInstanceId: "i-old", workflowExecutionStatus: "FAILURE", workflowStartTime: "2026-08-13 23:59:00" },
        ],
        total: 2,
      },
      list_task_instances: {
        processInstanceState: "FAILURE",
        taskList: [
          { taskInstanceId: "t-wrong", workflowInstanceId: "i-other", taskCode: "wrong-task", name: "unrelated_failure", state: "FAILURE", endTime: "2026-08-14 09:09:59" },
          { taskInstanceId: "t-1", workflowInstanceId: "i-1", taskCode: "task-1", name: "dwd_orders", state: "FAILURE", endTime: "2026-08-14 08:09:59" },
        ],
      },
      get_task_log: {
        task_name: "dwd_orders",
        task_instance_id: "t-1",
        state: "FAILURE",
        log: "INFO begin\nERROR wrapper failed\nCaused by: Table 'dw.dwd_orders' does not exist",
      },
      extract_task_runtime_config: {
        task_type: "SQL",
        runtime_config: { sql: "select * from dw.dwd_orders" },
      },
    };
    return {
      ok: true,
      status: 200,
      async text() { return JSON.stringify({ success: true, data: responses[request.action] }); },
    };
  };

  try {
    const result = await inspectDsFailureLogs(rootDir, { now: new Date("2026-08-14T09:00:00+08:00"), countries: ["cn"] });
    assert.deepEqual(actions.map((item) => item.action), ["list_instances", "list_task_instances", "get_task_log", "extract_task_runtime_config"]);
    const taskQuery = actions.find((item) => item.action === "list_task_instances");
    assert.equal(taskQuery.payload.state_type, "FAILURE");
    assert.equal(actions[0].payload.state_type, "");
    assert.equal(actions[0].payload.start_time, "2026-08-14 00:00:00");
    assert.equal(actions[0].payload.end_time, "2026-08-14 23:59:59");
    assert.equal(result.totalFailures, 1);
    assert.equal(result.countries[0].failures[0].instanceId, "i-1");
    assert.equal(result.countries[0].failures[0].repairStatus, "unresolved");
    assert.equal(result.countries[0].failures[0].taskInstanceId, "t-1");
    assert.equal(result.countries[0].failures[0].failureMessage, "Table 'dw.dwd_orders' does not exist");
    assert.equal(result.countries[0].failures[0].taskType, "SQL");
    assert.equal(result.countries[0].failures[0].taskScript, "select * from dw.dwd_orders");
    assert.equal(
      result.countries[0].failures[0].dsInstanceUrl,
      "https://dolphin.kuainiujinke.com/dolphinscheduler/ui/projects/1001/workflow/instances/i-1",
    );
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("DS failure log follows SUB_WORKFLOW tasks to the leaf SQL failure", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ds-failure-sub-workflow-"));
  await fs.mkdir(path.join(rootDir, "config"), { recursive: true });
  await fs.writeFile(path.join(rootDir, "config/ds-scheduler.config.json"), JSON.stringify({
    n8nWebhookUrl: "https://gateway.example/ds",
    countries: { ph: { name: "PH", token: "test-token" } },
    projects: { ph: [{ name: "warehouse", code: "1001" }] },
  }));

  const originalFetch = globalThis.fetch;
  const actions = [];
  let taskListCalls = 0;
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    actions.push(request.action);
    let data = {};
    if (request.action === "list_instances") {
      data = { totalList: [{ workflowDefinitionCode: "parent-wf", workflowInstanceId: "parent-i", workflowInstanceName: "parent", workflowExecutionStatus: "FAILURE", workflowStartTime: "2026-08-14 08:00:00" }], total: 1 };
    } else if (request.action === "list_task_instances") {
      taskListCalls += 1;
      data = taskListCalls === 1
        ? { taskList: [{ id: "parent-task-i", workflowInstanceId: "parent-i", taskCode: "sub-task", name: "DWD", taskType: "SUB_WORKFLOW", state: "FAILURE" }] }
        : { taskList: [{ id: "leaf-task-i", workflowInstanceId: "child-i", taskCode: "sql-task", name: "dwd_orders", taskType: "SQL", state: "FAILURE" }] };
    } else if (request.action === "get_task_log" && request.payload.task_type === "SUB_WORKFLOW") {
      data = { sub_workflow_instance_id: "child-i" };
    } else if (request.action === "get_instance") {
      data = { data: { workflowDefinitionCode: "child-wf" } };
    } else if (request.action === "get_task_log") {
      data = { log: "ERROR query failed\nCaused by: Unknown column 'loan_id'" };
    } else if (request.action === "extract_task_runtime_config") {
      assert.equal(request.payload.workflow_code, "child-wf");
      data = { task_type: "SQL", runtime_config: { sql: "select loan_id from dwd_orders" } };
    }
    return { ok: true, status: 200, async text() { return JSON.stringify({ success: true, data }); } };
  };

  try {
    const result = await inspectDsFailureLogs(rootDir, { now: new Date("2026-08-14T09:00:00+08:00"), countries: ["ph"] });
    assert.deepEqual(actions, ["list_instances", "list_task_instances", "get_task_log", "get_instance", "list_task_instances", "get_task_log", "extract_task_runtime_config"]);
    const [failure] = result.countries[0].failures;
    assert.equal(failure.taskInstanceId, "leaf-task-i");
    assert.equal(failure.taskName, "dwd_orders");
    assert.equal(failure.taskType, "SQL");
    assert.equal(failure.resolvedWorkflowInstanceId, "child-i");
    assert.equal(failure.resolvedWorkflowCode, "child-wf");
    assert.equal(failure.failureMessage, "Unknown column 'loan_id'");
    assert.equal(failure.taskScript, "select loan_id from dwd_orders");
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("DS failure log recovers failure evidence from a retried task in the same instance", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ds-failure-same-instance-"));
  await fs.mkdir(path.join(rootDir, "config"), { recursive: true });
  await fs.writeFile(path.join(rootDir, "config/ds-scheduler.config.json"), JSON.stringify({
    n8nWebhookUrl: "https://gateway.example/ds",
    countries: { ph: { name: "PH", token: "test-token" } },
    projects: { ph: [{ name: "warehouse", code: "1001" }] },
  }));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    const responses = {
      list_instances: { totalList: [{ workflowDefinitionCode: "wf-1", workflowInstanceId: "same-i", workflowInstanceName: "hourly", commandType: "START_FAILURE_TASK_PROCESS", workflowExecutionStatus: "SUCCESS", runTimes: 2, workflowStartTime: "2026-08-14 08:00:00" }], total: 1 },
      list_task_instances: { taskList: [{ id: "retried-task-i", workflowInstanceId: "same-i", taskCode: "sql-task", name: "hourly_sql", taskType: "SQL", state: "SUCCESS", retryTimes: 1 }] },
      get_task_log: { log: "INFO retry started\nCaused by: SQLSTATE 42S22 unknown column loan_id\nINFO retry success" },
      extract_task_runtime_config: { task_type: "SQL", runtime_config: { sql: "select loan_id from source" } },
    };
    return { ok: true, status: 200, async text() { return JSON.stringify({ success: true, data: responses[request.action] }); } };
  };

  try {
    const result = await inspectDsFailureLogs(rootDir, { now: new Date("2026-08-14T09:00:00+08:00"), countries: ["ph"] });
    const [failure] = result.countries[0].failures;
    assert.equal(failure.taskInstanceId, "retried-task-i");
    assert.equal(failure.taskState, "SUCCESS");
    assert.equal(failure.failureMessage, "SQLSTATE 42S22 unknown column loan_id");
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("DS failure log scans later task pages after same-instance recovery", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ds-failure-task-pages-"));
  await fs.mkdir(path.join(rootDir, "config"), { recursive: true });
  await fs.writeFile(path.join(rootDir, "config/ds-scheduler.config.json"), JSON.stringify({
    n8nWebhookUrl: "https://gateway.example/ds",
    countries: { pk: { name: "PK", token: "test-token" } },
    projects: { pk: [{ name: "data-quality", code: "170184693195456" }] },
  }));

  const originalFetch = globalThis.fetch;
  const taskPages = [];
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    let data = {};
    if (request.action === "list_instances") {
      data = { totalList: [{ workflowDefinitionCode: "wf-1", workflowInstanceId: "2413416", workflowInstanceName: "quality-check", commandType: "START_FAILURE_TASK_PROCESS", workflowExecutionStatus: "SUCCESS", runTimes: 2, workflowStartTime: "2026-08-17 11:30:43" }], total: 1 };
    } else if (request.action === "list_task_instances") {
      const pageNo = Number(request.payload.page_no);
      taskPages.push({ pageNo, stateType: request.payload.state_type || "" });
      data = request.payload.state_type === "FAILURE"
        ? { total: 0, totalList: [] }
        : pageNo === 1
        ? { total: 101, totalList: Array.from({ length: 100 }, (_, index) => ({ id: `success-${index}`, workflowInstanceId: "2413416", taskCode: `task-${index}`, name: `successful_task_${index}`, taskType: "SQL", state: "SUCCESS" })) }
        : { total: 101, totalList: [{ id: "failed-task", workflowInstanceId: "2413416", taskCode: "failed-code", name: "failed_quality_sql", taskType: "SQL", state: "FAILURE", endTime: "2026-08-17 11:31:00" }] };
    } else if (request.action === "get_task_log") {
      data = { log: "ERROR query failed\nCaused by: SQLSTATE 42S22 unknown column bad_col" };
    } else if (request.action === "extract_task_runtime_config") {
      data = { task_type: "SQL", runtime_config: { sql: "select bad_col from source" } };
    }
    return { ok: true, status: 200, async text() { return JSON.stringify({ success: true, data }); } };
  };

  try {
    const result = await inspectDsFailureLogs(rootDir, { now: new Date("2026-08-17T12:00:00+08:00"), countries: ["pk"] });
    const [failure] = result.countries[0].failures;
    assert.deepEqual(taskPages, [
      { pageNo: 1, stateType: "FAILURE" },
      { pageNo: 1, stateType: "" },
      { pageNo: 2, stateType: "" },
    ]);
    assert.equal(failure.taskInstanceId, "failed-task");
    assert.equal(failure.taskName, "failed_quality_sql");
    assert.equal(failure.failureMessage, "SQLSTATE 42S22 unknown column bad_col");
    assert.equal(failure.taskScript, "select bad_col from source");
    assert.equal(failure.taskQueryPages, 2);
    assert.equal(failure.taskQueryReadCount, 101);
    assert.equal(failure.taskQueryTotal, 101);
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("DS failure log follows a successful SUB_WORKFLOW wrapper after same-instance recovery", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ds-failure-recovered-sub-workflow-"));
  await fs.mkdir(path.join(rootDir, "config"), { recursive: true });
  await fs.writeFile(path.join(rootDir, "config/ds-scheduler.config.json"), JSON.stringify({
    n8nWebhookUrl: "https://gateway.example/ds",
    countries: { pk: { name: "PK", token: "test-token" } },
    projects: { pk: [{ name: "data-quality", code: "170184693195456" }] },
  }));

  const originalFetch = globalThis.fetch;
  let unfilteredTaskCalls = 0;
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    let data = {};
    if (request.action === "list_instances") {
      data = { totalList: [{ workflowDefinitionCode: "parent-wf", workflowInstanceId: "2413416", workflowInstanceName: "quality-check", commandType: "START_FAILURE_TASK_PROCESS", workflowExecutionStatus: "SUCCESS", runTimes: 2, workflowStartTime: "2026-08-17 11:30:43" }], total: 1 };
    } else if (request.action === "list_task_instances" && request.payload.state_type === "FAILURE") {
      data = { total: 0, totalList: [] };
    } else if (request.action === "list_task_instances") {
      unfilteredTaskCalls += 1;
      data = unfilteredTaskCalls === 1
        ? { total: 1, totalList: [{ id: "parent-wrapper", workflowInstanceId: "2413416", taskCode: "sub-code", name: "DWD", taskType: "SUB_WORKFLOW", state: "SUCCESS", retryTimes: 0 }] }
        : { total: 1, totalList: [{ id: "leaf-failure", workflowInstanceId: "child-instance", taskCode: "leaf-code", name: "quality_sql", taskType: "SQL", state: "FAILURE" }] };
    } else if (request.action === "get_task_log" && request.payload.task_type === "SUB_WORKFLOW") {
      data = { sub_workflow_instance_id: "child-instance" };
    } else if (request.action === "get_instance") {
      data = { workflowDefinitionCode: "child-wf" };
    } else if (request.action === "get_task_log") {
      data = { log: "ERROR quality check failed\nCaused by: duplicate key in quality result" };
    } else if (request.action === "extract_task_runtime_config") {
      data = { task_type: "SQL", runtime_config: { sql: "select duplicate_key from quality_result" } };
    }
    return { ok: true, status: 200, async text() { return JSON.stringify({ success: true, data }); } };
  };

  try {
    const result = await inspectDsFailureLogs(rootDir, { now: new Date("2026-08-17T12:00:00+08:00"), countries: ["pk"] });
    const [failure] = result.countries[0].failures;
    assert.equal(failure.taskInstanceId, "leaf-failure");
    assert.equal(failure.taskName, "quality_sql");
    assert.equal(failure.resolvedWorkflowInstanceId, "child-instance");
    assert.equal(failure.failureMessage, "duplicate key in quality result");
    assert.equal(failure.taskScript, "select duplicate_key from quality_result");
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
