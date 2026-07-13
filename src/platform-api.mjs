import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createDefaultMetabaseClient } from "./metabase-public-monitor.mjs";
import {
  buildDefaultCardParameters,
  checkPublicDashboards,
  evaluateRowsAgainstRule,
  mergeParameters,
} from "./metabase-public-monitor.mjs";
import { buildPublicCheckMessages, notifyText } from "./notifier.mjs";
import { readJsonFile } from "./utils.mjs";
import {
  mapWattrelRowsToAnomalies,
  queryWattrelAlerts as queryWattrelAlertRows,
} from "./wattrel-client.mjs";
import {
  readQualityRuleGenerationSheet,
  submitQualityRuleGenerationRow,
} from "./quality-rule-generation.mjs";
import {
  normalizeRuleMessages,
  validateCountriesConfig,
  validateRulesConfig,
  validateSandboxRequest,
} from "./platform-validation.mjs";

const FILES = {
  countries: "config/countries.config.json",
  rules: "config/public-monitor.config.json",
  inventory: "config/discovered-public-dashboards.ready.json",
  result: "config/public-check-result.ready.json",
  baselineCache: "config/public-check-baseline-cache.json",
  batchSchedule: "config/batch-check-schedule.json",
  batchHistory: "config/batch-check-run-history.json",
  wattrel: "config/wattrel.config.json",
  qualityRuleGeneration: "config/quality-rule-generation.config.json",
};
const DEFAULT_TV_WEBHOOK_URL = "https://tv-service-alert.kuainiu.chat/alert/v2/array";
const DEFAULT_DUTY_PLATFORM_BASE_URL = "https://big-data-duty-management-platform.kuainiujinke.com";
const DEFAULT_BATCH_SCHEDULE = {
  enabled: false,
  dailyRunTime: "09:00",
  dailyRunTimes: ["09:00"],
  intervalMinutes: 120,
  countryCode: "",
  dashboardUuid: "",
  notifyChannel: "knBot",
  webhookUrl: DEFAULT_TV_WEBHOOK_URL,
  botId: "",
  botToken: "",
  chatId: "",
  recipientEmails: "",
  mentions: "",
  countryConfigs: [],
  nextRunAt: null,
  lastRunAt: null,
  lastError: null,
  lastResult: null,
};
const DEFAULT_BATCH_HISTORY = { runs: [] };
const MAX_BATCH_HISTORY_RUNS = 200;

