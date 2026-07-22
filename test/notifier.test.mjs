import test from "node:test";
import assert from "node:assert/strict";
import { buildPublicCheckMessage, buildPublicCheckMessages, buildWebhookPayload, notifyText } from "../src/notifier.mjs";

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

test("buildWebhookPayload supports TV mentions", () => {
  const payload = buildWebhookPayload(
    "tv",
    "测试消息",
    {},
    {
      botId: "bot-001",
      mentions: "strongliu@kn.group,jerrycai@kn.group",
    },
  );

  assert.deepEqual(payload, {
    botId: "bot-001",
    message: "测试消息",
    mentions: ["strongliu@kn.group", "jerrycai@kn.group"],
  });
});

test("notifyText sends KN Chat Bot messages to each chat id", async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      async text() {
        return JSON.stringify({ ok: true, result: { message_id: 1 } });
      },
    };
  };

  try {
    const result = await notifyText(
      {
        alerts: {
          channel: "knBot",
          botToken: "token-001",
          chatId: "10001,10002",
          mentions: "owner@kn.group",
        },
      },
      "测试消息",
    );

    assert.equal(result.sent, true);
    assert.deepEqual(result.chatIds, ["10001", "10002"]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, "https://bot.kn.chat/bottoken-001/sendMessage");
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      chat_id: "10001",
      text: "测试消息\n\n提醒人：owner@kn.group",
      disable_web_page_preview: true,
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("notifyText resolves KN Chat user ids from recipient emails", async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (String(url).endsWith("/resolveUserId")) {
      assert.equal(options.method, "POST");
      assert.equal(options.body instanceof URLSearchParams, true);
      assert.equal(options.body.get("email"), "owner@kn.group");
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        async text() {
          return JSON.stringify({ ok: true, result: { user_id: 1571267276 } });
        },
      };
    }
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      async text() {
        return JSON.stringify({ ok: true, result: { message_id: 1 } });
      },
    };
  };

  try {
    const result = await notifyText(
      {
        alerts: {
          channel: "knBot",
          botToken: "token-001",
          recipientEmails: "owner@kn.group",
        },
      },
      "测试消息",
    );

    assert.equal(result.sent, true);
    assert.deepEqual(result.chatIds, ["1571267276"]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, "https://bot.kn.chat/bottoken-001/resolveUserId");
    assert.equal(calls[1].url, "https://bot.kn.chat/bottoken-001/sendMessage");
    assert.equal(JSON.parse(calls[1].options.body).chat_id, "1571267276");
  } finally {
    globalThis.fetch = previousFetch;
  }
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
  assert.match(message, /🧭 异常看板 Top 1/);
  assert.match(message, /巴基斯坦\(PK\) \/ 每期逾期率by日期：1条，1张卡片，缺失0、波动1，最大\+9\.2个百分点/);
  assert.match(message, /🔎 具体异常示例 Top 1/);
  assert.match(message, /巴基斯坦\(PK\) \/ 每期逾期率by日期 \/ 每期逾期率-表：指标「入催率」，\+9\.2个百分点/);
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
          countryCode: "INE",
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
  assert.match(message, /• 印尼\(INE\)：共1条，缺失0条，波动1条/);
  assert.match(message, /🧭 异常看板 Top 3/);
  assert.match(message, /缺少 D0 2026-06-09/);
  assert.match(message, /半小时点数据缺失/);
  assert.match(message, /🔎 具体异常示例 Top 3/);
  assert.doesNotMatch(message, /<details>|<summary>|<\/details>/);
  assert.match(message, /印尼\(INE\) \/ 每期逾期率by日期 \/ 每期逾期率：指标「入催率」，\+10\.9个百分点/);
  assert.match(message, /22\.3% → 33\.3%/);
  assert.match(message, /🌏 各国异常 Metabase 看板/);
  assert.match(message, /每期逾期率by日期（1条）：https:\/\/data\.kuainiu\.io\/public\/dashboard\/example-id/);
});

