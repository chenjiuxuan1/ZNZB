import test from "node:test";
import assert from "node:assert/strict";

globalThis.window = { location: { hash: "" } };
const {
  buildBatchScheduleCountryConfig,
  buildDashboardFluctuationRoute,
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
  assert.match(root.innerHTML, /正在读取 AI 结论|AI 分析原因/);
  assert.match(root.innerHTML, /data-run-id="run-ai"/);
  assert.match(renderMetabaseAnomalyAnalysis({
    runId: "run-ai", countryCode: "PH", anomalyIndex: 0,
    analysis: { summary: "已完成", confidence: "low", limitations: "测试" },
  }), /重新 AI 分析/);
});

test("scheduled run progress renders compact five-stage status and keeps country details collapsible", () => {
  const root = { innerHTML: "", querySelectorAll: () => [], querySelector: () => null };
  state.routeQuery = {};
  state.batchCheckTab = "schedule";
  state.batchSchedule = { enabled: true, countryConfigs: [], includeDsScheduler: true };
  state.batchScheduleProgress = {
    status: "ai_analyzing", totalCountries: 1, completedCountries: 1, countries: [{ countryCode: "PH", countryName: "菲律宾", status: "success", checkedCardCount: 2, anomalyCount: 1 }],
    stages: [
      { key: "country_scan", label: "国家巡检", status: "success", detail: "已完成 1/1 个国家巡检" },
      { key: "data_check", label: "DS 调度核查", status: "success", detail: "DS 调度核查完成" },
      { key: "notification", label: "告警通知", status: "success", detail: "已发送 1 条通知" },
      { key: "ai_analysis", label: "AI 取证队列", status: "queued", detail: "已提交 1/1 个异常看板" },
      { key: "finished", label: "巡检完成", status: "success", detail: "巡检和通知已完成" },
    ],
  };
  renderBatchCheck(root);
  assert.match(root.innerHTML, /AI 取证队列/);
  assert.match(root.innerHTML, /查看国家巡检明细/);
  assert.match(root.innerHTML, /已提交 1\/1 个异常看板/);
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
  }, [{ code: "MX", name: "Mexico" }], { today: "2026-07-28" });

  assert.equal(model.countryCount, 1);
  assert.equal(model.anomalyCount, 1);
  assert.equal(model.countries[0].countryCode, "MX");
  assert.equal(model.countries[0].anomalies[0].metricLabel, "D7 · APP=MEX023");
});

test("fluctuation visual does not synthesize fake history when points are absent", () => {
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

  const chart = fluctuationVisualTest.buildChart(anomaly);
  assert.deepEqual(chart.points, []);
});

test("fluctuation visual prefers a point with saved real series", () => {
  const anomalies = [{
    dashboardTitle: "Overdue",
    cardTitle: "D1",
    type: "completeDayChange",
    message: "完整日指标「D1」从 10 到 30，变化 +200%",
  }, {
    dashboardTitle: "Overdue",
    cardTitle: "D7",
    type: "completeDayChange",
    message: "完整日指标「D7」从 10 到 30，变化 +200%",
    series: [
      { date: "2026-07-11", value: 10 },
      { date: "2026-07-12", value: 30, anomaly: true },
    ],
  }];

  assert.equal(fluctuationVisualTest.chooseDisplayAnomalyIndex(anomalies, 0), 1);
  assert.equal(fluctuationVisualTest.chooseDisplayAnomalyIndex(anomalies, 1), 1);
});

test("fluctuation visual keeps the manually selected point", () => {
  state.fluctuationVisualSelected = { MX: 0 };
  const country = {
    countryCode: "MX",
    anomalies: [{
      dashboardTitle: "Overdue",
      cardTitle: "D1",
      type: "completeDayChange",
      message: "完整日指标「D1」从 10 到 30，变化 +200%",
    }, {
      dashboardTitle: "Overdue",
      cardTitle: "D7",
      type: "completeDayChange",
      message: "完整日指标「D7」从 10 到 30，变化 +200%",
      series: [{ date: "2026-07-12", value: 30, anomaly: true }],
    }],
  };

  assert.equal(fluctuationVisualTest.getDisplayAnomalyIndex(country), 0);
});

test("fluctuation visual limits concurrent dashboard history queries", async () => {
  let active = 0;
  let peak = 0;
  const completed = [];

  await fluctuationVisualTest.runWithConcurrency([1, 2, 3, 4, 5], 3, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    completed.push(value);
    active -= 1;
  });

  assert.equal(peak, 3);
  assert.deepEqual(completed.sort((left, right) => left - right), [1, 2, 3, 4, 5]);
});

