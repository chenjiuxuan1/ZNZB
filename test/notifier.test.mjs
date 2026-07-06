import test from "node:test";
import assert from "node:assert/strict";
import { buildPublicCheckMessage, buildWebhookPayload } from "../src/notifier.mjs";

test("buildWebhookPayload supports TV alert payload", () => {
  const payload = buildWebhookPayload(
    "tv",
    "测试消息",
    {
      title: "巡检测试",
      severity: "info",
      timestamp: "2026-06-08T09:30:00.000Z",
      anomalyCount: 0,
      checkedCardCount: 56,
    },
    {
      botId: "bot-001",
      textField: "message",
    },
  );

  assert.deepEqual(payload, {
    botId: "bot-001",
    message: "测试消息",
  });
});

test("buildPublicCheckMessage includes dashboard, context, card and exact message", () => {
  const message = buildPublicCheckMessage(
    {
      checkedAt: "2026-06-08T09:27:32.019Z",
      checkedCardCount: 56,
      anomalyCount: 1,
      anomalies: [
        {
          countryCode: "PK",
          countryName: "巴基斯坦",
          dashboardTitle: "每期逾期率by日期",
          context: "统计口径=到期日期",
          cardTitle: "每期逾期率-表",
          message: "完整日指标「入催率」从 23.8% 到 33.0%，绝对变化 +9.2个百分点（统计日期 2026-06-01 对比 2026-05-31）",
          dashboardUrl: "https://data.kuainiu.io/public/dashboard/example",
        },
      ],
    },
    { maxAnomalies: 50 },
  );

  assert.match(message, /📣【公共报表巡检汇总】/);
  assert.match(message, /• 检查范围：56张卡片/);
  assert.match(message, /• 异常数量：1条/);
  assert.match(message, /• 巴基斯坦\(PK\)：共1条，缺失0条，波动1条/);
  assert.match(message, /🚨【巴基斯坦\(PK\) 公共报表巡检异常】/);
  assert.match(message, /① 统计口径=到期日期 \/ 每期逾期率-表（1条）/);
  assert.match(message, /最大波动：\+9\.2个百分点/);
  assert.match(message, /23\.8% → 33\.0%/);
});

test("buildPublicCheckMessage separates missing data and fluctuations", () => {
  const message = buildPublicCheckMessage(
    {
      checkedAt: "2026-06-09T07:42:40.806Z",
      checkedCardCount: 57,
      anomalyCount: 3,
      anomalies: [
        {
          type: "requiredDatePresent",
          countryCode: "PH",
          countryName: "菲律宾",
          dashboardTitle: "OKR",
          cardTitle: "进件规模",
          message: "数据新鲜度异常：统计日期 缺少 D0 2026-06-09 的数据，当前最新日期是 2026-06-08",
        },
        {
          type: "intradayTimePointCompleteness",
          countryCode: "PK",
          countryName: "巴基斯坦",
          dashboardTitle: "核心链路准实时监控",
          cardTitle: "新客-注册次数",
          message: "半小时点数据缺失：日期 2026-06-10 缺少 00:30",
        },
        {
          type: "completeDayChange",
          countryCode: "ID",
          countryName: "印尼",
          dashboardTitle: "每期逾期率by日期",
          cardTitle: "每期逾期率",
          message: "完整日指标「入催率」从 22.3% 到 33.3%，绝对变化 +10.9个百分点（统计日期 2026-05-24 对比 2026-05-23）",
          dashboardUrl: "https://data.kuainiu.io/public/dashboard/example-id",
        },
      ],
    },
    { maxAnomalies: 50 },
  );

  assert.match(message, /• 数据缺失：2条/);
  assert.match(message, /• 数据波动：1条/);
  assert.match(message, /• 菲律宾\(PH\)：共1条，缺失1条，波动0条/);
  assert.match(message, /• 巴基斯坦\(PK\)：共1条，缺失1条，波动0条/);
  assert.match(message, /• 印尼\(ID\)：共1条，缺失0条，波动1条/);
  assert.match(message, /🚨【菲律宾\(PH\) 公共报表巡检异常】/);
  assert.match(message, /🔴 数据缺失异常（1条）/);
  assert.match(message, /缺少 D0 2026-06-09/);
  assert.match(message, /半小时点数据缺失/);
  assert.match(message, /🚨【印尼\(ID\) 公共报表巡检异常】/);
  assert.match(message, /🟡 数据波动异常（1条）/);
  assert.doesNotMatch(message, /<details>|<summary>|<\/details>/);
  assert.match(message, /最大波动：\+10\.9个百分点/);
  assert.match(message, /22\.3% → 33\.3%/);
  assert.match(message, /https:\/\/data\.kuainiu\.io\/public\/dashboard\/example-id/);
});

