import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  checkPublicDashboards,
  buildDefaultCardParameters,
  buildUpdateFrequencyHistoryParameters,
  evaluateRowsAgainstRule,
  mergeParameters,
} from "../src/metabase-public-monitor.mjs";
import { hasMetabaseInternalAuth, MetabaseInternalClient, resolveMetabaseAuth } from "../src/metabase-internal-client.mjs";

test("buildDefaultCardParameters maps dashboard defaults to card targets", () => {
  const result = buildDefaultCardParameters(
    {
      parameters: [
        { id: "d3e4e97d", type: "date/all-options", default: "past30days~" },
        { id: "empty", type: "string/=" },
      ],
    },
    {
      parameterMappings: [
        {
          parameter_id: "d3e4e97d",
          target: ["dimension", ["template-tag", "stat_date"], { "stage-number": 0 }],
        },
        {
          parameter_id: "empty",
          target: ["dimension", ["template-tag", "app"], { "stage-number": 0 }],
        },
      ],
    },
  );

  assert.deepEqual(result, [
    {
      id: "d3e4e97d",
      type: "date/all-options",
      target: ["dimension", ["template-tag", "stat_date"], { "stage-number": 0 }],
      value: "past30days~",
    },
  ]);
});

test("mergeParameters overrides by target while keeping actual dashboard parameter id", () => {
  const target = ["variable", ["template-tag", "date_type"]];

  assert.deepEqual(
    mergeParameters(
      [
        {
          id: "actual-dashboard-id",
          type: "string/=",
          target,
          value: ["周"],
        },
      ],
      [
        {
          id: "foreign-rule-id",
          type: "string/=",
          target,
          value: ["日"],
        },
      ],
    ),
    [
      {
        id: "actual-dashboard-id",
        type: "string/=",
        target,
        value: ["日"],
      },
    ],
  );
});

test("buildUpdateFrequencyHistoryParameters expands freshness queries for cadence detection", () => {
  const target = ["dimension", ["template-tag", "stat_date"], { "stage-number": 0 }];
  const result = buildUpdateFrequencyHistoryParameters(
    {
      parameters: [{ id: "date-filter", type: "date/all-options", default: "past1days~" }],
    },
    {
      parameterMappings: [{ parameter_id: "date-filter", target }],
    },
    [{ type: "requiredDatePresent", dateColumn: "统计日期" }],
    {
      requiredDatePresent: {
        autoDetectCadence: true,
        cadenceLookbackDays: 130,
      },
    },
  );

  assert.deepEqual(result, [{
    id: "date-filter",
    type: "date/all-options",
    target,
    value: "past130days~",
  }]);
});

test("checkPublicDashboards applies frequency defaults and the history window end to end", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "cadence-cache-"));
  const observationCacheFile = path.join(tempDir, "observations.json");
  await writeFile(observationCacheFile, JSON.stringify({ version: 1, entries: {
    "CN::weekly-dashboard::2::1::": {
      key: "CN::weekly-dashboard::2::1::", timezone: "Asia/Shanghai",
      latestBusinessDate: "2026-07-18", firstObservedAt: "2026-06-20T02:00:00Z",
      lastObservedAt: "2026-07-18T02:00:00Z", events: [
        { observedAt: "2026-06-20T02:00:00Z", latestBusinessDate: "2026-06-20" },
        { observedAt: "2026-06-27T02:00:00Z", latestBusinessDate: "2026-06-27" },
        { observedAt: "2026-07-04T02:00:00Z", latestBusinessDate: "2026-07-04" },
        { observedAt: "2026-07-11T02:00:00Z", latestBusinessDate: "2026-07-11" },
        { observedAt: "2026-07-18T02:00:00Z", latestBusinessDate: "2026-07-18" },
      ],
    },
  }}));
  const queriedParameters = [];
  const result = await checkPublicDashboards({
    observationCacheFile,
    inventory: {
      dashboardCount: 1,
      dashboards: [{
        countryCode: "CN",
        timezone: "Asia/Shanghai",
        sourcePanelTitle: "周报",
        uuid: "weekly-dashboard",
        url: "https://data.example/public/dashboard/weekly-dashboard",
        parameters: [{ id: "date-filter", type: "date/all-options", default: "past1days~" }],
        cards: [{
          title: "周指标",
          cardId: 1,
          dashcardId: 2,
          parameterMappings: [{
            parameter_id: "date-filter",
            target: ["dimension", ["template-tag", "stat_date"], { "stage-number": 0 }],
          }],
        }],
      }],
    },
    ruleConfig: {
      builtInChecks: { queryError: false, noData: false, emptyMetrics: false },
      ruleDefaults: {
        requiredDatePresent: {
          autoDetectCadence: true,
          cadenceLookbackDays: 130,
          cadenceMinIntervals: 3,
          cadenceMinConfidence: 0.75,
          cadenceMaxIntervalDays: 31,
          cadenceMaxIntervalMonths: 3,
        },
      },
      rules: [{
        type: "requiredDatePresent",
        dashboardTitle: "周报",
        cardTitle: "周指标",
        dateColumn: "统计日期",
        timezone: "dashboard",
        now: "2026-07-20T04:00:00Z",
        requiredLagDays: 1,
      }],
    },
    queryCardFn: async (_client, _dashboard, _card, parameters) => {
      queriedParameters.push(parameters);
      return {
        ok: true,
        rows: ["2026-06-20", "2026-06-27", "2026-07-04", "2026-07-11", "2026-07-18"]
          .map((date) => ({ "统计日期": date, "周指标": 100 })),
        error: null,
      };
    },
  });

  assert.equal(result.anomalyCount, 0);
  assert.equal(queriedParameters[0][0].value, "past130days~");
  assert.equal(result.checkedCards[0].freshness.dataCadence.label, "每周");
  assert.equal(result.checkedCards[0].freshness.refreshCadence.label, "每周");
  assert.equal(result.checkedCards[0].updateCadences[0].label, "每周");
  assert.equal(result.checkedCards[0].updateCadences[0].evidenceCount, 5);
});