export function createPlatformApi({
  rootDir = process.cwd(),
  metabaseClientFactory = createDefaultMetabaseClient,
  notifyTextFn = notifyText,
  wattrelQueryFn = null,
  qualityRuleGenerationSubmitFn = null,
} = {}) {
  const resolve = (name) => path.join(rootDir, FILES[name]);
  let batchScheduleRunProgress = null;

  return {
    async getSummary() {
      const [countries, rules, inventory, result] = await Promise.all([
        readJsonFile(resolve("countries"), { countries: [] }),
        readJsonFile(resolve("rules"), { rules: [] }),
        readPlatformInventory(rootDir, resolve("inventory")),
        readJsonFile(resolve("result"), null),
      ]);
      const flat = flattenInventory(inventory);
      return {
        countryCount: countries.countries?.length || 0,
        dashboardCount: flat.dashboardCount,
        cardCount: flat.cardCount,
        ruleCount: rules.rules?.length || 0,
        lastResult: result
          ? {
              checkedAt: result.checkedAt || null,
              checkedCardCount: result.checkedCardCount || 0,
              anomalyCount: result.anomalyCount || 0,
              dataQualityAnomalyCount: result.dataQualityAnomalyCount || 0,
            }
          : null,
        countries: countries.countries || [],
        countrySummaries: summarizeCountries(countries.countries || [], inventory, result),
      };
    },

    async getCountries() {
      return readJsonFile(resolve("countries"), { countries: [] });
    },

    async getBatchSchedule() {
      const schedule = await readJsonFile(resolve("batchSchedule"), DEFAULT_BATCH_SCHEDULE);
      const countries = await readJsonFile(resolve("countries"), { countries: [] });
      return normalizeBatchSchedule(schedule, schedule, { countries: countries.countries || [], preserveNextRunAt: true });
    },

    async getBatchScheduleRunProgress() {
      return batchScheduleRunProgress || { status: "idle", countries: [] };
    },

    async getBatchHistory(filters = {}) {
      const history = await readJsonFile(resolve("batchHistory"), DEFAULT_BATCH_HISTORY);
      return filterBatchHistory(history, filters);
    },

    async ingestExternalAlertRun(body = {}) {
      const startedAt = String(body.checkedAt || body.startedAt || new Date().toISOString());
      const finishedAt = String(body.finishedAt || new Date().toISOString());
      const source = normalizeExternalSource(body.source || body.kind || "external");
      const historyRunId = String(body.id || body.runId || randomUUID());
      const detailUrl = buildBatchHistoryDetailUrl(historyRunId);
      const countryRuns = normalizeExternalCountryRuns(body, { source, checkedAt: startedAt });
      if (countryRuns.length === 0) {
        throw badRequest("No external alert data", ["请至少提供一个国家或一条异常。"]);
      }

      let notificationSentCount = 0;
      if (body.notify === true || body.sendNotification === true) {
        const rules = await readJsonFile(resolve("rules"), { alerts: {} });
        const notifyOptions = typeof body.notifyOptions === "object" && body.notifyOptions ? body.notifyOptions : body;
        const notifyChannel = normalizeNotifyChannel(notifyOptions.notifyChannel || notifyOptions.channel || rules.alerts?.channel || "tv");
        const alerts = buildBatchNotifyAlerts({ ...notifyOptions, detailUrl }, rules.alerts || {}, notifyChannel);
        const combinedResult = combineScheduledCountryResults(countryRuns.filter((item) => item.ok));
        const messages = buildPublicCheckMessages(combinedResult, {
          ...alerts,
          maxSummaryAnomalyDashboards: Number(notifyOptions.maxSummaryAnomalyDashboards || 5),
          maxSummaryTopAnomalies: Number(notifyOptions.maxSummaryTopAnomalies || 8),
        });
        const results = [];
        for (const message of messages) {
          results.push(await notifyTextFn({ ...rules, alerts }, message.body, {
            title: message.title,
            severity: "warning",
            timestamp: combinedResult.checkedAt,
            anomalyCount: message.anomalyCount ?? combinedResult.anomalyCount,
            checkedCardCount: combinedResult.checkedCardCount,
          }));
        }
        const notification = {
          sent: results.some((item) => item.sent),
          skipped: false,
          reason: results.some((item) => item.sent) ? null : "send failed",
          sentMessages: messages.length,
          results,
          channel: alerts.channel,
          botId: alerts.botId || "",
          chatId: alerts.chatId || "",
          recipientEmails: alerts.recipientEmails || "",
          mentions: alerts.mentions || [],
          webhookUrl: alerts.webhookUrl || "",
          detailUrl: alerts.detailUrl || "",
          sentAt: new Date().toISOString(),
        };
        markCountryRunNotifications(countryRuns, notification);
        notificationSentCount = messages.length;
      }

      const entry = buildBatchHistoryEntry({
        trigger: `external_${source}`,
        id: historyRunId,
        startedAt,
        finishedAt,
        nextRunAt: null,
        schedule: { intervalMinutes: null },
        countryRuns,
        notificationSentCount,
      });
      entry.source = source;
      entry.title = String(body.title || externalSourceTitle(source));
      await appendBatchHistoryRun(resolve("batchHistory"), entry);
      return {
        ok: true,
        id: historyRunId,
        source,
        detailUrl,
        notificationSentCount,
        summary: {
          countryCount: entry.countryCount,
          checkedCardCount: entry.checkedCardCount,
          dashboardCount: entry.dashboardCount,
          anomalyCount: entry.anomalyCount,
        },
        entry,
      };
    },

    async queryWattrelAlerts(body = {}) {
      const config = await readJsonFile(resolve("wattrel"), { enabled: false });
      const countriesConfig = await readJsonFile(resolve("countries"), { countries: [] });
      const current = await queryCurrentWattrelTargets({
        config,
        countries: countriesConfig.countries || [],
        body,
        queryFn: wattrelQueryFn,
      });
      const anomalies = current.anomalies;

      if (anomalies.length === 0) {
        return {
          ok: true,
          source: "wattrel",
          rowCount: current.rows.length,
          detailUrl: null,
          notificationSentCount: 0,
          summary: {
            countryCount: 0,
            checkedCardCount: 0,
            dashboardCount: 0,
            anomalyCount: 0,
          },
          entry: null,
        };
      }

      const result = await this.ingestExternalAlertRun({
        source: "wattrel",
        title: body.title || config.title || "Wattrel 数据质量巡检",
        checkedAt: body.checkedAt || new Date().toISOString(),
        anomalies,
        notify: body.notify === true || body.sendNotification === true,
        notifyChannel: body.notifyChannel || body.channel,
        webhookUrl: body.webhookUrl,
        botId: body.botId,
        botToken: body.botToken,
        chatId: body.chatId,
        recipientEmails: body.recipientEmails,
        mentions: body.mentions,
        notifyOptions: body.notifyOptions,
      });

      return {
        ...result,
        rowCount: current.rows.length,
        countries: current.countries,
      };
    },

    async getCurrentWattrelAlerts(body = {}) {
      const config = await readJsonFile(resolve("wattrel"), { enabled: false });
      const checkedAt = body.checkedAt || new Date().toISOString();
      const countriesConfig = await readJsonFile(resolve("countries"), { countries: [] });
      const current = await queryCurrentWattrelTargets({
        config,
        countries: countriesConfig.countries || [],
        body,
        queryFn: wattrelQueryFn,
      });
      const snapshot = buildWattrelCurrentSnapshot({
        rows: current.rows,
        anomalies: current.anomalies,
        checkedAt,
        countryStatuses: current.countries,
      });
      return {
        ok: true,
        source: "wattrel",
        configEnabled: current.countries.some((item) => item.configured),
        connectionMode: current.connectionMode,
        ...snapshot,
      };
    },

    async getQualityRuleGenerationSheet(body = {}) {
      const config = await readJsonFile(resolve("qualityRuleGeneration"), {
        enabled: false,
        mock: true,
      });
      return readQualityRuleGenerationSheet({
        config,
        mode: body.mode || "auto",
      });
    },

    async submitQualityRuleGenerationRow(body = {}) {
      const config = await readJsonFile(resolve("qualityRuleGeneration"), {
        enabled: false,
        mock: true,
      });
      return submitQualityRuleGenerationRow({
        config,
        row: body.row || body,
        submitFn: qualityRuleGenerationSubmitFn || undefined,
      });
    },

    async saveBatchSchedule(body = {}) {
      const previous = await this.getBatchSchedule();
      const countries = await readJsonFile(resolve("countries"), { countries: [] });
      const inventory = await readPlatformInventory(rootDir, resolve("inventory"));
      const next = normalizeBatchSchedule(body, previous, { countries: countries.countries || [] });
      const enabledCountries = next.countryConfigs.filter((item) => item.enabled);
      if (next.enabled && enabledCountries.length === 0) {
        throw badRequest("No scheduled countries", ["启用定时巡检前请至少启用一个国家。"]);
      }
      for (const countryConfig of enabledCountries) {
        const countryInventory = filterBatchInventory(inventory, {
          countryCode: countryConfig.countryCode,
          dashboardUuids: countryConfig.dashboardUuids || [],
        });
        if (countryInventory.dashboardCount === 0) {
          throw badRequest("No public dashboard for country", [
            await explainUnavailableCountryInventory(rootDir, countryConfig.countryCode, countries.countries || []),
          ]);
        }
        if (isKnBotChannel(countryConfig.notifyChannel)) {
          if (!countryConfig.chatId && !countryConfig.recipientEmails) {
            throw badRequest("KN Chat recipient is required", [`${countryConfig.countryCode} 启用定时巡检前请填写接收人邮箱或群聊 chat_id。`]);
          }
          continue;
        }
        if (!countryConfig.botId) {
          throw badRequest("TV bot_id is required", [`${countryConfig.countryCode} 启用定时巡检前请填写 TV bot_id。`]);
        }
        if (!countryConfig.webhookUrl) {
          throw badRequest("TV webhook is required", [`${countryConfig.countryCode} 启用定时巡检前请填写 TV webhook 地址。`]);
        }
      }
      await writeJsonAtomic(resolve("batchSchedule"), next);
      return next;
    },

    async runBatchScheduleNow(now = new Date()) {
      const schedule = await this.getBatchSchedule();
      const enabledCountryConfigs = schedule.countryConfigs.filter((item) => item.enabled);
      if (enabledCountryConfigs.length === 0) {
        throw badRequest("No scheduled countries", ["请先至少启用一个国家，再运行定时巡检测试。"]);
      }

      const startedAt = now.toISOString();
      const nextRunAt = schedule.nextRunAt;
      const historyRunId = randomUUID();
      const detailUrl = buildBatchHistoryDetailUrl(historyRunId);
      batchScheduleRunProgress = createBatchScheduleRunProgress({
        id: historyRunId,
        trigger: "manual_test",
        startedAt,
        countryConfigs: enabledCountryConfigs,
      });
      try {
        const countryRuns = await runScheduledCountryChecks(enabledCountryConfigs, (body) => this.runBatchCheck(body), (event) => {
          batchScheduleRunProgress = updateBatchScheduleRunProgress(batchScheduleRunProgress, event);
        });
        batchScheduleRunProgress = { ...batchScheduleRunProgress, status: "sending", currentCountryCode: "", currentCountryName: "" };
        const notificationSentCount = await sendScheduledAggregateNotifications({
          countryRuns,
          countryConfigs: enabledCountryConfigs,
          rulesFile: resolve("rules"),
          notifyTextFn,
          detailUrl,
        });
        const failedRuns = countryRuns.filter((item) => !item.ok);
        const saved = {
          ...schedule,
          lastRunAt: startedAt,
          nextRunAt,
          lastError: failedRuns.length ? failedRuns.map((item) => `${item.countryCode}: ${item.error}`).join("; ") : null,
          lastResult: summarizeCountryScheduleRuns(countryRuns),
        };
        batchScheduleRunProgress = {
          ...batchScheduleRunProgress,
          status: failedRuns.length ? "partial_failed" : "success",
          finishedAt: new Date().toISOString(),
          result: saved.lastResult,
          notificationSentCount,
        };
        await writeJsonAtomic(resolve("batchSchedule"), saved);
        await appendBatchHistoryRun(resolve("batchHistory"), buildBatchHistoryEntry({
          trigger: "manual_test",
          id: historyRunId,
          startedAt,
          finishedAt: new Date().toISOString(),
          nextRunAt,
          schedule,
          countryRuns,
          notificationSentCount,
        }));
        return { ran: true, schedule: saved, result: saved.lastResult };
      } catch (error) {
        batchScheduleRunProgress = {
          ...(batchScheduleRunProgress || {}),
          status: "failed",
          error: error.message,
          finishedAt: new Date().toISOString(),
        };
        const saved = {
          ...schedule,
          lastRunAt: startedAt,
          nextRunAt,
          lastError: error.message,
          lastResult: null,
        };
        await writeJsonAtomic(resolve("batchSchedule"), saved);
        await appendBatchHistoryRun(resolve("batchHistory"), {
          id: historyRunId,
          trigger: "manual_test",
          startedAt,
          finishedAt: new Date().toISOString(),
          nextRunAt,
          status: "failed",
          ok: false,
          error: error.message,
          countryCount: 0,
          successCount: 0,
          failedCount: 1,
          checkedCardCount: 0,
          dashboardCount: 0,
          anomalyCount: 0,
          dataQualityAnomalyCount: 0,
          notificationSentCount: 0,
          runs: [],
        });
        return { ran: true, schedule: saved, error: error.message };
      }
    },

    async saveCountriesConfig(config) {
      const validation = validateCountriesConfig(config);
      if (!validation.ok) {
        throw badRequest("Invalid countries config", validation.errors);
      }
      await writeJsonAtomic(resolve("countries"), config);
      return config;
    },

    async getInventory(filters = {}) {
      const [countries, inventory] = await Promise.all([
        readJsonFile(resolve("countries"), { countries: [] }),
        readPlatformInventory(rootDir, resolve("inventory")),
      ]);
      const filtered = filterInventory(inventory, filters);
      return {
        ...filtered,
        panelSources: await loadPanelSources(rootDir, countries.countries || [], filters),
      };
    },

    async getRulesConfig() {
      const config = await readJsonFile(resolve("rules"), { rules: [] });
      return redactRuleConfig(config);
    },

    async saveRulesConfig(config) {
      const validation = validateRulesConfig(config);
      if (!validation.ok) {
        throw badRequest("Invalid rules config", validation.errors);
      }
      const previous = await readJsonFile(resolve("rules"), {});
      const next = {
        ...previous,
        ...config,
        alerts: preserveHiddenSecrets(config.alerts ?? previous.alerts, previous.alerts, ["webhookUrl", "botId"]),
        gateway: preserveHiddenSecrets(config.gateway ?? previous.gateway, previous.gateway, ["token"]),
      };
      await writeJsonAtomic(resolve("rules"), next);
      return redactRuleConfig(next);
    },

    async evaluateSandbox(body) {
      const validation = validateSandboxRequest(body);
      if (!validation.ok) {
        throw badRequest("Invalid sandbox request", validation.errors);
      }
      const rule = applyDashboardRuleDefaults(body.rule, body.dashboard);
      const raw = evaluateRowsAgainstRule(body.rows, rule);
      const messages = normalizeRuleMessages(raw);
      return {
        ok: true,
        matched: messages.length > 0,
        messages,
        rowCount: body.rows.length,
        dashboard: body.dashboard || null,
        card: body.card || null,
        rule,
      };
    },

    async evaluateLiveSandbox(body) {
      validateLiveSandboxRequest(body);
      const dashboard = body.dashboard;
      const card = body.card;
      const rule = applyDashboardRuleDefaults(body.rule, dashboard);
      const client = metabaseClientFactory(dashboard);
      const parameters = mergeParameters(buildDefaultCardParameters(dashboard, card), rule.parameters || []);
      const request = {
        cardId: card.cardId,
        dashcardId: card.dashcardId,
        parameters,
      };
      if (dashboard.access === "internal") {
        request.dashboardId = dashboard.dashboardId;
      } else {
        request.dashboardUuid = dashboard.uuid;
      }
      const rows = await client.queryDashcardJson(request);
      const safeRows = Array.isArray(rows) ? rows : [];
      const raw = evaluateRowsAgainstRule(safeRows, rule);
      const messages = normalizeRuleMessages(raw);
      return {
        ok: true,
        source: "metabase",
        matched: messages.length > 0,
        messages,
        rowCount: safeRows.length,
        rows: safeRows,
        request: {
          baseUrl: new URL(dashboard.url).origin,
          dashboardUuid: dashboard.uuid,
          dashboardId: dashboard.dashboardId || null,
          cardId: card.cardId,
          dashcardId: card.dashcardId,
          parameterCount: parameters.length,
        },
        dashboard,
        card,
        rule,
      };
    },

    async runBatchCheck(body = {}) {
      const inventory = await readPlatformInventory(rootDir, resolve("inventory"));
      const ruleConfig = await readJsonFile(resolve("rules"), {
        builtInChecks: { queryError: true, noData: true },
        rules: [],
      });
      const countryCode = String(body.countryCode || "").trim();
      const dashboardUuid = String(body.dashboardUuid || "").trim();
      const dashboardUuids = normalizeDashboardUuids(body.dashboardUuids);
      const filteredInventory = filterBatchInventory(inventory, { countryCode, dashboardUuid, dashboardUuids });
      if (countryCode && filteredInventory.dashboardCount === 0) {
        const countries = await readJsonFile(resolve("countries"), { countries: [] });
        throw badRequest("No public dashboard for country", [
          await explainUnavailableCountryInventory(rootDir, countryCode, countries.countries || []),
        ]);
      }
      if ((dashboardUuid || dashboardUuids.length) && filteredInventory.dashboardCount === 0) {
        throw badRequest("Dashboard not found", ["选择的看板不在当前国家范围内，请重新选择看板。"]);
      }
      const queryCardFn = async (_client, dashboard, card, parameters = []) => {
        const client = metabaseClientFactory(dashboard);
        try {
          const request = {
            cardId: card.cardId,
            dashcardId: card.dashcardId,
            parameters,
          };
          if (dashboard.access === "internal") {
            request.dashboardId = dashboard.dashboardId;
          } else {
            request.dashboardUuid = dashboard.uuid;
          }
          const rows = await client.queryDashcardJson(request);
          return {
            ok: true,
            rows: Array.isArray(rows) ? rows : [],
            error: null,
          };
        } catch (error) {
          return {
            ok: false,
            rows: [],
            error: error.message,
          };
        }
      };
      return checkPublicDashboards({
        inventory: filteredInventory,
        ruleConfig: {
          ...ruleConfig,
          builtInChecks: {
            ...(ruleConfig.builtInChecks || {}),
            queryError: true,
          },
          dataQuality: { ...(ruleConfig.dataQuality || {}), enabled: false },
        },
        baselineCacheFile: resolve("baselineCache"),
        queryCardFn,
      });
    },

    async runBatchCheckAndNotify(body = {}) {
      const result = await this.runBatchCheck(body);
      const anomalyCount = Number(result.anomalyCount || 0) + Number(result.dataQualityAnomalyCount || 0);
      if (anomalyCount <= 0) {
        return {
          ...result,
          notification: {
            sent: false,
            skipped: true,
            reason: "no anomalies",
            sentMessages: 0,
            results: [],
            channel: normalizeNotifyChannel(body.notifyChannel || "tv"),
            botId: String(body.botId || "").trim(),
            chatId: String(body.chatId || "").trim(),
            recipientEmails: String(body.recipientEmails || "").trim(),
            mentions: normalizeMentions(body.mentions),
            detailUrl: String(body.detailUrl || "").trim(),
            sentAt: null,
          },
        };
      }
      const rules = await readJsonFile(resolve("rules"), { alerts: {} });
      const notifyChannel = normalizeNotifyChannel(body.notifyChannel || "tv");
      const alerts = buildBatchNotifyAlerts(body, rules.alerts || {}, notifyChannel);
      const messages = buildPublicCheckMessages(result, alerts);
      const results = [];
      for (const message of messages) {
        results.push(
          await notifyTextFn({ ...rules, alerts }, message.body, {
            title: message.title,
            severity: anomalyCount > 0 ? "warning" : "info",
            timestamp: result.checkedAt,
            anomalyCount: message.anomalyCount ?? result.anomalyCount,
            checkedCardCount: result.checkedCardCount,
          }),
        );
      }
      return {
        ...result,
        notification: {
          sent: results.some((item) => item.sent),
          sentMessages: messages.length,
          results,
          channel: alerts.channel,
          botId: alerts.botId || "",
          chatId: alerts.chatId || "",
          mentions: alerts.mentions,
          webhookUrl: alerts.webhookUrl,
          detailUrl: alerts.detailUrl || "",
          sentAt: new Date().toISOString(),
        },
      };
    },

    async runDueBatchSchedule(now = new Date()) {
      const schedule = await this.getBatchSchedule();
      if (!schedule.enabled) {
        return { ran: false, reason: "disabled", schedule };
      }

      const dueAt = schedule.nextRunAt ? Date.parse(schedule.nextRunAt) : Number.NaN;
      if (Number.isFinite(dueAt) && dueAt > now.getTime()) {
        return { ran: false, reason: "not due", schedule };
      }

      const startedAt = now.toISOString();
      const nextRunAt = nextDailyRunAt(schedule.dailyRunTimes || [schedule.dailyRunTime], new Date(now.getTime() + 60_000));
      const historyRunId = randomUUID();
      const detailUrl = buildBatchHistoryDetailUrl(historyRunId);
      try {
        const enabledCountryConfigs = schedule.countryConfigs.filter((item) => item.enabled);
        batchScheduleRunProgress = createBatchScheduleRunProgress({
          id: historyRunId,
          trigger: "schedule",
          startedAt,
          countryConfigs: enabledCountryConfigs,
        });
        const countryRuns = await runScheduledCountryChecks(enabledCountryConfigs, (body) => this.runBatchCheck(body), (event) => {
          batchScheduleRunProgress = updateBatchScheduleRunProgress(batchScheduleRunProgress, event);
        });
        batchScheduleRunProgress = { ...batchScheduleRunProgress, status: "sending", currentCountryCode: "", currentCountryName: "" };
        const notificationSentCount = await sendScheduledAggregateNotifications({
          countryRuns,
          countryConfigs: enabledCountryConfigs,
          rulesFile: resolve("rules"),
          notifyTextFn,
          detailUrl,
        });
        const failedRuns = countryRuns.filter((item) => !item.ok);
        const saved = {
          ...schedule,
          lastRunAt: startedAt,
          nextRunAt,
          lastError: failedRuns.length ? failedRuns.map((item) => `${item.countryCode}: ${item.error}`).join("; ") : null,
          lastResult: summarizeCountryScheduleRuns(countryRuns),
        };
        batchScheduleRunProgress = {
          ...batchScheduleRunProgress,
          status: failedRuns.length ? "partial_failed" : "success",
          finishedAt: new Date().toISOString(),
          result: saved.lastResult,
          notificationSentCount,
        };
        await writeJsonAtomic(resolve("batchSchedule"), saved);
        await appendBatchHistoryRun(resolve("batchHistory"), buildBatchHistoryEntry({
          trigger: "schedule",
          id: historyRunId,
          startedAt,
          finishedAt: new Date().toISOString(),
          nextRunAt,
          schedule,
          countryRuns,
          notificationSentCount,
        }));
        return { ran: true, schedule: saved, result: saved.lastResult };
      } catch (error) {
        batchScheduleRunProgress = {
          ...(batchScheduleRunProgress || {}),
          status: "failed",
          error: error.message,
          finishedAt: new Date().toISOString(),
        };
        const saved = {
          ...schedule,
          lastRunAt: startedAt,
          nextRunAt,
          lastError: error.message,
          lastResult: null,
        };
        await writeJsonAtomic(resolve("batchSchedule"), saved);
        await appendBatchHistoryRun(resolve("batchHistory"), {
          id: historyRunId,
          trigger: "schedule",
          startedAt,
          finishedAt: new Date().toISOString(),
          nextRunAt,
          status: "failed",
          ok: false,
          error: error.message,
          countryCount: 0,
          successCount: 0,
          failedCount: 1,
          checkedCardCount: 0,
          dashboardCount: 0,
          anomalyCount: 0,
          dataQualityAnomalyCount: 0,
          notificationSentCount: 0,
          runs: [],
        });
        return { ran: true, schedule: saved, error: error.message };
      }
    },

    async getNotifyPreview(resultOverride = null, optionOverride = {}) {
      const rules = await readJsonFile(resolve("rules"), { alerts: {} });
      const result = resultOverride || await readJsonFile(resolve("result"), {
        checkedAt: new Date().toISOString(),
        checkedCardCount: 0,
        anomalyCount: 0,
        anomalies: [],
      });
      return {
        messages: buildPublicCheckMessages(result, { ...(rules.alerts || {}), ...optionOverride }),
      };
    },

    async sendNotifyTest(body = {}) {
      const rules = await readJsonFile(resolve("rules"), { alerts: {} });
      const botId = String(body.botId || "").trim();
      const message = String(body.message || "").trim();
      if (!botId) {
        throw badRequest("TV bot_id is required", ["请填写 TV bot_id。"]);
      }
      if (!message) {
        throw badRequest("Message is required", ["请先生成或填写要测试发送的 TV 文案。"]);
      }
      const alerts = {
        ...(rules.alerts || {}),
        channel: "tv",
        webhookUrl: resolveWebhookUrl(body.webhookUrl, rules.alerts?.webhookUrl),
        botId,
        mentions: normalizeMentions(body.mentions),
      };
      const result = await notifyTextFn({ ...rules, alerts }, message, {
        title: body.title || "值班平台 TV 测试",
        severity: "info",
        timestamp: new Date().toISOString(),
      });
      return {
        ...result,
        botId,
        sentAt: new Date().toISOString(),
      };
    },
  };
}