test("duty summary excludes Metabase 403 query failures from BI report", () => {
  const messages = buildPublicCheckMessages(
    {
      checkedAt: "2026-07-14T10:42:00.000Z",
      checkedCardCount: 18,
      anomalyCount: 2,
      anomalies: [
        {
          type: "queryError",
          countryCode: "INE",
          countryName: "印尼",
          dashboardTitle: "OKR",
          cardTitle: "转化漏斗",
          message: "报表「OKR」的「转化漏斗」查询失败：Metabase public request failed (403 Forbidden): <!DOCTYPE html>",
        },
        {
          type: "latestDayOverDayChange",
          countryCode: "MX",
          countryName: "墨西哥",
          dashboardTitle: "业务概览-核心链路准实时监控",
          cardTitle: "放款金额",
          message: "完整日指标「放款金额」从 10 到 25，波动 +150%",
          dashboardUrl: "https://data.kuainiu.io/public/dashboard/mx-core",
        },
      ],
    },
    {
      messageStyle: "dutySummary",
      wattrelSummary: {
        countries: [
          { countryCode: "CN", countryName: "中国", status: "success", count: 0 },
          { countryCode: "MX", countryName: "墨西哥", status: "success", count: 2 },
        ],
      },
    },
  );

  assert.equal(messages.length, 1);
  assert.match(messages[0].body, /【今日值班】0714 PM/);
  assert.match(messages[0].body, /中国：0/);
  assert.match(messages[0].body, /墨西哥：2/);
  assert.match(messages[0].body, /3\. BI报表\(Metabase\):/);
  assert.match(messages[0].body, /墨西哥\(MX\)：\n- 业务概览-核心链路准实时监控：波动异常1条\n  https:\/\/data\.kuainiu\.io\/public\/dashboard\/mx-core/);
  assert.match(messages[0].body, /业务概览-核心链路准实时监控/);
  assert.doesNotMatch(messages[0].body, /403 Forbidden/);
  assert.doesNotMatch(messages[0].body, /转化漏斗/);
});

test("duty summary includes previous-day baseline intraday anomalies below 100 percent", () => {
  const messages = buildPublicCheckMessages(
    {
      checkedAt: "2026-07-16T10:42:00.000Z",
      checkedCardCount: 12,
      anomalyCount: 1,
      anomalies: [
        {
          type: "intradayTimePointChange",
          countryCode: "MX",
          countryName: "墨西哥",
          dashboardTitle: "核心链路准实时监控",
          cardTitle: "新客-启动次数",
          message: "上一日同时间点指标「launch_num」为 300，近30天同点中位数 2500（样本26天），较基线 -88.0%；判定：上一日同点相对近30天基线波动超过±50.0%（America/Mexico_City 19:00，日期 2026-07-15）",
          dashboardUrl: "https://data.kuainiu.io/public/dashboard/mx-core",
        },
      ],
    },
    {
      messageStyle: "dutySummary",
      wattrelSummary: {
        countries: [
          { countryCode: "MX", countryName: "墨西哥", status: "success", count: 0 },
        ],
      },
    },
  );

  assert.match(messages[0].body, /3\. BI报表\(Metabase\):/);
  assert.match(messages[0].body, /墨西哥\(MX\)：\n- 核心链路准实时监控：波动异常1条\n  https:\/\/data\.kuainiu\.io\/public\/dashboard\/mx-core/);
  assert.doesNotMatch(messages[0].body, /3\. BI报表\(Metabase\):\n正常/);
});

test("duty summary lists every anomalous Metabase dashboard", () => {
  const anomalies = Array.from({ length: 10 }, (_, index) => ({
    type: "intradayTimePointCompleteness",
    countryCode: "TH",
    countryName: "泰国",
    dashboardTitle: `异常看板${index + 1}`,
    cardTitle: `指标${index + 1}`,
    message: `半小时点数据缺失：日期 2026-07-21 缺少 08:00`,
    dashboardUrl: `https://data.kuainiu.io/public/dashboard/th-${index + 1}`,
  }));
  const messages = buildPublicCheckMessages(
    {
      checkedAt: "2026-07-22T01:00:00.000Z",
      checkedCardCount: 10,
      anomalyCount: anomalies.length,
      anomalies,
    },
    { messageStyle: "dutySummary" },
  );

  assert.equal(messages.length, 1);
  assert.match(messages[0].body, /异常看板1：数据缺失1条/);
  assert.match(messages[0].body, /异常看板9：数据缺失1条/);
  assert.match(messages[0].body, /异常看板10：数据缺失1条/);
  assert.match(messages[0].body, /public\/dashboard\/th-10/);
  assert.doesNotMatch(messages[0].body, /另有\d+个看板异常/);
});

test("buildPublicCheckMessage shows zero missing data explicitly", () => {
  const message = buildPublicCheckMessage({
    checkedAt: "2026-06-09T07:42:40.806Z",
    checkedCardCount: 57,
    anomalyCount: 1,
    anomalies: [
      {
        type: "completeDayChange",
        countryCode: "INE",
        countryName: "印尼",
        dashboardTitle: "每期逾期率by日期",
        cardTitle: "每期逾期率",
        message: "完整日指标「入催率」从 22.3% 到 33.3%，绝对变化 +10.9个百分点（统计日期 2026-05-24 对比 2026-05-23）",
      },
    ],
  });

  assert.match(message, /• 数据缺失：0条/);
  assert.match(message, /• 数据波动：1条/);
  assert.match(message, /🧭 异常看板 Top 1/);
  assert.match(message, /🔎 具体异常示例 Top 1/);
});