test("checkPublicDashboards queries internal dashboards by dashboardId", async () => {
  const queriedRequests = [];
  const result = await checkPublicDashboards({
    inventory: {
      dashboardCount: 1,
      dashboards: [
        {
          access: "internal",
          dashboardId: "462",
          uuid: "internal-462",
          title: "业务概览-核心链路准实时监控",
          url: "https://data.kuainiu.io/dashboard/462",
          cards: [{ title: "注册数", cardId: 22, dashcardId: 11, parameterMappings: [] }],
        },
      ],
    },
    ruleConfig: { builtInChecks: { queryError: true, noData: true }, rules: [] },
    metabaseClientFactory: () => ({
      async queryDashcardJson(request) {
        queriedRequests.push(request);
        return [{ "统计日期": "2026-07-07", "注册数": 10 }];
      },
    }),
  });

  assert.equal(result.checkedCardCount, 1);
  assert.deepEqual(queriedRequests, [
    {
      cardId: 22,
      dashcardId: 11,
      parameters: [],
      dashboardId: "462",
    },
  ]);
});

test("checkPublicDashboards detects metric charts with rows but no metric values", async () => {
  const result = await checkPublicDashboards({
    inventory: {
      dashboardCount: 1,
      dashboards: [
        {
          sourcePanelTitle: "复借数据",
          title: "复借数据",
          uuid: "dash-empty-metric",
          url: "https://data.example/public/dashboard/dash-empty-metric",
          cards: [
            {
              title: "还款7日复借率",
              cardId: 468,
              dashcardId: 562,
              metrics: ["还款数", "还款~复借"],
              parameterMappings: [],
            },
          ],
        },
      ],
    },
    ruleConfig: { builtInChecks: { queryError: false, noData: false, emptyMetrics: true }, rules: [] },
    queryCardFn: async () => ({
      ok: true,
      rows: [
        { "统计日期": "2026-07-13", "还款数": null, "还款~复借": null },
        { "统计日期": "2026-07-14", "还款数": "", "还款~复借": null },
      ],
      error: null,
    }),
  });

  assert.equal(result.checkedCardCount, 1);
  assert.equal(result.anomalyCount, 1);
  assert.equal(result.anomalies[0].type, "emptyMetrics");
  assert.match(result.anomalies[0].message, /没有有效指标值：还款数、还款~复借/);
});

test("checkPublicDashboards treats zero metric chart value as present", async () => {
  const result = await checkPublicDashboards({
    inventory: {
      dashboardCount: 1,
      dashboards: [
        {
          sourcePanelTitle: "复借数据",
          title: "复借数据",
          uuid: "dash-zero-metric",
          url: "https://data.example/public/dashboard/dash-zero-metric",
          cards: [
            {
              title: "还款7日复借率",
              cardId: 468,
              dashcardId: 562,
              metrics: ["还款数", "还款~复借"],
              parameterMappings: [],
            },
          ],
        },
      ],
    },
    ruleConfig: { builtInChecks: { queryError: false, noData: false, emptyMetrics: true }, rules: [] },
    queryCardFn: async () => ({
      ok: true,
      rows: [{ "统计日期": "2026-07-14", "还款数": 0, "还款~复借": null }],
      error: null,
    }),
  });

  assert.equal(result.checkedCardCount, 1);
  assert.equal(result.anomalyCount, 0);
});

test("checkPublicDashboards resolves TH card 376 English schema instead of reporting empty Chinese metrics", async () => {
  const result = await checkPublicDashboards({
    inventory: { dashboardCount: 1, dashboards: [{
      countryCode: "TH", timezone: "Asia/Bangkok", sourcePanelTitle: "复借率",
      uuid: "2a587423-5279-49b7-824f-7b62a8c884a3", url: "https://data.example/public/dashboard/th",
      cards: [{
        title: "dashboard-用户还款后7日复借率", cardId: 376, dashcardId: 387,
        dimensions: ["finish_date"], metrics: ["repay_cnt", "freeze_rate_7"], parameterMappings: [],
      }],
    }] },
    ruleConfig: {
      builtInChecks: { queryError: false, noData: false, emptyMetrics: true },
      rules: [{
        type: "notEmpty", cardId: 376,
        columns: ["还款数", "还款~再进件", "再进件~通过", "通过~放款", "还款~复借"],
      }],
    },
    queryCardFn: async () => ({
      ok: true,
      rows: [{ finish_date: "2026-07-21", repay_cnt: 1321, freeze_rate_7: 0.42 }],
      error: null,
    }),
  });
  assert.equal(result.anomalyCount, 0);
  assert.equal(result.checkedCards[0].freshness.dateColumn, "finish_date");
  assert.deepEqual(result.checkedCards[0].freshness.metricColumns, ["repay_cnt", "freeze_rate_7"]);
  assert.equal(result.checkedCards[0].freshness.schemaMismatch, true);
});

test("checkPublicDashboards recovers a corrupted observation cache with an atomic rewrite", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "corrupt-cadence-cache-"));
  const observationCacheFile = path.join(tempDir, "observations.json");
  await writeFile(observationCacheFile, "{broken json");
  const result = await checkPublicDashboards({
    inventory: { dashboardCount: 1, dashboards: [{
      countryCode: "MX", timezone: "America/Mexico_City", sourcePanelTitle: "日报",
      uuid: "daily", url: "https://data.example/public/dashboard/daily",
      cards: [{ title: "数量", cardId: 1, dashcardId: 2, dimensions: ["date"], metrics: ["count"], parameterMappings: [] }],
    }] },
    ruleConfig: { builtInChecks: { queryError: true, noData: false, emptyMetrics: false }, rules: [] },
    observationCacheFile,
    queryCardFn: async () => ({ ok: true, rows: [{ date: "2026-07-21", count: 0 }], error: null }),
  });
  const rewritten = JSON.parse(await readFile(observationCacheFile, "utf8"));
  assert.equal(result.checkedCards[0].freshness.status, "learning");
  assert.equal(Object.keys(rewritten.entries).length, 1);
});

test("checkPublicDashboards collapses missing internal Metabase auth to dashboard config error", async () => {
  const previousSession = process.env.METABASE_SESSION;
  const previousCookie = process.env.METABASE_COOKIE;
  const previousAuthFile = process.env.METABASE_AUTH_FILE;
  delete process.env.METABASE_SESSION;
  delete process.env.METABASE_COOKIE;
  delete process.env.METABASE_AUTH_FILE;

  try {
    const result = await checkPublicDashboards({
      inventory: {
        dashboardCount: 1,
        dashboards: [
          {
            access: "internal",
            sourcePanelTitle: "业务概览-OKR",
            title: "OKR",
            dashboardId: "642",
            uuid: "internal-642",
            url: "https://data.kuainiu.io/dashboard/642",
            cards: [
              { title: "中国OKR", cardId: 1, dashcardId: 2, parameterMappings: [] },
              { title: "续贷交易来源", cardId: 3, dashcardId: 4, parameterMappings: [] },
            ],
          },
        ],
      },
      ruleConfig: { builtInChecks: { queryError: true, noData: true }, rules: [] },
    });

    assert.equal(result.checkedCardCount, 1);
    assert.equal(result.anomalyCount, 1);
    assert.equal(result.anomalies[0].type, "metabaseConfigError");
    assert.match(result.anomalies[0].message, /缺少 Metabase 登录态/);
  } finally {
    if (previousSession === undefined) {
      delete process.env.METABASE_SESSION;
    } else {
      process.env.METABASE_SESSION = previousSession;
    }
    if (previousCookie === undefined) {
      delete process.env.METABASE_COOKIE;
    } else {
      process.env.METABASE_COOKIE = previousCookie;
    }
    if (previousAuthFile === undefined) {
      delete process.env.METABASE_AUTH_FILE;
    } else {
      process.env.METABASE_AUTH_FILE = previousAuthFile;
    }
  }
});