test("fluctuation visual chart accepts hydrated series", () => {
  const chart = fluctuationVisualTest.buildChart({
    metricLabel: "注册数",
    message: "完整日指标「注册数」从 100 到 200",
    hydratedSeries: [
      { date: "2026-07-01", value: 100, baselineValue: 90, baselineSampleCount: 14 },
      { date: "2026-07-02", value: 200, baselineValue: 110, baselineSampleCount: 14, anomaly: true },
    ],
  });

  assert.deepEqual(chart.points.map((point) => [point.label, point.value, point.baselineValue, point.baselineSampleCount, point.anomaly]), [
    ["2026-07-01", 100, 90, 14, false],
    ["2026-07-02", 200, 110, 14, true],
  ]);
});

test("fluctuation visual formats daily and hourly point comparison percentages", () => {
  assert.equal(fluctuationVisualTest.formatComparisonPercent(120, 100), "+20%");
  assert.equal(fluctuationVisualTest.formatComparisonPercent(75, 100), "-25%");
  assert.equal(fluctuationVisualTest.formatComparisonPercent(0, 0), "0.0%");
  assert.match(fluctuationVisualTest.formatComparisonPercent(12, 0), /基准为 0/);
});

test("history anomaly dashboard link keeps the run, country, and dashboard filter", () => {
  const route = buildDashboardFluctuationRoute({
    runId: "run-7",
    countryCode: "MX",
    dashboardUrl: "https://data.example/dashboard/42?app=MEX023",
    dashboardTitle: "转化漏斗",
  });
  const [, queryString] = route.split("?");
  const query = new URLSearchParams(queryString);
  assert.equal(route.startsWith("/fluctuation-visual?"), true);
  assert.equal(query.get("runId"), "run-7");
  assert.equal(query.get("countryCode"), "MX");
  assert.equal(query.get("dashboardUrl"), "https://data.example/dashboard/42?app=MEX023");
  assert.equal(query.get("dashboardTitle"), "转化漏斗");
});

test("fluctuation visual prefers refreshed hourly data and keeps all 24 hours", () => {
  const savedSeries = [
    { date: "2026-08-02", value: 6650.72 },
    { date: "2026-08-03", value: 0, anomaly: true },
  ];
  const hydratedSeries = Array.from({ length: 24 }, (_, hour) => ({
    date: "2026-08-03",
    label: `${String(hour).padStart(2, "0")}:00`,
    value: hour + 1,
    baselineValue: hour + 2,
    xType: "hour",
    anomaly: hour === 2,
  }));

  const points = fluctuationVisualTest.normalizeSeries({
    series: savedSeries,
    hydratedSeries,
  });

  assert.equal(points.length, 24);
  assert.equal(points[0].label, "00:00");
  assert.equal(points.at(-1).label, "23:00");
  assert.equal(points[2].anomaly, true);
  assert.equal(points[2].baselineValue, 4);
  assert.equal(points.every((point) => point.xType === "hour"), true);
});

test("fluctuation visual does not format count metrics as percent because change text has percent", () => {
  const chart = fluctuationVisualTest.buildChart({
    metricLabel: "注册数",
    message: "完整日指标「注册数」从 100 到 200，波动 +100.0%",
    hydratedSeries: [
      { date: "2026-07-01", value: 100 },
      { date: "2026-07-02", value: 200, anomaly: true },
    ],
  });

  assert.equal(chart.percent, false);
});

test("fluctuation visual does not format count metrics as percent because card title has conversion", () => {
  const chart = fluctuationVisualTest.buildChart({
    metricLabel: "正审通过 · APP=MEX023",
    cardTitle: "分app规模&转化",
    message: "完整日指标「正审通过」从 4 到 0，波动 -100.0%",
    hydratedSeries: [
      { date: "2026-07-01", value: 150 },
      { date: "2026-07-02", value: 0, anomaly: true },
    ],
  });

  assert.equal(chart.percent, false);
});

test("fluctuation visual formats rate metrics as percent", () => {
  const chart = fluctuationVisualTest.buildChart({
    metricLabel: "D7逾期率",
    message: "完整日指标「D7逾期率」从 10.0% 到 20.0%",
    hydratedSeries: [
      { date: "2026-07-01", value: 10 },
      { date: "2026-07-02", value: 20, anomaly: true },
    ],
  });

  assert.equal(chart.percent, true);
});

test("fluctuation visual displays decimal rate values as percentage points", () => {
  const chart = fluctuationVisualTest.buildChart({
    metricLabel: "D7逾期率",
    hydratedSeries: [
      { date: "2026-07-01", value: 0.145 },
      { date: "2026-07-02", value: 0.286, anomaly: true },
    ],
  });

  const scale = fluctuationVisualTest.resolvePercentDisplayScale(chart);
  assert.equal(scale, 100);
  assert.equal(fluctuationVisualTest.formatChartValue(0.286, chart.percent, scale), "28.6%");
});