test("buildPublicCheckMessage shows zero missing data explicitly", () => {
  const message = buildPublicCheckMessage({
    checkedAt: "2026-06-09T07:42:40.806Z",
    checkedCardCount: 57,
    anomalyCount: 1,
    anomalies: [
      {
        type: "completeDayChange",
        countryCode: "ID",
        countryName: "印尼",
        dashboardTitle: "每期逾期率by日期",
        cardTitle: "每期逾期率",
        message: "完整日指标「入催率」从 22.3% 到 33.3%，绝对变化 +10.9个百分点（统计日期 2026-05-24 对比 2026-05-23）",
      },
    ],
  });

  assert.match(message, /🔴 数据缺失异常（0条）\n暂无异常/);
  assert.match(message, /🟡 数据波动异常（1条）/);
});

test("buildPublicCheckMessage includes data quality current anomaly counts", () => {
  const message = buildPublicCheckMessage({
    checkedAt: "2026-06-09T07:42:40.806Z",
    checkedCardCount: 57,
    anomalyCount: 1,
    dataQuality: {
      countries: [
        {
          countryCode: "ID",
          countryName: "印尼",
          status: "ok",
          currentAnomalyCount: 3,
        },
        {
          countryCode: "PH",
          countryName: "菲律宾",
          status: "error",
          error: "401 Unauthorized",
        },
      ],
    },
    anomalies: [
      {
        type: "completeDayChange",
        countryCode: "ID",
        countryName: "印尼",
        dashboardTitle: "每期逾期率by日期",
        cardTitle: "每期逾期率",
        message: "完整日指标「入催率」从 22.3% 到 33.3%，绝对变化 +10.9个百分点（统计日期 2026-05-24 对比 2026-05-23）",
      },
    ],
  });

  assert.match(message, /🧪 数据质量当前异常/);
  assert.match(message, /• 印尼\(ID\)：3条/);
  assert.match(message, /• 菲律宾\(PH\)：获取失败（401 Unauthorized）/);
  assert.match(message, /• 数据质量当前异常：3条/);
});

test("buildPublicCheckMessage shows both directions and time point for mixed intraday changes", () => {
  const message = buildPublicCheckMessage({
    checkedAt: "2026-06-11T09:35:48.906Z",
    checkedCardCount: 189,
    anomalyCount: 2,
    anomalies: [
      {
        type: "intradayTimePointChange",
        countryCode: "ID",
        countryName: "印尼",
        dashboardTitle: "核心链路准实时监控",
        cardTitle: "新客-放款金额",
        message: "同时间点指标「grant_amt」从 485000 到 12025000，波动 +2379.4%（Asia/Jakarta 13:00，stat_date 2026-06-11 对比 2026-06-10）",
      },
      {
        type: "intradayTimePointChange",
        countryCode: "ID",
        countryName: "印尼",
        dashboardTitle: "核心链路准实时监控",
        cardTitle: "新客-放款金额",
        message: "同时间点指标「grant_amt」从 23650000 到 485000，波动 -97.9%（Asia/Jakarta 09:30，stat_date 2026-06-11 对比 2026-06-10）",
      },
    ],
  });

  assert.match(message, /最大上涨：\+2379\.4%/);
  assert.match(message, /【核心链路准实时监控（stat_date 2026-06-11 对比 2026-06-10）】/);
  assert.match(message, /时间点：Asia\/Jakarta 13:00/);
  assert.match(message, /485,000 → 12,025,000/);
  assert.match(message, /最大下跌：-97\.9%/);
  assert.match(message, /时间点：Asia\/Jakarta 09:30/);
  assert.match(message, /23,650,000 → 485,000/);
});