function normalizeMentions(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (!value) {
    return [];
  }
  return String(value)
    .split(/[\n,，;；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeNotifyChannel(value) {
  const channel = String(value || "").trim();
  if (["knBot", "knChatBot", "kn_chat_bot", "kn-chat-bot"].includes(channel)) {
    return "knBot";
  }
  return channel || "tv";
}

function isKnBotChannel(value) {
  return normalizeNotifyChannel(value) === "knBot";
}

function buildBatchHistoryDetailUrl(runId) {
  const baseUrl = String(process.env.DUTY_PLATFORM_BASE_URL || process.env.PLATFORM_BASE_URL || "").trim()
    || DEFAULT_DUTY_PLATFORM_BASE_URL;
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  const params = new URLSearchParams({ historyRunId: String(runId || "") });
  return `${normalizedBaseUrl}/#/batch-check?${params.toString()}`;
}

function inferCountryNotifyChannel(mergedConfig, incomingConfig, previousSchedule) {
  if (incomingConfig.notifyChannel) {
    return normalizeNotifyChannel(incomingConfig.notifyChannel);
  }
  if (incomingConfig.botId) {
    return "tv";
  }
  if (mergedConfig.notifyChannel) {
    return normalizeNotifyChannel(mergedConfig.notifyChannel);
  }
  if (mergedConfig.botId) {
    return "tv";
  }
  return normalizeNotifyChannel(previousSchedule.notifyChannel || DEFAULT_BATCH_SCHEDULE.notifyChannel);
}

function buildBatchNotifyAlerts(body, configuredAlerts, notifyChannel) {
  const mentions = normalizeMentions(body.mentions);
  const detailUrl = String(body.detailUrl || configuredAlerts?.detailUrl || "").trim();
  if (isKnBotChannel(notifyChannel)) {
    const botToken = String(body.botToken || "${KN_BOT_TOKEN}").trim();
    const chatId = String(body.chatId || "").trim();
    const recipientEmails = String(body.recipientEmails || "").trim();
    if (!chatId && !recipientEmails) {
      throw badRequest("KN Chat recipient is required", ["请填写接收人邮箱或群聊 chat_id。"]);
    }
    return {
      ...(configuredAlerts || {}),
      channel: "knBot",
      botApiBaseUrl: String(body.botApiBaseUrl || configuredAlerts?.botApiBaseUrl || "").trim(),
      botToken,
      chatId,
      recipientEmails,
      mentions,
      detailUrl,
    };
  }

  const botId = String(body.botId || "").trim();
  if (!botId) {
    throw badRequest("TV bot_id is required", ["请填写 TV bot_id。"]);
  }
  const webhookUrl = resolveWebhookUrl(body.webhookUrl, configuredAlerts?.webhookUrl);
  if (!webhookUrl) {
    throw badRequest("TV webhook is required", ["请填写 TV webhook 地址。"]);
  }
  return {
    ...(configuredAlerts || {}),
    channel: "tv",
    webhookUrl,
    botId,
    mentions,
    detailUrl,
  };
}

function normalizeBatchSchedule(input = {}, previous = {}, options = {}) {
  const previousSchedule = { ...DEFAULT_BATCH_SCHEDULE, ...(previous || {}) };
  const enabled = Boolean(input.enabled);
  const intervalMinutes = clampNumber(input.intervalMinutes ?? previousSchedule.intervalMinutes, 5, 1440, 120);
  const dailyRunTimes = normalizeDailyRunTimes(input.dailyRunTimes ?? input.dailyRunTime ?? previousSchedule.dailyRunTimes ?? previousSchedule.dailyRunTime);
  const dailyRunTime = dailyRunTimes[0] || DEFAULT_BATCH_SCHEDULE.dailyRunTime;
  const webhookUrl = String(input.webhookUrl ?? previousSchedule.webhookUrl ?? DEFAULT_TV_WEBHOOK_URL).trim();
  const notifyChannel = normalizeNotifyChannel(input.notifyChannel ?? previousSchedule.notifyChannel ?? DEFAULT_BATCH_SCHEDULE.notifyChannel);
  const countryConfigs = normalizeCountryScheduleConfigs(input.countryConfigs, previousSchedule, options.countries || []);
  const requestedNextRunAt = normalizeScheduleTime(input.nextRunAt);
  const next = {
    ...previousSchedule,
    enabled,
    dailyRunTime,
    dailyRunTimes,
    intervalMinutes,
    countryCode: String(input.countryCode ?? previousSchedule.countryCode ?? "").trim(),
    dashboardUuid: String(input.dashboardUuid ?? previousSchedule.dashboardUuid ?? "").trim(),
    notifyChannel,
    webhookUrl: webhookUrl || DEFAULT_TV_WEBHOOK_URL,
    botId: String(input.botId ?? previousSchedule.botId ?? "").trim(),
    botToken: String(input.botToken ?? previousSchedule.botToken ?? "").trim(),
    chatId: String(input.chatId ?? previousSchedule.chatId ?? "").trim(),
    recipientEmails: String(input.recipientEmails ?? previousSchedule.recipientEmails ?? "").trim(),
    mentions: normalizeMentions(input.mentions ?? previousSchedule.mentions).join(","),
    countryConfigs,
    lastRunAt: previousSchedule.lastRunAt || null,
    lastError: previousSchedule.lastError || null,
    lastResult: previousSchedule.lastResult || null,
  };

  if (!enabled) {
    next.nextRunAt = null;
    return next;
  }

  if (requestedNextRunAt) {
    next.nextRunAt = requestedNextRunAt;
    return next;
  }

  if (options.preserveNextRunAt && previousSchedule.nextRunAt) {
    next.nextRunAt = previousSchedule.nextRunAt;
    return next;
  }

  const previousNextRunAt = previousSchedule.nextRunAt ? Date.parse(previousSchedule.nextRunAt) : Number.NaN;
  const dailyRunTimeChanged = dailyRunTimesKey(next.dailyRunTimes) !== dailyRunTimesKey(previousSchedule.dailyRunTimes || [previousSchedule.dailyRunTime]);
  const countryChanged = JSON.stringify(next.countryConfigs.map((item) => ({
    countryCode: item.countryCode,
    enabled: item.enabled,
    dashboardUuids: item.dashboardUuids || [],
    notifyChannel: item.notifyChannel || DEFAULT_BATCH_SCHEDULE.notifyChannel,
  }))) !== JSON.stringify((previousSchedule.countryConfigs || []).map((item) => ({
    countryCode: item.countryCode,
    enabled: item.enabled,
    dashboardUuids: item.dashboardUuids || [],
    notifyChannel: item.notifyChannel || DEFAULT_BATCH_SCHEDULE.notifyChannel,
  })));
  const intervalChanged = next.intervalMinutes !== Number(previousSchedule.intervalMinutes || DEFAULT_BATCH_SCHEDULE.intervalMinutes);
  if (!countryChanged && !intervalChanged && !dailyRunTimeChanged && Number.isFinite(previousNextRunAt) && previousNextRunAt > Date.now()) {
    next.nextRunAt = previousSchedule.nextRunAt;
  } else {
    next.nextRunAt = nextDailyRunAt(dailyRunTimes);
  }

  return next;
}

function normalizeDailyRunTime(value) {
  const text = String(value || "").trim();
  const match = text.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) {
    return DEFAULT_BATCH_SCHEDULE.dailyRunTime;
  }
  return `${match[1]}:${match[2]}`;
}

function normalizeDailyRunTimes(value) {
  const values = Array.isArray(value)
    ? value
    : String(value || "")
      .split(/[\n,，;；\s]+/)
      .map((item) => item.trim());
  const times = [...new Set(values.map(normalizeDailyRunTime).filter(Boolean))].sort();
  return times.length ? times : [...DEFAULT_BATCH_SCHEDULE.dailyRunTimes];
}

function dailyRunTimesKey(value) {
  return normalizeDailyRunTimes(value).join(",");
}

function nextDailyRunAt(dailyRunTimes, now = new Date()) {
  const beijingNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const year = beijingNow.getUTCFullYear();
  const month = beijingNow.getUTCMonth();
  const date = beijingNow.getUTCDate();
  const runTimes = normalizeDailyRunTimes(dailyRunTimes);
  for (const time of runTimes) {
    const [hour, minute] = time.split(":").map(Number);
    const nextUtcMs = Date.UTC(year, month, date, hour - 8, minute, 0, 0);
    if (nextUtcMs > now.getTime()) {
      return new Date(nextUtcMs).toISOString();
    }
  }
  const [hour, minute] = runTimes[0].split(":").map(Number);
  const nextUtcMs = Date.UTC(year, month, date + 1, hour - 8, minute, 0, 0);
  return new Date(nextUtcMs).toISOString();
}

function normalizeScheduleTime(value) {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return new Date(timestamp).toISOString();
}

function clampNumber(value, min, max, fallback) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(numberValue)));
}