test("fluctuation visual keeps already-percent rate values unchanged", () => {
  const chart = fluctuationVisualTest.buildChart({
    metricLabel: "D7逾期率",
    hydratedSeries: [
      { date: "2026-07-01", value: 14.5 },
      { date: "2026-07-02", value: 28.6, anomaly: true },
    ],
  });

  const scale = fluctuationVisualTest.resolvePercentDisplayScale(chart);
  assert.equal(scale, 1);
  assert.equal(fluctuationVisualTest.formatChartValue(28.6, chart.percent, scale), "28.6%");
});

test("fluctuation visual keeps small decimal axis labels distinct", () => {
  assert.equal(fluctuationVisualTest.formatChartValue(0.062, false, 1), "0.062");
  assert.equal(fluctuationVisualTest.formatChartValue(0.125, false, 1), "0.13");
  assert.equal(fluctuationVisualTest.formatChartValue(12.34, false, 1), "12.3");
});

test("fluctuation visual does not use pure numeric fallback as metric name", () => {
  const model = fluctuationVisualTest.buildFluctuationVisualModel({
    runs: [{
      id: "numeric-title-run",
      startedAt: "2026-07-28T01:00:00.000Z",
      runs: [{
        countryCode: "PK",
        result: {
          anomalies: [{
            dashboardTitle: "每小时监控",
            cardTitle: "10",
            type: "latestNonZeroToZero",
            message: "指标从 192 降为 0（统计日期 2026-07-29 对比 2026-07-28）",
          }],
        },
      }],
    }],
  }, [], { today: "2026-07-28" });

  assert.equal(model.countries[0].anomalies[0].metricLabel, "每小时监控");
});

test("fluctuation visual only uses runs updated today", () => {
  const model = fluctuationVisualTest.buildFluctuationVisualModel({
    runs: [{
      id: "old-run",
      startedAt: "2026-07-27T01:00:00.000Z",
      runs: [{
        countryCode: "MX",
        result: {
          anomalies: [{
            dashboardTitle: "Old",
            cardTitle: "Old",
            type: "completeDayChange",
            message: "完整日指标「D1」从 10 到 30，变化 +200%（统计日期 2026-07-27 对比 2026-07-26）",
          }],
        },
      }],
    }, {
      id: "today-run",
      startedAt: "2026-07-28T01:00:00.000Z",
      runs: [{
        countryCode: "MX",
        result: {
          anomalies: [{
            dashboardTitle: "Today",
            cardTitle: "Today",
            type: "completeDayChange",
            message: "完整日指标「D7」从 14.7% 到 26.7%，绝对变化 +12.0个百分点（统计日期 2026-07-13 对比 2026-07-12）",
          }],
        },
      }],
    }],
  }, [], { today: "2026-07-28" });

  assert.equal(model.run.id, "today-run");
  assert.equal(model.anomalyCount, 1);
  assert.equal(model.countries[0].anomalies[0].dashboardTitle, "Today");
});

test("fluctuation visual excludes China empty and zero-style anomalies", () => {
  const model = fluctuationVisualTest.buildFluctuationVisualModel({
    runs: [{
      id: "cn-run",
      startedAt: "2026-07-28T01:00:00.000Z",
      runs: [{
        countryCode: "CN",
        result: {
          anomalies: [{
            dashboardTitle: "CN zero",
            cardTitle: "CN zero",
            type: "latestNonZeroToZero",
            message: "指标「注册数」从 100 降为 0（统计日期 2026-07-28 对比 2026-07-27）",
          }, {
            dashboardTitle: "CN empty",
            cardTitle: "CN empty",
            type: "noData",
            message: "没有数据",
          }, {
            dashboardTitle: "CN missing date",
            cardTitle: "CN missing date",
            type: "requiredDatePresent",
            message: "数据缺失：统计日期缺少 2026-07-28",
          }],
        },
      }, {
        countryCode: "MX",
        result: {
          anomalies: [{
            dashboardTitle: "MX zero",
            cardTitle: "MX zero",
            type: "latestNonZeroToZero",
            message: "指标「注册数」从 100 降为 0（统计日期 2026-07-28 对比 2026-07-27）",
          }, {
            dashboardTitle: "MX missing date",
            cardTitle: "MX missing date",
            type: "requiredDatePresent",
            message: "数据缺失：统计日期缺少 2026-07-28",
          }],
        },
      }],
    }],
  }, [], { today: "2026-07-28" });

  assert.equal(model.countryCount, 1);
  assert.equal(model.countries[0].countryCode, "MX");
  assert.equal(model.anomalyCount, 1);
});