test("Metabase internal auth can be loaded from local auth file", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "metabase-auth-"));
  const authFile = path.join(tempDir, "metabase.auth.json");
  await writeFile(authFile, JSON.stringify({ apiKey: "test-api-key" }));

  const previousSession = process.env.METABASE_SESSION;
  const previousCookie = process.env.METABASE_COOKIE;
  const previousApiKey = process.env.METABASE_API_KEY;
  const previousAuthFile = process.env.METABASE_AUTH_FILE;
  delete process.env.METABASE_SESSION;
  delete process.env.METABASE_COOKIE;
  delete process.env.METABASE_API_KEY;
  process.env.METABASE_AUTH_FILE = authFile;

  try {
    assert.equal(hasMetabaseInternalAuth(), true);
    assert.equal(resolveMetabaseAuth().apiKey, "test-api-key");
  } finally {
    if (previousSession === undefined) {
      delete process.env.METABASE_SESSION;
    } else {
      process.env.METABASE_SESSION = previousSession;
    }
    if (previousCookie === undefined) {
      delete process.env.METABASE_COOKIE;
    } else {
      process.env.METABASE_COOKIE = previousCookie;
    }
    if (previousApiKey === undefined) {
      delete process.env.METABASE_API_KEY;
    } else {
      process.env.METABASE_API_KEY = previousApiKey;
    }
    if (previousAuthFile === undefined) {
      delete process.env.METABASE_AUTH_FILE;
    } else {
      process.env.METABASE_AUTH_FILE = previousAuthFile;
    }
  }
});

test("MetabaseInternalClient sends API key header", async () => {
  const requests = [];
  const client = new MetabaseInternalClient({
    baseUrl: "https://data.example",
    apiKey: "test-api-key",
    fetchFn: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        headers: new Map([["content-type", "application/json"]]),
        async text() {
          return "[]";
        },
      };
    },
  });

  await client.queryDashcardJson({
    dashboardId: "642",
    dashcardId: 2,
    cardId: 1,
    parameters: [],
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.headers["X-API-Key"], "test-api-key");
});

test("checkPublicDashboards classifies public 404 as stale public link", async () => {
  const result = await checkPublicDashboards({
    inventory: {
      dashboardCount: 1,
      dashboards: [
        {
          sourcePanelTitle: "放款统计",
          title: "放款统计",
          uuid: "stale-public-uuid",
          url: "https://data.example/public/dashboard/stale-public-uuid",
          cards: [{ title: "件均&费率", cardId: 1, dashcardId: 2, parameterMappings: [] }],
        },
      ],
    },
    ruleConfig: { builtInChecks: { queryError: true, noData: true }, rules: [] },
    queryCardFn: async () => ({
      ok: false,
      rows: [],
      error: 'Metabase public request failed (404 Not Found): "Not found."',
    }),
  });

  assert.equal(result.anomalyCount, 1);
  assert.equal(result.anomalies[0].type, "metabaseStalePublicLink");
});

test("checkPublicDashboards keeps OKR D0 freshness except PK D-1 exception", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "public-monitor-"));
  const inventoryFile = path.join(tempDir, "inventory.json");
  const rulesFile = path.join(tempDir, "rules.json");
  const outputFile = path.join(tempDir, "result.json");

  await writeFile(
    inventoryFile,
    JSON.stringify({
      dashboardCount: 1,
      dashboards: [
        {
          country: { code: "TH", name: "泰国", timezone: "Asia/Bangkok" },
          countryCode: "TH",
          countryName: "泰国",
          timezone: "Asia/Bangkok",
          sourcePanelTitle: "OKR",
          title: "OKR",
          uuid: "fake-dashboard",
          url: "https://example.invalid/public/dashboard/fake-dashboard",
          cards: [
            {
              dashcardId: 1,
              cardId: 2,
              title: "转化漏斗",
              parameterMappings: [],
            },
          ],
        },
        {
          country: { code: "PK", name: "巴基斯坦", timezone: "Asia/Karachi" },
          countryCode: "PK",
          countryName: "巴基斯坦",
          timezone: "Asia/Karachi",
          sourcePanelTitle: "OKR",
          title: "OKR",
          uuid: "fake-dashboard-pk",
          url: "https://example.invalid/public/dashboard/fake-dashboard-pk",
          cards: [
            {
              dashcardId: 3,
              cardId: 4,
              title: "转化漏斗",
              parameterMappings: [],
            },
          ],
        },
      ],
    }),
  );
  await writeFile(
    rulesFile,
    JSON.stringify({
      builtInChecks: { queryError: false, noData: false },
      rules: [
        {
          type: "requiredDatePresent",
          dashboardTitle: "OKR",
          cardTitle: "转化漏斗",
          dateColumn: "统计日期",
          timezone: "dashboard",
          requiredLagDays: 0,
          now: "2026-06-09T08:00:00Z",
          exclude: [{ countryCode: "PK", cardTitle: "转化漏斗" }],
        },
        {
          type: "requiredDatePresent",
          countryCode: "PK",
          dashboardTitle: "OKR",
          cardTitle: "转化漏斗",
          dateColumn: "统计日期",
          timezone: "dashboard",
          requiredLagDays: 1,
          now: "2026-06-09T08:00:00Z",
        },
      ],
    }),
  );

  const result = await checkPublicDashboards({
    inventoryFile,
    rulesFile,
    outputFile,
    queryCardFn: async () => ({
      ok: true,
      rows: [{ "统计日期": "2026-06-08", "注册~放款": 0.1 }],
      error: null,
    }),
  });

  assert.equal(result.anomalyCount, 1);
  assert.equal(result.anomalies[0].countryCode, "TH");
  assert.match(result.anomalies[0].message, /缺少 D0 2026-06-09/);
});