function normalizeCountryScheduleConfigs(inputConfigs, previousSchedule, countries) {
  const previousConfigs = new Map((previousSchedule.countryConfigs || []).map((item) => [item.countryCode, item]));
  const incomingConfigs = new Map((inputConfigs || []).map((item) => [String(item.countryCode || "").trim(), item]));
  const countryCodes = countries.length
    ? countries.map((country) => country.code).filter(Boolean)
    : [...new Set([...previousConfigs.keys(), ...incomingConfigs.keys()])].filter(Boolean);

  return countryCodes.map((countryCode) => {
    const previousConfig = previousConfigs.get(countryCode) || {};
    const incomingConfig = incomingConfigs.get(countryCode) || {};
    const merged = { ...previousConfig, ...incomingConfig };
    return {
      countryCode,
      countryName: countries.find((country) => country.code === countryCode)?.name || previousConfig.countryName || "",
      enabled: Boolean(merged.enabled),
      dashboardUuids: normalizeDashboardUuids(merged.dashboardUuids ?? previousConfig.dashboardUuids),
      notifyChannel: inferCountryNotifyChannel(merged, incomingConfig, previousSchedule),
      webhookUrl: String(merged.webhookUrl ?? previousSchedule.webhookUrl ?? DEFAULT_TV_WEBHOOK_URL).trim() || DEFAULT_TV_WEBHOOK_URL,
      botId: String(merged.botId ?? previousSchedule.botId ?? "").trim(),
      botToken: normalizeDefaultSecret(merged.botToken ?? previousSchedule.botToken, "${KN_BOT_TOKEN}"),
      chatId: String(merged.chatId ?? previousSchedule.chatId ?? "").trim(),
      recipientEmails: String(merged.recipientEmails ?? previousSchedule.recipientEmails ?? "").trim(),
      mentions: normalizeMentions(merged.mentions ?? previousSchedule.mentions).join(","),
    };
  });
}