test("buildPublicCheckMessage lists scanned dashboards for healthy checks", () => {
  const message = buildPublicCheckMessage({
    checkedAt: "2026-07-06T08:20:00.000Z",
    dashboardCount: 2,
    checkedCardCount: 12,
    anomalyCount: 0,
    checkedCards: [
      {
        countryCode: "PK",
        countryName: "巴基斯坦",
        dashboardTitle: "公共报表-核心链路",
        cardTitle: "注册数",
      },
      {
        countryCode: "PK",
        countryName: "巴基斯坦",
        dashboardTitle: "公共报表-核心链路",
        cardTitle: "放款金额",
      },
      {
        countryCode: "PH",
        countryName: "菲律宾",
        dashboardTitle: "公共报表-贷后监控",
        cardTitle: "逾期率",
      },
    ],
    anomalies: [],
  });

  assert.match(message, /• 检查范围：12张卡片/);
  assert.match(message, /• 覆盖看板：2个/);
  assert.match(message, /🧭 巡检看板/);
  assert.match(message, /• 巴基斯坦\(PK\) \/ 公共报表-核心链路：2张卡片/);
  assert.match(message, /• 菲律宾\(PH\) \/ 公共报表-贷后监控：1张卡片/);
  assert.match(message, /✅ 本次巡检未发现异常。/);
});

test("buildPublicCheckMessage summarizes multi-country anomalies without listing all checked dashboards", () => {
  const message = buildPublicCheckMessage({
    checkedAt: "2026-07-07T08:31:00.000Z",
    dashboardCount: 8,
    checkedCardCount: 45,
    anomalyCount: 3,
    checkedCards: [
      { countryCode: "INE", countryName: "印尼", dashboardTitle: "放款统计", cardTitle: "件均" },
      { countryCode: "INE", countryName: "印尼", dashboardTitle: "核心链路准实时监控", cardTitle: "老客-还款金额" },
      { countryCode: "PH", countryName: "菲律宾", dashboardTitle: "OKR", cardTitle: "进件规模" },
    ],
    anomalies: [
      {
        type: "intradayTimePointChange",
        countryCode: "INE",
        countryName: "印尼",
        dashboardTitle: "核心链路准实时监控",
        cardTitle: "老客-还款金额",
        message: "同时间点指标「repaid_amt」从 123883310 到 405325890，波动 +227.2%（Asia/Jakarta 08:30，stat_date 2026-07-07 对比 2026-07-06）",
      },
      {
        type: "completeDayChange",
        countryCode: "INE",
        countryName: "印尼",
        dashboardTitle: "放款统计",
        cardTitle: "放款金额",
        message: "完整日指标「grant_amt」从 100000 到 50000，波动 -50.0%（统计日期 2026-07-06 对比 2026-07-05）",
      },
      {
        type: "requiredDatePresent",
        countryCode: "PH",
        countryName: "菲律宾",
        dashboardTitle: "OKR",
        cardTitle: "进件规模",
        message: "数据新鲜度异常：统计日期 缺少 D-1 2026-07-06 的数据，当前最新日期是 2026-07-05",
      },
    ],
  });

  const summary = message.split("🚨【")[0];
  assert.match(summary, /• 覆盖看板：8个/);
  assert.doesNotMatch(summary, /🧭 巡检看板/);
  assert.match(summary, /🌏 国家分布/);
  assert.match(summary, /• 印尼\(INE\)：共2条，缺失0条，波动2条，涉及2个看板\/2张卡片/);
  assert.match(summary, /• 菲律宾\(PH\)：共1条，缺失1条，波动0条，涉及1个看板\/1张卡片/);
  assert.match(summary, /🧭 异常看板 Top 3/);
  assert.match(summary, /核心链路准实时监控：1条，1张卡片，缺失0、波动1，最大\+227\.2%/);
  assert.match(summary, /🔎 具体异常示例 Top 3/);
  assert.match(summary, /核心链路准实时监控 \/ 老客-还款金额：指标「repaid_amt」，\+227\.2%，123,883,310 → 405,325,890/);
  assert.match(summary, /完整异常原因、各时间点当前值\/基准值\/波动幅度已保存到巡检历史详情页。/);
});

