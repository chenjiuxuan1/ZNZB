import test from "node:test";
import assert from "node:assert/strict";

globalThis.window = { location: { hash: "" } };
const {
  buildBatchScheduleCountryConfig,
  parseAnomalyMessage,
  renderBatchCheck,
  renderMetabaseAnomalyAnalysis,
  renderHistoryDsDetails,
  renderHistoryWattrelDetails,
} = await import("../web/src/views/batch-check.js");
const { __test__: fluctuationVisualTest } = await import("../web/src/views/fluctuation-visual.js");
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

test("history anomaly details keep the concrete metric name for fluctuation alerts", () => {
  const detail = parseAnomalyMessage(
    "完整日指标「D7」从 24.7% 到 51.7%，绝对变化 +26.9个百分点（统计日期 2026-07-13 对比 2026-07-12，APP=MEX023）",
    "completeDayChange",
  );

  assert.equal(detail.reason, "指标波动超阈值");
  assert.equal(detail.metricName, "D7");
  assert.equal(detail.dimensionText, "APP=MEX023");
  assert.equal(detail.baselineValue, "24.7%");
  assert.equal(detail.currentValue, "51.7%");
  assert.equal(detail.changeValue, "+26.9");
  assert.equal(detail.timeText, "2026-07-13 / 对比 2026-07-12");
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
  assert.match(renderMetabaseAnomalyAnalysis({
    runId: "run-ai", countryCode: "PH", anomalyIndex: 0,
    analysis: { summary: "已完成", confidence: "low", limitations: "测试" },
  }), /重新 AI 分析/);
});
test("fluctuation visual model groups fluctuation anomalies by country", () => {
  const model = fluctuationVisualTest.buildFluctuationVisualModel({
    runs: [{
      id: "run-fluctuation",
      startedAt: "2026-07-28T00:00:00.000Z",
      runs: [{
        countryCode: "MX",
        countryName: "Mexico",
        result: {
          anomalies: [{
            dashboardTitle: "Overdue",
            cardTitle: "D7 overdue rate",
            type: "completeDayChange",
            message: "完整日指标「D7」从 14.7% 到 26.7%，绝对变化 +12.0个百分点（统计日期 2026-07-13 对比 2026-07-12，APP=MEX023）",
          }, {
            dashboardTitle: "Empty table",
            cardTitle: "Empty table",
            type: "noData",
            message: "没有数据",
          }],
        },
      }],
    }],
  }, [{ code: "MX", name: "Mexico" }]);

  assert.equal(model.countryCount, 1);
  assert.equal(model.anomalyCount, 1);
  assert.equal(model.countries[0].countryCode, "MX");
  assert.equal(model.countries[0].anomalies[0].metricLabel, "D7 · APP=MEX023");
});

test("fluctuation visual synthesizes a reference series when history points are absent", () => {
  const [anomaly] = fluctuationVisualTest.collectFluctuationAnomalies({
    runs: [{
      countryCode: "MX",
      result: {
        anomalies: [{
          dashboardTitle: "Overdue",
          cardTitle: "D7",
          type: "completeDayChange",
          message: "完整日指标「D7」从 14.7% 到 26.7%，绝对变化 +12.0个百分点（统计日期 2026-07-13 对比 2026-07-12）",
        }],
      },
    }],
  });

  const points = fluctuationVisualTest.synthesizeSeries(anomaly);
  assert.equal(points.length, 13);
  assert.equal(points[0].value, 14.7);
  assert.equal(points.at(-1).value, 26.7);
  assert.equal(points.at(-1).anomaly, true);
});
