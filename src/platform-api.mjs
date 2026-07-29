import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createDefaultMetabaseClient } from "./metabase-public-monitor.mjs";
import {
  buildDefaultCardParameters,
  buildUpdateFrequencyHistoryParameters,
  checkPublicDashboards,
  evaluateRowsAgainstRule,
  mergeParameters,
} from "./metabase-public-monitor.mjs";
import { discoverPublicDashboards } from "./metabase-discovery.mjs";
import { parseInternalMetabaseUrl } from "./metabase-internal-client.mjs";
import { parsePublicDashboardUrl } from "./metabase-public-client.mjs";
import { buildPublicCheckMessages, notifyText } from "./notifier.mjs";
import { readJsonFile } from "./utils.mjs";
import { analyzeMetabaseAnomaly, normalizeMetabaseAnomalyAnalysis } from "./metabase-anomaly-agent.mjs";
import {
  loadDsSchedulerConfig,
  saveDsSchedulerConfig,
  checkAllCountries,
} from "./ds-scheduler-monitor.mjs";
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
  observationCache: "config/public-check-cadence-observations.json",
  batchSchedule: "config/batch-check-schedule.json",
  batchHistory: "config/batch-check-run-history.json",
  metabaseAnomalyAnalyses: "config/metabase-anomaly-analyses.json",
  wattrel: "config/wattrel.config.json",
  qualityRuleGeneration: "config/quality-rule-generation.config.json",
  dsScheduler: "config/ds-scheduler.config.json",
  dsSchedule: "config/ds-scheduler-schedule.json",
  dsHistory: "config/ds-scheduler-history.json",
  dsNotification: "config/ds-scheduler-notification.json",
};
const DEFAULT_TV_WEBHOOK_URL = "https://tv-service-alert.kuainiu.chat/alert/v2/array";
const DEFAULT_DUTY_PLATFORM_BASE_URL = "https://big-data-duty-management-platform.kuainiujinke.com";
const DEFAULT_WATTREL_GATEWAY_WEBHOOK_URL = "http://127.0.0.1:5678/webhook/wattrel-query";
const DEFAULT_WATTREL_CONFIG = {
  enabled: true,
  gateway: {
    webhookUrl: DEFAULT_WATTREL_GATEWAY_WEBHOOK_URL,
  },
};
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
  includeDsScheduler: false,
  countryConfigs: [],
  nextRunAt: null,
  lastRunAt: null,
  lastError: null,
  lastResult: null,
};
const DEFAULT_BATCH_HISTORY = { runs: [] };
const DEFAULT_METABASE_ANOMALY_ANALYSES = { analyses: [] };
const HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BATCH_HISTORY_RUNS = 200;
const METABASE_ANALYSIS_PENDING_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_DS_SCHEDULE = {
  enabled: false,
  intervalMinutes: 60,
  countryConfigs: [],
  nextRunAt: null,
  lastRunAt: null,
  lastError: null,
  lastResult: null,
};
const DEFAULT_DS_HISTORY = { runs: [] };

