import test from "node:test";
import assert from "node:assert/strict";
import {
  extractDsAutoRetryRecords,
  extractAck,
  extractRemoteLogPath,
  inspectN8nAutoRetryExecutions,
  parseRetryLogOutcome,
  resolveAutoRepairLogPath,
} from "../src/ds-n8n-auto-retry-monitor.mjs";

test("parseRetryLogOutcome classifies the async repair final status", () => {
  assert.equal(parseRetryLogOutcome("重跑完成，恢复成功").status, "recovered");
  assert.equal(parseRetryLogOutcome("已恢复").status, "recovered");
  assert.equal(parseRetryLogOutcome("三次重跑全部失败").status, "failed");
  assert.equal(parseRetryLogOutcome("重跑后仍失败").status, "failed");
  assert.equal(parseRetryLogOutcome("任务正在重跑中").status, "running");
  assert.equal(parseRetryLogOutcome("仍在运行，尚未完成").status, "running");
  assert.equal(parseRetryLogOutcome("").status, "unknown");
  assert.equal(parseRetryLogOutcome("no clear marker").status, "unknown");
});

test("resolveAutoRepairLogPath reconstructs unresolved legacy n8n paths", () => {
  assert.equal(
    resolveAutoRepairLogPath({
      country: "ine",
      n8nRequestId: "ine-ds-alert-1788357218021",
      n8nLogPath: "/${country.key}_ds_failed_auto_retry_${requestId}.log",
    }),
    "/root/Global-Intelligent-Alarm-Repair-Assistant/auto_repair_records/ds_failed_auto_retry_logs/ine_ds_failed_auto_retry_ine-ds-alert-1788357218021.log",
  );
  assert.equal(
    resolveAutoRepairLogPath({ country: "ph", n8nRequestId: "req-1", n8nLogPath: "/root/concrete.log" }),
    "/root/concrete.log",
  );
  assert.equal(resolveAutoRepairLogPath({ country: "ine", n8nRequestId: "bad/request" }), "");
  assert.equal(resolveAutoRepairLogPath({ country: "ine", n8nRequestId: "requestId" }), "");
});

test("n8n execution metadata prefers runtime values over workflow code templates", () => {
  const concretePath = "/root/Global-Intelligent-Alarm-Repair-Assistant/auto_repair_records/ds_failed_auto_retry_logs/ine_ds_failed_auto_retry_ine-ds-alert-1788357218021.log";
  const detail = {
    workflowData: { nodes: [{ parameters: { jsCode: "const requestId = 'requestId'; const log = `/${country.key}_ds_failed_auto_retry_${requestId}.log`;" } }] },
    data: { resultData: { runData: { 整理响应: [{ data: { main: [[{ json: {
      accepted: true,
      background_started: true,
      request_id: "ine-ds-alert-1788357218021",
      runner: { log: concretePath },
    } }]] } }] } } },
  };
  assert.equal(extractAck(detail).request_id, "ine-ds-alert-1788357218021");
  assert.equal(extractRemoteLogPath(detail), concretePath);
});


function fakeDetail(status = "success") {
  const record = {
    country: "ph",
    projectCode: 15843450427744,
    projectName: "菲律宾数仓-正式环境",
    workflowInstanceId: 2540562,
    workflowDefinitionCode: 15845044707680,
    workflowInstanceName: "菲律宾-数仓工作流（1D）-20260830082501017",
    commandType: "SCHEDULER",
    workflowExecutionStatus: "FAILURE",
    workflowStartTime: "2026-08-30 08:25:01",
  };
  return {
    id: "n8n-1",
    status,
    data: {
      resultData: {
        runData: {
          DS失败告警Webhook: [{ data: { main: [[{ json: { country: "ph", message: JSON.stringify([record]) } }]] } }],
          "菲律宾启动后台重跑": [{ data: { main: [[{ json: { accepted: true, request_id: "req-1", log: "/root/Global-Intelligent-Alarm-Repair-Assistant/auto_repair_records/ds_failed_auto_retry_logs/req-1.log" } }]] } }],
        },
      },
    },
  };
}

test("extracts DS payload from n8n webhook JSON-string message", () => {
  const records = extractDsAutoRetryRecords(fakeDetail());
  assert.equal(records.length, 1);
  assert.equal(String(records[0].workflowInstanceId), "2540562");
  assert.equal(records[0].country, "ph");
});

