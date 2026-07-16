import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createPlatformApi,
  flattenInventory,
} from "../src/platform-api.mjs";

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
  assert.match(captured[0].message, /2\.数据质量告警“未处理”统计/);
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
  assert.match(captured[0].message, new RegExp(`historyRunId=${history.runs[0].id}`));

  const filteredHistory = await api.getBatchHistory({ countryCode: "INE", status: "anomaly" });
  assert.equal(filteredHistory.runs.length, 1);
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
            dest_tbl: "dwd_asset_withhold_detail",
            name: "提现一致性",
            src_value: 100,
            dest_value: 98,
            diff: 2,
          },
          {
            id: 2,
            dest_tbl: "dwd_asset_withhold_request",
            name: "提现请求一致性",
            src_value: 50,
            dest_value: 49,
            diff: 1,
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
  assert.match(captured[0].message, /1\.Flink: 正常/);
  assert.match(captured[0].message, /2\.数据质量告警“未处理”统计/);
  assert.match(captured[0].message, /印尼\(INE\)/);
  assert.match(captured[0].message, /菲律宾\(PH\)/);
  assert.match(captured[0].message, /印尼：2/);
  assert.match(captured[0].message, /菲律宾：0/);
  assert.match(captured[0].message, /4\. BI报表\(Metabase\):/);
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
