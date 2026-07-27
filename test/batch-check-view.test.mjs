import test from "node:test";
import assert from "node:assert/strict";

globalThis.window = { location: { hash: "" } };
const {
  buildBatchScheduleCountryConfig,
  parseAnomalyMessage,
  renderBatchCheck,
  renderHistoryDsDetails,
  renderHistoryWattrelDetails,
} = await import("../web/src/views/batch-check.js");
const { state } = await import("../web/src/state.js");

test("buildBatchScheduleCountryConfig keeps KN Chat personal recipients and group chat together", () => {
  const fields = {
    ".schedule-country-notify-channel": { value: "knBot" },
    ".schedule-country-enabled": { checked: true },
    ".schedule-country-dashboard-uuid": { value: "dashboard-ph" },
    ".schedule-country-chat-id": { value: "-100239001" },
    ".schedule-country-recipient-emails": { value: "owner@kn.group" },
  };
  const row = {
    dataset: { countryCode: "PH" },
    querySelector(selector) {
      return fields[selector] || null;
    },
  };

  const config = buildBatchScheduleCountryConfig(row, {
    webhookUrl: "https://tv.example/alert",
    botId: "tv-bot",
  });

  assert.equal(config.countryCode, "PH");
  assert.equal(config.chatId, "-100239001");
  assert.equal(config.recipientEmails, "owner@kn.group");
  assert.equal(config.botToken, "${KN_BOT_TOKEN}");
});

test("history details show Wattrel table values and DS project workflow scan details", () => {
  const wattrelHtml = renderHistoryWattrelDetails({
    total: 1,
    countries: [{
      countryCode: "TH",
      countryName: "泰国",
      count: 1,
      status: "success",
      anomalies: [{
        name: "放款计划校验",
        srcTbl: "ods_cash_apply_grant_plan",
        destTbl: "ods_cash_apply_grant_plan_cnt",
        expectedValue: 2781,
        actualValue: 0,
        diff: 2781,
      }],
    }],
  });
  const dsHtml = renderHistoryDsDetails({
    totalChecked: 2,
    totalCountries: 1,
    countries: [{
      country: "th",
      countryName: "泰国",
      checkedWorkflows: 2,
      stuckCount: 1,
      staleCount: 0,
      failedCount: 1,
      projects: [{ projectName: "泰国数仓", projectCode: "1001", checkedWorkflows: 2, success: true, checkedWorkflowDetails: [{ workflowName: "每日注册", workflowCode: "register_daily" }] }],
      stuckWorkflows: [{ workflowName: "每日放款", workflowCode: "loan_daily", consecutiveFailures: 3 }],
      failedWorkflows: [{ workflowName: "每日还款", workflowCode: "repay_daily", failureMessage: "今天 09:00 调度实例执行失败" }],
    }],
  });

  assert.match(wattrelHtml, /ods_cash_apply_grant_plan_cnt/);
  assert.match(wattrelHtml, /期望值/);
  assert.match(wattrelHtml, /2,781/);
  assert.match(dsHtml, /泰国数仓/);
  assert.doesNotMatch(dsHtml, /1001/);
  assert.match(dsHtml, /每日放款/);
  assert.match(dsHtml, /每日注册/);
  assert.match(dsHtml, /<summary>查看 1 个已扫描工作流<\/summary>/);
  assert.match(dsHtml, /连续失败 3 次/);
  assert.match(dsHtml, /执行失败：每日还款/);
});

test("history anomaly details parse latest non-zero to zero values", () => {
  const detail = parseAnomalyMessage(
    "指标「通过~放款」从 0.1038206 降为 0（统计日期 2026-07-27 对比 2026-07-26）",
    "latestNonZeroToZero",
  );

  assert.equal(detail.reason, "指标波动超阈值");
  assert.equal(detail.baselineValue, "0.1038206");
  assert.equal(detail.currentValue, "0");
  assert.equal(detail.timeText, "2026-07-27 / 对比 2026-07-26");
});

test("history anomaly detail exposes an AI analysis action", () => {
  const root = { innerHTML: "", querySelectorAll: () => [], querySelector: () => null };
  state.routeQuery = { historyRunId: "run-ai" };
  state.batchHistory = { runs: [{
    id: "run-ai", startedAt: "2026-07-27T00:00:00.000Z", successCount: 1, countryCount: 1,
    checkedCardCount: 1, anomalyCount: 1, dataQualityAnomalyCount: 0,
    runs: [{ countryCode: "PH", countryName: "菲律宾", ok: true, result: { checkedCardCount: 1, dashboardCount: 1, anomalyCount: 1, anomalies: [{ dashboardTitle: "OKR", cardTitle: "转化", type: "latestNonZeroToZero", message: "指标从 10 降为 0" }] } }],
  }] };
  renderBatchCheck(root);
  assert.match(root.innerHTML, /AI 分析原因/);
  assert.match(root.innerHTML, /data-run-id="run-ai"/);
});