test("n8n monitor reads executions and ignores the saved project scope", async () => {
  let executionOptions;
  let evidenceCalls = 0;
  const client = {
    async listWorkflows() {
      return { data: [{ id: "wf-1", name: "各国-DS失败自动重跑统一入口", nodes: [] }] };
    },
    async listExecutions(options) {
      executionOptions = options;
      return { data: [{ id: "n8n-1", workflowId: "wf-1", status: "success", startedAt: "2026-08-30T00:25:01.000Z", stoppedAt: "2026-08-30T00:25:03.000Z" }] };
    },
    async getExecution() {
      return fakeDetail();
    },
  };
  const result = await inspectN8nAutoRetryExecutions("/tmp/znzb", {
    now: new Date("2026-08-30T12:00:00Z"),
    countries: ["ph"],
    lookbackDays: 7,
    // A deliberately non-matching scope must not hide the DS record parsed
    // from the n8n execution detail.
    projectScope: { ph: ["another-project"] },
    projectScopeConfigured: true,
    n8nClient: client,
    dsEvidenceResolver: async () => {
      evidenceCalls += 1;
      return {
        taskLookupStatus: "resolved",
        taskInstanceId: "task-instance-1",
        taskName: "dwd_orders",
        taskCode: "task-code-1",
        taskType: "SQL",
        failureReason: "StarRocks 查询连接中断",
        failureMessage: "StarRocks 查询连接中断",
      };
    },
    bypassCache: true,
  });
  assert.equal(result.source, "n8n-auto-trigger-execution-log");
  assert.equal(result.totalExecutions, 1);
  assert.equal(result.totalFailures, 1);
  assert.equal(result.countries[0].failures[0].n8nExecutionId, "n8n-1");
  assert.equal(result.countries[0].failures[0].n8nTriggerStatus, "n8n_accepted");
  assert.equal(result.countries[0].failures[0].repairStatus, "unknown");
  assert.equal(result.countries[0].failures[0].retryResult, "unknown");
  assert.equal(result.countries[0].failures[0].taskName, "dwd_orders");
  assert.equal(result.countries[0].failures[0].failureReason, "StarRocks 查询连接中断");
  assert.equal(evidenceCalls, 1);
  assert.equal(executionOptions.startedAfter, undefined);
  assert.equal(executionOptions.startedBefore, undefined);
});

test("n8n monitor derives the DS repair outcome from execution notification text", async () => {
  const detail = fakeDetail();
  detail.data.resultData.runData["发送恢复通知"] = [{ data: { main: [[{ json: { message: "自动重跑已恢复成功，重跑次数：2" } }]] } }];
  const client = {
    async listWorkflows() { return { data: [{ id: "wf-1", name: "各国-DS失败自动重跑统一入口" }] }; },
    async listExecutions() { return { data: [{ id: "n8n-recovered", workflowId: "wf-1", status: "success", startedAt: "2026-08-30T00:25:01.000Z" }] }; },
    async getExecution() { return detail; },
  };
  const result = await inspectN8nAutoRetryExecutions("/tmp/znzb-recovered-outcome", {
    now: new Date("2026-08-30T12:00:00Z"), countries: ["ph"], n8nClient: client, enrichDsEvidence: false, bypassCache: true,
  });
  const item = result.countries[0].failures[0];
  assert.equal(item.repairStatus, "recovered");
  assert.equal(item.retryResult, "recovered");
});

test("n8n monitor deduplicates DS task evidence queries for repeated executions of one instance", async () => {
  let evidenceCalls = 0;
  const client = {
    async listWorkflows() { return { data: [{ id: "wf-1", name: "各国-DS失败自动重跑统一入口" }] }; },
    async listExecutions() {
      return { data: [
        { id: "n8n-a", workflowId: "wf-1", status: "success", startedAt: "2026-08-30T00:25:01.000Z" },
        { id: "n8n-b", workflowId: "wf-1", status: "success", startedAt: "2026-08-30T00:26:01.000Z" },
      ] };
    },
    async getExecution(id) {
      const detail = fakeDetail();
      detail.id = id;
      detail.data.resultData.lastNodeExecuted = "菲律宾启动后台重跑";
      return detail;
    },
  };
  const result = await inspectN8nAutoRetryExecutions("/tmp/znzb-deduplicated-evidence", {
    now: new Date("2026-08-30T12:00:00Z"),
    countries: ["ph"],
    lookbackDays: 7,
    n8nClient: client,
    dsEvidenceResolver: async () => {
      evidenceCalls += 1;
      return { taskLookupStatus: "resolved", taskName: "dwd_orders", taskCode: "task-1" };
    },
    bypassCache: true,
  });
  // Repeated n8n executions of the same DS instance collapse to a single row
  // showing the most recent execution only.
  assert.equal(result.countries[0].failures.length, 1);
  assert.equal(result.countries[0].failures[0].n8nExecutionId, "n8n-b");
  assert.equal(result.countries[0].failures[0].taskName, "dwd_orders");
  assert.equal(result.countries[0].failures[0].n8nLastNode, "菲律宾启动后台重跑");
  assert.equal(evidenceCalls, 1);
});

