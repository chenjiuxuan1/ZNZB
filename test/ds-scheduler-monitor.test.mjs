import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkAllCountries, loadDsSchedulerConfig, parseProjectNames, resolveDsWebhookUrl, resolveProjectName, saveDsSchedulerConfig } from "../src/ds-scheduler-monitor.mjs";

test("DS project names accept common separators and remove duplicates", () => {
  assert.deepEqual(
    parseProjectNames("数据平台，催收平台; 风控平台\n数据平台"),
    ["数据平台", "催收平台", "风控平台"],
  );
});

test("DS webhook URL defaults to the local n8n gateway when unset", () => {
  assert.equal(resolveDsWebhookUrl(""), "http://127.0.0.1:5678/webhook/ds-scheduler");
  assert.equal(resolveDsWebhookUrl(undefined), "http://127.0.0.1:5678/webhook/ds-scheduler");
  assert.equal(resolveDsWebhookUrl("https://remote.example/ds"), "https://remote.example/ds");
});

test("DS webhook URL honors the DS_SCHEDULER_WEBHOOK_URL env override", () => {
  const previous = process.env.DS_SCHEDULER_WEBHOOK_URL;
  process.env.DS_SCHEDULER_WEBHOOK_URL = "https://env-n8n.example/webhook/ds";
  try {
    assert.equal(resolveDsWebhookUrl(""), "https://env-n8n.example/webhook/ds");
    assert.equal(resolveDsWebhookUrl(undefined), "https://env-n8n.example/webhook/ds");
  } finally {
    if (previous === undefined) {
      delete process.env.DS_SCHEDULER_WEBHOOK_URL;
    } else {
      process.env.DS_SCHEDULER_WEBHOOK_URL = previous;
    }
  }
});

test("DS webhook URL interpolates env placeholders like wattrel", () => {
  const previous = process.env.DS_SCHEDULER_WEBHOOK_URL;
  process.env.DS_SCHEDULER_WEBHOOK_URL = "https://placeholder.example/webhook/ds";
  try {
    assert.equal(resolveDsWebhookUrl("${DS_SCHEDULER_WEBHOOK_URL}"), "https://placeholder.example/webhook/ds");
  } finally {
    if (previous === undefined) {
      delete process.env.DS_SCHEDULER_WEBHOOK_URL;
    } else {
      process.env.DS_SCHEDULER_WEBHOOK_URL = previous;
    }
  }
});

test("loadDsSchedulerConfig returns the local n8n default when no config file exists", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ds-scheduler-default-"));
  const config = await loadDsSchedulerConfig(rootDir);
  assert.equal(config.n8nWebhookUrl, "http://127.0.0.1:5678/webhook/ds-scheduler");
});

test("DS project code can be configured directly without name resolution", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ds-scheduler-"));
  await fs.mkdir(path.join(rootDir, "config"), { recursive: true });

  const saved = await saveDsSchedulerConfig(rootDir, {
    n8nWebhookUrl: "https://gateway.example/ds",
    countries: { ine: { name: "印尼", token: "token" } },
    projectNames: { ine: "data-platform" },
    projectCodes: { ine: "123456" },
    alerts: { channel: "tv", botId: "metabase-bot" },
  });
  const loaded = await loadDsSchedulerConfig(rootDir);

  assert.equal(saved.projectCodes.ine, "123456");
  assert.equal(saved.resolveErrors.length, 0);
  assert.equal(loaded.projectCodes.ine, "123456");
  assert.equal(loaded.alerts.botId, "metabase-bot");
});