function normalizeDefaultSecret(value, fallback) {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function summarizeBatchScheduleRun(result = {}) {
  return {
    checkedAt: result.checkedAt || null,
    checkedCardCount: result.checkedCardCount || 0,
    dashboardCount: result.dashboardCount || 0,
    checkedDashboards: summarizeCheckedDashboards(result),
    checkedCards: Array.isArray(result.checkedCards) ? result.checkedCards : [],
    anomalyCount: result.anomalyCount || 0,
    anomalies: Array.isArray(result.anomalies) ? result.anomalies : [],
    dataQualityAnomalyCount: result.dataQualityAnomalyCount || 0,
    dataQuality: result.dataQuality || null,
    notification: result.notification
      ? {
          sent: Boolean(result.notification.sent),
          skipped: Boolean(result.notification.skipped),
          reason: result.notification.reason || null,
          sentMessages: result.notification.sentMessages || 0,
          sentAt: result.notification.sentAt || null,
        }
      : null,
  };
}

function normalizeExternalSource(value) {
  return String(value || "external")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    || "external";
}

function externalSourceTitle(source) {
  if (source === "wattrel") {
    return "Wattrel 数据质量巡检";
  }
  return "外部告警巡检";
}

async function queryCurrentWattrelTargets({ config = {}, countries = [], body = {}, queryFn = null } = {}) {
  const targets = buildWattrelTargets({ config, countries, body, forceConfigured: Boolean(queryFn) });
  const countryStatuses = await Promise.all(targets.map(async (target) => {
    const status = {
      countryCode: target.countryCode,
      countryName: target.countryName,
      configured: target.configured,
      status: target.configured ? "pending" : "unconfigured",
      rowCount: 0,
      anomalyCount: 0,
      tableCount: 0,
      topTables: [],
      anomalies: [],
      error: null,
    };
    if (!target.configured) {
      return status;
    }
    try {
      const rows = await queryWattrelAlertRows({ config: target.config, limit: target.limit, queryFn });
      const anomalies = mapWattrelRowsToAnomalies(rows, {
        countryCode: target.countryCode,
        countryName: target.countryName,
      });
      const tableCount = new Set(anomalies.map((item) => item.destTbl || item.cardTitle).filter(Boolean)).size;
      status.status = "success";
      status.rowCount = rows.length;
      status.anomalyCount = anomalies.length;
      status.tableCount = tableCount;
      status.rows = rows;
      status.anomalies = anomalies;
      status.topTables = summarizeWattrelTargetTables(anomalies).slice(0, 5);
    } catch (error) {
      status.status = "failed";
      status.error = error.message || String(error);
    }
    return status;
  }));
  const allRows = countryStatuses.flatMap((country) => country.rows || []);
  const allAnomalies = countryStatuses.flatMap((country) => country.anomalies || []);
  return {
    rows: allRows,
    anomalies: allAnomalies,
    countries: countryStatuses,
    connectionMode: targets.some((item) => item.usesCountryConfig) ? "country" : "global",
  };
}

function buildWattrelTargets({ config = {}, countries = [], body = {}, forceConfigured = false } = {}) {
  const selectedCountryCode = String(body.countryCode || "").trim();
  const countryConnections = normalizeCountryWattrelConnections(config);
  const hasCountryConnections = countryConnections.length > 0;
  const countryList = countries.length
    ? countries
    : countryConnections.map((item) => ({ code: item.countryCode, name: item.countryName || item.countryCode }));
  const visibleCountries = selectedCountryCode
    ? countryList.filter((country) => country.code === selectedCountryCode)
    : countryList;

  if (hasCountryConnections || (!forceConfigured && !hasGlobalWattrelDatabase(config) && !config.defaultCountryCode && countryList.length)) {
    return visibleCountries.map((country) => {
      const code = String(country.code || country.countryCode || "").trim();
      const connection = countryConnections.find((item) => item.countryCode === code) || {};
      return buildCountryWattrelTarget({
        baseConfig: config,
        country,
        connection,
        body,
        forceConfigured,
        usesCountryConfig: true,
      });
    });
  }

  const preferredCode = config.defaultCountryCode || selectedCountryCode || "";
  const country = preferredCode
    ? (visibleCountries.find((item) => item.code === preferredCode) || { code: preferredCode, name: config.defaultCountryName || body.countryName || "" })
    : (visibleCountries[0] || { code: "", name: config.defaultCountryName || body.countryName || "" });
  return [buildCountryWattrelTarget({
    baseConfig: config,
    country,
    connection: {},
    body,
    forceConfigured,
    usesCountryConfig: false,
  })];
}

function buildCountryWattrelTarget({ baseConfig = {}, country = {}, connection = {}, body = {}, forceConfigured = false, usesCountryConfig = false }) {
  const code = String(connection.countryCode || country.code || country.countryCode || body.countryCode || baseConfig.defaultCountryCode || "").trim();
  const name = String(connection.countryName || country.name || country.countryName || body.countryName || baseConfig.defaultCountryName || "").trim();
  const envDatabase = countryEnvWattrelDatabase(code);
  const database = {
    ...(baseConfig.database || baseConfig.connection || {}),
    ...envDatabase,
    ...(connection.database || connection.connection || {}),
  };
  const ssh = {
    ...(baseConfig.ssh || {}),
    ...(connection.ssh || {}),
  };
  const query = {
    ...(baseConfig.query || {}),
    ...(connection.query || {}),
  };
  const limit = clampNumber(body.limit ?? query.limit ?? baseConfig.limit, 1, 1000, 100);
  const configured = forceConfigured || (connection.enabled !== false && baseConfig.enabled !== false && hasWattrelConnection({ database, ssh }));
  return {
    countryCode: code,
    countryName: name,
    configured,
    usesCountryConfig,
    limit,
    config: {
      ...baseConfig,
      ...connection,
      enabled: configured,
      defaultCountryCode: code,
      defaultCountryName: name,
      database,
      ssh,
      query: {
        ...query,
        limit,
      },
    },
  };
}

function normalizeCountryWattrelConnections(config = {}) {
  const raw = config.countries || config.countryConnections || config.countryDatabases || [];
  if (Array.isArray(raw)) {
    return raw.map((item) => ({
      ...item,
      countryCode: String(item.countryCode || item.code || "").trim(),
      countryName: String(item.countryName || item.name || "").trim(),
    })).filter((item) => item.countryCode);
  }
  if (raw && typeof raw === "object") {
    return Object.entries(raw).map(([code, item]) => ({
      ...(item || {}),
      countryCode: String(item?.countryCode || code).trim(),
      countryName: String(item?.countryName || item?.name || "").trim(),
    })).filter((item) => item.countryCode);
  }
  return [];
}

function countryEnvWattrelDatabase(countryCode) {
  const key = String(countryCode || "").toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  if (!key) {
    return {};
  }
  return stripEmptyValues({
    host: process.env[`WATTREL_${key}_DB_HOST`],
    port: process.env[`WATTREL_${key}_DB_PORT`],
    user: process.env[`WATTREL_${key}_DB_USER`],
    password: process.env[`WATTREL_${key}_DB_PASSWORD`],
    database: process.env[`WATTREL_${key}_DB_NAME`],
    charset: process.env[`WATTREL_${key}_DB_CHARSET`],
  });
}

function hasGlobalWattrelDatabase(config = {}) {
  return hasWattrelConnection({
    database: config.database || config.connection || {},
    ssh: config.ssh || {},
  });
}

function hasWattrelConnection({ database = {}, ssh = {} } = {}) {
  return hasWattrelDatabase(database) || hasWattrelSsh(ssh);
}

function hasWattrelDatabase(database = {}) {
  const host = resolveConfigString(database.host);
  const user = resolveConfigString(database.user);
  const dbName = resolveConfigString(database.database);
  return Boolean(host && user && dbName);
}

function hasWattrelSsh(ssh = {}) {
  return Boolean(resolveConfigString(ssh.host));
}

function resolveConfigString(value) {
  return String(value ?? "").replace(/\$\{([^}]+)\}/g, (_match, key) => process.env[key] || "").trim();
}

function stripEmptyValues(value = {}) {
  return Object.fromEntries(Object.entries(value).filter(([_key, entry]) => entry !== undefined && entry !== null && entry !== ""));
}

function buildWattrelCurrentSnapshot({ rows = [], anomalies = [], checkedAt, countryStatuses = [] } = {}) {
  const normalizedAnomalies = anomalies.map((anomaly) => normalizeExternalAnomaly(anomaly, {
    source: "wattrel",
    checkedAt,
    countryCode: anomaly.countryCode,
    countryName: anomaly.countryName,
  }));
  const countries = mergeWattrelCountryStatuses(summarizeWattrelCountries(normalizedAnomalies), countryStatuses);
  const topTables = summarizeWattrelTargetTables(normalizedAnomalies);
  return {
    checkedAt,
    rowCount: rows.length,
    summary: {
      countryCount: countries.length,
      configuredCountryCount: countries.filter((item) => item.configured).length,
      failedCountryCount: countries.filter((item) => item.status === "failed").length,
      anomalyCount: normalizedAnomalies.length,
      tableCount: topTables.length,
      targetTableCount: topTables.length,
    },
    countries,
    topTables,
    anomalies: normalizedAnomalies,
  };
}

function mergeWattrelCountryStatuses(summaryCountries = [], statusCountries = []) {
  const groups = new Map();
  for (const country of statusCountries) {
    const key = wattrelCountryKey(country);
    groups.set(key, {
      countryCode: country.countryCode || "",
      countryName: country.countryName || "",
      configured: Boolean(country.configured),
      status: country.status || (country.configured ? "success" : "unconfigured"),
      rowCount: country.rowCount || 0,
      anomalyCount: country.anomalyCount || 0,
      tableCount: country.tableCount || 0,
      topTables: country.topTables || [],
      anomalies: country.anomalies || [],
      error: country.error || null,
    });
  }
  for (const country of summaryCountries) {
    const key = wattrelCountryKey(country);
    const existing = groups.get(key) || {};
    groups.set(key, {
      ...existing,
      ...country,
      configured: existing.configured ?? true,
      status: existing.status === "failed" ? "failed" : "success",
      rowCount: existing.rowCount || country.anomalies?.length || 0,
      anomalyCount: country.anomalyCount || 0,
      tableCount: country.tableCount || 0,
      topTables: country.topTables || [],
      anomalies: country.anomalies || [],
    });
  }
  return [...groups.values()].sort((a, b) => {
    const severityOrder = { failed: 0, success: 1, unconfigured: 2 };
    return (severityOrder[a.status] ?? 3) - (severityOrder[b.status] ?? 3)
      || b.anomalyCount - a.anomalyCount
      || countryRunLabel(a).localeCompare(countryRunLabel(b));
  });
}

function wattrelCountryKey(country = {}) {
  return `${country.countryCode || ""}::${country.countryName || ""}`;
}