test("checkPublicDashboards skips explicitly ignored stopped-business cards", async () => {
  let queryCount = 0;
  const result = await checkPublicDashboards({
    inventory: {
      dashboardCount: 1,
      dashboards: [
        {
          countryCode: "CN",
          countryName: "中国",
          timezone: "Asia/Shanghai",
          sourcePanelTitle: "业务概览-核心链路准实时监控",
          title: "核心链路准实时监控",
          uuid: "cn-core",
          url: "https://example.invalid/public/dashboard/cn-core",
          cards: [
            { dashcardId: 1, cardId: 2, title: "新客-通过次数 ", parameterMappings: [] },
          ],
        },
      ],
    },
    ruleConfig: {
      builtInChecks: { queryError: true, noData: true, emptyMetrics: true },
      ignoredCards: [
        {
          countryCode: "CN",
          dashboardTitlePattern: "核心链路准实时监控$",
          cardTitlePattern: "^新客-通过次数\\s*$",
        },
      ],
      rules: [
        {
          type: "intradayTimePointCompleteness",
          dashboardTitle: "业务概览-核心链路准实时监控",
          cardTitlePattern: "^新客-",
          dateColumn: "日期",
          timeColumn: "开始时间",
          column: "pass_num",
        },
      ],
    },
    queryCardFn: async () => {
      queryCount += 1;
      return { ok: true, rows: [] };
    },
  });

  assert.equal(queryCount, 0);
  assert.equal(result.checkedCardCount, 0);
  assert.equal(result.anomalyCount, 0);
});

test("evaluateRowsAgainstRule checks latest value range", () => {
  const result = evaluateRowsAgainstRule(
    [
      { "统计日期": "2026-06-07", "注册~放款": 0.03 },
      { "统计日期": "2026-06-08", "注册~放款": 0.01 },
    ],
    {
      type: "latestValueOutsideRange",
      dateColumn: "统计日期",
      column: "注册~放款",
      min: 0.02,
    },
  );

  assert.match(result, /below/);
});

test("evaluateRowsAgainstRule accepts healthy row counts", () => {
  const result = evaluateRowsAgainstRule(
    [{ value: 1 }],
    {
      type: "rowCountOutsideRange",
      min: 1,
    },
  );

  assert.equal(result, null);
});

test("evaluateRowsAgainstRule detects latest zero rates", () => {
  const result = evaluateRowsAgainstRule(
    [
      { "统计日期": "2026-06-07", "注册~放款": 0.02 },
      { "统计日期": "2026-06-08", "注册~放款": 0 },
    ],
    {
      type: "latestZeroRate",
      columnPattern: "率|~",
    },
  );

  assert.deepEqual(result, ["指标「注册~放款」最新值为 0（统计日期=2026-06-08）"]);
});

test("evaluateRowsAgainstRule detects latest day over day change", () => {
  const result = evaluateRowsAgainstRule(
    [
      { "统计日期": "2026-06-07", "放款数": 100 },
      { "统计日期": "2026-06-08", "放款数": 120 },
    ],
    {
      type: "latestDayOverDayChange",
      maxAbsChangeRate: 0.1,
    },
  );

  assert.deepEqual(result, ["指标「放款数」最新值 120 较上一日 100 波动 20.0%（统计日期 2026-06-08 对比 2026-06-07）"]);
});

test("evaluateRowsAgainstRule prefers date-like columns over numeric columns", () => {
  const result = evaluateRowsAgainstRule(
    [
      { "注册数": 9000, "注册日期": "2026-06-07", "放款": 100 },
      { "注册数": 8000, "注册日期": "2026-06-08", "放款": 120 },
    ],
    {
      type: "latestDayOverDayChange",
      column: "放款",
      maxAbsChangeRate: 0.1,
    },
  );

  assert.deepEqual(result, ["指标「放款」最新值 120 较上一日 100 波动 20.0%（注册日期 2026-06-08 对比 2026-06-07）"]);
});

test("evaluateRowsAgainstRule checks complete day change before today", () => {
  const result = evaluateRowsAgainstRule(
    [
      { "统计日期": "2026-06-06", "注册~放款": 0.02 },
      { "统计日期": "2026-06-07", "注册~放款": 0.027 },
      { "统计日期": "2026-06-08", "注册~放款": 0.005 },
    ],
    {
      type: "completeDayChange",
      dateColumn: "统计日期",
      column: "注册~放款",
      timezone: "Asia/Jakarta",
      now: "2026-06-08T06:00:00Z",
      maxRiseRate: 0.25,
    },
  );

  assert.deepEqual(result, [
    "完整日指标「注册~放款」从 0.02 到 0.027，波动 +35.0%（统计日期 2026-06-07 对比 2026-06-06）",
  ]);
});

test("evaluateRowsAgainstRule supports absolute percentage point threshold", () => {
  const healthyResult = evaluateRowsAgainstRule(
    [
      { "统计日期": "2026-06-06", "注册~放款": 0.1 },
      { "统计日期": "2026-06-07", "注册~放款": 0.14 },
    ],
    {
      type: "completeDayChange",
      dateColumn: "统计日期",
      column: "注册~放款",
      timezone: "Asia/Jakarta",
      now: "2026-06-08T06:00:00Z",
      maxAbsDelta: 0.05,
      valueFormat: "percent",
    },
  );
  const anomalyResult = evaluateRowsAgainstRule(
    [
      { "统计日期": "2026-06-06", "注册~放款": 0.1 },
      { "统计日期": "2026-06-07", "注册~放款": 0.16 },
    ],
    {
      type: "completeDayChange",
      dateColumn: "统计日期",
      column: "注册~放款",
      timezone: "Asia/Jakarta",
      now: "2026-06-08T06:00:00Z",
      maxAbsDelta: 0.05,
      valueFormat: "percent",
    },
  );

  assert.deepEqual(healthyResult, []);
  assert.deepEqual(anomalyResult, [
    "完整日指标「注册~放款」从 10.0% 到 16.0%，绝对变化 +6.0个百分点（统计日期 2026-06-07 对比 2026-06-06）",
  ]);
});

test("evaluateRowsAgainstRule suppresses small numeric changes within ratio", () => {
  const result = evaluateRowsAgainstRule(
    [
      { "注册日期": "2026-06-08", "注册数": 2 },
      { "注册日期": "2026-06-09", "注册数": 1 },
    ],
    {
      type: "completeDayChange",
      dateColumn: "注册日期",
      column: "注册数",
      timezone: "Asia/Jakarta",
      now: "2026-06-10T06:00:00Z",
      maxDropRate: 0.25,
      smallValueThreshold: 50,
      smallValueMaxRatio: 3,
    },
  );

  assert.deepEqual(result, []);
});

