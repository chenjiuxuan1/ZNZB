import test from "node:test";
import assert from "node:assert/strict";
import { extractDsAutoRetryRecords, inspectN8nAutoRetryExecutions, loadAutoRepairLogConfig, parseRetryLogOutcome } from "../src/ds-n8n-auto-retry-monitor.mjs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

test("loadAutoRepairLogConfig resolves a per-country SSH host with a fallback default", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "n8n-auto-repair-log-"));
  try {
    await mkdir(path.join(rootDir, "config"), { recursive: true });
    await writeFile(path.join(rootDir, "config/alerts.config.json"), JSON.stringify({
      n8n: {
        baseUrl: "${N8N_BASE_URL}",
        apiKey: "${N8N_API_KEY}",
        autoRepairLog: {
          enabled: true,
          countries: {
            cn: { host: "10.20.47.14", port: 36000, user: "root" },
            ine: { host: "192.168.21.236", port: 36000, user: "root" },
            ph: { host: "10.20.10.12", port: 22, user: "root" },
            th: { host: "192.168.20.236", port: 36000, user: "root" },
            pk: { host: "10.20.84.176", port: 22, user: "root" },
            mx: { host: "172.20.220.165", port: 36000, user: "root" },
          },
        },
      },
    }));
    const cfg = await loadAutoRepairLogConfig(rootDir);
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.countries.cn.host, "10.20.47.14");
    assert.equal(cfg.countries.ine.port, 36000);
    assert.equal(cfg.countries.ph.port, 22);
    assert.equal(cfg.countries.mx.host, "172.20.220.165");
    // Unconfigured country falls back to the (empty) default host.
    assert.equal(cfg.countries["th"].host, "192.168.20.236");
    assert.equal(cfg.defaultSsh.host, "");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