test("START_PROCESS is visible as scan-only and never marked as a retry", async () => {
  const client = {
    async listWorkflows() { return { data: [{ id: "wf-1", name: "各国-DS失败自动重跑统一入口" }] }; },
    async listExecutions() { return { data: [{ id: "n8n-2", workflowId: "wf-1", status: "success", startedAt: "2026-08-30T00:25:01.000Z" }] }; },
    async getExecution() {
      const detail = fakeDetail();
      detail.data.resultData.runData.DS失败告警Webhook[0].data.main[0][0].json.message = JSON.stringify([{ country: "ph", projectCode: "p", commandType: "START_PROCESS", workflowExecutionStatus: "FAILURE", workflowInstanceId: "i-2" }]);
      return detail;
    },
  };
  const result = await inspectN8nAutoRetryExecutions("/tmp/znzb-start-process", {
    now: new Date("2026-08-30T12:00:00Z"), countries: ["ph"], lookbackDays: 7,
    projectScope: { ph: ["p"] }, projectScopeConfigured: true, n8nClient: client, bypassCache: true,
  });
  const item = result.countries[0].failures[0];
  assert.equal(item.n8nTriggerStatus, "ignored_start_workflow");
  assert.equal(item.retryResult, "not_triggered");
});

test("START_FAILURE_TASK_PROCESS retry callbacks are excluded from n8n monitor", async () => {
  const client = {
    async listWorkflows() { return { data: [{ id: "wf-1", name: "各国-DS失败自动重跑统一入口" }] }; },
    async listExecutions() { return { data: [{ id: "n8n-retry-callback", workflowId: "wf-1", status: "success", startedAt: "2026-08-30T00:25:01.000Z" }] }; },
    async getExecution() {
      const detail = fakeDetail();
      detail.data.resultData.runData.DS失败告警Webhook[0].data.main[0][0].json.message = JSON.stringify([{
        country: "ph",
        projectCode: "p",
        commandType: "START_FAILURE_TASK_PROCESS",
        workflowExecutionStatus: "FAILURE",
        workflowInstanceId: "retry-instance",
      }]);
      detail.data.resultData.lastNodeExecuted = "整理已忽略告警响应";
      return detail;
    },
  };
  const result = await inspectN8nAutoRetryExecutions("/tmp/znzb-retry-callback", {
    now: new Date("2026-08-30T12:00:00Z"), countries: ["ph"], lookbackDays: 7,
    n8nClient: client, enrichDsEvidence: false, bypassCache: true,
  });
  assert.equal(result.totalFailures, 0);
  assert.equal(result.countries[0].failures.length, 0);
});

test("n8n monitor applies an inclusive explicit date range locally", async () => {
  const client = {
    async listWorkflows() { return { data: [{ id: "wf-1", name: "各国-DS失败自动重跑统一入口" }] }; },
    async listExecutions() {
      return { data: [
        { id: "inside", workflowId: "wf-1", status: "success", startedAt: "2026-09-02T15:59:59.000Z" },
        { id: "outside", workflowId: "wf-1", status: "success", startedAt: "2026-09-03T16:00:00.000Z" },
      ] };
    },
    async getExecution(id) {
      const detail = fakeDetail();
      detail.id = id;
      return detail;
    },
  };
  const result = await inspectN8nAutoRetryExecutions("/tmp/znzb-explicit-date-range", {
    countries: ["ph"],
    startDate: "2026-09-02",
    endDate: "2026-09-03",
    n8nClient: client,
    enrichDsEvidence: false,
    bypassCache: true,
  });
  assert.equal(result.startDate, "2026-09-02");
  assert.equal(result.endDate, "2026-09-03");
  assert.equal(result.lookbackDays, 2);
  assert.equal(result.totalExecutions, 1);
});