test("evaluateRowsAgainstRule keeps small numeric changes beyond ratio", () => {
  const result = evaluateRowsAgainstRule(
    [
      { "注册日期": "2026-06-08", "注册数": 10 },
      { "注册日期": "2026-06-09", "注册数": 40 },
    ],
    {
      type: "completeDayChange",
      dateColumn: "注册日期",
      column: "注册数",
      timezone: "Asia/Jakarta",
      now: "2026-06-10T06:00:00Z",
      maxRiseRate: 0.4,
      smallValueThreshold: 50,
      smallValueMaxRatio: 3,
    },
  );

  assert.deepEqual(result, [
    "完整日指标「注册数」从 10 到 40，波动 +300.0%（注册日期 2026-06-09 对比 2026-06-08）",
  ]);
});

test("evaluateRowsAgainstRule keeps numeric changes at small value boundary", () => {
  const result = evaluateRowsAgainstRule(
    [
      { "注册日期": "2026-06-08", "正审进件": 50 },
      { "注册日期": "2026-06-09", "正审进件": 0 },
    ],
    {
      type: "completeDayChange",
      dateColumn: "注册日期",
      column: "正审进件",
      timezone: "Asia/Jakarta",
      now: "2026-06-10T06:00:00Z",
      maxDropRate: 0.25,
      smallValueThreshold: 50,
      smallValueMaxRatio: 3,
    },
  );

  assert.deepEqual(result, [
    "完整日指标「正审进件」从 50 到 0，波动 -100.0%（注册日期 2026-06-09 对比 2026-06-08）",
  ]);
});

test("evaluateRowsAgainstRule requires current day data by timezone", () => {
  const result = evaluateRowsAgainstRule(
    [
      { "统计日期": "2026-06-06", "注册数": 100 },
      { "统计日期": "2026-06-07", "注册数": 120 },
    ],
    {
      type: "requiredDatePresent",
      dateColumn: "统计日期",
      timezone: "Asia/Jakarta",
      now: "2026-06-08T10:00:00Z",
      requiredLagDays: 0,
    },
  );

  assert.equal(result, "数据新鲜度异常：统计日期 缺少 D0 2026-06-08 的数据，当前最新日期是 2026-06-07");
});

test("evaluateRowsAgainstRule accepts required D-1 data", () => {
  const result = evaluateRowsAgainstRule(
    [
      { "统计日期": "2026-06-06", "费率": 0.18 },
      { "统计日期": "2026-06-07", "费率": 0.19 },
    ],
    {
      type: "requiredDatePresent",
      dateColumn: "统计日期",
      timezone: "Asia/Jakarta",
      now: "2026-06-08T10:00:00Z",
      requiredLagDays: 1,
    },
  );

  assert.equal(result, null);
});

test("evaluateRowsAgainstRule does not treat a weekly-looking API result as refresh evidence", () => {
  const result = evaluateRowsAgainstRule(
    ["2026-06-20", "2026-06-27", "2026-07-04", "2026-07-11", "2026-07-18"]
      .map((date) => ({ "统计日期": date, "周指标": 100 })),
    {
      type: "requiredDatePresent",
      dateColumn: "统计日期",
      timezone: "Asia/Shanghai",
      now: "2026-07-20T04:00:00Z",
      requiredLagDays: 1,
      autoDetectCadence: true,
      cadenceLookbackDays: 130,
      cadenceMinIntervals: 3,
      cadenceMinConfidence: 0.75,
      cadenceMaxIntervalDays: 31,
      cadenceMaxIntervalMonths: 3,
    },
  );

  assert.match(result, /缺少 D-1/);
});

test("evaluateRowsAgainstRule keeps explicit freshness strict while cross-run cadence is learning", () => {
  const result = evaluateRowsAgainstRule(
    ["2026-03-31", "2026-04-30", "2026-05-31", "2026-06-30"]
      .map((date) => ({ "统计日期": date, "月指标": 100 })),
    {
      type: "requiredDatePresent",
      dateColumn: "统计日期",
      timezone: "Asia/Shanghai",
      now: "2026-07-20T04:00:00Z",
      requiredLagDays: 1,
      autoDetectCadence: true,
      cadenceLookbackDays: 130,
      cadenceMinIntervals: 3,
      cadenceMinConfidence: 0.75,
      cadenceMaxIntervalDays: 31,
      cadenceMaxIntervalMonths: 1,
    },
  );

  assert.match(result, /缺少 D-1/);
});

test("evaluateRowsAgainstRule never claims a monthly refresh from one API response", () => {
  const result = evaluateRowsAgainstRule(
    ["2026-03-31", "2026-04-30", "2026-05-31", "2026-06-30"]
      .map((date) => ({ "统计日期": date, "月指标": 100 })),
    {
      type: "requiredDatePresent",
      dateColumn: "统计日期",
      timezone: "Asia/Shanghai",
      now: "2026-08-02T04:00:00Z",
      requiredLagDays: 1,
      autoDetectCadence: true,
      cadenceLookbackDays: 130,
      cadenceMinIntervals: 3,
      cadenceMinConfidence: 0.75,
      cadenceMaxIntervalDays: 31,
      cadenceMaxIntervalMonths: 1,
    },
  );

  assert.doesNotMatch(result, /自动识别/);
});

test("evaluateRowsAgainstRule never claims weekly refresh from business-date spacing", () => {
  const result = evaluateRowsAgainstRule(
    ["2026-06-20", "2026-06-27", "2026-07-04", "2026-07-11"]
      .map((date) => ({ "统计日期": date, "周指标": 100 })),
    {
      type: "requiredDatePresent",
      dateColumn: "统计日期",
      timezone: "Asia/Shanghai",
      now: "2026-07-20T04:00:00Z",
      requiredLagDays: 1,
      autoDetectCadence: true,
      cadenceLookbackDays: 130,
      cadenceMinIntervals: 3,
      cadenceMinConfidence: 0.75,
      cadenceMaxIntervalDays: 31,
      cadenceMaxIntervalMonths: 3,
    },
  );

  assert.doesNotMatch(result, /自动识别/);
});