export function createPlatformApi({
  rootDir = process.cwd(),
  metabaseClientFactory = createDefaultMetabaseClient,
  discoverDashboardsFn = discoverPublicDashboards,
  notifyTextFn = notifyText,
  wattrelQueryFn = null,
  qualityRuleGenerationSubmitFn = null,
  metabaseAnomalyAgentFn = analyzeMetabaseAnomaly,
} = {}) {
  const resolve = (name) => path.join(rootDir, FILES[name]);
  let batchScheduleRunProgress = null;
  let batchScheduleRunning = false;
  // Prevent repeated UI clicks from dispatching several evidence jobs for the
  // same historical anomaly before the first request has persisted its cache.
  const metabaseAnalysisInFlight = new Set();
  let dashboardDiscoveryRunning = false;
  let dashboardDiscoveryProgress = { status: "idle", result: null, error: null, startedAt: null, finishedAt: null };
  const runIntegratedDsCheck = async (schedule) => {
    if (!schedule.includeDsScheduler) {
      return null;
    }
    const config = await loadDsSchedulerConfig(rootDir);
    const eligibleCodes = Object.keys(config.countries || {}).filter((code) => (
      String(config.countries?.[code]?.token || "").trim()
      && ((config.projects?.[code] || []).some((item) => String(item.code || "").trim())
        || String(config.projectCodes?.[code] || "").trim())
    ));
    if (eligibleCodes.length === 0) {
      return {
        checkedAt: new Date().toISOString(),
        skipped: true,
        reason: "没有已配置 Token 且项目名称已匹配的国家",
        totalCountries: 0,
        totalChecked: 0,
        totalStuck: 0,
        totalStale: 0,
        failedCountries: 0,
        countries: [],
      };
    }
    const scoped = {
      ...config,
      countries: Object.fromEntries(eligibleCodes.map((code) => [code, config.countries[code]])),
      projectCodes: Object.fromEntries(eligibleCodes.map((code) => [code, config.projectCodes[code]])),
      projects: Object.fromEntries(eligibleCodes.map((code) => [code, config.projects?.[code] || []])),
    };
    const result = await checkAllCountries(rootDir, scoped);
    result.notification = {
      sent: false,
      skipped: true,
      reason: "included in duty summary",
    };
    return result;
  };

  return {
    async getSummary() {
      const [countries, rules, readyInventory, result] = await Promise.all([
        readJsonFile(resolve("countries"), { countries: [] }),
        readJsonFile(resolve("rules"), { rules: [] }),
        readPlatformInventory(rootDir, resolve("inventory")),
        readJsonFile(resolve("result"), null),
      ]);
      const panelSources = await loadPanelSources(rootDir, countries.countries || []);
      const inventory = mergeDashboardSources(readyInventory, panelSources);
      const flat = flattenInventory(inventory);
      return {
        countryCount: countries.countries?.length || 0,
        dashboardCount: flat.dashboardCount,
        executableDashboardCount: flat.executableDashboardCount,
        pendingDashboardCount: flat.pendingDashboardCount,
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

    isBatchScheduleRunning() {
      return batchScheduleRunning;
    },

    async getBatchHistory(filters = {}) {
      const history = await readJsonFile(resolve("batchHistory"), DEFAULT_BATCH_HISTORY);
      return filterBatchHistory(history, filters);
    },

    async analyzeMetabaseAnomaly(body = {}) {
      const runId = String(body.runId || body.historyRunId || "").trim();
      const countryCode = normalizeCountryCode(body.countryCode);
      const anomalyIndex = Number(body.anomalyIndex);
      if (!runId || !countryCode || !Number.isInteger(anomalyIndex) || anomalyIndex < 0) {
        throw badRequest("Invalid Metabase anomaly analysis request", ["请提供巡检记录、国家和异常序号。"]);
      }
      const history = await readJsonFile(resolve("batchHistory"), DEFAULT_BATCH_HISTORY);
      const run = (history.runs || []).find((item) => String(item.id || "") === runId);
      const countryRun = (run?.runs || []).find((item) => String(item.countryCode || "") === countryCode);
      const anomalies = countryRun?.result?.anomalies || [];
      const anomaly = anomalies[anomalyIndex];
      if (!anomaly) {
        throw badRequest("Metabase anomaly not found", ["未找到对应的 Metabase 异常，历史记录可能已经清理或变更。"]);
      }
      const cacheKey = `${runId}:${countryCode}:${anomalyIndex}`;
      if (metabaseAnalysisInFlight.has(cacheKey)) {
        return {
          key: cacheKey,
          runId,
          countryCode,
          anomalyIndex,
          status: "pending",
          pending: true,
          cached: true,
        };
      }
      metabaseAnalysisInFlight.add(cacheKey);
      try {
      const cache = await readJsonFile(resolve("metabaseAnomalyAnalyses"), DEFAULT_METABASE_ANOMALY_ANALYSES);
      const existing = (cache.analyses || []).find((item) => item.key === cacheKey);
      if (existing && existing.status === "pending" && !isExpiredMetabaseAnalysis(existing)) {
        return { ...existing, cached: true };
      }
      if (existing && !body.force && !isExpiredMetabaseAnalysis(existing)) {
        return { ...existing, cached: true };
      }
      const sameDashboardAnomalies = anomalies.filter((item) => (
        item.dashboardUuid && anomaly.dashboardUuid
          ? item.dashboardUuid === anomaly.dashboardUuid
          : item.dashboardTitle === anomaly.dashboardTitle
      ));
      const generated = await metabaseAnomalyAgentFn({
        anomaly,
        context: {
          runId,
          startedAt: run.startedAt,
          countryCode: countryRun.countryCode,
          countryName: countryRun.countryName,
          anomalyIndex,
          sameDashboardAnomalies,
        },
      });
      const entry = {
        key: cacheKey,
        runId,
        countryCode,
        anomalyIndex,
        createdAt: new Date().toISOString(),
        status: generated.pending ? "pending" : "completed",
        ...generated,
      };
      // n8n can finish a short evidence job before its webhook acceptance
      // response reaches this process. Keep that earlier callback instead of
      // overwriting it with a later pending marker.
      const refreshedCache = await readJsonFile(resolve("metabaseAnomalyAnalyses"), DEFAULT_METABASE_ANOMALY_ANALYSES);
      const earlyCompletion = (refreshedCache.analyses || []).find((item) => (
        item.key === cacheKey
        && item.status === "completed"
        && entry.jobId
        && String(item.jobId || "") === String(entry.jobId)
      ));
      if (earlyCompletion) {
        return { ...earlyCompletion, cached: false };
      }
      const analyses = keepRecentMetabaseAnalyses([entry, ...(refreshedCache.analyses || [])]);
      await writeJsonAtomic(resolve("metabaseAnomalyAnalyses"), { updatedAt: new Date().toISOString(), analyses });
      return { ...entry, cached: false };
      } finally {
        metabaseAnalysisInFlight.delete(cacheKey);
      }
    },

    async getMetabaseAnomalyAnalysis(body = {}) {
      const { runId, countryCode, anomalyIndex, key } = normalizeMetabaseAnalysisIdentity(body);
      const cache = await readJsonFile(resolve("metabaseAnomalyAnalyses"), DEFAULT_METABASE_ANOMALY_ANALYSES);
      const entry = (cache.analyses || []).find((item) => item.key === (key || `${runId}:${countryCode}:${anomalyIndex}`));
      if (!entry) {
        const error = new Error("未找到该异常的分析任务。");
        error.statusCode = 404;
        throw error;
      }
      return entry;
    },

    async completeMetabaseAnomalyAnalysis(body = {}) {
      const { runId, countryCode, anomalyIndex, key } = normalizeMetabaseAnalysisIdentity(body);
      if (!body.analysis || typeof body.analysis !== "object") {
        throw badRequest("Invalid Metabase anomaly analysis callback", ["回调必须包含结构化 analysis 结果。"]);
      }
      const cache = await readJsonFile(resolve("metabaseAnomalyAnalyses"), DEFAULT_METABASE_ANOMALY_ANALYSES);
      const entryKey = key || `${runId}:${countryCode}:${anomalyIndex}`;
      const existing = (cache.analyses || []).find((item) => item.key === entryKey);
      if (!existing) {
        // A fast n8n workflow can post its result before analyzeMetabaseAnomaly
        // persists the pending record. Accept only callbacks tied to a retained
        // history anomaly, then let the initiating request merge it by job ID.
        const history = await readJsonFile(resolve("batchHistory"), DEFAULT_BATCH_HISTORY);
        const run = (history.runs || []).find((item) => String(item.id || "") === runId);
        const countryRun = (run?.runs || []).find((item) => String(item.countryCode || "") === countryCode);
        if (!countryRun?.result?.anomalies?.[anomalyIndex]) {
          const error = new Error("分析任务不存在或历史记录已清理。");
          error.statusCode = 404;
          throw error;
        }
        const earlyCompleted = buildCompletedMetabaseAnalysis({
          key: entryKey,
          runId,
          countryCode,
          anomalyIndex,
          jobId: body.jobId,
          body,
          createdAt: new Date().toISOString(),
          callbackReceivedBeforePending: true,
        });
        const analyses = keepRecentMetabaseAnalyses([earlyCompleted, ...(cache.analyses || [])]);
        await writeJsonAtomic(resolve("metabaseAnomalyAnalyses"), { updatedAt: new Date().toISOString(), analyses });
        return earlyCompleted;
      }
      if (existing.jobId && String(body.jobId || "") !== String(existing.jobId)) {
        throw badRequest("Invalid Metabase anomaly analysis callback", ["回调任务编号与待处理任务不一致。"]);
      }
      const completed = buildCompletedMetabaseAnalysis({
        ...existing,
        key: entryKey,
        runId,
        countryCode,
        anomalyIndex,
        jobId: body.jobId || existing.jobId,
        body,
        createdAt: existing.createdAt,
      });
      const analyses = keepRecentMetabaseAnalyses([completed, ...(cache.analyses || []).filter((item) => item.key !== entryKey)]);
      await writeJsonAtomic(resolve("metabaseAnomalyAnalyses"), { updatedAt: new Date().toISOString(), analyses });
      return completed;
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
      const config = await readJsonFile(resolve("wattrel"), DEFAULT_WATTREL_CONFIG);
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
      const config = await readJsonFile(resolve("wattrel"), DEFAULT_WATTREL_CONFIG);
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
        const hasPanelSources = countryInventory.dashboardCount === 0
          ? await hasCountryPanelSources(rootDir, countryConfig.countryCode)
          : false;
        if (countryInventory.dashboardCount === 0 && !hasPanelSources) {
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
      if (batchScheduleRunning) {
        throw badRequest("Batch check already running", ["巡检正在运行中，请等待完成后再试。"]);
      }
      const schedule = await this.getBatchSchedule();
      const enabledCountryConfigs = schedule.countryConfigs.filter((item) => item.enabled);
      if (enabledCountryConfigs.length === 0) {
        throw badRequest("No scheduled countries", ["请先至少启用一个国家，再运行定时巡检测试。"]);
      }

      const startedAt = now.toISOString();
      const nextRunAt = schedule.nextRunAt;
      const historyRunId = randomUUID();
      const detailUrl = buildBatchHistoryDetailUrl(historyRunId);
      batchScheduleRunning = true;
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
        const wattrelSummary = await buildScheduledWattrelSummary({
          countryConfigs: enabledCountryConfigs,
          wattrelConfigFile: resolve("wattrel"),
          queryFn: wattrelQueryFn,
        });
        let dsSchedulerSummary = null;
        let dsSchedulerError = null;
        try {
          dsSchedulerSummary = await runIntegratedDsCheck(schedule);
        } catch (error) {
          dsSchedulerError = error.message;
        }
        batchScheduleRunProgress = { ...batchScheduleRunProgress, status: "sending", currentCountryCode: "", currentCountryName: "" };
        const notificationSentCount = await sendScheduledAggregateNotifications({
          countryRuns,
          countryConfigs: enabledCountryConfigs,
          rulesFile: resolve("rules"),
          notifyTextFn,
          detailUrl,
          wattrelSummary,
          dsSchedulerSummary,
        });
        const failedRuns = countryRuns.filter((item) => !item.ok);
        const lastResult = {
          ...summarizeCountryScheduleRuns(countryRuns, { wattrelSummary }),
          dsSchedulerSummary,
          dsSchedulerError,
        };
        const saved = {
          ...schedule,
          lastRunAt: startedAt,
          nextRunAt,
          lastError: [failedRuns.map((item) => `${item.countryCode}: ${item.error}`).join("; "), dsSchedulerError ? `DS: ${dsSchedulerError}` : ""].filter(Boolean).join("; ") || null,
          lastResult,
        };
        batchScheduleRunProgress = {
          ...batchScheduleRunProgress,
          status: failedRuns.length || dsSchedulerError ? "partial_failed" : "success",
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
          wattrelSummary,
          dsSchedulerSummary,
          dsSchedulerError,
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
      } finally {
        batchScheduleRunning = false;
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
      const [countries, readyInventory] = await Promise.all([
        readJsonFile(resolve("countries"), { countries: [] }),
        readPlatformInventory(rootDir, resolve("inventory")),
      ]);
      const panelSources = await loadPanelSources(rootDir, countries.countries || [], filters);
      const filtered = filterInventory(mergeDashboardSources(readyInventory, panelSources), filters);
      return {
        ...filtered,
        panelSources,
      };
    },

    async addManualDashboard({ countryCode: countryCodeInput, title: titleInput, url: urlInput } = {}) {
      const countryCode = String(countryCodeInput || "").trim().toUpperCase();
      const title = String(titleInput || "").trim();
      const url = String(urlInput || "").trim();
      const countries = await readJsonFile(resolve("countries"), { countries: [] });
      const country = (countries.countries || []).find((item) => String(item.code || "").toUpperCase() === countryCode);
      if (!country) {
        throw badRequest("Invalid dashboard", ["请选择已配置的国家。"]);
      }
      if (!title) {
        throw badRequest("Invalid dashboard", ["请填写看板名称。"]);
      }

      let publicDashboard = null;
      let internalDashboard = null;
      try {
        publicDashboard = parsePublicDashboardUrl(url);
        internalDashboard = publicDashboard ? null : parseInternalMetabaseUrl(url);
      } catch {
        // The validation error below gives the user the supported formats.
      }
      if (!publicDashboard && internalDashboard?.type !== "dashboard") {
        throw badRequest("Invalid dashboard", ["仅支持 Metabase 的 /public/dashboard/... 或 /dashboard/... 看板链接。"]);
      }

      const sourcePath = panelSourceFilePath(rootDir, countryCode);
      const source = await readJsonFile(sourcePath, {});
      const panels = Array.isArray(source.panels) ? source.panels : [];
      const normalizedUrl = dashboardUrlIdentity(url);
      const existing = panels.find((panel) => (panel.links || []).some((link) => dashboardUrlIdentity(link.url) === normalizedUrl));
      const panel = existing || {
        id: `manual:${randomUUID()}`,
        title,
        type: "manual_metabase",
        manual: true,
        links: [{ url }],
      };
      if (!existing) {
        await writeJsonAtomic(sourcePath, {
          ...source,
          country: source.country || { code: country.code, name: country.name, timezone: country.timezone },
          panels: [...panels, panel],
        });
      }
      return panelSourceToDashboard({
        countryCode: country.code,
        countryName: country.name,
        timezone: country.timezone,
      }, panel);
    },

    async discoverManualDashboard({ countryCode: countryCodeInput, sourcePanelId } = {}) {
      const countryCode = String(countryCodeInput || "").trim().toUpperCase();
      const panelId = String(sourcePanelId || "").trim();
      const countries = await readJsonFile(resolve("countries"), { countries: [] });
      const country = (countries.countries || []).find((item) => String(item.code || "").toUpperCase() === countryCode);
      if (!country || !panelId) {
        throw badRequest("Invalid dashboard", ["请选择需要发现卡片的看板。"]);
      }
      const source = await readJsonFile(panelSourceFilePath(rootDir, countryCode), { panels: [] });
      const panel = (source.panels || []).find((item) => String(item.id) === panelId);
      if (!panel) {
        throw badRequest("Dashboard not found", ["未找到该看板的来源记录，请刷新页面后重试。"]);
      }

      const temporaryInputFile = path.join(rootDir, `config/.manual-discovery-${randomUUID()}.json`);
      let rawDiscovered;
      try {
        await writeJsonAtomic(temporaryInputFile, {
          country: { code: country.code, name: country.name, timezone: country.timezone },
          panels: [panel],
        });
        rawDiscovered = await discoverDashboardsFn({
          inputFile: temporaryInputFile,
          outputFile: null,
          sampleRows: 0,
        });
      } catch (error) {
        throw badRequest("Dashboard discovery failed", [error.message || "Metabase 看板发现失败"]);
      } finally {
        await fs.rm(temporaryInputFile, { force: true });
      }
      if ((rawDiscovered.sourceErrors || []).length > 0) {
        throw badRequest("Dashboard discovery failed", rawDiscovered.sourceErrors.map((item) => item.error).filter(Boolean));
      }

      const discovered = (rawDiscovered.dashboards || []).map((dashboard) => ({
        ...dashboard,
        country: dashboard.country || { code: country.code, name: country.name, timezone: country.timezone },
        countryCode: dashboard.countryCode || country.code,
        countryName: dashboard.countryName || country.name,
        timezone: dashboard.timezone || country.timezone,
        sourcePanelId: dashboard.sourcePanelId ?? panel.id,
        sourcePanelTitle: dashboard.sourcePanelTitle || panel.title,
        sourceUrl: dashboard.sourceUrl || panel.links?.[0]?.url || dashboard.url || "",
      }));
      const current = await readPlatformInventory(rootDir, resolve("inventory"));
      const existingCountryDashboards = (current.dashboards || [])
        .filter((dashboard) => getDashboardCountryCode(dashboard) === countryCode);
      const merged = mergeInventories([{
        country: { code: country.code, name: country.name, timezone: country.timezone },
        dashboards: existingCountryDashboards,
      }, {
        country: { code: country.code, name: country.name, timezone: country.timezone },
        dashboards: discovered,
      }]);
      const outputFile = path.join(rootDir, `config/discovered-public-dashboards.${countryCode.toLowerCase()}.json`);
      const discoveredAt = new Date().toISOString();
      await writeJsonAtomic(outputFile, { ...merged, discoveredAt });
      return {
        ok: true,
        countryCode,
        sourcePanelId: panel.id,
        discoveredAt,
        discoveredDashboardCount: discovered.length,
        executableDashboardCount: discovered.filter((dashboard) => (dashboard.cards || []).length > 0).length,
      };
    },

    async discoverCountryDashboards(countryCodeInput) {
      const countryCode = String(countryCodeInput || "").trim().toUpperCase();
      if (!countryCode) {
        throw badRequest("Country code is required", ["请选择需要重新发现的国家。"]);
      }
      const discoveredAt = new Date().toISOString();
      const [rawDiscovered, countries] = await Promise.all([
        discoverCountryInventoryFromPanelSources(rootDir, countryCode, discoverDashboardsFn),
        readJsonFile(resolve("countries"), { countries: [] }),
      ]);
      const country = (countries.countries || []).find((item) => String(item.code || "").toUpperCase() === countryCode) || {};
      const discovered = {
        ...rawDiscovered,
        country: rawDiscovered.country || {
          code: countryCode,
          name: country.name || countryCode,
          timezone: country.timezone,
        },
        dashboards: (rawDiscovered.dashboards || []).map((dashboard) => ({
          ...dashboard,
          country: dashboard.country || {
            code: countryCode,
            name: country.name || countryCode,
            timezone: country.timezone,
          },
          countryCode: dashboard.countryCode || countryCode,
          countryName: dashboard.countryName || country.name || countryCode,
          timezone: dashboard.timezone || country.timezone,
        })),
      };
      if ((discovered.sourceErrors || []).length > 0) {
        const message = discovered.sourceErrors.map((item) => item.error).filter(Boolean).join("; ") || "Metabase 看板发现失败";
        throw badRequest("Dashboard discovery failed", [message]);
      }
      const outputFile = path.join(rootDir, `config/discovered-public-dashboards.${countryCode.toLowerCase()}.json`);
      await writeJsonAtomic(outputFile, { ...discovered, discoveredAt });
      return {
        ok: true,
        countryCode,
        discoveredAt,
        discoveredDashboardCount: (discovered.dashboards || []).length,
        executableDashboardCount: (discovered.dashboards || []).filter((item) => (item.cards || []).length > 0).length,
      };
    },

    async discoverAllCountryDashboards() {
      const countries = await readJsonFile(resolve("countries"), { countries: [] });
      const results = [];
      for (const country of countries.countries || []) {
        try {
          if (await isCountryInventoryFullyDiscovered(rootDir, country.code)) {
            results.push({ ok: true, skipped: true, countryCode: String(country.code || "").toUpperCase() });
            continue;
          }
          results.push(await this.discoverCountryDashboards(country.code));
        } catch (error) {
          results.push({
            ok: false,
            countryCode: String(country.code || "").toUpperCase(),
            error: error.errors?.join("；") || error.message,
          });
        }
      }
      return {
        ok: results.every((item) => item.ok),
        total: results.length,
        succeeded: results.filter((item) => item.ok).length,
        skipped: results.filter((item) => item.skipped).length,
        failed: results.filter((item) => !item.ok).length,
        results,
      };
    },

    startDiscoverAllCountryDashboards() {
      if (dashboardDiscoveryRunning) {
        return { started: false, progress: dashboardDiscoveryProgress, completed: null };
      }
      dashboardDiscoveryRunning = true;
      dashboardDiscoveryProgress = {
        status: "running",
        result: null,
        error: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
      };
      const completed = this.discoverAllCountryDashboards()
        .then((result) => {
          dashboardDiscoveryProgress = {
            status: "completed",
            result,
            error: null,
            startedAt: dashboardDiscoveryProgress.startedAt,
            finishedAt: new Date().toISOString(),
          };
          return result;
        })
        .catch((error) => {
          dashboardDiscoveryProgress = {
            status: "failed",
            result: null,
            error: error.errors?.join("；") || error.message,
            startedAt: dashboardDiscoveryProgress.startedAt,
            finishedAt: new Date().toISOString(),
          };
          return null;
        })
        .finally(() => {
          dashboardDiscoveryRunning = false;
        });
      return { started: true, progress: dashboardDiscoveryProgress, completed };
    },

    getDiscoverAllCountryDashboardsProgress() {
      return { ...dashboardDiscoveryProgress };
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
      const ruleConfig = await readJsonFile(resolve("rules"), {});
      const rule = applyDashboardRuleDefaults(
        applyRuleTypeDefaults(body.rule, ruleConfig.ruleDefaults),
        body.dashboard,
      );
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
      const ruleConfig = await readJsonFile(resolve("rules"), {});
      const rule = applyDashboardRuleDefaults(
        applyRuleTypeDefaults(body.rule, ruleConfig.ruleDefaults),
        dashboard,
      );
      const client = metabaseClientFactory(dashboard);
      const historyParameters = buildUpdateFrequencyHistoryParameters(dashboard, card, [rule]);
      const parameters = mergeParameters(
        mergeParameters(buildDefaultCardParameters(dashboard, card), historyParameters),
        rule.parameters || [],
      );
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
      let filteredInventory = filterBatchInventory(inventory, { countryCode, dashboardUuid, dashboardUuids });
      if (countryCode) {
        const discoveredInventory = await discoverCountryInventoryFromPanelSources(rootDir, countryCode, discoverDashboardsFn);
        filteredInventory = filterBatchInventory(
          mergeInventories([filteredInventory, discoveredInventory]),
          { countryCode, dashboardUuid, dashboardUuids },
        );
      }
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
        observationCacheFile: resolve("observationCache"),
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
      const wattrelSummary = await buildScheduledWattrelSummary({
        countryConfigs: await buildBatchNotifyWattrelCountryConfigs({
          countriesFile: resolve("countries"),
          scheduleFile: resolve("batchSchedule"),
          countryCode: body.countryCode,
        }),
        wattrelConfigFile: resolve("wattrel"),
        queryFn: wattrelQueryFn,
      });
      const messages = buildPublicCheckMessages({ ...result, wattrelSummary }, {
        ...alerts,
        messageStyle: "dutySummary",
        wattrelSummary,
      });
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

      if (batchScheduleRunning) {
        return { ran: false, reason: "already running", schedule };
      }

      const startedAt = now.toISOString();
      const nextRunAt = nextDailyRunAt(schedule.dailyRunTimes || [schedule.dailyRunTime], new Date(now.getTime() + 60_000));
      const historyRunId = randomUUID();
      const detailUrl = buildBatchHistoryDetailUrl(historyRunId);
      batchScheduleRunning = true;
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
        const wattrelSummary = await buildScheduledWattrelSummary({
          countryConfigs: enabledCountryConfigs,
          wattrelConfigFile: resolve("wattrel"),
          queryFn: wattrelQueryFn,
        });
        let dsSchedulerSummary = null;
        let dsSchedulerError = null;
        try {
          dsSchedulerSummary = await runIntegratedDsCheck(schedule);
        } catch (error) {
          dsSchedulerError = error.message;
        }
        batchScheduleRunProgress = { ...batchScheduleRunProgress, status: "sending", currentCountryCode: "", currentCountryName: "" };
        const notificationSentCount = await sendScheduledAggregateNotifications({
          countryRuns,
          countryConfigs: enabledCountryConfigs,
          rulesFile: resolve("rules"),
          notifyTextFn,
          detailUrl,
          wattrelSummary,
          dsSchedulerSummary,
        });
        const failedRuns = countryRuns.filter((item) => !item.ok);
        const lastResult = {
          ...summarizeCountryScheduleRuns(countryRuns, { wattrelSummary }),
          dsSchedulerSummary,
          dsSchedulerError,
        };
        const saved = {
          ...schedule,
          lastRunAt: startedAt,
          nextRunAt,
          lastError: [failedRuns.map((item) => `${item.countryCode}: ${item.error}`).join("; "), dsSchedulerError ? `DS: ${dsSchedulerError}` : ""].filter(Boolean).join("; ") || null,
          lastResult,
        };
        batchScheduleRunProgress = {
          ...batchScheduleRunProgress,
          status: failedRuns.length || dsSchedulerError ? "partial_failed" : "success",
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
          wattrelSummary,
          dsSchedulerSummary,
          dsSchedulerError,
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
      } finally {
        batchScheduleRunning = false;
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

    async getDsSchedulerConfig() {
      const [config, batchSchedule, rules, dsOverride] = await Promise.all([
        loadDsSchedulerConfig(rootDir),
        readJsonFile(resolve("batchSchedule"), DEFAULT_BATCH_SCHEDULE),
        readJsonFile(resolve("rules"), { alerts: {} }),
        readOptionalJson(resolve("dsNotification")),
      ]);
      const notification = effectiveDsNotification(dsOverride, metabaseAlertConfig(batchSchedule, rules.alerts || {}));
      return {
        ...config,
        alerts: notification,
        projectStatus: buildDsProjectStatus(config),
      };
    },

    async saveDsSchedulerConfig(config) {
      const current = await this.getDsSchedulerConfig();
      return saveDsSchedulerConfig(rootDir, {
        ...config,
        alerts: current.alerts,
      });
    },

    async checkAllDsCountries() {
      const config = await this.getDsSchedulerConfig();
      return checkAllCountries(rootDir, config);
    },

    async getDsNotificationConfig() {
      const [stored, batchSchedule, rules] = await Promise.all([
        readOptionalJson(resolve("dsNotification")),
        readJsonFile(resolve("batchSchedule"), DEFAULT_BATCH_SCHEDULE),
        readJsonFile(resolve("rules"), { alerts: {} }),
      ]);
      return effectiveDsNotification(stored, metabaseAlertConfig(batchSchedule, rules.alerts || {}));
    },

    async saveDsNotificationConfig(input = {}) {
      const normalized = normalizeDsNotification(input);
      await writeJsonAtomic(resolve("dsNotification"), normalized);
      const effective = await this.getDsNotificationConfig();
      return { ...effective, inherited: false };
    },

    async previewDsNotification(input = {}) {
      const config = Object.keys(input || {}).length
        ? { ...(await this.getDsNotificationConfig()), ...normalizeDsNotification(input) }
        : await this.getDsNotificationConfig();
      const message = String(input.message || [
        "## DS 调度监控测试",
        "",
        `检查时间：${new Date().toLocaleString("zh-CN")}`,
        "本消息用于验证 DS 调度监控的通知渠道和接收人配置。",
      ].join("\n"));
      return {
        message,
        channel: config.channel,
        targetSummary: dsNotificationTargetSummary(config),
      };
    },

    async sendDsNotificationTest(input = {}) {
      const config = await this.getDsNotificationConfig();
      const preview = await this.previewDsNotification(input);
      validateDsNotificationTarget(config);
      const result = await notifyTextFn({ alerts: config }, preview.message, {
        title: "DS 调度监控通知测试",
        severity: "info",
        timestamp: new Date().toISOString(),
      });
      return {
        ...result,
        channel: config.channel,
        targetSummary: preview.targetSummary,
        sentAt: new Date().toISOString(),
      };
    },

    async getDsSchedule() {
      const [stored, config] = await Promise.all([
        readJsonFile(resolve("dsSchedule"), DEFAULT_DS_SCHEDULE),
        this.getDsSchedulerConfig(),
      ]);
      return {
        ...normalizeDsSchedule(stored, config, { preserveNextRunAt: true }),
        alerts: config.alerts || {},
      };
    },

    async saveDsSchedule(input = {}) {
      const config = await this.getDsSchedulerConfig();
      const schedule = normalizeDsSchedule(input, config);
      await writeJsonAtomic(resolve("dsSchedule"), schedule);
      return { ...schedule, alerts: config.alerts || {} };
    },

    async getDsHistory(filters = {}) {
      const history = await readJsonFile(resolve("dsHistory"), DEFAULT_DS_HISTORY);
      const countryCode = String(filters.countryCode || "").trim();
      const limit = Math.max(1, Math.min(200, Number(filters.limit || 50)));
      const runs = keepRecentHistoryRuns(history.runs || [])
        .filter((run) => !countryCode || (run.result?.countries || []).some((item) => item.country === countryCode))
        .slice(0, limit);
      return { ...history, runs };
    },

    async runDsScheduleNow() {
      const schedule = await this.getDsSchedule();
      return runDsSchedule({ api: this, schedule, trigger: "manual", rootDir, scheduleFile: resolve("dsSchedule"), historyFile: resolve("dsHistory") });
    },

    async runDueDsSchedule(now = new Date()) {
      const schedule = await this.getDsSchedule();
      if (!schedule.enabled || !schedule.nextRunAt || new Date(schedule.nextRunAt) > now) {
        return { ran: false, schedule };
      }
      if (batchScheduleRunning) {
        return { ran: false, reason: "batch check running", schedule };
      }
      return runDsSchedule({ api: this, schedule, trigger: "schedule", rootDir, scheduleFile: resolve("dsSchedule"), historyFile: resolve("dsHistory"), now });
    },
  };
}

function normalizeDsSchedule(input = {}, config = {}, { preserveNextRunAt = false } = {}) {
  const enabled = Boolean(input.enabled);
  const intervalMinutes = Math.max(5, Number(input.intervalMinutes || DEFAULT_DS_SCHEDULE.intervalMinutes));
  const countryConfigs = (Array.isArray(input.countryConfigs) ? input.countryConfigs : [])
    .map((item) => ({
      countryCode: String(item.countryCode || "").trim().toLowerCase(),
      enabled: Boolean(item.enabled),
      projectCode: String(item.projectCode || config.projectCodes?.[String(item.countryCode || "").toLowerCase()] || "").trim(),
    }))
    .filter((item) => item.countryCode);
  const missing = countryConfigs.find((item) => item.enabled && !item.projectCode);
  if (missing) {
    throw badRequest("DS project code is required", [`${missing.countryCode}: project code is required`]);
  }
  const nextRunAt = enabled
    ? (preserveNextRunAt && input.nextRunAt ? input.nextRunAt : new Date(Date.now() + intervalMinutes * 60_000).toISOString())
    : null;
  return {
    ...DEFAULT_DS_SCHEDULE,
    ...input,
    enabled,
    intervalMinutes,
    countryConfigs,
    nextRunAt,
  };
}

async function runDsSchedule({ api, schedule, trigger, rootDir, scheduleFile, historyFile, now = new Date() }) {
  const config = await api.getDsSchedulerConfig();
  const enabled = schedule.countryConfigs.filter((item) => item.enabled);
  if (enabled.length === 0) {
    throw badRequest("No DS countries enabled", ["请至少启用一个已配置项目的国家。"]);
  }
  const scopedConfig = {
    ...config,
    countries: Object.fromEntries(enabled.map((item) => [item.countryCode, config.countries?.[item.countryCode] || {}])),
    projectCodes: Object.fromEntries(enabled.map((item) => [item.countryCode, item.projectCode])),
  };
  const startedAt = now.toISOString();
  try {
    const result = await checkAllCountries(rootDir, scopedConfig);
    result.notification = await notifyDsSchedulerCheck(scopedConfig, result);
    const finishedAt = new Date().toISOString();
    const next = {
      ...schedule,
      nextRunAt: schedule.enabled ? new Date(Date.now() + schedule.intervalMinutes * 60_000).toISOString() : null,
      lastRunAt: finishedAt,
      lastError: null,
      lastResult: result,
    };
    await writeJsonAtomic(scheduleFile, next);
    await appendDsHistory(historyFile, { id: randomUUID(), trigger, startedAt, finishedAt, ok: true, result });
    return { ran: true, schedule: { ...next, alerts: config.alerts || {} }, result };
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const next = { ...schedule, lastRunAt: finishedAt, lastError: error.message };
    await writeJsonAtomic(scheduleFile, next);
    await appendDsHistory(historyFile, { id: randomUUID(), trigger, startedAt, finishedAt, ok: false, error: error.message });
    throw error;
  }
}

async function appendDsHistory(filePath, entry) {
  const history = await readJsonFile(filePath, DEFAULT_DS_HISTORY);
  await writeJsonAtomic(filePath, {
    updatedAt: new Date().toISOString(),
    runs: keepRecentHistoryRuns([entry, ...(history.runs || [])]),
  });
}

function keepRecentHistoryRuns(runs, nowMs = Date.now()) {
  const cutoffMs = nowMs - HISTORY_RETENTION_MS;
  return runs
    .filter((run) => {
      const timestampMs = Date.parse(run.finishedAt || run.startedAt || "");
      return !Number.isFinite(timestampMs) || timestampMs >= cutoffMs;
    })
    .slice(0, MAX_BATCH_HISTORY_RUNS);
}

async function readOptionalJson(filePath) {
  try {
    return await readJsonFile(filePath, null);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function normalizeDsNotification(input = {}) {
  return {
    channel: normalizeNotifyChannel(input.channel || input.notifyChannel || "knBot"),
    webhookUrl: String(input.webhookUrl || "").trim(),
    botId: String(input.botId || "").trim(),
    botToken: String(input.botToken || "").trim(),
    chatId: String(input.chatId || "").trim(),
    recipientEmails: String(input.recipientEmails || "").trim(),
    mentions: normalizeMentions(input.mentions),
    sendWhenHealthy: input.sendWhenHealthy !== false,
  };
}

function effectiveDsNotification(stored, inherited) {
  const source = stored && typeof stored === "object" ? stored : inherited;
  return {
    ...normalizeDsNotification(source || {}),
    inherited: !stored,
    targetSummary: dsNotificationTargetSummary(source || {}),
  };
}

function dsNotificationTargetSummary(config = {}) {
  const channel = normalizeNotifyChannel(config.channel || config.notifyChannel);
  const targets = channel === "knBot"
    ? [config.recipientEmails, config.chatId].filter(Boolean)
    : [config.botId, normalizeMentions(config.mentions).join("、")].filter(Boolean);
  return `${channel === "knBot" ? "KN Chat" : "TV webhook"} · ${targets.join(" · ") || "未配置接收目标"}`;
}

function validateDsNotificationTarget(config = {}) {
  if (config.channel === "knBot" && !config.botToken) {
    throw badRequest("KN Chat Bot Token is required", ["请填写 KN Chat Bot Token。"]);
  }
  if (config.channel === "tv" && !config.botId) {
    throw badRequest("TV bot_id is required", ["请填写 TV bot_id。"]);
  }
}

function buildDsProjectStatus(config = {}) {
  return Object.fromEntries(Object.keys(config.countries || {}).map((code) => [
    code,
    {
      status: (config.projects?.[code] || []).length
        ? ((config.projects[code] || []).every((item) => item.code) ? "resolved" : (config.projects[code] || []).some((item) => item.code) ? "partial" : "unresolved")
        : config.projectCodes?.[code] ? "resolved" : "unresolved",
      projectName: config.projectNames?.[code] || "",
      projects: config.projects?.[code] || [],
      error: (config.projects?.[code] || []).filter((item) => !item.code).map((item) => `${item.name}：${item.error || "尚未匹配"}`).join("；")
        || (config.projectNames?.[code] && !config.projectCodes?.[code] ? "项目名称尚未匹配" : ""),
    },
  ]));
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

function metabaseAlertConfig(schedule = {}, ruleAlerts = {}) {
  return {
    ...ruleAlerts,
    channel: schedule.notifyChannel || ruleAlerts.channel || "tv",
    webhookUrl: schedule.webhookUrl || ruleAlerts.webhookUrl || "",
    botId: schedule.botId || ruleAlerts.botId || "",
    botToken: schedule.botToken || ruleAlerts.botToken || "",
    chatId: schedule.chatId || ruleAlerts.chatId || "",
    recipientEmails: schedule.recipientEmails || ruleAlerts.recipientEmails || "",
    mentions: schedule.mentions || ruleAlerts.mentions || "",
    sendWhenHealthy: schedule.sendWhenHealthy ?? ruleAlerts.sendWhenHealthy ?? false,
  };
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
    includeDsScheduler: Boolean(input.includeDsScheduler ?? previousSchedule.includeDsScheduler),
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
      uniqueRuleCount: 0,
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
      status.uniqueRuleCount = new Set(anomalies.map((item) => wattrelRuleKey(item))).size;
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

  if (countryList.length && (!config.defaultCountryCode || selectedCountryCode) && (hasCountryConnections || forceConfigured || hasWattrelGateway(config.gateway || {}) || !hasGlobalWattrelDatabase(config))) {
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
  const gateway = {
    ...(baseConfig.gateway || {}),
    ...(connection.gateway || {}),
  };
  const query = {
    ...(baseConfig.query || {}),
    ...(connection.query || {}),
  };
  const limit = clampNumber(body.limit ?? query.limit ?? baseConfig.limit, 1, 1000, 100);
  const configured = forceConfigured || (connection.enabled !== false && baseConfig.enabled !== false && hasWattrelConnection({ database, ssh, gateway }));
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
      gateway,
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
    gateway: config.gateway || {},
  });
}

function hasWattrelConnection({ database = {}, ssh = {}, gateway = {} } = {}) {
  return hasWattrelDatabase(database) || hasWattrelSsh(ssh) || hasWattrelGateway(gateway);
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

function hasWattrelGateway(gateway = {}) {
  return Boolean(resolveWattrelGatewayWebhookUrl(gateway));
}

function resolveWattrelGatewayWebhookUrl(gateway = {}) {
  return resolveConfigString(gateway.webhookUrl)
    || resolveConfigString(gateway.url)
    || resolveConfigString(process.env.WATTREL_GATEWAY_WEBHOOK_URL)
    || DEFAULT_WATTREL_GATEWAY_WEBHOOK_URL;
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
      uniqueRuleCount: country.uniqueRuleCount ?? country.anomalyCount ?? 0,
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
      uniqueRuleCount: country.uniqueRuleCount ?? country.anomalyCount ?? 0,
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
        rules: new Set(),
        tableCount: 0,
        tables: new Map(),
        anomalies: [],
      });
    }
    const group = groups.get(key);
    group.anomalyCount += 1;
    group.rules.add(wattrelRuleKey(anomaly));
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
      uniqueRuleCount: group.rules.size,
      tableCount: topTables.length,
      topTables: topTables.slice(0, 5),
      anomalies: group.anomalies,
    };
  }).sort((a, b) => b.anomalyCount - a.anomalyCount || countryRunLabel(a).localeCompare(countryRunLabel(b)));
}

function wattrelRuleKey(anomaly = {}) {
  const qualityId = anomaly.qualityId ?? anomaly.quality_id;
  if (qualityId !== undefined && qualityId !== null && String(qualityId).trim()) {
    return `quality:${String(qualityId).trim()}`;
  }
  const ruleName = String(
    anomaly.checkName
      || anomaly.name
      || anomaly.metric
      || anomaly.cardTitle
      || anomaly.destTbl
      || anomaly.destTable
      || anomaly.table
      || "未命名校验规则",
  ).trim();
  return `name:${ruleName.toLocaleLowerCase()}`;
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

function summarizeCountryScheduleRuns(countryRuns = [], { wattrelSummary = null } = {}) {
  const successfulRuns = countryRuns.filter((item) => item.ok);
  const failedRuns = countryRuns.filter((item) => !item.ok);
  return {
    countryCount: countryRuns.length,
    successCount: successfulRuns.length,
    failedCount: failedRuns.length,
    checkedCardCount: successfulRuns.reduce((sum, item) => sum + Number(item.result?.checkedCardCount || 0), 0),
    dashboardCount: successfulRuns.reduce((sum, item) => sum + Number(item.result?.dashboardCount || 0), 0),
    anomalyCount: successfulRuns.reduce((sum, item) => sum + Number(item.result?.anomalyCount || 0), 0),
    wattrelSummary,
    runs: countryRuns,
  };
}

async function runScheduledCountryChecks(countryConfigs, runBatchCheckFn, onProgress = null, concurrency = 1) {
  const countryRuns = new Array(countryConfigs.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < countryConfigs.length) {
      const i = nextIndex++;
      const countryConfig = countryConfigs[i];
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
        countryRuns[i] = countryRun;
        onProgress?.({ type: "success", countryConfig, countryRun });
      } catch (error) {
        const countryRun = {
          countryCode: countryConfig.countryCode,
          countryName: countryConfig.countryName || "",
          ok: false,
          error: error.message,
        };
        countryRuns[i] = countryRun;
        onProgress?.({ type: "failed", countryConfig, countryRun });
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, countryConfigs.length) }, () => worker());
  await Promise.all(workers);
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

async function sendScheduledAggregateNotifications({ countryRuns, countryConfigs, rulesFile, notifyTextFn, detailUrl, wattrelSummary = null, dsSchedulerSummary = null }) {
  const successfulRuns = countryRuns.filter((item) => item.ok);
  if (successfulRuns.length === 0) {
    markCountryRunNotifications(countryRuns, {
      sent: false,
      skipped: true,
      reason: "no successful country runs",
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
    const result = {
      ...combineScheduledCountryResults(group.countryRuns),
      wattrelSummary,
    };
    const messages = buildPublicCheckMessages(result, {
      ...group.alerts,
      countryDetailMode: "summary",
      messageStyle: "dutySummary",
      wattrelSummary,
      dsScheduleSummary: dsSchedulerSummary,
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
    sentMessages += results.filter((item) => item.sent).length;
  }

  return sentMessages;
}

async function buildScheduledWattrelSummary({ countryConfigs = [], wattrelConfigFile, queryFn = null } = {}) {
  const countries = countryConfigs.map((item) => ({
    code: item.countryCode,
    name: item.countryName || countryDisplayName(item.countryCode),
  })).filter((item) => item.code);
  if (!countries.length) {
    return null;
  }

  try {
    const config = await readJsonFile(wattrelConfigFile, DEFAULT_WATTREL_CONFIG);
    const current = await queryCurrentWattrelTargets({
      config,
      countries,
      body: { limit: 1000 },
      queryFn,
    });
    const statusByCountry = new Map((current.countries || []).map((item) => [String(item.countryCode || "").toUpperCase(), item]));
    const summaryCountries = countries.map((country) => {
      const code = String(country.code || "").toUpperCase();
      const status = statusByCountry.get(code) || {};
      return {
        countryCode: code,
        countryName: country.name || status.countryName || countryDisplayName(code),
        count: Number(status.anomalyCount ?? 0),
        status: status.status || "unconfigured",
        error: status.error || null,
        anomalies: status.anomalies || [],
      };
    });
    return {
      checkedAt: new Date().toISOString(),
      countries: summaryCountries,
      total: summaryCountries.reduce((sum, item) => sum + item.count, 0),
      failedCount: summaryCountries.filter((item) => item.status === "failed").length,
    };
  } catch (error) {
    return {
      checkedAt: new Date().toISOString(),
      countries: countries.map((country) => ({
        countryCode: String(country.code || "").toUpperCase(),
        countryName: country.name || countryDisplayName(country.code),
        count: 0,
        status: "failed",
        error: error.message || String(error),
      })),
      total: 0,
      failedCount: countries.length,
    };
  }
}

async function buildBatchNotifyWattrelCountryConfigs({ countriesFile, scheduleFile, countryCode = "" } = {}) {
  const selectedCode = String(countryCode || "").trim().toUpperCase();
  const countriesConfig = await readJsonFile(countriesFile, { countries: [] });
  const allCountries = (countriesConfig.countries || []).map((country) => ({
    countryCode: String(country.code || country.countryCode || "").trim().toUpperCase(),
    countryName: country.name || country.countryName || "",
  })).filter((country) => country.countryCode);
  if (selectedCode) {
    return allCountries.filter((country) => country.countryCode === selectedCode);
  }

  const schedule = await readJsonFile(scheduleFile, DEFAULT_BATCH_SCHEDULE);
  const enabledScheduleCountries = (schedule.countryConfigs || [])
    .filter((country) => country.enabled !== false)
    .map((country) => ({
      countryCode: String(country.countryCode || "").trim().toUpperCase(),
      countryName: country.countryName || countryDisplayName(country.countryCode),
    }))
    .filter((country) => country.countryCode);

  return enabledScheduleCountries.length ? enabledScheduleCountries : allCountries;
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

function countryDisplayName(countryCode) {
  const code = String(countryCode || "").toUpperCase();
  const names = {
    CN: "中国",
    MX: "墨西哥",
    TH: "泰国",
    INE: "印尼",
    PH: "菲律宾",
    PK: "巴基斯坦",
  };
  return names[code] || code;
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

function buildBatchHistoryEntry({
  trigger = "schedule",
  id = randomUUID(),
  startedAt,
  finishedAt,
  nextRunAt,
  schedule,
  countryRuns,
  notificationSentCount = null,
  wattrelSummary = null,
  dsSchedulerSummary = null,
  dsSchedulerError = null,
}) {
  const summary = summarizeCountryScheduleRuns(countryRuns, { wattrelSummary });
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
    status: summary.failedCount > 0 || dsSchedulerError ? "partial_failed" : "success",
    ok: summary.failedCount === 0 && !dsSchedulerError,
    countryCount: summary.countryCount,
    successCount: summary.successCount,
    failedCount: summary.failedCount,
    checkedCardCount: summary.checkedCardCount,
    dashboardCount: summary.dashboardCount,
    anomalyCount: summary.anomalyCount,
    dataQualityAnomalyCount: countryRuns.reduce((sum, run) => sum + Number(run.result?.dataQualityAnomalyCount || 0), 0),
    wattrelSummary,
    notificationSentCount: sentCount,
    dsSchedulerSummary,
    dsSchedulerError,
    runs: countryRuns,
  };
}

async function appendBatchHistoryRun(historyFile, entry) {
  const history = await readJsonFile(historyFile, DEFAULT_BATCH_HISTORY);
  const runs = keepRecentHistoryRuns([entry, ...(history.runs || [])]);
  await writeJsonAtomic(historyFile, { updatedAt: new Date().toISOString(), runs });
}

function normalizeMetabaseAnalysisIdentity(body = {}) {
  const runId = String(body.runId || body.historyRunId || "").trim();
  const countryCode = normalizeCountryCode(body.countryCode);
  const anomalyIndex = Number(body.anomalyIndex);
  const key = String(body.key || "").trim();
  if (key) return { runId, countryCode, anomalyIndex, key };
  if (!runId || !countryCode || !Number.isInteger(anomalyIndex) || anomalyIndex < 0) {
    throw badRequest("Invalid Metabase anomaly analysis identity", ["请提供巡检记录、国家和异常序号。"]);
  }
  return { runId, countryCode, anomalyIndex, key: "" };
}

function normalizeCountryCode(value) {
  return String(value || "").trim().toUpperCase();
}

function isExpiredMetabaseAnalysis(entry, nowMs = Date.now()) {
  if (entry?.status !== "pending") return false;
  const createdAt = Date.parse(entry?.createdAt || "");
  return !Number.isFinite(createdAt) || nowMs - createdAt >= METABASE_ANALYSIS_PENDING_TIMEOUT_MS;
}

function buildCompletedMetabaseAnalysis({ key, runId, countryCode, anomalyIndex, jobId, body, createdAt, callbackReceivedBeforePending = false, ...existing }) {
  return {
    ...existing,
    key,
    runId,
    countryCode,
    anomalyIndex,
    jobId: String(jobId || existing.jobId || ""),
    createdAt: createdAt || new Date().toISOString(),
    status: "completed",
    completedAt: new Date().toISOString(),
    pending: false,
    provider: existing.provider || "n8n-evidence",
    model: String(body.model || existing.model || "n8n-configured-model"),
    analysis: normalizeMetabaseAnomalyAnalysis(body.analysis),
    evidence: normalizeAgentEvidence(body.evidence),
    observability: body.observability && typeof body.observability === "object"
      ? body.observability
      : (existing.observability || { enabled: false, written: false, reason: "n8n 未返回 Langfuse 状态" }),
    fallbackUsed: Boolean(body.fallbackUsed),
    ...(callbackReceivedBeforePending ? { callbackReceivedBeforePending: true } : {}),
  };
}

function normalizeAgentEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  // Evidence is visible in the duty platform. Keep it bounded and never persist
  // credentials or raw query results that a workflow may accidentally include.
  const jsonText = JSON.stringify(value, null, 2);
  if (/authorization|token|secret|password/i.test(jsonText)) return { omitted: true, reason: "回调证据包含敏感字段，未保存。" };
  if (jsonText.length > 20_000) return { omitted: true, reason: "回调证据过大，未保存。" };
  return value;
}

function keepRecentMetabaseAnalyses(analyses, nowMs = Date.now()) {
  const cutoff = nowMs - HISTORY_RETENTION_MS;
  const seen = new Set();
  return (analyses || []).filter((item) => {
    const createdAt = Date.parse(item?.createdAt || "");
    if (!Number.isFinite(createdAt) || createdAt < cutoff || seen.has(item?.key)) return false;
    seen.add(item.key);
    return true;
  });
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

  const primaryInventoryName = path.basename(primaryInventoryFile);
  const countryInventoryFiles = fileNames
    .filter((fileName) => fileName !== primaryInventoryName)
    .filter((fileName) => /^discovered-public-dashboards\.[a-z]+\.json$/i.test(fileName))
    .map((fileName) => path.join(configDir, fileName));
  const countryInventories = [];

  for (const filePath of countryInventoryFiles) {
    const inventory = await readJsonFile(filePath, { dashboards: [] });
    countryInventories.push(await filterInventoryByCurrentPanelSources(configDir, filePath, inventory));
  }

  const overrideCountryCodes = getInventoryCountryCodes(countryInventories);
  const filteredPrimary = overrideCountryCodes.size > 0
    ? {
        ...primary,
        dashboards: (primary.dashboards || []).filter(
          (dashboard) => !overrideCountryCodes.has(getDashboardCountryCode(dashboard)),
        ),
      }
    : primary;
  const inventories = [filteredPrimary, ...countryInventories];

  return mergeInventories(inventories);
}

async function filterInventoryByCurrentPanelSources(configDir, inventoryFilePath, inventory) {
  const sourceRefs = await readCurrentPanelSourceRefs(configDir, inventoryFilePath);
  if (sourceRefs.urls.size === 0 && sourceRefs.panelIds.size === 0) {
    return inventory;
  }

  return {
    ...inventory,
    dashboards: (inventory.dashboards || []).filter((dashboard) => {
      const sourcePanelId = dashboard.sourcePanelId == null ? "" : String(dashboard.sourcePanelId);
      return sourceRefs.urls.has(dashboard.sourceUrl || "")
        || sourceRefs.urls.has(dashboard.url || "")
        || (sourcePanelId && sourceRefs.panelIds.has(sourcePanelId));
    }),
  };
}

async function readCurrentPanelSourceRefs(configDir, inventoryFilePath) {
  const match = path.basename(inventoryFilePath).match(/^discovered-public-dashboards\.([a-z]+)\.json$/i);
  if (!match) {
    return { urls: new Set(), panelIds: new Set() };
  }

  const panelsFile = path.join(configDir, `discovered-panels.${match[1].toLowerCase()}.json`);
  const panels = await readJsonFile(panelsFile, { panels: [] });
  const panelItems = panels?.panels || [];
  return {
    urls: new Set(
      panelItems
      .flatMap((panel) => panel.links || [])
      .map((link) => link.url)
      .filter(Boolean),
    ),
    panelIds: new Set(
      panelItems
        .map((panel) => panel.id)
        .filter((id) => id != null)
        .map(String),
    ),
  };
}

async function discoverCountryInventoryFromPanelSources(rootDir, countryCode, discoverDashboardsFn) {
  if (!countryCode || typeof discoverDashboardsFn !== "function") {
    return { dashboards: [] };
  }

  const inputFile = panelSourceFilePath(rootDir, countryCode);
  try {
    return await discoverDashboardsFn({
      inputFile,
      outputFile: null,
      sampleRows: 0,
    });
  } catch (error) {
    return {
      dashboardCount: 0,
      totalCardCount: 0,
      sourceErrorCount: 1,
      sourceErrors: [
        {
          countryCode,
          error: error.message,
        },
      ],
      dashboards: [],
    };
  }
}

async function hasCountryPanelSources(rootDir, countryCode) {
  if (!countryCode) {
    return false;
  }
  const source = await readJsonFile(panelSourceFilePath(rootDir, countryCode), {});
  return Array.isArray(source.panels) && source.panels.length > 0;
}

async function isCountryInventoryFullyDiscovered(rootDir, countryCode) {
  const code = String(countryCode || "").trim().toLowerCase();
  if (!code) return false;
  const inventoryFile = code === "ine"
    ? "config/discovered-public-dashboards.json"
    : `config/discovered-public-dashboards.${code}.json`;
  const [sources, inventory] = await Promise.all([
    readJsonFile(panelSourceFilePath(rootDir, code.toUpperCase()), { panels: [] }),
    readJsonFile(path.join(rootDir, inventoryFile), { dashboards: [] }),
  ]);
  const refs = extractPanelSourceRefs(sources);
  if (refs.length === 0) return false;
  const dashboards = inventory.dashboards || [];
  return refs.every((ref) => dashboards.some((dashboard) => (
    (ref.type === "url" && (dashboard.sourceUrl === ref.value || dashboard.url === ref.value))
    || (ref.type === "id" && String(dashboard.sourcePanelId || "") === ref.value)
  ) && Array.isArray(dashboard.cards) && dashboard.cards.length > 0));
}

function extractPanelSourceRefs(source) {
  return (source.panels || []).flatMap((panel) => {
    const urls = (panel.links || []).map((link) => link.url).filter(Boolean);
    if (urls.length > 0) return urls.map((value) => ({ type: "url", value }));
    return panel.id == null ? [] : [{ type: "id", value: String(panel.id) }];
  });
}

function getInventoryCountryCodes(inventories) {
  const codes = new Set();
  for (const inventory of inventories) {
    const inventoryCode = inventory.country?.code || inventory.countryCode;
    if (inventoryCode) {
      codes.add(String(inventoryCode).toUpperCase());
    }
    for (const dashboard of inventory.dashboards || []) {
      const dashboardCode = getDashboardCountryCode(dashboard);
      if (dashboardCode) {
        codes.add(dashboardCode);
      }
    }
  }
  return codes;
}

function getDashboardCountryCode(dashboard) {
  return String(dashboard?.countryCode || dashboard?.country?.code || "").toUpperCase();
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
  const runId = String(filters.runId || "").trim();
  const countryCode = String(filters.countryCode || "").trim();
  const status = String(filters.status || "").trim();
  const limit = clampNumber(filters.limit ?? 50, 1, MAX_BATCH_HISTORY_RUNS, 50);
  let runs = keepRecentHistoryRuns(history.runs || []);

  // History-detail links only need one record. Returning the complete history here
  // makes the page slow when each run contains all Metabase, Wattrel, and DS details.
  if (runId) {
    runs = runs.filter((run) => String(run.id || "") === runId);
  }

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
        dashboardUrl: card.dashboardUrl || "",
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
        dashboardUrl: anomaly.dashboardUrl || "",
        checkedCardCount: 0,
        failedCardCount: 0,
        anomalyCount: 0,
      });
    }
    const group = groups.get(key);
    group.anomalyCount += 1;
    if (!group.dashboardUrl && anomaly.dashboardUrl) {
      group.dashboardUrl = anomaly.dashboardUrl;
    }
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
    executableDashboardCount: dashboards.filter((dashboard) => dashboard.executable !== false).length,
    pendingDashboardCount: dashboards.filter((dashboard) => dashboard.executable === false).length,
    cardCount: dashboards.reduce((sum, dashboard) => sum + (dashboard.cards?.length || 0), 0),
  };
}

function mergeDashboardSources(inventory, panelSources = []) {
  const dashboards = (inventory?.dashboards || []).map((dashboard) => ({
    ...dashboard,
    availability: "ready",
    executable: Array.isArray(dashboard.cards) && dashboard.cards.length > 0,
    pendingReason: "",
  }));
  const identities = new Map();
  dashboards.forEach((dashboard, index) => {
    dashboardIdentities(dashboard).forEach((identity) => identities.set(identity, index));
  });

  for (const source of panelSources) {
    for (const panel of source.panels || []) {
      const pending = panelSourceToDashboard(source, panel);
      let match = dashboardIdentities(pending)
        .map((identity) => identities.get(identity))
        .find((index) => index !== undefined);
      if (match === undefined) {
        match = dashboards.findIndex((dashboard) => {
          if (getDashboardCountryCode(dashboard) !== pending.countryCode) return false;
          if (String(dashboard.sourcePanelId ?? "") !== String(pending.sourcePanelId ?? "")) return false;
          const readyTitle = normalizeSourceTitle(dashboard.sourcePanelTitle || dashboard.title);
          const pendingTitle = normalizeSourceTitle(pending.sourcePanelTitle || pending.title);
          return readyTitle && pendingTitle && (readyTitle.includes(pendingTitle) || pendingTitle.includes(readyTitle));
        });
        if (match < 0) match = undefined;
      }
      if (match === undefined) {
        const pendingTitle = canonicalDashboardTitle(pending.sourcePanelTitle || pending.title);
        match = dashboards.findIndex((dashboard) => (
          getDashboardCountryCode(dashboard) === pending.countryCode
          && canonicalDashboardTitle(dashboard.sourcePanelTitle || dashboard.title) === pendingTitle
        ));
        if (match < 0) match = undefined;
      }
      if (match !== undefined) {
        dashboards[match] = {
          ...pending,
          ...dashboards[match],
          sourcePanelId: dashboards[match].sourcePanelId ?? panel.id,
          sourcePanelTitle: dashboards[match].sourcePanelTitle || panel.title,
        };
        dashboardIdentities(dashboards[match]).forEach((identity) => identities.set(identity, match));
        continue;
      }
      const index = dashboards.push(pending) - 1;
      dashboardIdentities(pending).forEach((identity) => identities.set(identity, index));
    }
  }

  return { ...inventory, dashboards };
}

function panelSourceToDashboard(source, panel) {
  const link = (panel.links || [])[0] || {};
  let internal = null;
  try {
    internal = parseInternalMetabaseUrl(link.url || "");
  } catch {
    internal = null;
  }
  const dashboardId = internal?.type === "dashboard" ? Number(internal.id) : null;
  return {
    countryCode: source.countryCode,
    countryName: source.countryName,
    timezone: source.timezone,
    sourcePanelId: panel.id,
    sourcePanelTitle: panel.title,
    title: panel.title,
    url: link.url || "",
    sourceUrl: link.url || "",
    access: internal ? "internal" : "source",
    dashboardId,
    uuid: dashboardId ? `internal:${dashboardId}` : `source:${source.countryCode}:${panel.id}`,
    cards: [],
    availability: "pending_discovery",
    executable: false,
    pendingReason: "尚未取得 Metabase 卡片清单",
  };
}

function dashboardIdentities(dashboard) {
  const countryCode = getDashboardCountryCode(dashboard);
  const values = [];
  if (dashboard.dashboardId != null && dashboard.dashboardId !== "") {
    values.push(`id:${countryCode}:${dashboard.dashboardId}`);
  }
  if (dashboard.uuid) {
    values.push(`uuid:${countryCode}:${dashboard.uuid}`);
  }
  for (const rawUrl of [dashboard.url, dashboard.sourceUrl]) {
    if (!rawUrl) continue;
    try {
      const url = new URL(rawUrl);
      values.push(`url:${countryCode}:${url.origin}${url.pathname.replace(/\/$/, "")}`);
    } catch {
      values.push(`url:${countryCode}:${String(rawUrl).split("?")[0]}`);
    }
  }
  return [...new Set(values)];
}

function dashboardUrlIdentity(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return String(rawUrl || "").split("?")[0].replace(/\/$/, "");
  }
}

function normalizeSourceTitle(value) {
  return String(value || "")
    .replace(/^(业务概览|投放获客|营销活动|资产管理|贷后催收)-/, "")
    .replace(/^NEW_/, "")
    .trim()
    .toLowerCase();
}

function canonicalDashboardTitle(value) {
  return normalizeSourceTitle(value)
    .replace(/by日期$/i, "")
    .replace(/[^a-z0-9\u4e00-\u9fff]/gi, "");
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
    .filter((dashboard) => !q || dashboard.cards.length > 0 || [
      dashboard.title,
      dashboard.sourcePanelTitle,
      dashboard.url,
    ].filter(Boolean).some((value) => String(value).toLowerCase().includes(q)));

  return {
    ...inventory,
    dashboards,
    dashboardCount: dashboards.length,
    executableDashboardCount: dashboards.filter((dashboard) => dashboard.executable !== false).length,
    pendingDashboardCount: dashboards.filter((dashboard) => dashboard.executable === false).length,
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
      executableDashboardCount: dashboards.filter((dashboard) => dashboard.executable !== false).length,
      pendingDashboardCount: dashboards.filter((dashboard) => dashboard.executable === false).length,
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

function applyRuleTypeDefaults(rule = {}, ruleDefaults = {}) {
  return {
    ...(ruleDefaults?.[rule.type] || {}),
    ...rule,
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
