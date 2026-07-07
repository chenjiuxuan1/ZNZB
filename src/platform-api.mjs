import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { MetabasePublicClient } from "./metabase-public-client.mjs";
import {
  buildDefaultCardParameters,
  checkPublicDashboards,
  evaluateRowsAgainstRule,
  mergeParameters,
} from "./metabase-public-monitor.mjs";
import { buildPublicCheckMessages, notifyText } from "./notifier.mjs";
import { readJsonFile } from "./utils.mjs";
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
};
const DEFAULT_TV_WEBHOOK_URL = "https://tv-service-alert.kuainiu.chat/alert/v2/array";
const DEFAULT_BATCH_SCHEDULE = {
  enabled: false,
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
  metabaseClientFactory = (dashboard) => new MetabasePublicClient({
    baseUrl: new URL(dashboard.url).origin,
    requestTimeoutSeconds: 30,
  }),
  notifyTextFn = notifyText,
} = {}) {
  const resolve = (name) => path.join(rootDir, FILES[name]);

  return {
    async getSummary() {
      const [countries, rules, inventory, result] = await Promise.all([
        readJsonFile(resolve("countries"), { countries: [] }),
        readJsonFile(resolve("rules"), { rules: [] }),
        readJsonFile(resolve("inventory"), { dashboards: [] }),
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

    async getBatchHistory(filters = {}) {
      const history = await readJsonFile(resolve("batchHistory"), DEFAULT_BATCH_HISTORY);
      return filterBatchHistory(history, filters);
    },

    async saveBatchSchedule(body = {}) {
      const previous = await this.getBatchSchedule();
      const countries = await readJsonFile(resolve("countries"), { countries: [] });
      const next = normalizeBatchSchedule(body, previous, { countries: countries.countries || [] });
      const enabledCountries = next.countryConfigs.filter((item) => item.enabled);
      if (next.enabled && enabledCountries.length === 0) {
        throw badRequest("No scheduled countries", ["启用定时巡检前请至少启用一个国家。"]);
      }
      for (const countryConfig of enabledCountries) {
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

    async saveCountriesConfig(config) {
      const validation = validateCountriesConfig(config);
      if (!validation.ok) {
        throw badRequest("Invalid countries config", validation.errors);
      }
      await writeJsonAtomic(resolve("countries"), config);
      return config;
    },

    async getInventory(filters = {}) {
      const inventory = await readJsonFile(resolve("inventory"), { dashboards: [] });
      return filterInventory(inventory, filters);
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
      const rows = await client.queryDashcardJson({
        cardId: card.cardId,
        dashboardUuid: dashboard.uuid,
        dashcardId: card.dashcardId,
        parameters,
      });
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
      const inventory = await readJsonFile(resolve("inventory"), { dashboards: [] });
      const ruleConfig = await readJsonFile(resolve("rules"), {
        builtInChecks: { queryError: true, noData: true },
        rules: [],
      });
      const countryCode = String(body.countryCode || "").trim();
      const dashboardUuid = String(body.dashboardUuid || "").trim();
      const dashboardUuids = normalizeDashboardUuids(body.dashboardUuids);
      const filteredInventory = filterBatchInventory(inventory, { countryCode, dashboardUuid, dashboardUuids });
      if ((dashboardUuid || dashboardUuids.length) && filteredInventory.dashboardCount === 0) {
        throw badRequest("Dashboard not found", ["选择的看板不在当前国家范围内，请重新选择看板。"]);
      }
      const queryCardFn = async (_client, dashboard, card, parameters = []) => {
        const client = metabaseClientFactory(dashboard);
        try {
          const rows = await client.queryDashcardJson({
            cardId: card.cardId,
            dashboardUuid: dashboard.uuid,
            dashcardId: card.dashcardId,
            parameters,
          });
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
      const nextRunAt = new Date(now.getTime() + schedule.intervalMinutes * 60_000).toISOString();
      try {
        const countryRuns = [];
        for (const countryConfig of schedule.countryConfigs.filter((item) => item.enabled)) {
          try {
            const result = await this.runBatchCheckAndNotify({
              countryCode: countryConfig.countryCode,
              dashboardUuids: countryConfig.dashboardUuids || [],
              notifyChannel: countryConfig.notifyChannel,
              webhookUrl: countryConfig.webhookUrl,
              botId: countryConfig.botId,
              botToken: countryConfig.botToken,
              chatId: countryConfig.chatId,
              recipientEmails: countryConfig.recipientEmails,
              mentions: countryConfig.mentions,
            });
            countryRuns.push({
              countryCode: countryConfig.countryCode,
              countryName: countryConfig.countryName || "",
              ok: true,
              result: summarizeBatchScheduleRun(result),
            });
          } catch (error) {
            countryRuns.push({
              countryCode: countryConfig.countryCode,
              countryName: countryConfig.countryName || "",
              ok: false,
              error: error.message,
            });
          }
        }
        const failedRuns = countryRuns.filter((item) => !item.ok);
        const saved = {
          ...schedule,
          lastRunAt: startedAt,
          nextRunAt,
          lastError: failedRuns.length ? failedRuns.map((item) => `${item.countryCode}: ${item.error}`).join("; ") : null,
          lastResult: summarizeCountryScheduleRuns(countryRuns),
        };
        await writeJsonAtomic(resolve("batchSchedule"), saved);
        await appendBatchHistoryRun(resolve("batchHistory"), buildBatchHistoryEntry({
          startedAt,
          finishedAt: new Date().toISOString(),
          nextRunAt,
          schedule,
          countryRuns,
        }));
        return { ran: true, schedule: saved, result: saved.lastResult };
      } catch (error) {
        const saved = {
          ...schedule,
          lastRunAt: startedAt,
          nextRunAt,
          lastError: error.message,
          lastResult: null,
        };
        await writeJsonAtomic(resolve("batchSchedule"), saved);
        await appendBatchHistoryRun(resolve("batchHistory"), {
          id: randomUUID(),
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
  if (mergedConfig.botId || previousSchedule.botId) {
    return "tv";
  }
  return normalizeNotifyChannel(previousSchedule.notifyChannel || DEFAULT_BATCH_SCHEDULE.notifyChannel);
}

function buildBatchNotifyAlerts(body, configuredAlerts, notifyChannel) {
  const mentions = normalizeMentions(body.mentions);
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
  };
}

function normalizeBatchSchedule(input = {}, previous = {}, options = {}) {
  const previousSchedule = { ...DEFAULT_BATCH_SCHEDULE, ...(previous || {}) };
  const enabled = Boolean(input.enabled);
  const intervalMinutes = clampNumber(input.intervalMinutes ?? previousSchedule.intervalMinutes, 5, 1440, 120);
  const webhookUrl = String(input.webhookUrl ?? previousSchedule.webhookUrl ?? DEFAULT_TV_WEBHOOK_URL).trim();
  const notifyChannel = normalizeNotifyChannel(input.notifyChannel ?? previousSchedule.notifyChannel ?? DEFAULT_BATCH_SCHEDULE.notifyChannel);
  const countryConfigs = normalizeCountryScheduleConfigs(input.countryConfigs, previousSchedule, options.countries || []);
  const next = {
    ...previousSchedule,
    enabled,
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

  if (options.preserveNextRunAt && previousSchedule.nextRunAt) {
    next.nextRunAt = previousSchedule.nextRunAt;
    return next;
  }

  const previousNextRunAt = previousSchedule.nextRunAt ? Date.parse(previousSchedule.nextRunAt) : Number.NaN;
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
  if (!countryChanged && !intervalChanged && Number.isFinite(previousNextRunAt) && previousNextRunAt > Date.now()) {
    next.nextRunAt = previousSchedule.nextRunAt;
  } else {
    next.nextRunAt = new Date(Date.now() + intervalMinutes * 60_000).toISOString();
  }

  return next;
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
      botToken: String(merged.botToken ?? previousSchedule.botToken ?? "${KN_BOT_TOKEN}").trim(),
      chatId: String(merged.chatId ?? previousSchedule.chatId ?? "").trim(),
      recipientEmails: String(merged.recipientEmails ?? previousSchedule.recipientEmails ?? "").trim(),
      mentions: normalizeMentions(merged.mentions ?? previousSchedule.mentions).join(","),
    };
  });
}

function summarizeBatchScheduleRun(result = {}) {
  return {
    checkedAt: result.checkedAt || null,
    checkedCardCount: result.checkedCardCount || 0,
    dashboardCount: result.dashboardCount || 0,
    checkedDashboards: summarizeCheckedDashboards(result),
    anomalyCount: result.anomalyCount || 0,
    dataQualityAnomalyCount: result.dataQualityAnomalyCount || 0,
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

function buildBatchHistoryEntry({ startedAt, finishedAt, nextRunAt, schedule, countryRuns }) {
  const summary = summarizeCountryScheduleRuns(countryRuns);
  const notificationSentCount = countryRuns.reduce((sum, run) => {
    const notification = run.result?.notification;
    return sum + (notification?.sent ? Number(notification.sentMessages || 0) : 0);
  }, 0);
  return {
    id: randomUUID(),
    trigger: "schedule",
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
    notificationSentCount,
    runs: countryRuns,
  };
}

async function appendBatchHistoryRun(historyFile, entry) {
  const history = await readJsonFile(historyFile, DEFAULT_BATCH_HISTORY);
  const runs = [entry, ...(history.runs || [])].slice(0, MAX_BATCH_HISTORY_RUNS);
  await writeJsonAtomic(historyFile, { updatedAt: new Date().toISOString(), runs });
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
