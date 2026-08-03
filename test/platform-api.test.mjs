import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createPlatformApi,
  flattenInventory,
} from "../src/platform-api.mjs";

test("Wattrel n8n gateway keeps MySQL column headers for row mapping", async () => {
  const workflow = await fs.readFile(new URL("../n8n-wattrel-query-gateway.json", import.meta.url), "utf8");
  const client = await fs.readFile(new URL("../src/wattrel-client.mjs", import.meta.url), "utf8");
  assert.match(workflow, /mysql --batch --raw --column-names --host/);
  assert.doesNotMatch(workflow, /mysql --batch --raw --silent --host=/);
  assert.doesNotMatch(client, /"--silent"/);
  assert.match(client, /request\.setTimeout\(/);
});

async function makeFixture() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "duty-platform-"));
  await fs.mkdir(path.join(rootDir, "config"), { recursive: true });
  await fs.writeFile(
    path.join(rootDir, "config/countries.config.json"),
    JSON.stringify({
      countries: [{ code: "INE", name: "印尼", timezone: "Asia/Jakarta", status: "ready" }],
    }),
  );
  await fs.writeFile(
    path.join(rootDir, "config/public-monitor.config.json"),
    JSON.stringify({
      alerts: { channel: "tv", webhookUrl: "${TV_ALERT_WEBHOOK_URL}" },
      rules: [
        {
          type: "requiredDatePresent",
          dashboardTitle: "OKR",
          cardTitles: ["规模"],
          dateColumn: "统计日期",
          now: "2026-07-06T08:00:00.000Z",
        },
      ],
    }),
  );
  await fs.writeFile(
    path.join(rootDir, "config/discovered-public-dashboards.ready.json"),
    JSON.stringify({
      dashboardCount: 1,
      dashboards: [
        {
          countryCode: "INE",
          countryName: "印尼",
          title: "OKR",
          uuid: "dash-1",
          url: "https://data.example/public/dashboard/dash-1",
          cards: [
            {
              title: "规模",
              cardId: 1,
              dashcardId: 2,
              columns: ["统计日期", "注册数"],
              sampleRows: [{ "统计日期": "2026-07-06", "注册数": 10 }],
              queryStatus: "ok",
            },
          ],
        },
      ],
    }),
  );
  await fs.writeFile(
    path.join(rootDir, "config/public-check-result.ready.json"),
    JSON.stringify({
      checkedAt: "2026-07-06T00:00:00.000Z",
      anomalyCount: 0,
      checkedCardCount: 1,
      anomalies: [],
    }),
  );
  return rootDir;
}

test("flattenInventory returns dashboard and card counts", () => {
  const flat = flattenInventory({
    dashboards: [
      { title: "A", cards: [{ title: "C1" }, { title: "C2" }] },
      { title: "B", cards: [] },
    ],
  });

  assert.equal(flat.dashboardCount, 2);
  assert.equal(flat.cardCount, 2);
});

test("platform api returns summary and inventory", async () => {
  const rootDir = await makeFixture();
  const api = createPlatformApi({ rootDir });

  const summary = await api.getSummary();
  assert.equal(summary.countryCount, 1);
  assert.equal(summary.dashboardCount, 1);
  assert.equal(summary.cardCount, 1);
  assert.equal(summary.ruleCount, 1);

  const inventory = await api.getInventory({ countryCode: "INE", q: "规模" });
  assert.equal(inventory.dashboards.length, 1);
  assert.equal(inventory.dashboards[0].cards.length, 1);
});

