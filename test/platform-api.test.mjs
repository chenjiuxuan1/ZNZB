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
  assert.ok(captured[0].message.includes("公共报表巡检"));
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
  assert.equal(captured.length, 2);
  assert.equal(captured[0].config.alerts.botId, "tv-bot-001");

  const history = await api.getBatchHistory();
  assert.equal(history.runs.length, 1);
  assert.equal(history.runs[0].status, "success");
  assert.equal(history.runs[0].countryCount, 1);
  assert.equal(history.runs[0].checkedCardCount, 1);
  assert.equal(history.runs[0].anomalyCount, 1);
  assert.equal(history.runs[0].notificationSentCount, 2);
  assert.equal(history.runs[0].runs[0].result.checkedDashboards.length, 1);

  const filteredHistory = await api.getBatchHistory({ countryCode: "INE", status: "anomaly" });
  assert.equal(filteredHistory.runs.length, 1);
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