test("evaluateRowsAgainstRule keeps daily-looking series on strict D-1 freshness while learning", () => {
  const result = evaluateRowsAgainstRule(
    ["2026-07-15", "2026-07-16", "2026-07-17", "2026-07-18"]
      .map((date) => ({ "统计日期": date, "日指标": 100 })),
    {
      type: "requiredDatePresent",
      dateColumn: "统计日期",
      timezone: "Asia/Shanghai",
      now: "2026-07-20T04:00:00Z",
      requiredLagDays: 1,
      autoDetectCadence: true,
      cadenceLookbackDays: 130,
      cadenceMinIntervals: 3,
      cadenceMinConfidence: 0.75,
      cadenceMaxIntervalDays: 31,
      cadenceMaxIntervalMonths: 3,
    },
  );

  assert.match(result, /缺少 D-1 2026-07-19/);
  assert.doesNotMatch(result, /自动识别/);
});

test("evaluateRowsAgainstRule does not infer a cadence from irregular sparse dates", () => {
  const result = evaluateRowsAgainstRule(
    ["2026-07-05", "2026-07-09", "2026-07-14", "2026-07-18"]
      .map((date) => ({ "统计日期": date, "稀疏指标": 100 })),
    {
      type: "requiredDatePresent",
      dateColumn: "统计日期",
      timezone: "Asia/Shanghai",
      now: "2026-07-20T04:00:00Z",
      requiredLagDays: 1,
      autoDetectCadence: true,
      cadenceLookbackDays: 130,
      cadenceMinIntervals: 3,
      cadenceMinConfidence: 0.75,
      cadenceMaxIntervalDays: 31,
      cadenceMaxIntervalMonths: 3,
    },
  );

  assert.match(result, /缺少 D-1 2026-07-19/);
  assert.doesNotMatch(result, /推断每/);
});

test("evaluateRowsAgainstRule suppresses correlated same-direction changes", () => {
  const result = evaluateRowsAgainstRule(
    [
      { "统计日期": "2026-06-06", "放款成本": 44672.218, "总花费": 7192227.2, "注册成本": 1098.7209 },
      { "统计日期": "2026-06-07", "放款成本": 20244.199, "总花费": 3704688.5, "注册成本": 616.31816 },
    ],
    {
      type: "completeDayChange",
      dateColumn: "统计日期",
      columns: ["放款成本", "总花费", "注册成本"],
      timezone: "Asia/Jakarta",
      now: "2026-06-08T06:00:00Z",
      maxDropRate: 0.25,
      correlatedChangeSuppressions: [
        {
          columns: ["放款成本", "总花费", "注册成本"],
          sameDirection: true,
          maxRelativeRateGap: 0.5,
        },
      ],
    },
  );

  assert.deepEqual(result, []);
});

test("evaluateRowsAgainstRule keeps correlated changes when rate spread is too large", () => {
  const result = evaluateRowsAgainstRule(
    [
      { "统计日期": "2026-06-06", "放款成本": 100, "总花费": 1000 },
      { "统计日期": "2026-06-07", "放款成本": 40, "总花费": 800 },
    ],
    {
      type: "completeDayChange",
      dateColumn: "统计日期",
      columns: ["放款成本", "总花费"],
      timezone: "Asia/Jakarta",
      now: "2026-06-08T06:00:00Z",
      maxDropRate: 0.25,
      correlatedChangeSuppressions: [
        {
          columns: ["放款成本", "总花费"],
          sameDirection: true,
          maxRelativeRateGap: 0.5,
        },
      ],
    },
  );

  assert.deepEqual(result, [
    "完整日指标「放款成本」从 100 到 40，波动 -60.0%（统计日期 2026-06-07 对比 2026-06-06）",
  ]);
});

test("evaluateRowsAgainstRule limits complete-day comparisons to latest data lookback window", () => {
  const result = evaluateRowsAgainstRule(
    [
      { "统计日期": "2026-06-06", APP: "active", "入催率": 0.2 },
      { "统计日期": "2026-06-07", APP: "active", "入催率": 0.21 },
      { "统计日期": "2026-05-01", APP: "stale", "入催率": 0.1 },
      { "统计日期": "2026-05-02", APP: "stale", "入催率": 0.2 },
    ],
    {
      type: "completeDayChange",
      dateColumn: "统计日期",
      column: "入催率",
      dimensionColumns: ["APP"],
      timezone: "Asia/Jakarta",
      now: "2026-06-08T10:00:00Z",
      maxAbsDelta: 0.08,
      valueFormat: "percent",
      lookbackDays: 7,
    },
  );

  assert.deepEqual(result, []);
});

test("evaluateRowsAgainstRule checks intraday progress against expected ratio", () => {
  const result = evaluateRowsAgainstRule(
    [
      { "日期": "2026-06-07", "开始时间": "00:00", "reg_cnt": 100 },
      { "日期": "2026-06-08", "开始时间": "00:00", "reg_cnt": 20 },
    ],
    {
      type: "intradayProgress",
      dateColumn: "日期",
      column: "reg_cnt",
      timezone: "Asia/Jakarta",
      now: "2026-06-08T01:00:00Z",
      expectedProgress: {
        "08:00": 0.33,
        "22:00": 0.95,
      },
      maxBelowExpectedRate: 0.2,
      ignoreDimensionColumns: ["开始时间"],
    },
  );

  assert.deepEqual(result, [
    "当日指标「reg_cnt」进度 20.0% 低于期望 33.0%（Asia/Jakarta 08:00，2026-06-08=20，2026-06-07=100）",
  ]);
});

test("evaluateRowsAgainstRule supports business-hour intraday progress window", () => {
  const result = evaluateRowsAgainstRule(
    [
      { "放款日期": "2026-06-07", "放款笔数": 100 },
      { "放款日期": "2026-06-08", "放款笔数": 10 },
    ],
    {
      type: "intradayProgress",
      dateColumn: "放款日期",
      column: "放款笔数",
      timezone: "Asia/Jakarta",
      now: "2026-06-08T03:00:00Z",
      expectedProgress: {
        "05:00": 0,
        "23:30": 1,
      },
      maxBelowExpectedRate: 0.2,
    },
  );

  assert.deepEqual(result, [
    "当日指标「放款笔数」进度 10.0% 低于期望 27.0%（Asia/Jakarta 10:00，2026-06-08=10，2026-06-07=100）",
  ]);
});