test("platform api hydrates fluctuation series from saved dashboard card", async () => {
  const rootDir = await makeFixture();
  const inventoryPath = path.join(rootDir, "config/discovered-public-dashboards.ready.json");
  await fs.writeFile(
    inventoryPath,
    JSON.stringify({
      dashboardCount: 1,
      dashboards: [{
        countryCode: "MX",
        countryName: "墨西哥",
        sourcePanelTitle: "OKR",
        title: "Dashboard",
        uuid: "dash-mx",
        url: "https://data.example/public/dashboard/dash-mx",
        parameters: [{
          id: "date-param",
          name: "统计日期",
          type: "date/all-options",
          default: "past30days~",
        }, {
          id: "app-param",
          name: "app",
          type: "category",
          default: "all-apps",
        }],
        cards: [{
          title: "规模",
          cardId: 11,
          dashcardId: 22,
          visualizationSettings: {
            column_settings: {
              "[\"name\",\"注册数\"]": { number_style: "decimal" },
            },
          },
          parameterMappings: [{
            parameter_id: "date-param",
            target: ["dimension", ["template-tag", "stat_date"], { "stage-number": 0 }],
          }, {
            parameter_id: "app-param",
            target: ["dimension", ["template-tag", "app"], { "stage-number": 0 }],
          }],
        }],
      }],
    }),
  );
  await fs.writeFile(
    path.join(rootDir, "config/public-monitor.config.json"),
    JSON.stringify({
      rules: [{
        type: "completeDayChange",
        dashboardTitle: "OKR",
        cardTitle: "规模",
        dateColumn: "统计日期",
        columns: ["注册数"],
      }],
    }),
  );
  const calls = [];
  const api = createPlatformApi({
    rootDir,
    metabaseClientFactory: () => ({
      async queryDashcardJson(request) {
        calls.push(request);
        return [
          { "统计日期": "2026-07-01", "注册数": 100 },
          { "统计日期": "2026-07-02", "注册数": 110 },
          { "统计日期": "2026-07-03", "注册数": 220 },
        ];
      },
    }),
  });

  const result = await api.getFluctuationVisualSeries({
    anomaly: {
      countryCode: "MX",
      dashboardUuid: "dash-mx",
      dashboardUrl: "https://data.example/public/dashboard/dash-mx?app=MEX023&%E7%BB%9F%E8%AE%A1%E6%97%A5%E6%9C%9F=past90days~",
      dashboardTitle: "OKR",
      cardTitle: "规模",
      cardId: 11,
      dashcardId: 22,
      type: "completeDayChange",
      message: "完整日指标「注册数」从 110 到 220，波动 +100.0%（统计日期 2026-07-03 对比 2026-07-02）",
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].dashboardUuid, "dash-mx");
  assert.equal(calls[0].cardId, 11);
  const parametersById = new Map(calls[0].parameters.map((parameter) => [parameter.id, parameter.value]));
  assert.equal(parametersById.get("date-param"), "past15days~");
  assert.equal(parametersById.get("app-param"), "MEX023");
  assert.deepEqual(result.series.map((point) => [point.date, point.value, point.anomaly]), [
    ["2026-07-01", 100, false],
    ["2026-07-02", 110, false],
    ["2026-07-03", 220, true],
  ]);
  assert.deepEqual(result.series.map((point) => point.percent), [false, false, false]);
});

test("platform api marks hydrated fluctuation series as percent from card visualization settings", async () => {
  const rootDir = await makeFixture();
  await fs.writeFile(
    path.join(rootDir, "config/discovered-public-dashboards.ready.json"),
    JSON.stringify({
      dashboardCount: 1,
      dashboards: [{
        countryCode: "MX",
        countryName: "墨西哥",
        sourcePanelTitle: "新客转化率(注册~放款)",
        uuid: "dash-mx-rate",
        url: "https://data.example/public/dashboard/dash-mx-rate",
        parameters: [],
        cards: [{
          title: "分app趋势",
          cardId: 12,
          dashcardId: 23,
          visualizationSettings: {
            column_settings: {
              "[\"name\",\"注册-放款率\"]": { number_style: "percent" },
            },
          },
          parameterMappings: [],
        }],
      }],
    }),
  );
  await fs.writeFile(
    path.join(rootDir, "config/public-monitor.config.json"),
    JSON.stringify({
      rules: [{
        type: "completeDayChange",
        dashboardTitle: "新客转化率(注册~放款)",
        cardTitle: "分app趋势",
        dateColumn: "注册日期",
        columns: ["注册-放款率"],
      }],
    }),
  );
  const api = createPlatformApi({
    rootDir,
    metabaseClientFactory: () => ({
      async queryDashcardJson() {
        return [
          { "注册日期": "2026-07-01", "注册-放款率": 0.1 },
          { "注册日期": "2026-07-02", "注册-放款率": 0.2 },
        ];
      },
    }),
  });

  const result = await api.getFluctuationVisualSeries({
    anomaly: {
      countryCode: "MX",
      dashboardUuid: "dash-mx-rate",
      cardId: 12,
      dashcardId: 23,
      type: "completeDayChange",
      message: "完整日指标「注册-放款率」从 10.0% 到 20.0%（统计日期 2026-07-02 对比 2026-07-01）",
    },
  });

  assert.deepEqual(result.series.map((point) => point.percent), [true, true]);
});

test("platform api hydrates hourly fluctuation series with dashboard timezone", async () => {
  const rootDir = await makeFixture();
  await fs.writeFile(
    path.join(rootDir, "config/discovered-public-dashboards.ready.json"),
    JSON.stringify({
      dashboardCount: 1,
      dashboards: [{
        countryCode: "PK",
        countryName: "巴基斯坦",
        sourcePanelTitle: "每小时监控",
        uuid: "dash-pk-hourly",
        url: "https://data.example/dashboard/1053",
        timezone: "Asia/Karachi",
        parameters: [{ id: "date-filter", type: "date/all-options", default: "past1days~" }],
        cards: [{
          title: "进件 - 老客",
          cardId: 1053,
          dashcardId: 2053,
          parameterMappings: [{
            parameter_id: "date-filter",
            target: ["dimension", ["template-tag", "date"], { "stage-number": 0 }],
          }],
        }],
      }],
    }),
  );
  await fs.writeFile(
    path.join(rootDir, "config/public-monitor.config.json"),
    JSON.stringify({
      rules: [{
        type: "intradayTimePointChange",
        dashboardTitle: "每小时监控",
        cardTitle: "进件 - 老客",
        dateColumn: "日期",
        columns: ["0", "1", "2"],
        timezone: "dashboard",
      }],
    }),
  );
  const api = createPlatformApi({
    rootDir,
    metabaseClientFactory: () => ({
      async queryDashcardJson(request) {
        assert.equal(request.parameters[0].value, "past15days~");
        return [
          { "日期": "2026-07-30", "0": 10, "1": 0, "2": 20 },
        ];
      },
    }),
  });

  const result = await api.getFluctuationVisualSeries({
    anomaly: {
      countryCode: "PK",
      dashboardUuid: "dash-pk-hourly",
      cardId: 1053,
      dashcardId: 2053,
      type: "latestNonZeroToZero",
      message: "同时间点指标「1」从 99 到 0，波动 -100.0%（Asia/Karachi 01:00，日期 2026-07-30 对比 2026-07-29）",
    },
  });

  assert.deepEqual(result.series.map((point) => [point.label, point.value, point.anomaly, point.timezone]), [
    ["00:00", 10, false, "Asia/Karachi"],
    ["01:00", 0, true, "Asia/Karachi"],
    ["02:00", 20, false, "Asia/Karachi"],
  ]);
});

test("platform api analyzes and caches a saved Metabase anomaly", async () => {
  const rootDir = await makeFixture();
  await fs.writeFile(
    path.join(rootDir, "config/batch-check-run-history.json"),
    JSON.stringify({
      runs: [{
        id: "run-agent-1",
        startedAt: "2026-07-27T00:00:00.000Z",
        runs: [{
          countryCode: "INE",
          countryName: "印尼",
          ok: true,
          result: {
            anomalies: [{ dashboardTitle: "OKR", dashboardUuid: "dash-1", cardTitle: "规模", type: "latestNonZeroToZero", message: "指标从 10 降为 0" }],
          },
        }],
      }],
    }),
  );
  let calls = 0;
  const api = createPlatformApi({
    rootDir,
    metabaseAnomalyAgentFn: async ({ anomaly, context }) => {
      calls += 1;
      assert.equal(anomaly.cardTitle, "规模");
      assert.equal(context.countryCode, "INE");
      return { model: "test-model", analysis: { summary: "数据归零", possibleCauses: [], verificationSteps: [], recommendedActions: [], confidence: "low", limitations: "测试" } };
    },
  });

  const first = await api.analyzeMetabaseAnomaly({ runId: "run-agent-1", countryCode: "INE", anomalyIndex: 0 });
  const second = await api.analyzeMetabaseAnomaly({ runId: "run-agent-1", countryCode: "INE", anomalyIndex: 0 });

  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(calls, 1);
  const saved = JSON.parse(await fs.readFile(path.join(rootDir, "config/metabase-anomaly-analyses.json"), "utf8"));
  assert.equal(saved.analyses.length, 1);

  const forced = await api.analyzeMetabaseAnomaly({ runId: "run-agent-1", countryCode: "INE", anomalyIndex: 0, force: true });
  assert.equal(forced.cached, false);
  assert.equal(calls, 2);
});

test("platform api queues every anomaly from the same dashboard for independent AI analysis", async () => {
  const rootDir = await makeFixture();
  await fs.writeFile(
    path.join(rootDir, "config/batch-check-run-history.json"),
    JSON.stringify({ runs: [{
      id: "run-all-dashboard-anomalies",
      runs: [{
        countryCode: "INE",
        countryName: "印尼",
        ok: true,
        result: {
          anomalies: [
            { dashboardTitle: "OKR", dashboardUuid: "dash-1", cardTitle: "放款金额", message: "金额归零" },
            { dashboardTitle: "OKR", dashboardUuid: "dash-1", cardTitle: "放款件数", message: "件数归零" },
          ],
        },
      }],
    }] }),
  );
  const previousEnv = {
    METABASE_ANOMALY_AGENT_N8N_WEBHOOK_URL: process.env.METABASE_ANOMALY_AGENT_N8N_WEBHOOK_URL,
    METABASE_ANOMALY_AGENT_N8N_TOKEN: process.env.METABASE_ANOMALY_AGENT_N8N_TOKEN,
    METABASE_ANOMALY_AGENT_CALLBACK_TOKEN: process.env.METABASE_ANOMALY_AGENT_CALLBACK_TOKEN,
  };
  process.env.METABASE_ANOMALY_AGENT_N8N_WEBHOOK_URL = "https://n8n.example/webhook/agent";
  process.env.METABASE_ANOMALY_AGENT_N8N_TOKEN = "test-token";
  process.env.METABASE_ANOMALY_AGENT_CALLBACK_TOKEN = "callback-token";
  const received = [];
  const api = createPlatformApi({
    rootDir,
    metabaseAnomalyAgentFn: async ({ anomaly, context }) => {
      received.push({ anomaly, context });
      return { analysis: { summary: `${anomaly.cardTitle} 已独立核验`, confidence: "high" } };
    },
  });

  try {
    const result = await api.triggerDashboardGroupedAnalysis("run-all-dashboard-anomalies", [{
      countryCode: "INE",
      countryName: "印尼",
      ok: true,
      result: {
        anomalies: [
          { dashboardTitle: "OKR", dashboardUuid: "dash-1", cardTitle: "放款金额", message: "金额归零" },
          { dashboardTitle: "OKR", dashboardUuid: "dash-1", cardTitle: "放款件数", message: "件数归零" },
        ],
      },
    }]);

    assert.equal(result.triggered, 2);
    assert.equal(result.totalAnomalies, 2);
    assert.deepEqual(received.map(({ anomaly }) => anomaly.cardTitle), ["放款金额", "放款件数"]);
    assert.ok(received.every(({ context }) => context.sameDashboardAnomalies.length === 2));
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("platform api stores an async Metabase evidence job and accepts its callback", async () => {
  const rootDir = await makeFixture();
  await fs.writeFile(
    path.join(rootDir, "config/batch-check-run-history.json"),
    JSON.stringify({ runs: [{
      id: "run-agent-callback", startedAt: "2026-07-28T00:00:00.000Z",
      runs: [{ countryCode: "INE", countryName: "印尼", result: { anomalies: [{ dashboardTitle: "OKR", cardTitle: "规模", message: "指标从 10 降为 0" }] } }],
    }] }),
  );
  const api = createPlatformApi({
    rootDir,
    metabaseAnomalyAgentFn: async () => ({ pending: true, jobId: "job-callback", provider: "n8n-evidence" }),
  });
  const started = await api.analyzeMetabaseAnomaly({ runId: "run-agent-callback", countryCode: "INE", anomalyIndex: 0 });
  assert.equal(started.status, "pending");
  const completed = await api.completeMetabaseAnomalyAnalysis({
    runId: "run-agent-callback", countryCode: "INE", anomalyIndex: 0, jobId: "job-callback",
    analysis: { summary: "DWD 分区缺失", confidence: "high", dataSideVerdict: "data_issue", notificationAction: "send" },
    evidence: { evidenceChain: Array.from({ length: 20 }, (_, index) => ({ kind: "trace_lineage", table: `dwd_example_${index}`, result: { quality: "producer_sql" } })), dsStatus: "failed" },
  });
  assert.equal(completed.status, "completed");
  assert.equal(completed.analysis.dataSideVerdict, "data_issue");
  assert.equal(completed.evidence.dsStatus, "failed");
  assert.ok(completed.evidence);
  assert.equal(completed.evidence.evidenceChain.length, 20);
  assert.equal(completed.evidence.evidenceChain[0].result.quality, "producer_sql");

  const lowercaseCountryCallback = await api.completeMetabaseAnomalyAnalysis({
    runId: "run-agent-callback", countryCode: "ine", anomalyIndex: 0, jobId: "job-callback",
    analysis: { summary: "小写国家码回调", confidence: "medium" },
  });
  assert.equal(lowercaseCountryCallback.countryCode, "INE");
  assert.equal(lowercaseCountryCallback.analysis.summary, "小写国家码回调");

  await assert.rejects(
    () => api.completeMetabaseAnomalyAnalysis({
      runId: "run-agent-callback", countryCode: "INE", anomalyIndex: 0,
      analysis: { summary: "缺少任务编号" },
    }),
    (error) => error.statusCode === 400,
  );
});

test("platform api force retries a pending Metabase evidence job", async () => {
  const rootDir = await makeFixture();
  await fs.writeFile(
    path.join(rootDir, "config/batch-check-run-history.json"),
    JSON.stringify({ runs: [{
      id: "run-agent-force-pending",
      runs: [{ countryCode: "INE", result: { anomalies: [{ dashboardTitle: "OKR", cardTitle: "规模", message: "指标归零" }] } }],
    }] }),
  );
  let calls = 0;
  const api = createPlatformApi({
    rootDir,
    metabaseAnomalyAgentFn: async () => ({ pending: true, jobId: `job-${++calls}`, provider: "n8n-evidence" }),
  });

  const first = await api.analyzeMetabaseAnomaly({ runId: "run-agent-force-pending", countryCode: "INE", anomalyIndex: 0 });
  const cached = await api.analyzeMetabaseAnomaly({ runId: "run-agent-force-pending", countryCode: "INE", anomalyIndex: 0 });
  const forced = await api.analyzeMetabaseAnomaly({ runId: "run-agent-force-pending", countryCode: "INE", anomalyIndex: 0, force: true });

  assert.equal(first.jobId, "job-1");
  assert.equal(cached.cached, true);
  assert.equal(forced.jobId, "job-2");
  assert.equal(forced.cached, false);
  assert.equal(calls, 2);
});

test("platform api proxies a saved anomaly card through its Metabase readonly client", async () => {
  const rootDir = await makeFixture();
  await fs.writeFile(
    path.join(rootDir, "config/batch-check-run-history.json"),
    JSON.stringify({ runs: [{
      id: "run-agent-card", runs: [{ countryCode: "PH", result: { anomalies: [{ cardId: 99, cardTitle: "放款", dashboardUrl: "https://data.kuainiu.io/dashboard/123" }] } }],
    }] }),
  );
  let receivedBaseUrl = "";
  const api = createPlatformApi({
    rootDir,
    metabaseInternalClientFactory: (baseUrl) => ({
      getCard: async (cardId) => {
        receivedBaseUrl = baseUrl;
        assert.equal(cardId, 99);
        return { id: 99, name: "放款", database_id: 2, dataset_query: { native: { query: "SELECT * FROM dwd_loan" } } };
      },
    }),
  });
  const result = await api.getMetabaseAnomalyCardSql({ runId: "run-agent-card", countryCode: "ph", anomalyIndex: 0 });
  assert.equal(receivedBaseUrl, "http://172.16.0.212:80");
  assert.equal(result.card.dataset_query.native.query, "SELECT * FROM dwd_loan");
});

test("platform api deduplicates concurrent Metabase evidence requests", async () => {
  const rootDir = await makeFixture();
  await fs.writeFile(
    path.join(rootDir, "config/batch-check-run-history.json"),
    JSON.stringify({ runs: [{
      id: "run-agent-concurrent", startedAt: "2026-07-28T00:00:00.000Z",
      runs: [{ countryCode: "MX", countryName: "墨西哥", result: { anomalies: [{ dashboardTitle: "OKR", cardTitle: "放款", message: "归零" }] } }],
    }] }),
  );
  let calls = 0;
  const api = createPlatformApi({
    rootDir,
    metabaseAnomalyAgentFn: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { pending: true, jobId: "job-concurrent", provider: "n8n-evidence" };
    },
  });
  const [first, second] = await Promise.all([
    api.analyzeMetabaseAnomaly({ runId: "run-agent-concurrent", countryCode: "mx", anomalyIndex: 0 }),
    api.analyzeMetabaseAnomaly({ runId: "run-agent-concurrent", countryCode: "MX", anomalyIndex: 0 }),
  ]);
  assert.equal(calls, 1);
  assert.equal(first.countryCode, "MX");
  assert.equal(second.pending, true);
});

test("platform api preserves an n8n callback that arrives before its pending job is written", async () => {
  const rootDir = await makeFixture();
  await fs.writeFile(
    path.join(rootDir, "config/batch-check-run-history.json"),
    JSON.stringify({ runs: [{
      id: "run-early-callback", startedAt: "2026-07-28T00:00:00.000Z",
      runs: [{ countryCode: "PH", countryName: "菲律宾", result: { anomalies: [{ dashboardTitle: "OKR", cardTitle: "放款", message: "指标归零" }] } }],
    }] }),
  );
  let api;
  api = createPlatformApi({
    rootDir,
    metabaseAnomalyAgentFn: async () => {
      await api.completeMetabaseAnomalyAnalysis({
        runId: "run-early-callback", countryCode: "PH", anomalyIndex: 0, jobId: "job-early",
        analysis: { summary: "底表已核查", confidence: "high", dataSideVerdict: "data_issue" },
      });
      return { pending: true, jobId: "job-early", provider: "n8n-evidence" };
    },
  });
  const result = await api.analyzeMetabaseAnomaly({ runId: "run-early-callback", countryCode: "PH", anomalyIndex: 0 });
  assert.equal(result.status, "completed");
  assert.equal(result.callbackReceivedBeforePending, true);
  assert.equal(result.analysis.summary, "底表已核查");
});

test("platform api merges pending panel sources into the dashboard inventory", async () => {
  const rootDir = await makeFixture();
  await fs.copyFile(
    path.join(rootDir, "config/discovered-public-dashboards.ready.json"),
    path.join(rootDir, "config/discovered-public-dashboards.json"),
  );
  await fs.writeFile(
    path.join(rootDir, "config/discovered-panels.json"),
    JSON.stringify({
      panels: [
        {
          id: 10,
          title: "OKR",
          links: [{ url: "https://data.example/public/dashboard/dash-1" }],
        },
        {
          id: 11,
          title: "每小时监控",
          links: [{ url: "https://data.kuainiu.io/dashboard/1206" }],
        },
      ],
    }),
  );
  const api = createPlatformApi({ rootDir });

  const inventory = await api.getInventory({ countryCode: "INE" });

  assert.equal(inventory.dashboards.length, 2);
  assert.equal(inventory.dashboards.find((item) => item.uuid === "dash-1").availability, "ready");
  const pending = inventory.dashboards.find((item) => Number(item.dashboardId) === 1206);
  assert.equal(pending.availability, "pending_discovery");
  assert.equal(pending.executable, false);
  assert.equal(pending.sourcePanelId, 11);
});

test("platform api explicitly discovers and persists one country inventory", async () => {
  const rootDir = await makeFixture();
  await fs.writeFile(
    path.join(rootDir, "config/discovered-panels.json"),
    JSON.stringify({ panels: [{ id: 8, title: "资产管理-提前还款监控", links: [{ url: "https://data.kuainiu.io/dashboard/1052" }] }] }),
  );
  const api = createPlatformApi({
    rootDir,
    discoverDashboardsFn: async () => ({
      country: { code: "INE", name: "印尼" },
      dashboards: [{
        countryCode: "INE",
        title: "提前还款监控",
        dashboardId: 1052,
        uuid: "internal:1052",
        cards: [{ title: "小时指标", cardId: 1, dashcardId: 2 }],
      }],
    }),
  });

  const result = await api.discoverCountryDashboards("INE");

  assert.equal(result.ok, true);
  assert.equal(result.discoveredDashboardCount, 1);
  const saved = JSON.parse(await fs.readFile(path.join(rootDir, "config/discovered-public-dashboards.ine.json"), "utf8"));
  assert.equal(saved.dashboards[0].dashboardId, 1052);
});

test("country discovery assigns country metadata when Metabase source omits it", async () => {
  const rootDir = await makeFixture();
  await fs.writeFile(
    path.join(rootDir, "config/discovered-panels.json"),
    JSON.stringify({ panels: [{ id: 11, title: "每小时监控", links: [{ url: "https://data.kuainiu.io/dashboard/1052" }] }] }),
  );
  const api = createPlatformApi({
    rootDir,
    discoverDashboardsFn: async () => ({
      dashboards: [{
        title: "每小时监控",
        dashboardId: 1052,
        uuid: "internal:1052",
        sourcePanelId: 11,
        cards: [{ title: "小时指标", cardId: 1, dashcardId: 2 }],
      }],
    }),
  });

  await api.discoverCountryDashboards("INE");
  const inventory = await api.getInventory({ countryCode: "INE" });
  const hourly = inventory.dashboards.find((item) => Number(item.dashboardId) === 1052);

  assert.equal(hourly.countryCode, "INE");
  assert.equal(hourly.countryName, "印尼");
  assert.equal(hourly.executable, true);
  assert.equal(hourly.cards.length, 1);
});

test("platform api discovers all configured countries and isolates failures", async () => {
  const rootDir = await makeFixture();
  await fs.writeFile(
    path.join(rootDir, "config/countries.config.json"),
    JSON.stringify({ countries: [{ code: "INE", name: "印尼" }, { code: "PH", name: "菲律宾" }] }),
  );
  let attempts = 0;
  const api = createPlatformApi({
    rootDir,
    discoverDashboardsFn: async ({ inputFile }) => {
      attempts += 1;
      if (inputFile.endsWith(".ph.json")) throw new Error("Metabase authentication failed");
      return { dashboards: [] };
    },
  });

  const result = await api.discoverAllCountryDashboards();

  assert.equal(attempts, 2);
  assert.equal(result.total, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.results.find((item) => item.countryCode === "PH").ok, false);
  assert.match(result.results.find((item) => item.countryCode === "PH").error, /authentication failed/);
});

test("platform api starts all-country discovery in the background and exposes progress", async () => {
  const rootDir = await makeFixture();
  let resolveDiscovery;
  let markRequested;
  const requested = new Promise((resolve) => { markRequested = resolve; });
  const api = createPlatformApi({
    rootDir,
    discoverDashboardsFn: async () => new Promise((resolve) => {
      resolveDiscovery = resolve;
      markRequested();
    }),
  });

  const started = api.startDiscoverAllCountryDashboards();
  const pending = api.getDiscoverAllCountryDashboardsProgress();

  assert.equal(started.started, true);
  assert.equal(pending.status, "running");
  await requested;
  resolveDiscovery({ dashboards: [] });
  await started.completed;
  assert.equal(api.getDiscoverAllCountryDashboardsProgress().status, "completed");
});

test("platform api skips INE when its default inventory already contains every source dashboard", async () => {
  const rootDir = await makeFixture();
  await fs.copyFile(
    path.join(rootDir, "config/discovered-public-dashboards.ready.json"),
    path.join(rootDir, "config/discovered-public-dashboards.json"),
  );
  await fs.writeFile(
    path.join(rootDir, "config/discovered-panels.json"),
    JSON.stringify({ panels: [{ id: 1, links: [{ url: "https://data.example/public/dashboard/dash-1" }] }] }),
  );
  let attempts = 0;
  const api = createPlatformApi({
    rootDir,
    discoverDashboardsFn: async () => {
      attempts += 1;
      return { dashboards: [] };
    },
  });

  const result = await api.discoverAllCountryDashboards();

  assert.equal(attempts, 0);
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.results[0], { ok: true, skipped: true, countryCode: "INE" });
});

test("platform api adds a manual Metabase dashboard as pending without discovery", async () => {
  const rootDir = await makeFixture();
  let discoveries = 0;
  const api = createPlatformApi({
    rootDir,
    discoverDashboardsFn: async () => {
      discoveries += 1;
      return { dashboards: [] };
    },
  });

  const added = await api.addManualDashboard({
    countryCode: "INE",
    title: "手动核心看板",
    url: "https://data.example/public/dashboard/manual-uuid",
  });
  const inventory = await api.getInventory({ countryCode: "INE" });
  const dashboard = inventory.dashboards.find((item) => item.title === "手动核心看板");

  assert.equal(discoveries, 0);
  assert.equal(added.availability, "pending_discovery");
  assert.equal(dashboard.executable, false);
  assert.equal(dashboard.url, "https://data.example/public/dashboard/manual-uuid");
});

test("platform api rejects manual links that are not Metabase dashboards", async () => {
  const rootDir = await makeFixture();
  const api = createPlatformApi({ rootDir });

  await assert.rejects(
    () => api.addManualDashboard({
      countryCode: "INE",
      title: "不是看板",
      url: "https://example.com/collection/12",
    }),
    (error) => error.statusCode === 400 && error.errors.some((message) => message.includes("/public/dashboard")),
  );
});

test("platform api discovers only the selected manual dashboard and preserves other dashboards", async () => {
  const rootDir = await makeFixture();
  const requestedPanels = [];
  const api = createPlatformApi({
    rootDir,
    discoverDashboardsFn: async ({ inputFile }) => {
      const source = JSON.parse(await fs.readFile(inputFile, "utf8"));
      requestedPanels.push(source.panels);
      const panel = source.panels[0];
      return {
        dashboards: [{
          countryCode: "INE",
          countryName: "印尼",
          sourcePanelId: panel.id,
          sourcePanelTitle: panel.title,
          title: panel.title,
          uuid: "manual-uuid",
          url: panel.links[0].url,
          cards: [{ title: "新增卡片", cardId: 12, dashcardId: 13 }],
        }],
      };
    },
  });
  const added = await api.addManualDashboard({
    countryCode: "INE",
    title: "手动核心看板",
    url: "https://data.example/public/dashboard/manual-uuid",
  });

  const result = await api.discoverManualDashboard({ countryCode: "INE", sourcePanelId: added.sourcePanelId });
  const inventory = await api.getInventory({ countryCode: "INE" });

  assert.equal(requestedPanels.length, 1);
  assert.equal(requestedPanels[0].length, 1);
  assert.equal(requestedPanels[0][0].id, added.sourcePanelId);
  assert.equal(result.executableDashboardCount, 1);
  assert.equal(inventory.dashboards.find((item) => item.title === "手动核心看板").executable, true);
  assert.ok(inventory.dashboards.find((item) => item.title === "OKR"));
});

test("platform api does not duplicate a ready internal dashboard from panel sources", async () => {
  const rootDir = await makeFixture();
  await fs.writeFile(
    path.join(rootDir, "config/discovered-public-dashboards.ready.json"),
    JSON.stringify({
      dashboards: [{
        countryCode: "INE",
        countryName: "印尼",
        title: "每小时监控",
        dashboardId: 1206,
        uuid: "internal:1206",
        url: "https://data.kuainiu.io/dashboard/1206",
        cards: [{ title: "小时指标", cardId: 1, dashcardId: 2 }],
      }],
    }),
  );
  await fs.writeFile(
    path.join(rootDir, "config/discovered-panels.json"),
    JSON.stringify({
      panels: [{
        id: 11,
        title: "每小时监控",
        links: [{ url: "https://data.kuainiu.io/dashboard/1206?日期=past15days~" }],
      }],
    }),
  );
  const api = createPlatformApi({ rootDir });

  const inventory = await api.getInventory({ countryCode: "INE" });

  assert.equal(inventory.dashboards.length, 1);
  assert.equal(inventory.dashboards[0].availability, "ready");
  assert.equal(inventory.dashboards[0].executable, true);
  assert.equal(inventory.dashboards[0].sourcePanelId, 11);
});

test("platform api lets country inventory override stale ready inventory", async () => {
  const rootDir = await makeFixture();
  await fs.writeFile(
    path.join(rootDir, "config/discovered-public-dashboards.ready.json"),
    JSON.stringify({
      dashboards: [
        {
          countryCode: "MX",
          countryName: "墨西哥",
          access: "public",
          title: "放款统计",
          uuid: "old-public-mx-loan",
          url: "https://data.kuainiu.io/public/dashboard/old-public-mx-loan",
          cards: [{ title: "旧卡片", cardId: 1, dashcardId: 2 }],
        },
        {
          countryCode: "INE",
          countryName: "印尼",
          access: "public",
          title: "OKR",
          uuid: "dash-ine",
          url: "https://data.kuainiu.io/public/dashboard/dash-ine",
          cards: [{ title: "规模", cardId: 3, dashcardId: 4 }],
        },
      ],
    }),
  );
  await fs.writeFile(
    path.join(rootDir, "config/discovered-public-dashboards.mx.json"),
    JSON.stringify({
      country: { code: "MX", name: "墨西哥" },
      dashboards: [
        {
          countryCode: "MX",
          countryName: "墨西哥",
          access: "internal",
          title: "资产管理-放款统计",
          dashboardId: "280",
          uuid: "internal-280",
          url: "https://data.kuainiu.io/dashboard/280",
          sourceUrl: "https://data.kuainiu.io/dashboard/280",
          cards: [{ title: "新卡片", cardId: 5, dashcardId: 6 }],
        },
        {
          countryCode: "MX",
          countryName: "墨西哥",
          access: "public",
          title: "放款统计",
          uuid: "stale-country-public-mx-loan",
          url: "https://data.kuainiu.io/public/dashboard/stale-country-public-mx-loan",
          cards: [{ title: "残留卡片", cardId: 7, dashcardId: 8 }],
        },
      ],
    }),
  );
  await fs.writeFile(
    path.join(rootDir, "config/discovered-panels.mx.json"),
    JSON.stringify({
      country: { code: "MX", name: "墨西哥" },
      panels: [
        {
          title: "资产管理-放款统计",
          links: [{ url: "https://data.kuainiu.io/dashboard/280" }],
        },
      ],
    }),
  );

  const api = createPlatformApi({ rootDir, discoverDashboardsFn: null });
  const inventory = await api.getInventory();

  assert.deepEqual(
    inventory.dashboards.map((dashboard) => dashboard.uuid).sort(),
    ["dash-ine", "internal-280"],
  );
  assert.equal(
    inventory.dashboards.some((dashboard) =>
      ["old-public-mx-loan", "stale-country-public-mx-loan"].includes(dashboard.uuid),
    ),
    false,
  );
});

test("platform api keeps country inventory dashboards matched by source panel id", async () => {
  const rootDir = await makeFixture();
  await fs.writeFile(
    path.join(rootDir, "config/discovered-public-dashboards.ready.json"),
    JSON.stringify({ dashboardCount: 0, dashboards: [] }),
  );
  await fs.writeFile(
    path.join(rootDir, "config/discovered-public-dashboards.mx.json"),
    JSON.stringify({
      country: { code: "MX", name: "墨西哥" },
      dashboards: [
        {
          countryCode: "MX",
          countryName: "墨西哥",
          access: "public",
          sourcePanelId: 2,
          sourcePanelTitle: "核心链路准实时监控",
          title: "核心链路准实时监控",
          uuid: "mx-core",
          url: "https://data.kuainiu.io/public/dashboard/mx-core",
          cards: [{ title: "新客-启动次数", cardId: 1, dashcardId: 2 }],
        },
      ],
    }),
  );
  await fs.writeFile(
    path.join(rootDir, "config/discovered-panels.mx.json"),
    JSON.stringify({
      country: { code: "MX", name: "墨西哥" },
      panels: [
        {
          id: 2,
          title: "业务概览-核心链路准实时监控",
          links: [{ url: "https://data.kuainiu.io/dashboard/464" }],
        },
      ],
    }),
  );

  const api = createPlatformApi({ rootDir });
  const inventory = await api.getInventory({ countryCode: "MX" });

  assert.deepEqual(inventory.dashboards.map((dashboard) => dashboard.uuid), ["mx-core"]);
  assert.equal(inventory.totalCardCount, 1);
});

test("platform api evaluates sandbox rules", async () => {
  const rootDir = await makeFixture();
  const api = createPlatformApi({ rootDir });

  const result = await api.evaluateSandbox({
    dashboard: { title: "OKR" },
    card: { title: "规模" },
    rule: { type: "requiredDatePresent", dateColumn: "统计日期", requiredDate: "2026-07-06" },
    rows: [{ "统计日期": "2026-07-06" }],
  });

  assert.equal(result.ok, true);
  assert.equal(result.matched, false);
  assert.deepEqual(result.messages, []);
});

test("platform api evaluates live sandbox through readonly Metabase client", async () => {
  const rootDir = await makeFixture();
  const api = createPlatformApi({
    rootDir,
    metabaseClientFactory: () => ({
      async queryDashcardJson(request) {
        assert.equal(request.cardId, 1);
        assert.equal(request.dashboardUuid, "dash-1");
        assert.equal(request.dashcardId, 2);
        return [{ "统计日期": "2026-07-06", "注册数": 10 }];
      },
    }),
  });
  const inventory = await api.getInventory();
  const dashboard = inventory.dashboards[0];
  const card = dashboard.cards[0];

  const result = await api.evaluateLiveSandbox({
    dashboard,
    card,
    rule: { type: "requiredDatePresent", dateColumn: "统计日期", requiredDate: "2026-07-06" },
  });

  assert.equal(result.source, "metabase");
  assert.equal(result.rowCount, 1);
  assert.equal(result.matched, false);
  assert.equal(result.request.parameterCount, 0);
});

test("platform live sandbox expands history but does not infer refresh from one response", async () => {
  const rootDir = await makeFixture();
  await fs.writeFile(
    path.join(rootDir, "config/public-monitor.config.json"),
    JSON.stringify({
      ruleDefaults: {
        requiredDatePresent: {
          autoDetectCadence: true,
          cadenceLookbackDays: 130,
          cadenceMinIntervals: 3,
          cadenceMinConfidence: 0.75,
          cadenceMaxIntervalDays: 31,
          cadenceMaxIntervalMonths: 1,
        },
      },
      rules: [],
    }),
  );
  const target = ["dimension", ["template-tag", "stat_date"], { "stage-number": 0 }];
  const api = createPlatformApi({
    rootDir,
    metabaseClientFactory: () => ({
      async queryDashcardJson(request) {
        assert.equal(request.parameters[0].value, "past130days~");
        return ["2026-06-20", "2026-06-27", "2026-07-04", "2026-07-11", "2026-07-18"]
          .map((date) => ({ "统计日期": date, "周指标": 10 }));
      },
    }),
  });

  const result = await api.evaluateLiveSandbox({
    dashboard: {
      title: "周报",
      uuid: "weekly-dashboard",
      url: "https://data.example/public/dashboard/weekly-dashboard",
      timezone: "Asia/Shanghai",
      parameters: [{ id: "date-filter", type: "date/all-options", default: "past1days~" }],
    },
    card: {
      title: "周指标",
      cardId: 1,
      dashcardId: 2,
      parameterMappings: [{ parameter_id: "date-filter", target }],
    },
    rule: {
      type: "requiredDatePresent",
      dateColumn: "统计日期",
      requiredDate: "2026-07-19",
    },
  });

  assert.equal(result.matched, true);
  assert.equal(result.rule.autoDetectCadence, true);
  assert.equal(result.request.parameterCount, 1);
});

test("platform api runs scoped batch check", async () => {
  const rootDir = await makeFixture();
  const api = createPlatformApi({
    rootDir,
    metabaseClientFactory: () => ({
      async queryDashcardJson() {
        return [{ "统计日期": "2026-07-05", "注册数": 10 }];
      },
    }),
  });

  const result = await api.runBatchCheck({
    countryCode: "INE",
  });

  assert.equal(result.checkedCardCount, 1);
  assert.equal(result.dashboardCount, 1);
  assert.equal(result.dataQualityAnomalyCount, 0);
  assert.ok(result.anomalyCount >= 1);
});

test("platform api merges newly discovered dashboards into an existing country during scheduled checks", async () => {
  const rootDir = await makeFixture();
  const api = createPlatformApi({
    rootDir,
    discoverDashboardsFn: async () => ({
      dashboards: [{
        countryCode: "INE",
        countryName: "印尼",
        title: "提前还款监控",
        access: "internal",
        dashboardId: 1052,
        uuid: "internal:1052",
        url: "https://data.kuainiu.io/dashboard/1052",
        cards: [{ title: "提前还款", cardId: 10521, dashcardId: 10522 }],
      }],
    }),
    metabaseClientFactory: () => ({
      async queryDashcardJson() {
        return [{ "统计日期": "2026-07-24", "注册数": 10 }];
      },
    }),
  });

  const result = await api.runBatchCheck({ countryCode: "INE" });

  assert.equal(result.dashboardCount, 2);
  assert.equal(result.checkedCardCount, 2);
});

test("DS scheduler config inherits Metabase recipients", async () => {
  const rootDir = await makeFixture();
  await fs.writeFile(
    path.join(rootDir, "config/ds-scheduler.config.json"),
    JSON.stringify({ countries: {}, projectNames: {}, projectCodes: {} }),
  );
  await fs.writeFile(
    path.join(rootDir, "config/batch-check-schedule.json"),
    JSON.stringify({
      notifyChannel: "knBot",
      recipientEmails: "metabase-owner@example.com",
      botToken: "${KN_BOT_TOKEN}",
      sendWhenHealthy: true,
    }),
  );

  const config = await createPlatformApi({ rootDir }).getDsSchedulerConfig();

  assert.equal(config.alerts.channel, "knBot");
  assert.equal(config.alerts.recipientEmails, "metabase-owner@example.com");
  assert.equal(config.alerts.botToken, "${KN_BOT_TOKEN}");
  assert.equal(config.alerts.sendWhenHealthy, true);
});

test("DS scheduler schedule persists project-scoped countries and inherits alerts", async () => {
  const rootDir = await makeFixture();
  await fs.writeFile(
    path.join(rootDir, "config/ds-scheduler.config.json"),
    JSON.stringify({
      n8nWebhookUrl: "https://n8n.example/ds",
      countries: { ine: { name: "印尼", token: "token-ine" } },
      projectNames: { ine: "数据平台" },
      projectCodes: { ine: "12739141488160" },
    }),
  );
  await fs.writeFile(
    path.join(rootDir, "config/batch-check-schedule.json"),
    JSON.stringify({ notifyChannel: "knBot", recipientEmails: "owner@example.com" }),
  );
  const api = createPlatformApi({ rootDir });

  const saved = await api.saveDsSchedule({
    enabled: true,
    intervalMinutes: 60,
    countryConfigs: [{ countryCode: "ine", enabled: true, projectCode: "12739141488160" }],
  });
  const schedule = await api.getDsSchedule();

  assert.equal(saved.enabled, true);
  assert.equal(schedule.countryConfigs[0].projectCode, "12739141488160");
  assert.equal(schedule.alerts.recipientEmails, "owner@example.com");
  assert.ok(schedule.nextRunAt);
});

test("DS scheduler schedule rejects an enabled country without project code", async () => {
  const rootDir = await makeFixture();
  const api = createPlatformApi({ rootDir });

  await assert.rejects(
    () => api.saveDsSchedule({
      enabled: true,
      intervalMinutes: 60,
      countryConfigs: [{ countryCode: "ine", enabled: true, projectCode: "" }],
    }),
    /project code/i,
  );
});

test("DS notification inherits Metabase defaults until an override is saved", async () => {
  const rootDir = await makeFixture();
  await fs.writeFile(
    path.join(rootDir, "config/batch-check-schedule.json"),
    JSON.stringify({
      notifyChannel: "knBot",
      botToken: "metabase-token",
      chatId: "metabase-chat",
      recipientEmails: "owner@example.com",
      sendWhenHealthy: true,
    }),
  );
  const api = createPlatformApi({ rootDir });

  const inherited = await api.getDsNotificationConfig();
  assert.equal(inherited.inherited, true);
  assert.equal(inherited.channel, "knBot");
  assert.equal(inherited.recipientEmails, "owner@example.com");

  await api.saveDsNotificationConfig({
    channel: "tv",
    webhookUrl: "https://tv.example/alert",
    botId: "ds-bot",
    mentions: "alice",
    sendWhenHealthy: false,
  });
  const overridden = await api.getDsNotificationConfig();
  assert.equal(overridden.inherited, false);
  assert.equal(overridden.channel, "tv");
  assert.equal(overridden.botId, "ds-bot");
  assert.equal(overridden.recipientEmails, "");
});

test("DS notification preview and send test use the effective DS target", async () => {
  const rootDir = await makeFixture();
  const sent = [];
  const api = createPlatformApi({
    rootDir,
    notifyTextFn: async (config, message, meta) => {
      sent.push({ config, message, meta });
      return { sent: true };
    },
  });
  await api.saveDsNotificationConfig({
    channel: "knBot",
    botToken: "ds-token",
    chatId: "ds-chat",
    recipientEmails: "ds-owner@example.com",
    sendWhenHealthy: true,
  });

  const preview = await api.previewDsNotification();
  assert.match(preview.message, /DS 调度监控测试/);
  assert.match(preview.targetSummary, /ds-owner@example.com/);

  const result = await api.sendDsNotificationTest({ message: preview.message });
  assert.equal(result.sent, true);
  assert.equal(sent[0].config.alerts.chatId, "ds-chat");
  assert.equal(sent[0].meta.title, "DS 调度监控通知测试");
});

test("requested hourly dashboards are stored in all six country sources", async () => {
  const expected = new Map([
    ["config/discovered-panels.json", "/dashboard/1052"],
    ["config/discovered-panels.pk.json", "/dashboard/1053"],
    ["config/discovered-panels.th.json", "/dashboard/1054"],
    ["config/discovered-panels.ph.json", "/dashboard/1056"],
    ["config/discovered-panels.cn.json", "/dashboard/1206"],
    ["config/discovered-panels.mx.json", "/dashboard/1039"],
  ]);
  for (const [relativePath, dashboardPath] of expected) {
    const source = JSON.parse(await fs.readFile(path.resolve(relativePath), "utf8"));
    const target = (source.panels || []).find((panel) => (panel.links || []).some((link) => link.url.includes(dashboardPath)));
    const urls = (source.panels || []).flatMap((panel) => (panel.links || []).map((link) => link.url));
    assert.ok(urls.some((url) => url.includes(dashboardPath)), `${relativePath} should contain ${dashboardPath}`);
    assert.equal(target?.title, "每小时监控");
  }
  const rules = JSON.parse(await fs.readFile(path.resolve("config/public-monitor.config.json"), "utf8")).rules;
  const hourlyRules = rules.filter((rule) => rule.context === "提前还款每小时监控");
  assert.equal(hourlyRules.length, 2);
  assert.ok(hourlyRules.every((rule) => rule.dashboardTitlePattern === "每小时监控$"));
});

test("platform api scans full configured country scope by default", async () => {
  const rootDir = await makeFixture();
  await fs.writeFile(
    path.join(rootDir, "config/discovered-public-dashboards.ready.json"),
    JSON.stringify({
      dashboardCount: 2,
      dashboards: [
        {
          countryCode: "INE",
          countryName: "印尼",
          title: "OKR",
          uuid: "dash-1",
          url: "https://data.example/public/dashboard/dash-1",
          cards: [
            { title: "规模", cardId: 1, dashcardId: 2 },
          ],
        },
        {
          countryCode: "INE",
          countryName: "印尼",
          title: "核心链路准实时监控",
          uuid: "dash-2",
          url: "https://data.example/public/dashboard/dash-2",
          cards: [
            { title: "注册数", cardId: 3, dashcardId: 4 },
          ],
        },
      ],
    }),
  );
  const api = createPlatformApi({
    rootDir,
    metabaseClientFactory: () => ({
      async queryDashcardJson() {
        return [{ "统计日期": "2026-07-06", "注册数": 10 }];
      },
    }),
  });

  const result = await api.runBatchCheck({
    countryCode: "INE",
  });

  assert.equal(result.dashboardCount, 2);
  assert.equal(result.checkedCardCount, 2);
});

test("platform api filters batch check by selected dashboard uuids", async () => {
  const rootDir = await makeFixture();
  await fs.writeFile(
    path.join(rootDir, "config/discovered-public-dashboards.ready.json"),
    JSON.stringify({
      dashboardCount: 2,
      dashboards: [
        {
          countryCode: "INE",
          countryName: "印尼",
          title: "OKR",
          uuid: "dash-1",
          url: "https://data.example/public/dashboard/dash-1",
          cards: [
            { title: "规模", cardId: 1, dashcardId: 2 },
          ],
        },
        {
          countryCode: "INE",
          countryName: "印尼",
          title: "核心链路准实时监控",
          uuid: "dash-2",
          url: "https://data.example/public/dashboard/dash-2",
          cards: [
            { title: "注册数", cardId: 3, dashcardId: 4 },
          ],
        },
      ],
    }),
  );
  const queriedDashboards = [];
  const api = createPlatformApi({
    rootDir,
    metabaseClientFactory: (dashboard) => ({
      async queryDashcardJson() {
        queriedDashboards.push(dashboard.uuid);
        return [{ "统计日期": "2026-07-06", "注册数": 10 }];
      },
    }),
  });

  const result = await api.runBatchCheck({
    countryCode: "INE",
    dashboardUuids: ["dash-2"],
  });

  assert.equal(result.dashboardCount, 1);
  assert.equal(result.checkedCardCount, 1);
  assert.deepEqual(queriedDashboards, ["dash-2"]);
});

test("platform api explains countries that only have internal source dashboards", async () => {
  const rootDir = await makeFixture();
  await fs.writeFile(
    path.join(rootDir, "config/countries.config.json"),
    JSON.stringify({
      countries: [
        { code: "CN", name: "中国", timezone: "Asia/Shanghai", status: "ready" },
      ],
    }),
  );
  await fs.writeFile(
    path.join(rootDir, "config/discovered-public-dashboards.ready.json"),
    JSON.stringify({ dashboardCount: 0, dashboards: [] }),
  );
  await fs.writeFile(
    path.join(rootDir, "config/discovered-panels.cn.json"),
    JSON.stringify({
      panels: [
        {
          title: "业务概览-OKR",
          links: [{ url: "https://data.kuainiu.io/collection/799-okr" }],
        },
      ],
    }),
  );
  const api = createPlatformApi({ rootDir });

  await assert.rejects(
    () => api.runBatchCheck({ countryCode: "CN" }),
    (error) => {
      assert.equal(error.message, "No public dashboard for country");
      assert.match(
        error.errors?.[0] || "",
        /中国 \/ CN 当前有 1 个来源看板.*尚未发现可巡检的 \/public\/dashboard UUID/,
      );
      return true;
    },
  );
});

test("platform api discovers internal dashboards from source list when country inventory is stale", async () => {
  const rootDir = await makeFixture();
  await fs.writeFile(
    path.join(rootDir, "config/countries.config.json"),
    JSON.stringify({
      countries: [
        { code: "PH", name: "菲律宾", timezone: "Asia/Manila", status: "ready" },
      ],
    }),
  );
  await fs.writeFile(
    path.join(rootDir, "config/discovered-public-dashboards.ready.json"),
    JSON.stringify({ dashboardCount: 0, dashboards: [] }),
  );
  await fs.writeFile(
    path.join(rootDir, "config/discovered-public-dashboards.ph.json"),
    JSON.stringify({
      country: { code: "PH", name: "菲律宾" },
      dashboards: [
        {
          countryCode: "PH",
          countryName: "菲律宾",
          access: "public",
          title: "旧 OKR",
          uuid: "stale-public-ph",
          url: "https://data.kuainiu.io/public/dashboard/stale-public-ph",
          cards: [{ title: "旧卡片", cardId: 1, dashcardId: 2 }],
        },
      ],
    }),
  );
  await fs.writeFile(
    path.join(rootDir, "config/discovered-panels.ph.json"),
    JSON.stringify({
      country: { code: "PH", name: "菲律宾", timezone: "Asia/Manila" },
      panels: [
        {
          title: "业务概览-OKR",
          links: [{ url: "https://data.kuainiu.io/dashboard/501-dashboard" }],
        },
      ],
    }),
  );

  const discoveredInputs = [];
  const api = createPlatformApi({
    rootDir,
    discoverDashboardsFn: async (options) => {
      discoveredInputs.push(options.inputFile);
      return {
        country: { code: "PH", name: "菲律宾", timezone: "Asia/Manila" },
        dashboardCount: 1,
        dashboards: [
          {
            countryCode: "PH",
            countryName: "菲律宾",
            timezone: "Asia/Manila",
            access: "internal",
            title: "业务概览-OKR",
            dashboardId: "501",
            uuid: "internal-501",
            url: "https://data.kuainiu.io/dashboard/501-dashboard",
            sourceUrl: "https://data.kuainiu.io/dashboard/501-dashboard",
            cards: [{ title: "规模", cardId: 10, dashcardId: 20 }],
          },
        ],
      };
    },
    metabaseClientFactory: (dashboard) => ({
      async queryDashcardJson(request) {
        assert.equal(dashboard.access, "internal");
        assert.equal(request.dashboardId, "501");
        assert.equal(request.dashboardUuid, undefined);
        return [{ "统计日期": "2026-07-06", "注册数": 10 }];
      },
    }),
  });

  const result = await api.runBatchCheck({ countryCode: "PH" });

  assert.equal(result.dashboardCount, 1);
  assert.equal(result.checkedCardCount, 1);
  assert.equal(result.checkedCards[0].dashboardUuid, "internal-501");
  assert.equal(discoveredInputs.length, 1);
  assert.match(discoveredInputs[0], /discovered-panels\.ph\.json$/);
});

test("platform api runs scoped batch check and sends TV notification", async () => {
  const rootDir = await makeFixture();
  const captured = [];
  const api = createPlatformApi({
    rootDir,
    metabaseClientFactory: () => ({
      async queryDashcardJson() {
        return [{ "统计日期": "2026-07-05", "注册数": 10 }];
      },
    }),
    notifyTextFn: async (config, message, metadata) => {
      captured.push({ config, message, metadata });
      return { sent: true, status: 200 };
    },
  });

  const result = await api.runBatchCheckAndNotify({
    countryCode: "INE",
    webhookUrl: "https://tv-service-alert.kuainiu.chat/alert/v2/array",
    botId: "tv-bot-001",
    mentions: "strongliu@kn.group,jerrycai@kn.group",
  });

  assert.equal(result.checkedCardCount, 1);
  assert.equal(result.notification.sent, true);
  assert.equal(result.notification.botId, "tv-bot-001");
  assert.deepEqual(result.notification.mentions, ["strongliu@kn.group", "jerrycai@kn.group"]);
  assert.equal(captured[0].config.alerts.webhookUrl, "https://tv-service-alert.kuainiu.chat/alert/v2/array");
  assert.equal(captured[0].config.alerts.botId, "tv-bot-001");
  assert.match(captured[0].message, /【今日值班】/);
  assert.match(captured[0].message, /1\.数据质量告警“未处理”统计/);
  assert.doesNotMatch(captured[0].message, /公共报表巡检汇总/);
});

test("platform api skips TV notification when batch check is healthy", async () => {
  const rootDir = await makeFixture();
  const api = createPlatformApi({
    rootDir,
    metabaseClientFactory: () => ({
      async queryDashcardJson() {
        return [{ "统计日期": "2026-07-06", "注册数": 10 }];
      },
    }),
    notifyTextFn: async () => {
      throw new Error("notifyTextFn should not be called for healthy batch checks");
    },
  });

  const result = await api.runBatchCheckAndNotify({
    countryCode: "INE",
    webhookUrl: "https://tv-service-alert.kuainiu.chat/alert/v2/array",
    botId: "tv-bot-001",
  });

  assert.equal(result.anomalyCount, 0);
  assert.equal(result.notification.sent, false);
  assert.equal(result.notification.skipped, true);
  assert.equal(result.notification.reason, "no anomalies");
  assert.equal(result.notification.sentMessages, 0);
});

test("platform api saves batch schedule and runs it when due", async () => {
  const rootDir = await makeFixture();
  const captured = [];
  const api = createPlatformApi({
    rootDir,
    metabaseClientFactory: () => ({
      async queryDashcardJson() {
        return [{ "统计日期": "2026-07-05", "注册数": 10 }];
      },
    }),
    notifyTextFn: async (config, message, metadata) => {
      captured.push({ config, message, metadata });
      return { sent: true, status: 200 };
    },
    wattrelQueryFn: async () => [{
      name: "放款数据校验",
      src_tbl: "ods_loan",
      dest_tbl: "dwd_loan",
      src_value: 10,
      dest_value: 9,
      diff: 1,
    }],
  });

  const schedule = await api.saveBatchSchedule({
    enabled: true,
    intervalMinutes: 5,
    webhookUrl: "https://tv-service-alert.kuainiu.chat/alert/v2/array",
    countryConfigs: [
      {
        countryCode: "INE",
        enabled: true,
        dashboardUuids: ["dash-1"],
        webhookUrl: "https://tv-service-alert.kuainiu.chat/alert/v2/array",
        botId: "tv-bot-001",
        mentions: "owner@kn.group",
      },
    ],
  });

  assert.equal(schedule.enabled, true);
  assert.equal(schedule.intervalMinutes, 5);
  assert.ok(schedule.nextRunAt);

  const notDue = await api.runDueBatchSchedule(new Date(Date.parse(schedule.nextRunAt) - 1000));
  assert.equal(notDue.ran, false);
  assert.equal(notDue.reason, "not due");

  const due = await api.runDueBatchSchedule(new Date(Date.parse(schedule.nextRunAt) + 1000));
  assert.equal(due.ran, true);
  assert.equal(due.schedule.lastError, null);
  assert.equal(due.schedule.lastResult.anomalyCount, 1);
  assert.equal(due.schedule.lastResult.successCount, 1);
  assert.equal(due.schedule.lastResult.runs[0].result.notification.sent, true);
  assert.ok(Date.parse(due.schedule.nextRunAt) > Date.parse(schedule.nextRunAt));
  assert.equal(captured.length, 1);
  assert.equal(captured[0].config.alerts.botId, "tv-bot-001");

  const history = await api.getBatchHistory();
  assert.equal(history.runs.length, 1);
  assert.equal(history.runs[0].status, "success");
  assert.equal(history.runs[0].countryCount, 1);
  assert.equal(history.runs[0].checkedCardCount, 1);
  assert.equal(history.runs[0].anomalyCount, 1);
  assert.equal(history.runs[0].notificationSentCount, 1);
  assert.equal(history.runs[0].runs[0].result.checkedDashboards.length, 1);
  assert.equal(history.runs[0].runs[0].result.checkedCards.length, 1);
  assert.equal(history.runs[0].runs[0].result.anomalies.length, 1);
  assert.equal(history.runs[0].wattrelSummary.total, 1);
  assert.equal(history.runs[0].wattrelSummary.countries[0].count, 1);
  assert.match(captured[0].message, new RegExp(`historyRunId=${history.runs[0].id}`));

  const filteredHistory = await api.getBatchHistory({ countryCode: "INE", status: "anomaly" });
  assert.equal(filteredHistory.runs.length, 1);

  const selectedHistory = await api.getBatchHistory({ runId: history.runs[0].id });
  assert.equal(selectedHistory.total, 1);
  assert.equal(selectedHistory.runs[0].id, history.runs[0].id);
});

test("platform api persists the global DS switch on Metabase schedule", async () => {
  const rootDir = await makeFixture();
  const api = createPlatformApi({ rootDir });

  const defaults = await api.getBatchSchedule();
  assert.equal(defaults.includeDsScheduler, false);

  const saved = await api.saveBatchSchedule({
    ...defaults,
    includeDsScheduler: true,
  });
  assert.equal(saved.includeDsScheduler, true);
  assert.equal((await api.getBatchSchedule()).includeDsScheduler, true);
});

test("platform api saves schedule with internal source inventory without discovering during save", async () => {
  const rootDir = await makeFixture();
  await fs.writeFile(
    path.join(rootDir, "config/countries.config.json"),
    JSON.stringify({
      countries: [
        { code: "PH", name: "菲律宾", timezone: "Asia/Manila", status: "ready" },
      ],
    }),
  );
  await fs.writeFile(
    path.join(rootDir, "config/discovered-public-dashboards.ready.json"),
    JSON.stringify({ dashboardCount: 0, dashboards: [] }),
  );
  await fs.writeFile(
    path.join(rootDir, "config/discovered-panels.ph.json"),
    JSON.stringify({
      country: { code: "PH", name: "菲律宾", timezone: "Asia/Manila" },
      panels: [
        {
          title: "业务概览-OKR",
          links: [{ url: "https://data.kuainiu.io/dashboard/501-dashboard" }],
        },
      ],
    }),
  );
  const api = createPlatformApi({
    rootDir,
    discoverDashboardsFn: async () => {
      throw new Error("save should not discover dashboards");
    },
  });

  const schedule = await api.saveBatchSchedule({
    enabled: true,
    countryConfigs: [
      {
        countryCode: "PH",
        enabled: true,
        notifyChannel: "knBot",
        recipientEmails: "owner@kn.group",
      },
    ],
  });

  assert.equal(schedule.enabled, true);
  assert.equal(schedule.countryConfigs[0].countryCode, "PH");
});

test("platform api aggregates scheduled countries by same notification target", async () => {
  const rootDir = await makeFixture();
  await fs.writeFile(
    path.join(rootDir, "config/countries.config.json"),
    JSON.stringify({
      countries: [
        { code: "INE", name: "印尼", timezone: "Asia/Jakarta", status: "ready" },
        { code: "PH", name: "菲律宾", timezone: "Asia/Manila", status: "ready" },
      ],
    }),
  );
  await fs.writeFile(
    path.join(rootDir, "config/discovered-public-dashboards.ready.json"),
    JSON.stringify({
      dashboardCount: 2,
      dashboards: [
        {
          countryCode: "INE",
          countryName: "印尼",
          title: "OKR",
          uuid: "dash-ine",
          url: "https://data.example/public/dashboard/dash-ine",
          cards: [{ title: "规模", cardId: 1, dashcardId: 2, columns: ["统计日期", "注册数"] }],
        },
        {
          countryCode: "PH",
          countryName: "菲律宾",
          title: "OKR",
          uuid: "dash-ph",
          url: "https://data.example/public/dashboard/dash-ph",
          cards: [{ title: "规模", cardId: 3, dashcardId: 4, columns: ["统计日期", "注册数"] }],
        },
      ],
    }),
  );
  const captured = [];
  const api = createPlatformApi({
    rootDir,
    metabaseClientFactory: () => ({
      async queryDashcardJson() {
        return [{ "统计日期": "2026-07-05", "注册数": 10 }];
      },
    }),
    notifyTextFn: async (config, message, metadata) => {
      captured.push({ config, message, metadata });
      return { sent: true, status: 200 };
    },
    wattrelQueryFn: async (config) => {
      const countryCode = config.country?.code || config.defaultCountryCode;
      if (countryCode === "INE") {
        return [
          {
            id: 1,
            quality_id: 101,
            dest_tbl: "dwd_asset_withhold_detail",
            name: "提现一致性",
            src_value: 100,
            dest_value: 98,
            diff: 2,
          },
          {
            id: 2,
            quality_id: 102,
            dest_tbl: "dwd_asset_withhold_request",
            name: "提现请求一致性",
            src_value: 50,
            dest_value: 49,
            diff: 1,
          },
          {
            id: 3,
            quality_id: 101,
            dest_tbl: "dwd_asset_withhold_detail",
            name: "提现一致性（当天重跑）",
            src_value: 101,
            dest_value: 98,
            diff: 3,
          },
        ];
      }
      return [];
    },
  });

  const schedule = await api.saveBatchSchedule({
    enabled: true,
    dailyRunTimes: ["09:00"],
    countryConfigs: [
      {
        countryCode: "INE",
        enabled: true,
        dashboardUuids: ["dash-ine"],
        webhookUrl: "https://tv-service-alert.kuainiu.chat/alert/v2/array",
        botId: "shared-tv-bot",
      },
      {
        countryCode: "PH",
        enabled: true,
        dashboardUuids: ["dash-ph"],
        webhookUrl: "https://tv-service-alert.kuainiu.chat/alert/v2/array",
        botId: "shared-tv-bot",
      },
    ],
  });

  await api.runDueBatchSchedule(new Date(Date.parse(schedule.nextRunAt) + 1000));

  assert.equal(captured.length, 1);
  assert.match(captured[0].message, /【今日值班】\d{4} (AM|PM)/);
  assert.doesNotMatch(captured[0].message, /Flink/);
  assert.match(captured[0].message, /1\.数据质量告警“未处理”统计/);
  assert.match(captured[0].message, /发现 2 条异常，涉及 2 个看板。/);
  assert.match(captured[0].message, /🇮🇩 印尼\(INE\)：\n• <a href="https:\/\/data\.example\/public\/dashboard\/dash-ine">OKR \/ 规模：数据缺失<\/a>/);
  assert.match(captured[0].message, /🇵🇭 菲律宾\(PH\)：\n• <a href="https:\/\/data\.example\/public\/dashboard\/dash-ph">OKR \/ 规模：数据缺失<\/a>/);
  assert.match(captured[0].message, /🇮🇩 印尼\(INE\)：2/);
  assert.match(captured[0].message, /🇵🇭 菲律宾\(PH\)：0/);
  assert.match(captured[0].message, /3\. BI报表\(Metabase\):/);
  assert.doesNotMatch(captured[0].message, /异常概览/);
  assert.doesNotMatch(captured[0].message, /各国异常 Metabase 看板/);

  const history = await api.getBatchHistory();
  assert.equal(history.runs[0].notificationSentCount, 1);
  assert.equal(history.runs[0].countryCount, 2);
});

test("platform api ingests external wattrel alert runs into batch history", async () => {
  const rootDir = await makeFixture();
  const api = createPlatformApi({ rootDir });

  const result = await api.ingestExternalAlertRun({
    source: "wattrel",
    checkedAt: "2026-07-08T02:40:00.000Z",
    countries: [
      {
        countryCode: "CN",
        countryName: "中国",
        checkedCount: 2,
        anomalies: [
          {
            name: "dwd_asset_withhold_cnt",
            srcTbl: "ods_repay_withhold",
            destTbl: "dwd_asset_withhold",
            expectedValue: 1212966,
            actualValue: 1219544,
            diff: -6578,
            window: "2026-04-05 至 2026-07-04",
          },
        ],
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, "wattrel");
  assert.equal(result.summary.countryCount, 1);
  assert.equal(result.summary.checkedCardCount, 2);
  assert.equal(result.summary.anomalyCount, 1);
  assert.match(result.detailUrl, /^https:\/\/big-data-duty-management-platform\.kuainiujinke\.com\/#\/batch-check\?historyRunId=/);

  const history = await api.getBatchHistory({ countryCode: "CN", status: "anomaly" });
  assert.equal(history.runs.length, 1);
  assert.equal(history.runs[0].source, "wattrel");
  assert.equal(history.runs[0].trigger, "external_wattrel");
  assert.equal(history.runs[0].runs[0].result.anomalies[0].dashboardTitle, "Wattrel 数据质量");
  assert.equal(history.runs[0].runs[0].result.anomalies[0].cardTitle, "dwd_asset_withhold");
  assert.match(history.runs[0].runs[0].result.anomalies[0].message, /期望值 1212966，实际值 1219544，差值 -6578/);
});

test("platform api can notify after ingesting external wattrel alerts", async () => {
  const rootDir = await makeFixture();
  const captured = [];
  const api = createPlatformApi({
    rootDir,
    notifyTextFn: async (config, message, metadata) => {
      captured.push({ config, message, metadata });
      return { sent: true, status: 200 };
    },
  });

  const result = await api.ingestExternalAlertRun({
    source: "wattrel",
    checkedAt: "2026-07-08T02:40:00.000Z",
    notify: true,
    notifyChannel: "tv",
    webhookUrl: "https://tv-service-alert.kuainiu.chat/alert/v2/array",
    botId: "tv-bot-001",
    anomalies: [
      {
        countryCode: "INE",
        countryName: "印尼",
        name: "dwb_asset_info_reduce_amt",
        destTbl: "dwb_asset_info",
        expectedValue: 543295.82,
        actualValue: 544267.82,
        diff: -972,
      },
    ],
  });

  assert.equal(result.notificationSentCount, 1);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].config.alerts.botId, "tv-bot-001");
  assert.match(captured[0].message, /公共报表巡检汇总/);
  assert.match(captured[0].message, /Wattrel 数据质量/);
  assert.match(captured[0].message, /dwb_asset_info/);
});

test("platform api locally queries wattrel alerts into batch history", async () => {
  const rootDir = await makeFixture();
  await fs.writeFile(
    path.join(rootDir, "config/wattrel.config.json"),
    JSON.stringify({
      enabled: true,
      defaultCountryCode: "CN",
      defaultCountryName: "中国",
      query: { limit: 5 },
    }),
  );
  const api = createPlatformApi({
    rootDir,
    wattrelQueryFn: async (config) => {
      assert.equal(config.query.limit, 5);
      return [
        {
          name: "dwd_asset_withhold_cnt",
          src_tbl: "ods_repay_withhold",
          dest_tbl: "dwd_asset_withhold",
          src_value: 1212966,
          dest_value: 1219544,
          diff: -6578,
          check_window: "2026-04-05 至 2026-07-04",
        },
      ];
    },
  });

  const result = await api.queryWattrelAlerts({ limit: 5 });

  assert.equal(result.ok, true);
  assert.equal(result.source, "wattrel");
  assert.equal(result.rowCount, 1);
  assert.equal(result.summary.countryCount, 1);
  assert.equal(result.summary.anomalyCount, 1);
  const history = await api.getBatchHistory({ countryCode: "CN", status: "anomaly" });
  assert.equal(history.runs.length, 1);
  assert.equal(history.runs[0].trigger, "external_wattrel");
  assert.equal(history.runs[0].runs[0].result.anomalies[0].countryCode, "CN");
  assert.equal(history.runs[0].runs[0].result.anomalies[0].cardTitle, "dwd_asset_withhold");
});

test("platform api treats country ssh wattrel config as configured", async () => {
  const rootDir = await makeFixture();
  await fs.writeFile(
    path.join(rootDir, "config/wattrel.config.json"),
    JSON.stringify({
      enabled: true,
      countries: {
        INE: {
          name: "印尼",
          ssh: {
            host: "192.168.21.236",
            port: 36000,
            user: "root",
            envFiles: [
              "/root/Global-Intelligent-Alarm-Repair-Assistant/.env.local",
              "/root/INE-Intelligent-Alarm-Repair-Assistant/.env.local",
            ],
          },
        },
      },
      query: { limit: 5 },
    }),
  );
  const api = createPlatformApi({
    rootDir,
    wattrelQueryFn: async (config) => {
      assert.equal(config.ssh.host, "192.168.21.236");
      assert.equal(config.ssh.port, 36000);
      assert.equal(config.ssh.envFiles[1], "/root/INE-Intelligent-Alarm-Repair-Assistant/.env.local");
      return [];
    },
  });

  const result = await api.getCurrentWattrelAlerts({ countryCode: "INE" });

  assert.equal(result.configEnabled, true);
  assert.equal(result.countries[0].configured, true);
  assert.equal(result.countries[0].status, "success");
});

test("platform api queries country wattrel targets concurrently", async () => {
  const rootDir = await makeFixture();
  await fs.writeFile(
    path.join(rootDir, "config/countries.config.json"),
    JSON.stringify({
      countries: [
        { code: "INE", name: "印尼" },
        { code: "PH", name: "菲律宾" },
      ],
    }),
  );
  await fs.writeFile(
    path.join(rootDir, "config/wattrel.config.json"),
    JSON.stringify({
      enabled: true,
      countries: {
        INE: { ssh: { host: "192.168.21.236", port: 36000, user: "root" } },
        PH: { ssh: { host: "10.20.10.12", user: "root" } },
      },
    }),
  );
  const started = [];
  const api = createPlatformApi({
    rootDir,
    wattrelQueryFn: async (config) => {
      started.push(config.ssh.host);
      await new Promise((resolve) => setTimeout(resolve, 100));
      return [];
    },
  });

  const startedAt = Date.now();
  const result = await api.getCurrentWattrelAlerts();
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.countries.length, 2);
  assert.deepEqual(started.sort(), ["10.20.10.12", "192.168.21.236"]);
  assert.ok(elapsedMs < 180, `expected concurrent query, took ${elapsedMs}ms`);
});

test("platform api treats n8n wattrel gateway as configured", async () => {
  const rootDir = await makeFixture();
  await fs.writeFile(
    path.join(rootDir, "config/wattrel.config.json"),
    JSON.stringify({
      enabled: true,
      gateway: { webhookUrl: "https://n8n.example/webhook/wattrel-query" },
      countries: {
        INE: { name: "印尼" },
      },
    }),
  );
  const api = createPlatformApi({
    rootDir,
    wattrelQueryFn: async (config) => {
      assert.equal(config.gateway.webhookUrl, "https://n8n.example/webhook/wattrel-query");
      return [
        {
          name: "代扣请求数量校验",
          dest_tbl: "dwd_asset_withhold_request",
          src_tbl: "ods_repay_withhold_request",
          src_value: 10,
          dest_value: 8,
          diff: 2,
        },
      ];
    },
  });

  const result = await api.getCurrentWattrelAlerts({ countryCode: "INE", limit: 7 });

  assert.equal(result.configEnabled, true);
  assert.equal(result.summary.anomalyCount, 1);
  assert.equal(result.countries[0].status, "success");
  assert.equal(result.countries[0].anomalies[0].destTbl, "dwd_asset_withhold_request");
});

test("platform api uses local n8n wattrel gateway by default", async () => {
  const rootDir = await makeFixture();
  await fs.writeFile(
    path.join(rootDir, "config/countries.config.json"),
    JSON.stringify({
      countries: [{ code: "CN", name: "中国", timezone: "Asia/Shanghai", status: "ready" }],
    }),
  );
  await fs.writeFile(
    path.join(rootDir, "config/wattrel.config.json"),
    JSON.stringify({ enabled: true }),
  );
  const api = createPlatformApi({
    rootDir,
    wattrelQueryFn: async (config) => {
      assert.equal(config.gateway.webhookUrl, "http://127.0.0.1:5678/webhook/wattrel-query");
      assert.equal(config.country.code, "CN");
      return [];
    },
  });

  const result = await api.getCurrentWattrelAlerts({ countryCode: "CN" });

  assert.equal(result.configEnabled, true);
  assert.equal(result.summary.configuredCountryCount, 1);
  assert.equal(result.countries[0].status, "success");
});

test("platform api falls back to local n8n gateway when env placeholder is empty", async () => {
  const rootDir = await makeFixture();
  await fs.writeFile(
    path.join(rootDir, "config/countries.config.json"),
    JSON.stringify({
      countries: [{ code: "CN", name: "中国", timezone: "Asia/Shanghai", status: "ready" }],
    }),
  );
  await fs.writeFile(
    path.join(rootDir, "config/wattrel.config.json"),
    JSON.stringify({
      enabled: true,
      gateway: { webhookUrl: "${WATTREL_GATEWAY_WEBHOOK_URL}" },
    }),
  );
  const previousWebhookUrl = process.env.WATTREL_GATEWAY_WEBHOOK_URL;
  delete process.env.WATTREL_GATEWAY_WEBHOOK_URL;
  const api = createPlatformApi({
    rootDir,
    wattrelQueryFn: async (config) => {
      assert.equal(config.gateway.webhookUrl, "http://127.0.0.1:5678/webhook/wattrel-query");
      return [];
    },
  });

  try {
    const result = await api.getCurrentWattrelAlerts({ countryCode: "CN" });

    assert.equal(result.configEnabled, true);
    assert.equal(result.summary.configuredCountryCount, 1);
    assert.equal(result.countries[0].configured, true);
  } finally {
    if (previousWebhookUrl === undefined) {
      delete process.env.WATTREL_GATEWAY_WEBHOOK_URL;
    } else {
      process.env.WATTREL_GATEWAY_WEBHOOK_URL = previousWebhookUrl;
    }
  }
});

test("platform api uses local n8n gateway when wattrel config file is missing", async () => {
  const rootDir = await makeFixture();
  await fs.writeFile(
    path.join(rootDir, "config/countries.config.json"),
    JSON.stringify({
      countries: [{ code: "CN", name: "中国", timezone: "Asia/Shanghai", status: "ready" }],
    }),
  );
  const api = createPlatformApi({
    rootDir,
    wattrelQueryFn: async (config) => {
      assert.equal(config.gateway.webhookUrl, "http://127.0.0.1:5678/webhook/wattrel-query");
      assert.equal(config.country.code, "CN");
      return [];
    },
  });

  const result = await api.getCurrentWattrelAlerts({ countryCode: "CN" });

  assert.equal(result.configEnabled, true);
  assert.equal(result.summary.configuredCountryCount, 1);
  assert.equal(result.countries[0].configured, true);
});

test("platform api locally queries wattrel with no active alerts", async () => {
  const rootDir = await makeFixture();
  await fs.writeFile(
    path.join(rootDir, "config/wattrel.config.json"),
    JSON.stringify({ enabled: true }),
  );
  const api = createPlatformApi({
    rootDir,
    wattrelQueryFn: async () => [],
  });

  const result = await api.queryWattrelAlerts();

  assert.equal(result.ok, true);
  assert.equal(result.rowCount, 0);
  assert.equal(result.summary.anomalyCount, 0);
  const history = await api.getBatchHistory();
  assert.equal(history.runs.length, 0);
});

test("platform api reads current wattrel alerts without writing history", async () => {
  const rootDir = await makeFixture();
  await fs.writeFile(
    path.join(rootDir, "config/wattrel.config.json"),
    JSON.stringify({ enabled: true, query: { limit: 10 } }),
  );
  const api = createPlatformApi({
    rootDir,
    wattrelQueryFn: async () => [
      {
        country_code: "INE",
        country_name: "印尼",
        name: "dwb_asset_info_reduce_amt",
        src_tbl: "dwd_asset_main",
        dest_tbl: "dwb_asset_info",
        src_value: 543295.82,
        dest_value: 544267.82,
        diff: -972,
        begin: "2026-07-04",
        end: "2026-07-05",
      },
      {
        country_code: "PH",
        country_name: "菲律宾",
        name: "dwd_asset_withhold_cnt",
        src_tbl: "ods_repay_withhold",
        dest_tbl: "dwd_asset_withhold",
        src_value: 1212966,
        dest_value: 1219544,
        diff: -6578,
      },
    ],
  });

  const result = await api.getCurrentWattrelAlerts({ limit: 10 });

  assert.equal(result.ok, true);
  assert.equal(result.source, "wattrel");
  assert.equal(result.summary.countryCount, 2);
  assert.equal(result.summary.anomalyCount, 2);
  assert.equal(result.summary.targetTableCount, 2);
  assert.equal(result.countries[0].anomalyCount, 1);
  assert.equal(result.anomalies[0].destTbl, "dwb_asset_info");
  assert.match(result.anomalies[0].message, /期望值/);
  const history = await api.getBatchHistory();
  assert.equal(history.runs.length, 0);
});

test("platform api preserves explicit next run time on schedule save", async () => {
  const rootDir = await makeFixture();
  const api = createPlatformApi({ rootDir });
  const nextRunAt = "2026-07-07T06:30:00.000Z";

  const schedule = await api.saveBatchSchedule({
    enabled: true,
    intervalMinutes: 30,
    nextRunAt,
    countryConfigs: [
      {
        countryCode: "INE",
        enabled: true,
        dashboardUuids: ["dash-1"],
        notifyChannel: "knBot",
        recipientEmails: "owner@kn.group",
      },
    ],
  });

  assert.equal(schedule.nextRunAt, nextRunAt);
  assert.equal(schedule.countryConfigs[0].botToken, "${KN_BOT_TOKEN}");
});

test("platform api schedules the next run at a fixed Beijing daily time", async () => {
  const rootDir = await makeFixture();
  const api = createPlatformApi({
    rootDir,
    metabaseClientFactory: () => ({
      async queryDashcardJson() {
        return [{ "统计日期": "2026-07-06", "注册数": 10 }];
      },
    }),
    notifyTextFn: async () => ({ sent: true, status: 200 }),
  });

  const schedule = await api.saveBatchSchedule({
    enabled: true,
    dailyRunTime: "09:00",
    intervalMinutes: 30,
    nextRunAt: "2026-07-07T01:00:00.000Z",
    countryConfigs: [
      {
        countryCode: "INE",
        enabled: true,
        dashboardUuids: ["dash-1"],
        notifyChannel: "knBot",
        recipientEmails: "owner@kn.group",
      },
    ],
  });

  assert.equal(schedule.dailyRunTime, "09:00");

  const due = await api.runDueBatchSchedule(new Date("2026-07-07T01:00:01.000Z"));

  assert.equal(due.ran, true);
  assert.equal(due.schedule.nextRunAt, "2026-07-08T01:00:00.000Z");
});

test("platform api supports multiple Beijing daily run times", async () => {
  const rootDir = await makeFixture();
  const api = createPlatformApi({
    rootDir,
    metabaseClientFactory: () => ({
      async queryDashcardJson() {
        return [{ "统计日期": "2026-07-06", "注册数": 10 }];
      },
    }),
    notifyTextFn: async () => ({ sent: true, status: 200 }),
  });

  const schedule = await api.saveBatchSchedule({
    enabled: true,
    dailyRunTimes: ["09:00", "14:30", "20:00"],
    nextRunAt: "2026-07-07T06:30:00.000Z",
    countryConfigs: [
      {
        countryCode: "INE",
        enabled: true,
        dashboardUuids: ["dash-1"],
        notifyChannel: "knBot",
        recipientEmails: "owner@kn.group",
      },
    ],
  });

  assert.deepEqual(schedule.dailyRunTimes, ["09:00", "14:30", "20:00"]);

  const due = await api.runDueBatchSchedule(new Date("2026-07-07T06:30:01.000Z"));

  assert.equal(due.ran, true);
  assert.equal(due.schedule.nextRunAt, "2026-07-07T12:00:00.000Z");
});

test("platform api rolls multiple daily run times to tomorrow after the last time", async () => {
  const rootDir = await makeFixture();
  const api = createPlatformApi({
    rootDir,
    metabaseClientFactory: () => ({
      async queryDashcardJson() {
        return [{ "统计日期": "2026-07-06", "注册数": 10 }];
      },
    }),
    notifyTextFn: async () => ({ sent: true, status: 200 }),
  });

  await api.saveBatchSchedule({
    enabled: true,
    dailyRunTimes: ["09:00", "14:30", "20:00"],
    nextRunAt: "2026-07-07T12:00:00.000Z",
    countryConfigs: [
      {
        countryCode: "INE",
        enabled: true,
        dashboardUuids: ["dash-1"],
        notifyChannel: "knBot",
        recipientEmails: "owner@kn.group",
      },
    ],
  });

  const due = await api.runDueBatchSchedule(new Date("2026-07-07T12:00:01.000Z"));

  assert.equal(due.ran, true);
  assert.equal(due.schedule.nextRunAt, "2026-07-08T01:00:00.000Z");
});

test("platform api can manually test saved country schedule before it is due", async () => {
  const rootDir = await makeFixture();
  const captured = [];
  const api = createPlatformApi({
    rootDir,
    metabaseClientFactory: () => ({
      async queryDashcardJson() {
        return [{ "统计日期": "2026-07-05", "注册数": 10 }];
      },
    }),
    notifyTextFn: async (config, message, metadata) => {
      captured.push({ config, message, metadata });
      return { sent: true, status: 200 };
    },
  });

  await api.saveBatchSchedule({
    enabled: false,
    intervalMinutes: 120,
    countryConfigs: [
      {
        countryCode: "INE",
        enabled: true,
        dashboardUuids: ["dash-1"],
        notifyChannel: "tv",
        webhookUrl: "https://tv-service-alert.kuainiu.chat/alert/v2/array",
        botId: "tv-bot-001",
      },
    ],
  });

  const result = await api.runBatchScheduleNow(new Date("2026-07-07T06:00:00.000Z"));

  assert.equal(result.ran, true);
  assert.equal(result.schedule.enabled, false);
  assert.equal(result.schedule.lastResult.countryCount, 1);
  assert.equal(result.schedule.lastResult.anomalyCount, 1);
  assert.equal(captured.length, 1);

  const history = await api.getBatchHistory();
  assert.equal(history.runs[0].trigger, "manual_test");
  assert.equal(history.runs[0].countryCount, 1);
});

test("scheduled Wattrel history keeps only the latest result for each quality rule", async () => {
  const rootDir = await makeFixture();
  await fs.writeFile(
    path.join(rootDir, "config/countries.config.json"),
    JSON.stringify({ countries: [{ code: "TH", name: "泰国", timezone: "Asia/Bangkok", status: "ready" }] }),
  );
  await fs.writeFile(
    path.join(rootDir, "config/discovered-public-dashboards.ready.json"),
    JSON.stringify({
      dashboardCount: 1,
      dashboards: [{
        countryCode: "TH",
        countryName: "泰国",
        title: "OKR",
        uuid: "dash-th",
        url: "https://data.example/public/dashboard/dash-th",
        cards: [{ title: "规模", cardId: 1, dashcardId: 2, columns: ["统计日期", "注册数"] }],
      }],
    }),
  );
  const api = createPlatformApi({
    rootDir,
    metabaseClientFactory: () => ({
      async queryDashcardJson() {
        return [{ "统计日期": "2026-07-05", "注册数": 10 }];
      },
    }),
    wattrelQueryFn: async () => [
      { id: 573719, quality_id: 7, name: "dwd_mkt_ivr_job_sharding_cnt", dest_tbl: "dwd_mkt_ivr_job_sharding" },
      { id: 573380, quality_id: 7, name: "ods_cash_apply_grant_plan_cnt", dest_tbl: "ods_cash_apply_grant_plan" },
    ],
    notifyTextFn: async () => ({ sent: true, status: 200 }),
  });

  await api.saveBatchSchedule({
    enabled: false,
    countryConfigs: [{
      countryCode: "TH",
      enabled: true,
      dashboardUuids: ["dash-th"],
      notifyChannel: "knBot",
      recipientEmails: "owner@kn.group",
    }],
  });

  const result = await api.runBatchScheduleNow(new Date("2026-07-27T04:00:00.000Z"));

  assert.equal(result.result.wattrelSummary.countries[0].count, 1);
  assert.equal(result.result.wattrelSummary.total, 1);
  assert.equal(result.result.wattrelSummary.countries[0].anomalies.length, 1);
  assert.equal(result.result.wattrelSummary.countries[0].anomalies[0].destTbl, "dwd_mkt_ivr_job_sharding");
});

test("platform api supports scheduled KN Chat Bot notifications", async () => {
  const rootDir = await makeFixture();
  const captured = [];
  const api = createPlatformApi({
    rootDir,
    metabaseClientFactory: () => ({
      async queryDashcardJson() {
        return [{ "统计日期": "2026-07-05", "注册数": 10 }];
      },
    }),
    notifyTextFn: async (config, message, metadata) => {
      captured.push({ config, message, metadata });
      return { sent: true, status: 200, chatIds: ["10001"] };
    },
  });

  const schedule = await api.saveBatchSchedule({
    enabled: true,
    intervalMinutes: 5,
    countryConfigs: [
      {
        countryCode: "INE",
        enabled: true,
        dashboardUuids: ["dash-1"],
        notifyChannel: "knBot",
        botToken: "token-001",
        recipientEmails: "owner@kn.group",
        mentions: "owner@kn.group",
      },
    ],
  });

  const due = await api.runDueBatchSchedule(new Date(Date.parse(schedule.nextRunAt) + 1000));

  assert.equal(due.ran, true);
  assert.equal(due.schedule.lastError, null);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].config.alerts.channel, "knBot");
  assert.equal(captured[0].config.alerts.botToken, "token-001");
  assert.equal(captured[0].config.alerts.recipientEmails, "owner@kn.group");
  assert.deepEqual(captured[0].config.alerts.mentions, ["owner@kn.group"]);
});

test("platform api validates and saves rules", async () => {
  const rootDir = await makeFixture();
  const api = createPlatformApi({ rootDir });

  const next = await api.saveRulesConfig({
    rules: [{ type: "notEmpty", dashboardTitle: "OKR", cardTitles: ["规模"] }],
  });

  assert.equal(next.rules.length, 1);
  const saved = JSON.parse(await fs.readFile(path.join(rootDir, "config/public-monitor.config.json"), "utf8"));
  assert.equal(saved.rules[0].type, "notEmpty");
});

test("platform api keeps hidden secret placeholders from overwriting stored values", async () => {
  const rootDir = await makeFixture();
  const rulesPath = path.join(rootDir, "config/public-monitor.config.json");
  await fs.writeFile(
    rulesPath,
    JSON.stringify({
      alerts: { webhookUrl: "plain-secret-webhook", botId: "plain-secret-bot" },
      gateway: { token: "plain-secret-token" },
      rules: [{ type: "notEmpty", dashboardTitle: "OKR", cardTitles: ["规模"] }],
    }),
  );
  const api = createPlatformApi({ rootDir });

  const visible = await api.getRulesConfig();
  assert.equal(visible.alerts.webhookUrl, "<hidden>");
  assert.equal(visible.gateway.token, "<hidden>");

  await api.saveRulesConfig({
    ...visible,
    rules: [{ type: "rowCountAtLeast", dashboardTitle: "OKR", cardTitles: ["规模"], minRows: 1 }],
  });

  const saved = JSON.parse(await fs.readFile(rulesPath, "utf8"));
  assert.equal(saved.alerts.webhookUrl, "plain-secret-webhook");
  assert.equal(saved.alerts.botId, "plain-secret-bot");
  assert.equal(saved.gateway.token, "plain-secret-token");
  assert.equal(saved.rules[0].type, "rowCountAtLeast");
});

test("platform api blocks quality rule generation write without webhook", async () => {
  const rootDir = await makeFixture();
  await fs.writeFile(
    path.join(rootDir, "config/quality-rule-generation.config.json"),
    JSON.stringify({ enabled: true, sheetUrl: "https://docs.google.com/spreadsheets/d/example/edit?gid=1" }),
  );
  const api = createPlatformApi({ rootDir });

  await assert.rejects(
    () => api.submitQualityRuleGenerationRow({
      row: {
        countryRaw: "CN",
        database: "dwd",
        table: "dwd_demo",
        srcSql: "SELECT 1 AS cnt",
      },
    }),
    /write webhook is not configured/,
  );
});

test("platform api submits quality rule generation rows to configured writer", async () => {
  const rootDir = await makeFixture();
  await fs.writeFile(
    path.join(rootDir, "config/quality-rule-generation.config.json"),
    JSON.stringify({
      enabled: true,
      sheetUrl: "https://docs.google.com/spreadsheets/d/example/edit?gid=160372088",
      gid: "160372088",
      writeWebhookUrl: "https://n8n.example/webhook/quality-rule-write",
    }),
  );
  let captured = null;
  const api = createPlatformApi({
    rootDir,
    qualityRuleGenerationSubmitFn: async (url, payload) => {
      captured = { url, payload };
      return { ok: true };
    },
  });

  const result = await api.submitQualityRuleGenerationRow({
    row: {
      countryRaw: "中国",
      database: "dwd_sec",
      table: "dwd_cst_pay_cost_detail",
      autoGenerate: "是",
      needApply: "否",
      candidateKey: "dwd_sec::dwd_cst_pay_cost_detail::cnt",
      srcSql: "SELECT 1 AS cnt",
      destSql: "SELECT 1 AS cnt",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(captured.url, "https://n8n.example/webhook/quality-rule-write");
  assert.equal(captured.payload.row.country, "CN");
  assert.equal(captured.payload.values["国家"], "中国");
  assert.equal(captured.payload.values["数据库"], "dwd_sec");
  assert.equal(captured.payload.values["表名"], "dwd_cst_pay_cost_detail");
  assert.equal(captured.payload.values["是否自动生成"], "是");
  assert.equal(captured.payload.values["是否需要自动生成"], "是");
  assert.equal(captured.payload.values["是否上线"], "0");
  assert.equal(captured.payload.values["src_sql"], "SELECT 1 AS cnt");
});

test("platform api generates notify preview", async () => {
  const rootDir = await makeFixture();
  const api = createPlatformApi({ rootDir });

  const preview = await api.getNotifyPreview();
  assert.ok(preview.messages.length >= 1);
  assert.ok(preview.messages[0].body.includes("公共报表巡检"));
});

test("platform api sends TV notify test with explicit bot id", async () => {
  const rootDir = await makeFixture();
  let captured = null;
  const api = createPlatformApi({
    rootDir,
    notifyTextFn: async (config, message, metadata) => {
      captured = { config, message, metadata };
      return { sent: true, status: 200 };
    },
  });

  const result = await api.sendNotifyTest({
    botId: "tv-bot-001",
    message: "测试消息",
    webhookUrl: "https://tv-service-alert.kuainiu.chat/alert/v2/array",
    mentions: "strongliu@kn.group,jerrycai@kn.group",
  });

  assert.equal(result.sent, true);
  assert.equal(captured.config.alerts.channel, "tv");
  assert.equal(captured.config.alerts.webhookUrl, "https://tv-service-alert.kuainiu.chat/alert/v2/array");
  assert.equal(captured.config.alerts.botId, "tv-bot-001");
  assert.deepEqual(captured.config.alerts.mentions, ["strongliu@kn.group", "jerrycai@kn.group"]);
  assert.equal(captured.message, "测试消息");
});
