import test from "node:test";
import assert from "node:assert/strict";
import { extractDsAutoRetryRecords, inspectN8nAutoRetryExecutions } from "../src/ds-n8n-auto-retry-monitor.mjs";

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
    bypassCache: true,
  });
  assert.equal(result.source, "n8n-auto-trigger-execution-log");
  assert.equal(result.totalExecutions, 1);
  assert.equal(result.totalFailures, 1);
  assert.equal(result.countries[0].failures[0].n8nExecutionId, "n8n-1");
  assert.equal(result.countries[0].failures[0].n8nTriggerStatus, "n8n_accepted");
  assert.equal(executionOptions.startedAfter, undefined);
  assert.equal(executionOptions.startedBefore, undefined);
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