test("buildPublicCheckMessage links to frontend history detail when provided", () => {
  const message = buildPublicCheckMessage(
    {
      checkedAt: "2026-07-07T08:31:00.000Z",
      dashboardCount: 1,
      checkedCardCount: 2,
      anomalyCount: 1,
      checkedCards: [
        { countryCode: "INE", countryName: "印尼", dashboardTitle: "核心链路", cardTitle: "注册数" },
      ],
      anomalies: [
        {
          type: "completeDayChange",
          countryCode: "INE",
          countryName: "印尼",
          dashboardTitle: "核心链路",
          dashboardUrl: "https://data.kuainiu.io/public/dashboard/core-link",
          cardTitle: "注册数",
          message: "完整日指标「注册数」从 100 到 200，波动 +100.0%（统计日期 2026-07-06 对比 2026-07-05）",
        },
      ],
    },
    { detailUrl: "http://127.0.0.1:8787/#/batch-check?historyRunId=run-001" },
  );

  assert.match(message, /🔎 查看完整明细：http:\/\/127\.0\.0\.1:8787\/#\/batch-check\?historyRunId=run-001/);
  assert.match(message, /🌏 各国异常 Metabase 看板/);
  assert.match(message, /• 印尼\(INE\)\n  - 核心链路（1条）：https:\/\/data\.kuainiu\.io\/public\/dashboard\/core-link/);
  assert.doesNotMatch(message, /按国家查看/);
  assert.doesNotMatch(message, /countryCode=INE/);
});

test("buildPublicCheckMessage includes data quality current anomaly counts", () => {
  const message = buildPublicCheckMessage({
    checkedAt: "2026-06-09T07:42:40.806Z",
    checkedCardCount: 57,
    anomalyCount: 1,
    dataQuality: {
      countries: [
        {
          countryCode: "INE",
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
        countryCode: "INE",
        countryName: "印尼",
        dashboardTitle: "每期逾期率by日期",
        cardTitle: "每期逾期率",
        message: "完整日指标「入催率」从 22.3% 到 33.3%，绝对变化 +10.9个百分点（统计日期 2026-05-24 对比 2026-05-23）",
      },
    ],
  });

  assert.match(message, /🧪 数据质量当前异常/);
  assert.match(message, /• 印尼\(INE\)：3条/);
  assert.match(message, /• 菲律宾\(PH\)：获取失败（401 Unauthorized）/);
  assert.doesNotMatch(message, /• 数据质量当前异常：3条/);
});

test("buildPublicCheckMessage shows both directions and time point for mixed intraday changes", () => {
  const message = buildPublicCheckMessage({
    checkedAt: "2026-06-11T09:35:48.906Z",
    checkedCardCount: 189,
    anomalyCount: 2,
    anomalies: [
      {
        type: "intradayTimePointChange",
        countryCode: "INE",
        countryName: "印尼",
        dashboardTitle: "核心链路准实时监控",
        cardTitle: "新客-放款金额",
        message: "同时间点指标「grant_amt」从 485000 到 12025000，波动 +2379.4%（Asia/Jakarta 13:00，stat_date 2026-06-11 对比 2026-06-10）",
      },
      {
        type: "intradayTimePointChange",
        countryCode: "INE",
        countryName: "印尼",
        dashboardTitle: "核心链路准实时监控",
        cardTitle: "新客-放款金额",
        message: "同时间点指标「grant_amt」从 23650000 到 485000，波动 -97.9%（Asia/Jakarta 09:30，stat_date 2026-06-11 对比 2026-06-10）",
      },
    ],
  });

  assert.match(message, /核心链路准实时监控：2条，1张卡片，缺失0、波动2，最大\+2379\.4%/);
  assert.match(message, /核心链路准实时监控 \/ 新客-放款金额：指标「grant_amt」，\+2379\.4%/);
  assert.match(message, /Asia\/Jakarta 13:00/);
  assert.match(message, /485,000 → 12,025,000/);
  assert.match(message, /核心链路准实时监控 \/ 新客-放款金额：指标「grant_amt」，-97\.9%/);
  assert.match(message, /Asia\/Jakarta 09:30/);
  assert.match(message, /23,650,000 → 485,000/);
});

test("buildPublicCheckMessage includes baseline detail for intraday changes", () => {
  const message = buildPublicCheckMessage({
    checkedAt: "2026-07-06T09:35:48.906Z",
    checkedCardCount: 1,
    anomalyCount: 1,
    anomalies: [
      {
        type: "intradayTimePointChange",
        countryCode: "INE",
        countryName: "印尼",
        dashboardTitle: "核心链路准实时监控",
        cardTitle: "老客-还款金额",
        message: "同时间点指标「repaid_amt」从 123883310 到 405325890，波动 +227.2%；近30天同点中位数 150000000（样本26天），较基线 +170.2%；判定：昨日同点波动超过±50.0%，且近30天同点中位数波动超过±50.0%，两项同时命中才触发（Asia/Jakarta 08:30，stat_date 2026-07-06 对比 2026-07-05）",
      },
    ],
  });

  assert.match(message, /核心链路准实时监控：1条，1张卡片，缺失0、波动1，最大\+227\.2%/);
  assert.match(message, /样本26天/);
  assert.match(message, /完整异常原因、各时间点当前值\/基准值\/波动幅度已保存到巡检历史详情页。/);
  assert.match(message, /123,883,310 → 405,325,890/);
});
