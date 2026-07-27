import test from "node:test";
import assert from "node:assert/strict";

globalThis.window = { location: { hash: "" } };
const {
  buildBatchScheduleCountryConfig,
  renderHistoryDsDetails,
  renderHistoryWattrelDetails,
} = await import("../web/src/views/batch-check.js");

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
      projects: [{ projectName: "泰国数仓", projectCode: "1001", checkedWorkflows: 2, success: true }],
      stuckWorkflows: [{ workflowName: "每日放款", workflowCode: "loan_daily", consecutiveFailures: 3 }],
    }],
  });

  assert.match(wattrelHtml, /ods_cash_apply_grant_plan_cnt/);
  assert.match(wattrelHtml, /期望值/);
  assert.match(wattrelHtml, /2,781/);
  assert.match(dsHtml, /泰国数仓/);
  assert.match(dsHtml, /每日放款/);
  assert.match(dsHtml, /连续失败 3 次/);
});