function summarizeWattrelCountries(anomalies = []) {
  const groups = new Map();
  for (const anomaly of anomalies) {
    const countryCode = String(anomaly.countryCode || "").trim();
    const countryName = String(anomaly.countryName || "").trim();
    const key = `${countryCode}::${countryName}` || "unknown";
    if (!groups.has(key)) {
      groups.set(key, {
        countryCode,
        countryName,
        anomalyCount: 0,
        tableCount: 0,
        tables: new Map(),
        anomalies: [],
      });
    }
    const group = groups.get(key);
    group.anomalyCount += 1;
    group.anomalies.push(anomaly);
    const tableName = String(anomaly.destTbl || anomaly.cardTitle || "未知目标表").trim();
    if (!group.tables.has(tableName)) {
      group.tables.set(tableName, {
        name: tableName,
        count: 0,
        checks: new Set(),
      });
    }
    const table = group.tables.get(tableName);
    table.count += 1;
    if (anomaly.name) {
      table.checks.add(anomaly.name);
    }
  }
  return [...groups.values()].map((group) => {
    const topTables = [...group.tables.values()]
      .map((table) => ({
        name: table.name,
        count: table.count,
        checks: [...table.checks],
      }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    return {
      countryCode: group.countryCode,
      countryName: group.countryName,
      anomalyCount: group.anomalyCount,
      tableCount: topTables.length,
      topTables: topTables.slice(0, 5),
      anomalies: group.anomalies,
    };
  }).sort((a, b) => b.anomalyCount - a.anomalyCount || countryRunLabel(a).localeCompare(countryRunLabel(b)));
}

function summarizeWattrelTargetTables(anomalies = []) {
  const groups = new Map();
  for (const anomaly of anomalies) {
    const tableName = String(anomaly.destTbl || anomaly.cardTitle || "未知目标表").trim();
    if (!groups.has(tableName)) {
      groups.set(tableName, {
        name: tableName,
        count: 0,
        checks: new Set(),
        countries: new Set(),
        examples: [],
      });
    }
    const group = groups.get(tableName);
    group.count += 1;
    if (anomaly.name) {
      group.checks.add(anomaly.name);
    }
    const countryLabel = [anomaly.countryName, anomaly.countryCode].filter(Boolean).join(" / ");
    if (countryLabel) {
      group.countries.add(countryLabel);
    }
    if (group.examples.length < 3) {
      group.examples.push(anomaly.message || anomaly.name || tableName);
    }
  }
  return [...groups.values()]
    .map((group) => ({
      name: group.name,
      count: group.count,
      checks: [...group.checks],
      countries: [...group.countries],
      examples: group.examples,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function countryRunLabel(country = {}) {
  return [country.countryName, country.countryCode].filter(Boolean).join(" / ") || "未归属国家";
}

function normalizeExternalCountryRuns(body = {}, { source, checkedAt }) {
  const countries = Array.isArray(body.countries) ? body.countries : [];
  const flatAnomalies = Array.isArray(body.anomalies) ? body.anomalies : [];
  const countryRuns = [];

  for (const country of countries) {
    const countryCode = String(country.countryCode || country.code || "").trim();
    const countryName = String(country.countryName || country.name || "").trim();
    const anomalies = Array.isArray(country.anomalies) ? country.anomalies : [];
    countryRuns.push(buildExternalCountryRun({
      source,
      checkedAt: country.checkedAt || checkedAt,
      countryCode,
      countryName,
      checkedCount: country.checkedCount ?? country.checkedCardCount,
      dashboardCount: country.dashboardCount,
      anomalies,
    }));
  }

  if (flatAnomalies.length > 0) {
    const grouped = new Map();
    for (const anomaly of flatAnomalies) {
      const countryCode = String(anomaly.countryCode || anomaly.code || body.countryCode || "").trim();
      const countryName = String(anomaly.countryName || anomaly.country || body.countryName || "").trim();
      const key = `${countryCode}::${countryName}`;
      if (!grouped.has(key)) {
        grouped.set(key, { countryCode, countryName, anomalies: [] });
      }
      grouped.get(key).anomalies.push(anomaly);
    }
    for (const group of grouped.values()) {
      const exists = countryRuns.some((item) => item.countryCode === group.countryCode && item.countryName === group.countryName);
      if (!exists) {
        countryRuns.push(buildExternalCountryRun({
          source,
          checkedAt,
          countryCode: group.countryCode,
          countryName: group.countryName,
          anomalies: group.anomalies,
        }));
      }
    }
  }

  return countryRuns;
}

function buildExternalCountryRun({ source, checkedAt, countryCode, countryName, checkedCount, dashboardCount, anomalies }) {
  const normalizedAnomalies = (anomalies || []).map((item) => normalizeExternalAnomaly(item, {
    source,
    checkedAt,
    countryCode,
    countryName,
  }));
  const checkedCards = normalizedAnomalies.map((anomaly) => ({
    countryCode: anomaly.countryCode,
    countryName: anomaly.countryName,
    dashboardTitle: anomaly.dashboardTitle,
    cardTitle: anomaly.cardTitle,
    ok: false,
    source,
  }));
  const effectiveCheckedCount = Number(checkedCount ?? checkedCards.length) || checkedCards.length;
  const result = {
    checkedAt,
    checkedCardCount: effectiveCheckedCount,
    dashboardCount: Number(dashboardCount || new Set(normalizedAnomalies.map((item) => item.dashboardTitle)).size || 1),
    checkedDashboards: summarizeCheckedDashboards({
      checkedCards,
      anomalies: normalizedAnomalies,
    }),
    checkedCards,
    anomalyCount: normalizedAnomalies.length,
    anomalies: normalizedAnomalies,
    dataQualityAnomalyCount: 0,
    dataQuality: null,
    source,
  };
  return {
    countryCode,
    countryName,
    ok: true,
    source,
    result,
  };
}

function normalizeExternalAnomaly(anomaly = {}, defaults = {}) {
  const source = defaults.source || "external";
  const countryCode = String(anomaly.countryCode || anomaly.code || defaults.countryCode || "").trim();
  const countryName = String(anomaly.countryName || anomaly.country || defaults.countryName || "").trim();
  const dashboardTitle = String(
    anomaly.dashboardTitle
      || anomaly.groupTitle
      || (source === "wattrel" ? "Wattrel 数据质量" : "外部告警"),
  ).trim();
  const cardTitle = String(
    anomaly.cardTitle
      || anomaly.destTbl
      || anomaly.destTable
      || anomaly.table
      || anomaly.name
      || anomaly.checkName
      || "未命名告警",
  ).trim();
  const checkName = String(anomaly.checkName || anomaly.name || anomaly.metric || cardTitle).trim();
  return {
    ...anomaly,
    source,
    type: String(anomaly.type || (source === "wattrel" ? "wattrelQualityAlert" : "externalAlert")),
    countryCode,
    countryName,
    dashboardTitle,
    cardTitle,
    checkedAt: anomaly.checkedAt || defaults.checkedAt || null,
    severity: anomaly.severity || "warning",
    message: String(anomaly.message || formatExternalAnomalyMessage({ ...anomaly, checkName, source })),
  };
}

function formatExternalAnomalyMessage(anomaly = {}) {
  const pieces = [];
  const checkName = String(anomaly.checkName || anomaly.name || anomaly.metric || "").trim();
  const destTbl = String(anomaly.destTbl || anomaly.destTable || anomaly.table || "").trim();
  const srcTbl = String(anomaly.srcTbl || anomaly.srcTable || "").trim();
  const expected = firstPresent(anomaly.expectedValue, anomaly.srcValue, anomaly.expected, anomaly.srcCnt);
  const actual = firstPresent(anomaly.actualValue, anomaly.destValue, anomaly.actual, anomaly.destCnt);
  const diff = firstPresent(anomaly.diff, anomaly.diffValue);
  const windowText = String(anomaly.window || anomaly.timeRange || anomaly.checkWindow || "").trim();

  if (checkName) {
    pieces.push(`指标「${checkName}」`);
  }
  if (destTbl) {
    pieces.push(`目标表 ${destTbl}`);
  }
  if (srcTbl) {
    pieces.push(`源表 ${srcTbl}`);
  }
  if (expected !== undefined || actual !== undefined) {
    pieces.push(`期望值 ${formatExternalValue(expected)}，实际值 ${formatExternalValue(actual)}`);
  }
  if (diff !== undefined) {
    pieces.push(`差值 ${formatExternalValue(diff)}`);
  }
  if (windowText) {
    pieces.push(windowText);
  }

  return pieces.length ? pieces.join("，") : "外部告警异常";
}

function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function formatExternalValue(value) {
  if (value === undefined || value === null || value === "") {
    return "-";
  }
  return String(value);
}

function summarizeCountryScheduleRuns(countryRuns = []) {
  const successfulRuns = countryRuns.filter((item) => item.ok);
  const failedRuns = countryRuns.filter((item) => !item.ok);
  return {
    countryCount: countryRuns.length,
    successCount: successfulRuns.length,
    failedCount: failedRuns.length,
    checkedCardCount: successfulRuns.reduce((sum, item) => sum + Number(item.result?.checkedCardCount || 0), 0),
    dashboardCount: successfulRuns.reduce((sum, item) => sum + Number(item.result?.dashboardCount || 0), 0),
    anomalyCount: successfulRuns.reduce((sum, item) => sum + Number(item.result?.anomalyCount || 0), 0),
    runs: countryRuns,
  };
}

async function runScheduledCountryChecks(countryConfigs, runBatchCheckFn, onProgress = null) {
  const countryRuns = [];
  for (const countryConfig of countryConfigs) {
    onProgress?.({ type: "start", countryConfig });
    try {
      const result = await runBatchCheckFn({
        countryCode: countryConfig.countryCode,
        dashboardUuids: countryConfig.dashboardUuids || [],
      });
      const countryRun = {
        countryCode: countryConfig.countryCode,
        countryName: countryConfig.countryName || "",
        ok: true,
        result: summarizeBatchScheduleRun(result),
      };
      countryRuns.push(countryRun);
      onProgress?.({ type: "success", countryConfig, countryRun });
    } catch (error) {
      const countryRun = {
        countryCode: countryConfig.countryCode,
        countryName: countryConfig.countryName || "",
        ok: false,
        error: error.message,
      };
      countryRuns.push(countryRun);
      onProgress?.({ type: "failed", countryConfig, countryRun });
    }
  }
  return countryRuns;
}

function createBatchScheduleRunProgress({ id, trigger, startedAt, countryConfigs }) {
  const countries = countryConfigs.map((item) => ({
    countryCode: item.countryCode,
    countryName: item.countryName || "",
    status: "pending",
    checkedCardCount: 0,
    anomalyCount: 0,
    dashboardCount: 0,
    error: "",
  }));
  return {
    id,
    trigger,
    status: "running",
    startedAt,
    finishedAt: null,
    totalCountries: countries.length,
    completedCountries: 0,
    currentCountryCode: "",
    currentCountryName: "",
    countries,
  };
}

function updateBatchScheduleRunProgress(progress, event) {
  if (!progress || !event?.countryConfig) {
    return progress;
  }
  const countryCode = event.countryConfig.countryCode;
  const countries = (progress.countries || []).map((item) => {
    if (item.countryCode !== countryCode) {
      return item;
    }
    if (event.type === "start") {
      return {
        ...item,
        status: "running",
        startedAt: new Date().toISOString(),
      };
    }
    const result = event.countryRun?.result || {};
    return {
      ...item,
      status: event.type === "success" ? "success" : "failed",
      finishedAt: new Date().toISOString(),
      checkedCardCount: result.checkedCardCount || 0,
      dashboardCount: result.dashboardCount || 0,
      anomalyCount: result.anomalyCount || 0,
      error: event.countryRun?.error || "",
    };
  });
  const completedCountries = countries.filter((item) => ["success", "failed"].includes(item.status)).length;
  const runningCountry = countries.find((item) => item.status === "running");
  return {
    ...progress,
    status: "running",
    countries,
    completedCountries,
    currentCountryCode: runningCountry?.countryCode || (event.type === "start" ? countryCode : ""),
    currentCountryName: runningCountry?.countryName || (event.type === "start" ? event.countryConfig.countryName || "" : ""),
  };
}

async function sendScheduledAggregateNotifications({ countryRuns, countryConfigs, rulesFile, notifyTextFn, detailUrl }) {
  const successfulRuns = countryRuns.filter((item) => item.ok);
  if (!successfulRuns.some((item) => Number(item.result?.anomalyCount || 0) + Number(item.result?.dataQualityAnomalyCount || 0) > 0)) {
    markCountryRunNotifications(countryRuns, {
      sent: false,
      skipped: true,
      reason: "no anomalies",
      sentMessages: 0,
      sentAt: null,
    });
    return 0;
  }

  const rules = await readJsonFile(rulesFile, { alerts: {} });
  const configByCountry = new Map(countryConfigs.map((item) => [item.countryCode, item]));
  const groups = groupScheduledRunsByNotifyTarget(successfulRuns, configByCountry, rules.alerts || {}, detailUrl);
  let sentMessages = 0;

  for (const group of groups) {
    const result = combineScheduledCountryResults(group.countryRuns);
    const messages = buildPublicCheckMessages(result, {
      ...group.alerts,
      countryDetailMode: "summary",
    });
    const results = [];
    for (const message of messages) {
      results.push(await notifyTextFn({ ...rules, alerts: group.alerts }, message.body, {
        title: message.title,
        severity: "warning",
        timestamp: result.checkedAt,
        anomalyCount: message.anomalyCount ?? result.anomalyCount,
        checkedCardCount: result.checkedCardCount,
      }));
    }
    const sent = results.some((item) => item.sent);
    const notification = {
      sent,
      skipped: false,
      reason: sent ? null : "send failed",
      sentMessages: messages.length,
      results,
      channel: group.alerts.channel,
      botId: group.alerts.botId || "",
      chatId: group.alerts.chatId || "",
      recipientEmails: group.alerts.recipientEmails || "",
      mentions: group.alerts.mentions || [],
      webhookUrl: group.alerts.webhookUrl || "",
      detailUrl: group.alerts.detailUrl || "",
      sentAt: new Date().toISOString(),
    };
    for (const countryRun of group.countryRuns) {
      countryRun.result.notification = notification;
    }
    sentMessages += messages.length;
  }

  return sentMessages;
}

function groupScheduledRunsByNotifyTarget(countryRuns, configByCountry, configuredAlerts, detailUrl) {
  const groups = new Map();
  for (const countryRun of countryRuns) {
    const countryConfig = configByCountry.get(countryRun.countryCode) || {};
    const notifyChannel = normalizeNotifyChannel(countryConfig.notifyChannel || configuredAlerts.channel || "tv");
    const alerts = buildBatchNotifyAlerts({ ...countryConfig, detailUrl }, configuredAlerts, notifyChannel);
    const key = notificationTargetKey(alerts);
    if (!groups.has(key)) {
      groups.set(key, { alerts, countryRuns: [] });
    }
    groups.get(key).countryRuns.push(countryRun);
  }
  return [...groups.values()];
}

function notificationTargetKey(alerts = {}) {
  return [
    alerts.channel || "",
    alerts.webhookUrl || "",
    alerts.botId || "",
    alerts.botApiBaseUrl || "",
    alerts.botToken || "",
    alerts.chatId || "",
    alerts.recipientEmails || "",
    (alerts.mentions || []).join(","),
  ].join("\u0000");
}

function combineScheduledCountryResults(countryRuns = []) {
  const results = countryRuns.map((item) => item.result || {});
  const checkedAt = results.map((item) => item.checkedAt).filter(Boolean).sort().slice(-1)[0] || new Date().toISOString();
  const checkedCards = results.flatMap((item) => item.checkedCards || []);
  const anomalies = results.flatMap((item) => item.anomalies || []);
  return {
    checkedAt,
    checkedCardCount: results.reduce((sum, item) => sum + Number(item.checkedCardCount || 0), 0),
    dashboardCount: results.reduce((sum, item) => sum + Number(item.dashboardCount || 0), 0),
    checkedDashboards: results.flatMap((item) => item.checkedDashboards || []),
    checkedCards,
    anomalyCount: anomalies.length,
    anomalies,
    dataQualityAnomalyCount: results.reduce((sum, item) => sum + Number(item.dataQualityAnomalyCount || 0), 0),
    dataQuality: null,
  };
}

function markCountryRunNotifications(countryRuns, notification) {
  for (const countryRun of countryRuns) {
    if (countryRun.ok && countryRun.result) {
      countryRun.result.notification = notification;
    }
  }
}

function buildBatchHistoryEntry({ trigger = "schedule", id = randomUUID(), startedAt, finishedAt, nextRunAt, schedule, countryRuns, notificationSentCount = null }) {
  const summary = summarizeCountryScheduleRuns(countryRuns);
  const sentCount = notificationSentCount ?? countryRuns.reduce((sum, run) => {
    const notification = run.result?.notification;
    return sum + (notification?.sent ? Number(notification.sentMessages || 0) : 0);
  }, 0);
  return {
    id,
    trigger,
    startedAt,
    finishedAt,
    nextRunAt,
    intervalMinutes: schedule.intervalMinutes || null,
    status: summary.failedCount > 0 ? "partial_failed" : "success",
    ok: summary.failedCount === 0,
    countryCount: summary.countryCount,
    successCount: summary.successCount,
    failedCount: summary.failedCount,
    checkedCardCount: summary.checkedCardCount,
    dashboardCount: summary.dashboardCount,
    anomalyCount: summary.anomalyCount,
    dataQualityAnomalyCount: countryRuns.reduce((sum, run) => sum + Number(run.result?.dataQualityAnomalyCount || 0), 0),
    notificationSentCount: sentCount,
    runs: countryRuns,
  };
}

async function appendBatchHistoryRun(historyFile, entry) {
  const history = await readJsonFile(historyFile, DEFAULT_BATCH_HISTORY);
  const runs = [entry, ...(history.runs || [])].slice(0, MAX_BATCH_HISTORY_RUNS);
  await writeJsonAtomic(historyFile, { updatedAt: new Date().toISOString(), runs });
}

async function readPlatformInventory(rootDir, primaryInventoryFile) {
  const primary = await readJsonFile(primaryInventoryFile, { dashboards: [] });
  const configDir = path.join(rootDir, "config");
  let fileNames = [];
  try {
    fileNames = await fs.readdir(configDir);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  const countryInventoryFiles = fileNames
    .filter((fileName) => /^discovered-public-dashboards\.[a-z]+\.json$/i.test(fileName))
    .map((fileName) => path.join(configDir, fileName));
  const inventories = [primary];

  for (const filePath of countryInventoryFiles) {
    inventories.push(await readJsonFile(filePath, { dashboards: [] }));
  }

  return mergeInventories(inventories);
}

function mergeInventories(inventories) {
  const dashboardsByKey = new Map();
  const sourceErrors = [];

  for (const inventory of inventories) {
    sourceErrors.push(...(inventory.sourceErrors || []));
    for (const dashboard of inventory.dashboards || []) {
      const key = [
        dashboard.countryCode || dashboard.country?.code || "",
        dashboard.access || "public",
        dashboard.dashboardId || dashboard.uuid || dashboard.url || dashboard.title || "",
      ].join("::");
      dashboardsByKey.set(key, dashboard);
    }
  }

  const dashboards = [...dashboardsByKey.values()];
  return {
    ...(inventories[0] || {}),
    dashboardCount: dashboards.length,
    totalCardCount: dashboards.reduce((sum, dashboard) => sum + (dashboard.cards?.length || 0), 0),
    sourceErrorCount: sourceErrors.length,
    sourceErrors,
    dashboards,
  };
}

function filterBatchHistory(history = DEFAULT_BATCH_HISTORY, filters = {}) {
  const countryCode = String(filters.countryCode || "").trim();
  const status = String(filters.status || "").trim();
  const limit = clampNumber(filters.limit ?? 50, 1, MAX_BATCH_HISTORY_RUNS, 50);
  let runs = history.runs || [];

  if (countryCode) {
    runs = runs.filter((run) => (run.runs || []).some((countryRun) => countryRun.countryCode === countryCode));
  }

  if (status === "success") {
    runs = runs.filter((run) => run.status === "success");
  } else if (status === "partial_failed") {
    runs = runs.filter((run) => run.status === "partial_failed");
  } else if (status === "failed") {
    runs = runs.filter((run) => run.status === "failed");
  } else if (status === "anomaly") {
    runs = runs.filter((run) => Number(run.anomalyCount || 0) + Number(run.dataQualityAnomalyCount || 0) > 0);
  } else if (status === "healthy") {
    runs = runs.filter((run) => Number(run.anomalyCount || 0) + Number(run.dataQualityAnomalyCount || 0) === 0 && run.status !== "failed");
  }

  return {
    updatedAt: history.updatedAt || null,
    total: runs.length,
    runs: runs.slice(0, limit),
  };
}

function normalizeDashboardUuids(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
  }
  if (!value) {
    return [];
  }
  return [...new Set(String(value)
    .split(/[\n,，;；]+/)
    .map((item) => item.trim())
    .filter(Boolean))];
}

function summarizeCheckedDashboards(result = {}) {
  const groups = new Map();
  for (const card of result.checkedCards || []) {
    const key = `${card.countryCode || ""}::${card.dashboardUuid || card.dashboardTitle || ""}`;
    if (!groups.has(key)) {
      groups.set(key, {
        countryCode: card.countryCode || "",
        countryName: card.countryName || "",
        dashboardUuid: card.dashboardUuid || "",
        dashboardTitle: card.dashboardTitle || "",
        checkedCardCount: 0,
        failedCardCount: 0,
        anomalyCount: 0,
      });
    }
    const group = groups.get(key);
    group.checkedCardCount += 1;
    if (!card.ok) {
      group.failedCardCount += 1;
    }
  }
  for (const anomaly of result.anomalies || []) {
    const key = `${anomaly.countryCode || ""}::${anomaly.dashboardUuid || anomaly.dashboardTitle || ""}`;
    if (!groups.has(key)) {
      groups.set(key, {
        countryCode: anomaly.countryCode || "",
        countryName: anomaly.countryName || "",
        dashboardUuid: anomaly.dashboardUuid || "",
        dashboardTitle: anomaly.dashboardTitle || "",
        checkedCardCount: 0,
        failedCardCount: 0,
        anomalyCount: 0,
      });
    }
    groups.get(key).anomalyCount += 1;
  }
  return [...groups.values()];
}

function filterBatchInventory(inventory, { countryCode, dashboardUuid, dashboardUuids = [] }) {
  const selectedDashboardUuids = new Set(dashboardUuids);
  const dashboards = [];
  for (const dashboard of inventory.dashboards || []) {
    const code = dashboard.countryCode || dashboard.country?.code || "";
    if (countryCode && code !== countryCode) {
      continue;
    }
    if (selectedDashboardUuids.size && !selectedDashboardUuids.has(dashboard.uuid)) {
      continue;
    }
    if (!selectedDashboardUuids.size && dashboardUuid && dashboard.uuid !== dashboardUuid) {
      continue;
    }
    const cards = dashboard.cards || [];
    if (cards.length) {
      dashboards.push({ ...dashboard, cards });
    }
  }
  return {
    ...inventory,
    dashboards,
    dashboardCount: dashboards.length,
    totalCardCount: dashboards.reduce((sum, dashboard) => sum + (dashboard.cards?.length || 0), 0),
  };
}

function resolveWebhookUrl(frontendWebhookUrl, configuredWebhookUrl) {
  const frontend = String(frontendWebhookUrl || "").trim();
  if (frontend) {
    return frontend;
  }
  const env = String(process.env.TV_ALERT_WEBHOOK_URL || "").trim();
  if (env) {
    return env;
  }
  const configured = String(configuredWebhookUrl || "").trim();
  if (configured && !/^\$\{[^}]+\}$/.test(configured)) {
    return configured;
  }
  return DEFAULT_TV_WEBHOOK_URL;
}

export function flattenInventory(inventory) {
  const dashboards = inventory?.dashboards || [];
  return {
    dashboardCount: dashboards.length,
    cardCount: dashboards.reduce((sum, dashboard) => sum + (dashboard.cards?.length || 0), 0),
  };
}

export async function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(tempPath, filePath);
}

function filterInventory(inventory, filters = {}) {
  const q = String(filters.q || "").trim().toLowerCase();
  const countryCode = String(filters.countryCode || "").trim();
  const dashboardTitle = String(filters.dashboardTitle || "").trim();
  const dashboards = (inventory.dashboards || [])
    .filter((dashboard) => !countryCode || dashboard.countryCode === countryCode || dashboard.country?.code === countryCode)
    .filter((dashboard) => !dashboardTitle || dashboard.title === dashboardTitle || dashboard.sourcePanelTitle === dashboardTitle)
    .map((dashboard) => ({
      ...dashboard,
      cards: (dashboard.cards || []).filter((card) => {
        if (!q) {
          return true;
        }
        return [dashboard.title, dashboard.sourcePanelTitle, card.title, card.cardId, card.dashcardId]
          .filter((value) => value !== undefined && value !== null)
          .some((value) => String(value).toLowerCase().includes(q));
      }),
    }))
    .filter((dashboard) => !q || dashboard.cards.length > 0);

  return {
    ...inventory,
    dashboards,
    dashboardCount: dashboards.length,
    totalCardCount: dashboards.reduce((sum, dashboard) => sum + (dashboard.cards?.length || 0), 0),
  };
}

async function loadPanelSources(rootDir, countries, filters = {}) {
  const selectedCountryCode = String(filters.countryCode || "").trim();
  const targetCountries = selectedCountryCode
    ? countries.filter((country) => country.code === selectedCountryCode)
    : countries;
  const sources = [];

  for (const country of targetCountries) {
    const filePath = panelSourceFilePath(rootDir, country.code);
    const source = await readJsonFile(filePath, {});
    if (!source || !Array.isArray(source.panels) || source.panels.length === 0) {
      continue;
    }

    sources.push({
      countryCode: country.code,
      countryName: country.name,
      timezone: country.timezone,
      sourceTitle: source.title || "",
      sourceUid: source.uid || "",
      panels: source.panels.map((panel) => ({
        id: panel.id,
        title: panel.title || "-",
        type: panel.type || "",
        datasource: panel.datasource || "",
        targetCount: Number(panel.targetCount || 0),
        textPreview: panel.textPreview || "",
        links: Array.isArray(panel.links) ? panel.links : [],
      })),
    });
  }

  return sources;
}

function panelSourceFilePath(rootDir, countryCode) {
  if (countryCode === "INE") {
    return path.join(rootDir, "config/discovered-panels.json");
  }
  return path.join(rootDir, `config/discovered-panels.${String(countryCode || "").toLowerCase()}.json`);
}

async function explainUnavailableCountryInventory(rootDir, countryCode, countries = []) {
  const country = countries.find((item) => item.code === countryCode) || {};
  const label = [country.name, countryCode].filter(Boolean).join(" / ") || countryCode || "该国家";
  const source = await readJsonFile(panelSourceFilePath(rootDir, countryCode), {});
  const sourceCount = Array.isArray(source.panels) ? source.panels.length : 0;
  if (sourceCount > 0) {
    return `${label} 当前有 ${sourceCount} 个来源看板，但都是 Metabase 内部 collection/dashboard 链接，尚未发现可巡检的 /public/dashboard UUID；请先在 Metabase 开启 public sharing 并重新发现后再上线巡检。`;
  }
  return `${label} 当前没有可巡检的 public dashboard 清单，请先补充 /public/dashboard UUID 并重新发现。`;
}

function summarizeCountries(countries, inventory, result) {
  return countries.map((country) => {
    const dashboards = (inventory.dashboards || []).filter((dashboard) => {
      return dashboard.countryCode === country.code || dashboard.country?.code === country.code;
    });
    const anomalies = (result?.anomalies || []).filter((anomaly) => anomaly.countryCode === country.code);
    return {
      code: country.code,
      name: country.name,
      timezone: country.timezone,
      status: country.status || "unknown",
      dashboardCount: dashboards.length,
      cardCount: dashboards.reduce((sum, dashboard) => sum + (dashboard.cards?.length || 0), 0),
      anomalyCount: anomalies.length,
    };
  });
}

function redactRuleConfig(config) {
  return {
    ...config,
    alerts: sanitizeAlerts(config.alerts),
    gateway: sanitizeGateway(config.gateway),
  };
}

function sanitizeAlerts(alerts = {}) {
  return {
    ...alerts,
    webhookUrl: alerts.webhookUrl ? maskSecretReference(alerts.webhookUrl) : alerts.webhookUrl,
    botId: alerts.botId ? maskSecretReference(alerts.botId) : alerts.botId,
  };
}

function sanitizeGateway(gateway = {}) {
  return {
    ...gateway,
    token: gateway.token ? maskSecretReference(gateway.token) : gateway.token,
  };
}

function preserveHiddenSecrets(next = {}, previous = {}, fields = []) {
  const merged = { ...next };
  for (const field of fields) {
    if (merged[field] === "<hidden>") {
      merged[field] = previous?.[field];
    }
  }
  return merged;
}

function applyDashboardRuleDefaults(rule = {}, dashboard = {}) {
  const timezone = rule.timezone === "dashboard" || !rule.timezone
    ? dashboard?.timezone || dashboard?.country?.timezone || "Asia/Jakarta"
    : rule.timezone;

  return {
    ...rule,
    timezone,
  };
}

function validateLiveSandboxRequest(body) {
  if (!body || typeof body !== "object") {
    throw badRequest("Invalid live sandbox request", ["请求体不能为空。"]);
  }
  if (!body.dashboard?.url || !body.dashboard?.uuid) {
    throw badRequest("Invalid live sandbox request", ["请选择带 Metabase URL 和 uuid 的看板。"]);
  }
  if (!body.card?.cardId || !body.card?.dashcardId) {
    throw badRequest("Invalid live sandbox request", ["请选择带 cardId 和 dashcardId 的卡片。"]);
  }
  if (!body.rule || typeof body.rule !== "object" || !body.rule.type) {
    throw badRequest("Invalid live sandbox request", ["请选择要试跑的规则。"]);
  }
}

function maskSecretReference(value) {
  const text = String(value);
  if (/^\$\{[^}]+\}$/.test(text)) {
    return text;
  }
  return "<hidden>";
}

function badRequest(message, errors) {
  const error = new Error(message);
  error.statusCode = 400;
  error.errors = errors;
  return error;
}