test("DS project details preserve multiple explicitly configured projects", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ds-scheduler-multiple-"));
  await fs.mkdir(path.join(rootDir, "config"), { recursive: true });

  const saved = await saveDsSchedulerConfig(rootDir, {
    n8nWebhookUrl: "https://gateway.example/ds",
    countries: { ine: { name: "印尼", token: "token" } },
    projectNames: { ine: "数据平台，催收平台" },
    projects: {
      ine: [
        { name: "数据平台", code: "1001" },
        { name: "催收平台", code: "1002" },
      ],
    },
  });

  assert.deepEqual(saved.projects.ine, [
    { name: "数据平台", code: "1001", error: "" },
    { name: "催收平台", code: "1002", error: "" },
  ]);
  assert.equal(saved.projectCodes.ine, "1001");
});

test("DS checks every configured project and aggregates partial failures", async () => {
  const originalFetch = globalThis.fetch;
  const requestedCodes = [];
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    requestedCodes.push(request.payload.project_code);
    const failed = request.payload.project_code === "1002";
    return {
      async text() {
        return JSON.stringify(failed
          ? { success: false, error: { message: "project unavailable" } }
          : { success: true, data: { total_checked: 3, stuck_count: 1, stale_count: 0, stuck_workflows: [], checked_workflows: [{ workflow_code: "daily_loan", workflow_name: "每日放款" }] } });
      },
    };
  };
  try {
    const result = await checkAllCountries(process.cwd(), {
      n8nWebhookUrl: "https://gateway.example/ds",
      countries: { ine: { name: "印尼", token: "token" } },
      projects: { ine: [{ name: "数据平台", code: "1001" }, { name: "催收平台", code: "1002" }] },
    });

    assert.deepEqual(requestedCodes, ["1001", "1002"]);
    assert.equal(result.countries[0].success, true);
    assert.equal(result.countries[0].partialFailure, true);
    assert.equal(result.countries[0].checkedWorkflows, 3);
    assert.equal(result.countries[0].projects.length, 2);
    assert.deepEqual(result.countries[0].checkedWorkflowDetails, [{ workflowCode: "daily_loan", workflowName: "每日放款" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DS resolveProjectName reports a friendly 403 gateway error instead of raw HTML", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 403,
    ok: false,
    async text() {
      return "<!-- 403 Forbidden --><html><head><title>403 Forbidden</title></head><body>Please confirm you are accessing from the company network</body></html>";
    },
  });
  try {
    const result = await resolveProjectName("https://gateway.example/ds", "cn", "token", "数据平台");
    assert.equal(result.success, false);
    assert.equal(result.error, "n8n 网关拒绝访问，请确认服务器 IP 已加入公司网络白名单");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DS config save records a friendly error when the gateway returns 403", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 403,
    ok: false,
    async text() {
      return "<!-- 403 Forbidden --><html><body>Forbidden</body></html>";
    },
  });
  try {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "ds-scheduler-403-"));
    await fs.mkdir(path.join(rootDir, "config"), { recursive: true });
    const saved = await saveDsSchedulerConfig(rootDir, {
      n8nWebhookUrl: "https://gateway.example/ds",
      countries: { cn: { name: "中国", token: "token" } },
      projectNames: { cn: "数据平台" },
    });
    assert.equal(saved.resolveErrors.length, 1);
    assert.equal(saved.resolveErrors[0].country, "cn");
    assert.equal(saved.resolveErrors[0].error, "n8n 网关拒绝访问，请确认服务器 IP 已加入公司网络白名单");
    assert.ok(!saved.resolveErrors[0].error.includes("invalid JSON"));
    assert.ok(!saved.resolveErrors[0].error.includes("<html"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DS check surfaces a readable error when the gateway returns an object error message", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 200,
    ok: true,
    async text() {
      return JSON.stringify({
        success: false,
        error: { code: "DS_API_ERROR", message: { status: 401, body: { raw: "" }, url: "http://10.20.47.14:12345/dolphinscheduler/projects/123/schedules?pageNo=1&pageSize=200" } },
      });
    },
  });
  try {
    const result = await checkAllCountries(process.cwd(), {
      n8nWebhookUrl: "http://127.0.0.1:5678/webhook/ds-scheduler",
      countries: { cn: { name: "中国", token: "real-token" } },
      projects: { cn: [{ name: "数据平台", code: "123" }] },
    });
    assert.equal(result.countries[0].success, false);
    assert.equal(result.countries[0].projects[0].error, "DS Token 无效或未授权 (HTTP 401)：http://10.20.47.14:12345/dolphinscheduler/projects/123/schedules");
    assert.ok(!result.countries[0].projects[0].error.includes("[object Object]"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DS check only reports ONLINE workflows that missed one full schedule cycle", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 200,
    ok: true,
    async text() {
      return JSON.stringify({
        success: true,
        data: {
          total_checked: 5,
          stuck_count: 0,
          stale_count: 2,
          stuck_workflows: [],
          stale_workflows: [
            { workflow_code: "1001", workflow_name: "online-missed-cycle-wf", schedule_id: 1, schedule_status: "ONLINE", stale_reason: "missed_schedule_cycle", stale_message: "已跨过一个完整调度周期仍未运行", schedule_cycle: "每天 09:00", last_run_at: "2026-07-23T01:00:00.000Z", next_run_at: "2026-07-24T01:00:00.000Z", total_instances_checked: 0 },
            { workflow_code: "1004", workflow_name: "online-legacy-stale-wf", schedule_id: 4, schedule_status: "ONLINE", stale_reason: "no_recent_run", stale_message: "定时任务在线但近期无运行记录", total_instances_checked: 0 },
            { workflow_code: "1002", workflow_name: "offline-wf-a", schedule_id: 2, schedule_status: "OFFLINE", stale_reason: "schedule_offline", stale_message: "定时任务已下线，长时间未运行", total_instances_checked: 0 },
            { workflow_code: "1003", workflow_name: "offline-wf-b", schedule_id: 3, schedule_status: "OFFLINE", stale_reason: "schedule_offline", stale_message: "定时任务已下线，长时间未运行", total_instances_checked: 0 },
          ],
        },
      });
    },
  });
  try {
    const result = await checkAllCountries(process.cwd(), {
      n8nWebhookUrl: "http://127.0.0.1:5678/webhook/ds-scheduler",
      countries: { cn: { name: "中国", token: "real-token" } },
      projects: { cn: [{ name: "数据平台", code: "123" }] },
    });
    const country = result.countries[0];
    assert.equal(country.staleCount, 1, "only online workflows missing a complete schedule cycle count as stale");
    assert.equal(country.staleWorkflows.length, 1);
    assert.equal(country.staleWorkflows[0].workflowName, "online-missed-cycle-wf");
    assert.equal(country.staleWorkflows[0].scheduleCycle, "每天 09:00");
    assert.equal(country.staleWorkflows[0].lastRunAt, "2026-07-23T01:00:00.000Z");
    assert.equal(country.staleWorkflows[0].nextRunAt, "2026-07-24T01:00:00.000Z");
    assert.equal(result.totalStale, 1);
    assert.ok(!country.inactiveWorkflows, "inactiveWorkflows should not exist");
    assert.ok(!result.totalInactive, "totalInactive should not exist");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DS check reports only online scheduled workflows whose current-day execution failed", async () => {
  const originalFetch = globalThis.fetch;
  let requestPayload;
  globalThis.fetch = async (_url, options) => {
    requestPayload = JSON.parse(options.body).payload;
    return {
      status: 200,
      ok: true,
      async text() {
        return JSON.stringify({
          success: true,
          data: {
            total_checked: 4,
            stuck_count: 0,
            stale_count: 0,
            stuck_workflows: [],
            stale_workflows: [],
            failed_workflows: [
              { workflow_code: "1001", workflow_name: "daily-loan", schedule_status: "ONLINE", failure_reason: "scheduled_instance_failed", has_later_success: false, failure_message: "今天 09:00 调度实例执行失败", instance_id: "9988", instance_state: "FAILURE", start_time: "2026-07-27T09:00:02.000Z", end_time: "2026-07-27T09:03:10.000Z" },
              { workflow_code: "1004", workflow_name: "recovered-daily-loan", schedule_status: "ONLINE", failure_reason: "scheduled_instance_failed", has_later_success: true, failure_message: "今天 09:00 曾失败，之后重跑成功", instance_id: "9989", instance_state: "FAILURE" },
              { workflow_code: "1002", workflow_name: "offline-failed", schedule_status: "OFFLINE", failure_reason: "scheduled_instance_failed" },
              { workflow_code: "1003", workflow_name: "legacy-failed", schedule_status: "ONLINE", failure_reason: "historical_failure" },
            ],
          },
        });
      },
    };
  };
  try {
    const result = await checkAllCountries(process.cwd(), {
      n8nWebhookUrl: "http://127.0.0.1:5678/webhook/ds-scheduler",
      countries: { th: { name: "泰国", token: "real-token" } },
      projects: { th: [{ name: "泰国数仓", code: "123" }] },
    });
    const country = result.countries[0];
    assert.equal(requestPayload.failure_policy, "scheduled_today_final_failure");
    assert.equal(requestPayload.include_failed_workflows, true);
    assert.equal(country.failedCount, 1);
    assert.equal(country.failedWorkflows[0].workflowName, "daily-loan");
    assert.equal(country.failedWorkflows[0].instanceState, "FAILURE");
    assert.doesNotMatch(JSON.stringify(country.failedWorkflows), /recovered-daily-loan/);
    assert.equal(result.totalFailed, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DS check recognizes raw DolphinScheduler scheduled failure instances from legacy gateways", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 200,
    ok: true,
    async text() {
      return JSON.stringify({
        success: true,
        data: {
          total_checked: 44,
          records: [{
            projectCode: "13068695921632",
            projectName: "墨西哥数仓-工作流",
            workflowInstanceId: "3018647",
            workflowDefinitionCode: "20048471875198",
            workflowInstanceName: "墨西哥-数仓工作流 (1/2H)-NEW-20260727190300033",
            commandType: "SCHEDULER",
            workflowExecutionStatus: "FAILURE",
            recovery: "NO",
            workflowStartTime: "2026-07-27 19:03:00",
            workflowEndTime: "2026-07-27 19:21:34",
          }],
        },
      });
    },
  });
  try {
    const result = await checkAllCountries(process.cwd(), {
      n8nWebhookUrl: "http://127.0.0.1:5678/webhook/ds-scheduler",
      countries: { mx: { name: "墨西哥", token: "real-token" } },
      projects: { mx: [{ name: "墨西哥数仓-工作流", code: "13068695921632" }] },
    });
    const country = result.countries[0];
    assert.equal(country.failedCount, 1);
    assert.equal(country.failedWorkflows[0].workflowName, "墨西哥-数仓工作流 (1/2H)-NEW-20260727190300033");
    assert.equal(country.failedWorkflows[0].instanceState, "FAILURE");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DS check retries one transient n8n timeout before marking a project failed", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      const error = new Error("request aborted");
      error.name = "AbortError";
      throw error;
    }
    return {
      status: 200,
      ok: true,
      async text() {
        return JSON.stringify({ success: true, data: { total_checked: 17, stuck_count: 0, stale_count: 0, failed_workflows: [] } });
      },
    };
  };
  try {
    const result = await checkAllCountries(process.cwd(), {
      n8nWebhookUrl: "http://127.0.0.1:5678/webhook/ds-scheduler",
      checkRetries: 1,
      checkRetryDelayMs: 0,
      countries: { pk: { name: "巴基斯坦", token: "real-token" } },
      projects: { pk: [{ name: "巴基斯坦数仓-工作流_new", code: "123" }] },
    });
    assert.equal(calls, 2);
    assert.equal(result.countries[0].success, true);
    assert.equal(result.countries[0].checkedWorkflows, 17);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