test("evaluateRowsAgainstRule checks intraday same-time change", () => {
  const result = evaluateRowsAgainstRule(
    [
      { "日期": "2026-06-07", "开始时间": "08:00", "reg_cnt": 100 },
      { "日期": "2026-06-07", "开始时间": "08:30", "reg_cnt": 100 },
      { "日期": "2026-06-07", "开始时间": "09:00", "reg_cnt": 100 },
      { "日期": "2026-06-08", "开始时间": "08:00", "reg_cnt": 100 },
      { "日期": "2026-06-08", "开始时间": "08:30", "reg_cnt": 160 },
    ],
    {
      type: "intradaySameTimeChange",
      dateColumn: "日期",
      timeColumn: "开始时间",
      column: "reg_cnt",
      timezone: "Asia/Jakarta",
      now: "2026-06-08T01:45:00Z",
      maxAbsChangeRate: 0.2,
      alertWhenTodayMissing: true,
    },
  );

  assert.deepEqual(result, [
    "同时间指标「reg_cnt」从 200 到 260，波动 +30.0%（Asia/Jakarta 截止 08:30，日期 2026-06-08 对比 2026-06-07）",
  ]);
});

test("evaluateRowsAgainstRule detects missing intraday time points", () => {
  const result = evaluateRowsAgainstRule(
    [
      { "日期": "2026-06-08", "开始时间": "00:00", "reg_cnt": 100 },
      { "日期": "2026-06-08", "开始时间": "01:00", "reg_cnt": 100 },
    ],
    {
      type: "intradayTimePointCompleteness",
      dateColumn: "日期",
      timeColumn: "开始时间",
      column: "reg_cnt",
      timezone: "Asia/Jakarta",
      now: "2026-06-07T18:00:00Z",
      startTime: "00:00",
      intervalMinutes: 30,
      ignoreDimensionColumns: ["开始时间"],
    },
  );

  assert.deepEqual(result, [
    "半小时点数据缺失：日期 2026-06-08 缺少 00:30（Asia/Jakarta 01:00，期望 00:00~01:00 每 30 分钟）",
  ]);
});

test("evaluateRowsAgainstRule allows intraday time point data delay", () => {
  const result = evaluateRowsAgainstRule(
    [
      { "日期": "2026-06-08", "开始时间": "00:00", "reg_cnt": 100 },
      { "日期": "2026-06-08", "开始时间": "00:30", "reg_cnt": 100 },
      { "日期": "2026-06-08", "开始时间": "01:00", "reg_cnt": 100 },
      { "日期": "2026-06-08", "开始时间": "01:30", "reg_cnt": 100 },
      { "日期": "2026-06-08", "开始时间": "02:00", "reg_cnt": 100 },
    ],
    {
      type: "intradayTimePointCompleteness",
      dateColumn: "日期",
      timeColumn: "开始时间",
      column: "reg_cnt",
      timezone: "Asia/Jakarta",
      now: "2026-06-07T20:00:00Z",
      startTime: "00:00",
      intervalMinutes: 30,
      allowedDelayMinutes: 60,
      ignoreDimensionColumns: ["开始时间"],
    },
  );

  assert.deepEqual(result, []);
});

test("evaluateRowsAgainstRule aligns completeness to previous day time points", () => {
  const result = evaluateRowsAgainstRule(
    [
      { "日期": "2026-06-07", "开始时间": "00:30", "reg_cnt": 79 },
      { "日期": "2026-06-07", "开始时间": "01:30", "reg_cnt": 57 },
      { "日期": "2026-06-08", "开始时间": "00:30", "reg_cnt": 67 },
      { "日期": "2026-06-08", "开始时间": "01:30", "reg_cnt": 75 },
    ],
    {
      type: "intradayTimePointCompleteness",
      dateColumn: "日期",
      timeColumn: "开始时间",
      column: "reg_cnt",
      timezone: "Asia/Jakarta",
      now: "2026-06-07T19:00:00Z",
      startTime: "00:00",
      intervalMinutes: 30,
      expectedTimePointSource: "previousDay",
      ignoreDimensionColumns: ["开始时间"],
    },
  );

  assert.deepEqual(result, []);
});

test("evaluateRowsAgainstRule never checks time points after the local execution time", () => {
  const result = evaluateRowsAgainstRule(
    [
      { "日期": "2026-06-07", "开始时间": "08:30", reg_cnt: 100 },
      { "日期": "2026-06-07", "开始时间": "09:30", reg_cnt: 100 },
      { "日期": "2026-06-08", "开始时间": "08:30", reg_cnt: 100 },
    ],
    {
      type: "intradayTimePointCompleteness",
      dateColumn: "日期",
      timeColumn: "开始时间",
      column: "reg_cnt",
      timezone: "Asia/Shanghai",
      now: "2026-06-08T01:00:00Z",
      startTime: "00:00",
      cutoffTime: "23:30",
      intervalMinutes: 30,
      expectedTimePointSource: "previousDay",
      ignoreDimensionColumns: ["开始时间"],
    },
  );

  assert.deepEqual(result, []);
});

test("evaluateRowsAgainstRule excludes future dates for every rule type", () => {
  const result = evaluateRowsAgainstRule(
    [
      { "统计日期": "2026-06-08", value: 10 },
      { "统计日期": "2026-06-09", value: 999 },
    ],
    {
      type: "latestValueOutsideRange",
      dateColumn: "统计日期",
      column: "value",
      max: 100,
      timezone: "Asia/Shanghai",
      now: "2026-06-08T01:00:00Z",
    },
  );

  assert.equal(result, null);
});

test("evaluateRowsAgainstRule applies the execution cutoff before non-intraday rules", () => {
  const result = evaluateRowsAgainstRule(
    [
      { "日期": "2026-06-08", "开始时间": "08:30", value: 10 },
      { "日期": "2026-06-08", "开始时间": "09:30", value: 999 },
    ],
    {
      type: "latestValueOutsideRange",
      dateColumn: "日期",
      timeColumn: "开始时间",
      column: "value",
      max: 100,
      timezone: "Asia/Shanghai",
      now: "2026-06-08T01:00:00Z",
    },
  );

  assert.equal(result, null);
});

test("evaluateRowsAgainstRule ignores future rows in same-time changes", () => {
  const result = evaluateRowsAgainstRule(
    [
      { "日期": "2026-06-07", "开始时间": "08:30", reg_cnt: 100 },
      { "日期": "2026-06-07", "开始时间": "09:30", reg_cnt: 100 },
      { "日期": "2026-06-08", "开始时间": "08:30", reg_cnt: 100 },
      { "日期": "2026-06-08", "开始时间": "09:30", reg_cnt: 1000 },
    ],
    {
      type: "intradaySameTimeChange",
      dateColumn: "日期",
      timeColumn: "开始时间",
      column: "reg_cnt",
      timezone: "Asia/Shanghai",
      now: "2026-06-08T01:00:00Z",
      cutoffTime: "23:30",
      maxAbsChangeRate: 0.2,
      ignoreDimensionColumns: ["开始时间"],
    },
  );

  assert.deepEqual(result, []);
});

test("evaluateRowsAgainstRule checks intraday time point change", () => {
  const result = evaluateRowsAgainstRule(
    [
      { "日期": "2026-06-07", "开始时间": "00:00", "reg_cnt": 100 },
      { "日期": "2026-06-07", "开始时间": "00:30", "reg_cnt": 100 },
      { "日期": "2026-06-08", "开始时间": "00:00", "reg_cnt": 110 },
      { "日期": "2026-06-08", "开始时间": "00:30", "reg_cnt": 130 },
    ],
    {
      type: "intradayTimePointChange",
      dateColumn: "日期",
      timeColumn: "开始时间",
      column: "reg_cnt",
      timezone: "Asia/Jakarta",
      now: "2026-06-07T17:30:00Z",
      startTime: "00:00",
      intervalMinutes: 30,
      maxAbsChangeRate: 0.15,
      minPrevious: 100,
      ignoreDimensionColumns: ["开始时间"],
    },
  );

  assert.deepEqual(result, [
    "同时间点指标「reg_cnt」从 100 到 130，波动 +30.0%；判定：昨日同点波动超过±15.0%；近30天同点样本不足7天时，先按昨日同点阈值触发（Asia/Jakarta 00:30，日期 2026-06-08 对比 2026-06-07）",
  ]);
});

test("evaluateRowsAgainstRule adds monthly time point baseline details", () => {
  const result = evaluateRowsAgainstRule(
    [
      { "日期": "2026-06-01", "开始时间": "00:30", "reg_cnt": 100 },
      { "日期": "2026-06-02", "开始时间": "00:30", "reg_cnt": 100 },
      { "日期": "2026-06-03", "开始时间": "00:30", "reg_cnt": 100 },
      { "日期": "2026-06-04", "开始时间": "00:30", "reg_cnt": 100 },
      { "日期": "2026-06-05", "开始时间": "00:30", "reg_cnt": 100 },
      { "日期": "2026-06-06", "开始时间": "00:30", "reg_cnt": 100 },
      { "日期": "2026-06-07", "开始时间": "00:30", "reg_cnt": 100 },
      { "日期": "2026-06-08", "开始时间": "00:30", "reg_cnt": 180 },
    ],
    {
      type: "intradayTimePointChange",
      dateColumn: "日期",
      timeColumn: "开始时间",
      column: "reg_cnt",
      timezone: "Asia/Jakarta",
      now: "2026-06-07T17:30:00Z",
      startTime: "00:30",
      intervalMinutes: 30,
      maxAbsChangeRate: 0.5,
      baselineLookbackDays: 30,
      baselineMinSamples: 7,
      baselineMaxAbsChangeRate: 0.5,
      minPrevious: 100,
      ignoreDimensionColumns: ["开始时间"],
    },
  );

  assert.deepEqual(result, [
    "同时间点指标「reg_cnt」从 100 到 180，波动 +80.0%；近30天同点中位数 100（样本7天），较基线 +80.0%；判定：昨日同点波动超过±50.0%，且近30天同点中位数波动超过±50.0%，两项同时命中才触发（Asia/Jakarta 00:30，日期 2026-06-08 对比 2026-06-07）",
  ]);
});

test("evaluateRowsAgainstRule detects previous day time point drop against baseline after current day recovers", () => {
  const result = evaluateRowsAgainstRule(
    [
      { "日期": "2026-06-01", "开始时间": "00:30", "launch_num": 100 },
      { "日期": "2026-06-02", "开始时间": "00:30", "launch_num": 100 },
      { "日期": "2026-06-03", "开始时间": "00:30", "launch_num": 100 },
      { "日期": "2026-06-04", "开始时间": "00:30", "launch_num": 100 },
      { "日期": "2026-06-05", "开始时间": "00:30", "launch_num": 100 },
      { "日期": "2026-06-06", "开始时间": "00:30", "launch_num": 100 },
      { "日期": "2026-06-07", "开始时间": "00:30", "launch_num": 100 },
      { "日期": "2026-06-08", "开始时间": "00:30", "launch_num": 20 },
      { "日期": "2026-06-09", "开始时间": "00:30", "launch_num": 100 },
    ],
    {
      type: "intradayTimePointChange",
      dateColumn: "日期",
      timeColumn: "开始时间",
      column: "launch_num",
      timezone: "Asia/Jakarta",
      now: "2026-06-08T17:30:00Z",
      startTime: "00:30",
      intervalMinutes: 30,
      maxAbsChangeRate: 0.5,
      baselineLookbackDays: 30,
      baselineMinSamples: 7,
      baselineMaxAbsChangeRate: 0.5,
      scanPreviousDateAgainstBaseline: true,
      minPrevious: 10,
      ignoreDimensionColumns: ["开始时间"],
    },
  );

  assert.deepEqual(result, [
    "上一日同时间点指标「launch_num」为 20，近30天同点中位数 100（样本7天），较基线 -80.0%；判定：上一日同点相对近30天基线波动超过±50.0%（Asia/Jakarta 00:30，日期 2026-06-08）",
  ]);
});

test("evaluateRowsAgainstRule checks explicit empty data rule", () => {
  const result = evaluateRowsAgainstRule([], {
    type: "notEmpty",
    message: "这张表没有值",
  });

  assert.equal(result, "这张表没有值");
});

test("evaluateRowsAgainstRule detects rows with empty metric columns", () => {
  const result = evaluateRowsAgainstRule(
    [
      { "统计日期": "2026-07-13", "还款数": null, "还款~复借": null },
      { "统计日期": "2026-07-14", "还款数": "", "还款~复借": null },
    ],
    {
      type: "notEmpty",
      columns: ["还款数", "还款~复借"],
    },
  );

  assert.equal(result, "指标列没有有效数值：还款数、还款~复借");
});

test("evaluateRowsAgainstRule treats zero metric value as non-empty", () => {
  const result = evaluateRowsAgainstRule(
    [{ "统计日期": "2026-07-14", "还款数": 0, "还款~复借": null }],
    {
      type: "notEmpty",
      columns: ["还款数", "还款~复借"],
    },
  );

  assert.equal(result, null);
});

test("evaluateRowsAgainstRule treats percent string metric value as non-empty", () => {
  const result = evaluateRowsAgainstRule(
    [{ "统计日期": "2026-07-14", "还款数": "1,532", "还款~复借": "13.2%" }],
    {
      type: "notEmpty",
      columns: ["还款数", "还款~复借"],
    },
  );

  assert.equal(result, null);
});
