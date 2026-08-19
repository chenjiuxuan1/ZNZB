import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createDefaultMetabaseClient, resolveInternalMetabaseApiBaseUrl } from "./metabase-public-monitor.mjs";
import {
  buildAnomalyMetricSeries,
  buildDefaultCardParameters,
  buildUpdateFrequencyHistoryParameters,
  checkPublicDashboards,
  evaluateRowsAgainstRule,
  mergeParameters,
  ruleMatchesCard,
} from "./metabase-public-monitor.mjs";
import { discoverPublicDashboards } from "./metabase-discovery.mjs";
import { parseInternalMetabaseUrl } from "./metabase-internal-client.mjs";
import { MetabaseInternalClient } from "./metabase-internal-client.mjs";
import { parsePublicDashboardUrl } from "./metabase-public-client.mjs";
import { buildPublicCheckMessages, notifyText } from "./notifier.mjs";
import { readJsonFile } from "./utils.mjs";
import { fetchCompatible } from "./fetch-compatible.mjs";
import { analyzeMetabaseAnomaly, analyzeMetabaseAnomalyBatch, normalizeMetabaseAnomalyAnalysis, isMetabaseVerdictMissingAnalysis, getMetabaseAnomalyAgentSettings } from "./metabase-anomaly-agent.mjs";
import { createBoundedTaskQueue, getMetabaseAnomalyAccelerationSettings } from "./metabase-anomaly-acceleration.mjs";
import {
  buildDashboardAnalysisJobs,
  getBatchInvestigationLimits,
  MAX_DASHBOARD_ANALYSIS_BYTES,
  MAX_ANOMALIES_PER_DIFY_BATCH,
  runBoundedInvestigationQueue,
} from "./metabase-anomaly-batch.mjs";
import {
  loadDsSchedulerConfig,
  saveDsSchedulerConfig,
  checkAllCountries,
  notifyDsSchedulerCheck,
} from "./ds-scheduler-monitor.mjs";
import { inspectDsFailureLogs } from "./ds-failure-log-monitor.mjs";
import {
  loadHiveSchedulerConfig,
  saveHiveSchedulerConfig,
  checkAllHiveCountries,
  notifyHiveSchedulerCheck,
} from "./hive-scheduler-monitor.mjs";
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
import {
  collectFluctuationMetricTagIdentities,
  createFluctuationMetricTagStore,
} from "./fluctuation-metric-tags.mjs";

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
  metabaseAnomalyPendingRuns: "config/metabase-anomaly-pending-runs.json",
  metabaseAnomalyEvidenceSnapshots: "config/metabase-anomaly-evidence-snapshots.json",
  wattrel: "config/wattrel.config.json",
  qualityRuleGeneration: "config/quality-rule-generation.config.json",
  dsScheduler: "config/ds-scheduler.config.json",
  dsSchedule: "config/ds-scheduler-schedule.json",
  dsHistory: "config/ds-scheduler-history.json",
  dsNotification: "config/ds-scheduler-notification.json",
  hiveScheduler: "config/hive-scheduler.config.json",
  hiveSchedule: "config/hive-scheduler-schedule.json",
  hiveHistory: "config/hive-scheduler-history.json",
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
  includeHiveScheduler: false,
  countryConfigs: [],
  nextRunAt: null,
  lastRunAt: null,
  lastError: null,
  lastResult: null,
};
const DEFAULT_BATCH_HISTORY = { runs: [] };
const DEFAULT_METABASE_ANOMALY_ANALYSES = { analyses: [] };
const DEFAULT_METABASE_ANOMALY_PENDING_RUNS = { runs: [] };
const DEFAULT_METABASE_ANOMALY_EVIDENCE_SNAPSHOTS = { snapshots: [] };
const HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BATCH_HISTORY_RUNS = 200;
const METABASE_ANALYSIS_PENDING_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_METABASE_ANALYSIS_ATTEMPTS = 2;
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
const DEFAULT_HIVE_SCHEDULE = {
  enabled: false,
  intervalMinutes: 60,
  nextRunAt: null,
  lastRunAt: null,
  lastError: null,
  lastResult: null,
};
const DEFAULT_HIVE_HISTORY = { runs: [] };
const jsonUpdateTails = new Map();

export async function updateJsonAtomic(filePath, fallback, transform) {
  const previous = jsonUpdateTails.get(filePath) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const current = await readJsonFile(filePath, fallback);
    const next = await transform(current);
    await writeJsonAtomic(filePath, next);
    return next;
  });
  const tail = operation.catch(() => {}).finally(() => {
    if (jsonUpdateTails.get(filePath) === tail) jsonUpdateTails.delete(filePath);
  });
  jsonUpdateTails.set(filePath, tail);
  return operation;
}

export function createPlatformApi({
  rootDir = process.cwd(),
  metabaseClientFactory = createDefaultMetabaseClient,
  metabaseInternalClientFactory = (baseUrl) => new MetabaseInternalClient({ baseUrl }),
  discoverDashboardsFn = discoverPublicDashboards,
  notifyTextFn = notifyText,
  wattrelQueryFn = null,
  qualityRuleGenerationSubmitFn = null,
  metabaseAnomalyAgentFn = analyzeMetabaseAnomaly,
  metabaseAnomalyBatchAgentFn = analyzeMetabaseAnomalyBatch,
  fluctuationMetricTagStore = createFluctuationMetricTagStore(),
  aiFirstMetabasePatrolEnabled = isAiFirstMetabasePatrolEnabled(),
  dsAutoRetryManager = null,
} = {}) {
  const resolve = (name) => path.join(rootDir, FILES[name]);
  let batchScheduleRunProgress = null;
  let batchScheduleRunning = false;
  let batchScheduleStopRequested = false;
  let batchScheduleAbortController = null;
  let dsScheduleRunning = false;
  let hiveScheduleRunning = false;
  // Prevent repeated UI clicks from dispatching several evidence jobs for the
  // same historical anomaly before the first request has persisted its cache.
  const metabaseAnalysisInFlight = new Set();
  let dashboardDiscoveryRunning = false;
  let dashboardDiscoveryProgress = { status: "idle", result: null, error: null, startedAt: null, finishedAt: null };
  const appendHistoryEntry = async (entry) => {
    await appendBatchHistoryRun(resolve("batchHistory"), entry);
    try {
      await fluctuationMetricTagStore.ensureIdentities(collectFluctuationMetricTagIdentities(entry));
    } catch (error) {
      console.error(`[fluctuation-metric-tags] sync failed for ${entry.id || "history"}: ${error.message}`);
    }
  };
  const findMetabasePatrolRun = async (runId) => {
    const history = await readJsonFile(resolve("batchHistory"), DEFAULT_BATCH_HISTORY);
    const completed = (history.runs || []).find((item) => String(item.id || "") === runId);
    if (completed) return { run: completed, source: "history" };
    const pending = await readJsonFile(resolve("metabaseAnomalyPendingRuns"), DEFAULT_METABASE_ANOMALY_PENDING_RUNS);
    const pendingRun = (pending.runs || []).find((item) => String(item.id || "") === runId);
    return pendingRun ? { run: pendingRun, source: "pending" } : { run: null, source: null };
  };
  const findMetabasePatrolAnomaly = async ({ runId, countryCode, anomalyIndex }) => {
    const { run, source } = await findMetabasePatrolRun(runId);
    const countryRun = (run?.runs || []).find((item) => normalizeCountryCode(item.countryCode) === countryCode);
    return { run, countryRun, anomaly: countryRun?.result?.anomalies?.[anomalyIndex] || null, source };
  };
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
  const runIntegratedHiveCheck = async (schedule) => {
    if (!schedule.includeHiveScheduler) return null;
    const config = await loadHiveSchedulerConfig(rootDir);
    const eligibleCodes = Object.keys(config.countries || {}).filter((code) => (
      config.countries?.[code]?.enabled
      && String(config.countries?.[code]?.token || "").trim()
      && (config.projects?.[code] || []).some((item) => String(item.code || "").trim())
    ));
    if (!eligibleCodes.length) {
      return {
        checkedAt: new Date().toISOString(),
        skipped: true,
        reason: "HIVE 页面没有已启用且项目匹配成功的国家",
        totalChecked: 0,
        totalNotRun: 0,
        totalAbnormal: 0,
        failedCountries: 0,
        countries: [],
      };
    }
    const scoped = {
      ...config,
      countries: Object.fromEntries(eligibleCodes.map((code) => [code, config.countries[code]])),
      projects: Object.fromEntries(eligibleCodes.map((code) => [code, config.projects?.[code] || []])),
    };
    const result = await checkAllHiveCountries(rootDir, scoped);
    result.notification = await notifyHiveSchedulerCheck(scoped, result);
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

    stopBatchScheduleRun() {
      batchScheduleStopRequested = true;
      batchScheduleAbortController?.abort();
      batchScheduleRunProgress = batchScheduleRunProgress ? {
        ...batchScheduleRunProgress,
        status: "stopped",
        stopRequestedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      } : batchScheduleRunProgress;
      return { stopping: batchScheduleRunning, progress: batchScheduleRunProgress };
    },

    async getBatchHistory(filters = {}) {
      const history = await readJsonFile(resolve("batchHistory"), DEFAULT_BATCH_HISTORY);
      return filterBatchHistory(history, filters);
    },

    async getFluctuationMetricTags(body = {}) {
      return fluctuationMetricTagStore.getTags(body.items || []);
    },

    async updateFluctuationMetricTag(body = {}) {
      return fluctuationMetricTagStore.updateTag(body.identity || {}, String(body.tag || ""));
    },

    async savePendingMetabasePatrolRun(entry = {}) {
      const id = String(entry.id || "").trim();
      if (!id || !Array.isArray(entry.runs)) {
        throw badRequest("Invalid pending Metabase patrol run", ["待取证巡检必须包含运行 ID 和国家结果。"]);
      }
      const saved = {
        ...entry,
        id,
        status: String(entry.status || "ai_analyzing"),
        createdAt: entry.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await updateJsonAtomic(resolve("metabaseAnomalyPendingRuns"), DEFAULT_METABASE_ANOMALY_PENDING_RUNS, (store) => ({
        updatedAt: saved.updatedAt,
        runs: [saved, ...(store.runs || []).filter((item) => String(item.id || "") !== id)].slice(0, MAX_BATCH_HISTORY_RUNS),
      }));
      return saved;
    },

    async removePendingMetabasePatrolRun(runId) {
      const id = String(runId || "").trim();
      if (!id) return false;
      let removed = false;
      await updateJsonAtomic(resolve("metabaseAnomalyPendingRuns"), DEFAULT_METABASE_ANOMALY_PENDING_RUNS, (store) => {
        const runs = (store.runs || []).filter((item) => String(item.id || "") !== id);
        removed = runs.length !== (store.runs || []).length;
        return removed ? { updatedAt: new Date().toISOString(), runs } : store;
      });
      return removed;
    },

    async prepareMetabaseInvestigationBatches({ runId, wattrelSummary = null, dsSchedulerSummary = null } = {}) {
      const normalizedRunId = String(runId || "").trim();
      const { run } = await findMetabasePatrolRun(normalizedRunId);
      if (!run) throw badRequest("Metabase patrol run not found", ["未找到待取证巡检记录。"]);
      const cardCache = new Map();
      const cases = [];
      for (const countryRun of run.runs || []) {
        if (!countryRun.ok) continue;
        const countryCode = normalizeCountryCode(countryRun.countryCode);
        for (let anomalyIndex = 0; anomalyIndex < (countryRun.result?.anomalies || []).length; anomalyIndex += 1) {
          const anomaly = countryRun.result.anomalies[anomalyIndex];
          const cardId = Number(anomaly.cardId);
          const cardKey = Number.isFinite(cardId) ? `${countryCode}:${cardId}` : `${countryCode}:card:${anomaly.dashboardUuid || anomaly.dashboardTitle || anomaly.cardTitle || anomalyIndex}`;
          if (!cardCache.has(cardKey)) {
            let cardSql = "";
            if (Number.isFinite(cardId)) {
              const baseUrl = resolveInternalMetabaseApiBaseUrl(getMetabaseBaseUrl(anomaly.dashboardUrl));
              const card = await metabaseInternalClientFactory(baseUrl).getCard(cardId);
              cardSql = String(card.dataset_query?.native?.query || card.native_query || "");
            }
            const tables = extractQualifiedSqlTables(cardSql);
            cardCache.set(cardKey, { cardSql, sourceTable: tables[0] || `card:${cardId || anomaly.dashboardUuid || anomalyIndex}`, sourceTables: tables });
          }
          const source = cardCache.get(cardKey);
          cases.push({
            countryCode,
            anomalyIndex,
            dashboardUuid: resolveAnomalyDashboardUuid(anomaly),
            dashboardTitle: String(anomaly.dashboardTitle || "").trim(),
            sourceTable: source.sourceTable,
            anomaly: compactMetabaseAnomaly(anomaly),
            cardSql: source.cardSql,
            sourceTables: source.sourceTables,
          });
        }
      }
      const groups = buildDashboardAnalysisJobs(cases, MAX_ANOMALIES_PER_DIFY_BATCH);
      const pendingSnapshots = [];
      const batches = groups.map((group) => {
        const snapshotId = `snapshot-${randomUUID()}`;
        const snapshot = {
          snapshotId,
          runId: normalizedRunId,
          countryCode: group.countryCode,
          dashboardUuid: group.dashboardUuid,
          dashboardTitle: group.dashboardTitle,
          collectedAt: new Date().toISOString(),
          complete: true,
          evidence: {
            cards: group.cases.map((item) => ({
              anomalyIndex: item.anomalyIndex,
              cardSql: item.cardSql || "",
              sourceTables: item.sourceTables || [],
            })),
            wattrelSummary,
            dsSchedulerSummary,
          },
          missing: [],
        };
        pendingSnapshots.unshift(snapshot);
        return {
          ...group,
          sourceTable: group.cases.every((item) => item.sourceTable === group.cases[0]?.sourceTable) ? group.cases[0]?.sourceTable || "" : "",
          runId: normalizedRunId,
          batchId: `batch-${randomUUID()}`,
          snapshotId,
          cases: group.cases.map(({ cardSql, sourceTables, ...item }) => item),
        };
      });
      await updateJsonAtomic(resolve("metabaseAnomalyEvidenceSnapshots"), DEFAULT_METABASE_ANOMALY_EVIDENCE_SNAPSHOTS, (store) => ({
        updatedAt: new Date().toISOString(),
        snapshots: [...pendingSnapshots, ...(store.snapshots || [])].slice(0, 500),
      }));
      return { runId: normalizedRunId, batches };
    },

    async submitMetabaseInvestigationBatch(batch = {}) {
      const runId = String(batch.runId || "").trim();
      const countryCode = normalizeCountryCode(batch.countryCode);
      const batchId = String(batch.batchId || "").trim();
     const snapshotId = String(batch.snapshotId || "").trim();
     const cases = Array.isArray(batch.cases) ? batch.cases : [];
      const stage = "dashboard_analysis";
      const invalidCaseCount = cases.length === 0;
     const payloadBytes = Buffer.byteLength(JSON.stringify({ ...batch, cases }), "utf8");
      if (!runId || !countryCode || !batchId || !snapshotId || invalidCaseCount || payloadBytes > MAX_DASHBOARD_ANALYSIS_BYTES) {
        throw badRequest("Invalid Metabase investigation batch", ["看板分析任务必须包含有效标识和至少一条异常，且请求不得超过 512 KiB。"]);
     }
      const normalizedCases = [];
      for (const item of cases) {
        const anomalyIndex = Number(item?.anomalyIndex);
        const { anomaly } = await findMetabasePatrolAnomaly({ runId, countryCode, anomalyIndex });
        if (!anomaly) throw badRequest("Invalid Metabase investigation batch", ["批量取证包含不存在的异常。"]);
        normalizedCases.push({ ...item, anomalyIndex, anomaly: item.anomaly || compactMetabaseAnomaly(anomaly) });
      }
      if (new Set(normalizedCases.map((item) => item.anomalyIndex)).size !== normalizedCases.length) {
        throw badRequest("Invalid Metabase investigation batch", ["批量取证不能包含重复异常。"]);
      }
      const generated = await metabaseAnomalyBatchAgentFn({ batch: { ...batch, runId, countryCode, batchId, snapshotId, cases: normalizedCases } });
      if (!generated?.pending || !generated.jobId) {
        const error = new Error("批量 n8n 取证任务未返回异步任务编号。");
        error.statusCode = 502;
        throw error;
      }
      const createdAt = new Date().toISOString();
      const entries = normalizedCases.map((item) => ({
        key: `${runId}:${countryCode}:${item.anomalyIndex}`,
        runId,
        countryCode,
        anomalyIndex: item.anomalyIndex,
        batchId,
        snapshotId,
        stage,
        dashboardUuid: String(batch.dashboardUuid || item.anomaly?.dashboardUuid || ""),
        anomaly: item.anomaly,
        createdAt,
        status: "pending",
        pending: true,
        jobId: String(generated.jobId),
        provider: generated.provider || "n8n-evidence",
        model: generated.model || "n8n-configured-model",
       observability: generated.observability || { enabled: false, written: false, reason: "n8n 批量任务已受理，等待回调" },
     }));
     const keys = new Set(entries.map((item) => item.key));
      await updateJsonAtomic(resolve("metabaseAnomalyAnalyses"), DEFAULT_METABASE_ANOMALY_ANALYSES, (store) => {
        const existingByKey = new Map((store.analyses || []).map((item) => [item.key, item]));
        const finalEntries = entries.map((entry) => {
          const existing = existingByKey.get(entry.key);
          if (existing?.status === "completed" && String(existing.jobId || "") === String(entry.jobId || "")) return existing;
          return entry;
        });
        const analyses = keepRecentMetabaseAnalyses([...finalEntries, ...(store.analyses || []).filter((item) => !keys.has(item.key))]);
        return { updatedAt: createdAt, analyses };
      });
      return { ...generated, batchId, runId, countryCode, cases: normalizedCases };
    },

    async waitForMetabaseInvestigationBatch(batch = {}, { deadlineAt = Number.POSITIVE_INFINITY, intervalMs = 2_000 } = {}) {
      const limits = getBatchInvestigationLimits();
      const runId = String(batch.runId || "").trim();
      const countryCode = normalizeCountryCode(batch.countryCode);
      const indexes = (batch.cases || []).map((item) => Number(item.anomalyIndex));
      const endAt = Math.min(Date.now() + limits.timeoutMs, deadlineAt);
      while (Date.now() < endAt) {
        const cache = await readJsonFile(resolve("metabaseAnomalyAnalyses"), DEFAULT_METABASE_ANOMALY_ANALYSES);
        const entries = indexes.map((anomalyIndex) => (cache.analyses || []).find((item) => item.key === `${runId}:${countryCode}:${anomalyIndex}`));
        if (entries.length && entries.every((item) => item && item.status !== "pending")) {
          return { status: entries.some((item) => item.status === "failed" || item.status === "timed_out") ? "partial_failed" : "completed", entries };
        }
        await delay(Math.min(intervalMs, Math.max(1, endAt - Date.now())));
      }
      const timeoutMinutes = Math.max(1, Math.round(limits.timeoutMs / 60_000));
      return this.markMetabaseInvestigationBatchTimedOut(batch, { reason: Date.now() >= deadlineAt ? "巡检已达到 45 分钟全局截止" : `等待 Dify 回调超过 ${timeoutMinutes} 分钟` });
    },

    async markMetabaseInvestigationBatchTimedOut(batch = {}, { reason = "AI 未在时限内回写" } = {}) {
      const runId = String(batch.runId || "").trim();
      const countryCode = normalizeCountryCode(batch.countryCode);
      const cases = Array.isArray(batch.cases) ? batch.cases : [];
      const now = new Date().toISOString();
      const keys = new Set(cases.map((item) => `${runId}:${countryCode}:${Number(item.anomalyIndex)}`));
      const timedOut = cases.map((item) => ({
        key: `${runId}:${countryCode}:${Number(item.anomalyIndex)}`,
        runId,
        countryCode,
        anomalyIndex: Number(item.anomalyIndex),
        batchId: String(batch.batchId || ""),
        snapshotId: String(batch.snapshotId || ""),
        jobId: String(batch.jobId || ""),
        createdAt: now,
        completedAt: now,
        status: "timed_out",
        pending: false,
        provider: "n8n-evidence",
        model: "n8n-configured-model",
        analysis: normalizeMetabaseAnomalyAnalysis({
          summary: "AI 未在巡检时限内完成取证。",
          confidence: "low",
          limitations: reason,
          dataSideVerdict: "insufficient_evidence",
          notificationAction: "send",
        }),
        evidence: {},
      }));
      let replacements = timedOut;
      await updateJsonAtomic(resolve("metabaseAnomalyAnalyses"), DEFAULT_METABASE_ANOMALY_ANALYSES, (store) => {
        const existingByKey = new Map((store.analyses || []).map((item) => [item.key, item]));
        replacements = timedOut.map((item) => {
          const existing = existingByKey.get(item.key);
          return existing?.status === "completed" ? existing : { ...existing, ...item };
        });
        const analyses = keepRecentMetabaseAnalyses([...replacements, ...(store.analyses || []).filter((item) => !keys.has(item.key))]);
        return { updatedAt: now, analyses };
      });
      return { status: "timed_out", entries: replacements };
    },

    async collectRetryableMetabaseBatches({ settled = [], runId, analysesFile }) {
      const cache = await readJsonFile(analysesFile, DEFAULT_METABASE_ANOMALY_ANALYSES);
      const byKey = new Map((cache.analyses || []).map((item) => [item.key, item]));
      const retryable = [];
      for (const { batch, result } of settled || []) {
        const settlement = String(result?.status || "").trim();
        if (settlement === "timed_out" || settlement === "failed") {
          retryable.push(batch);
          continue;
        }
        if (settlement !== "completed") continue;
        const countryCode = normalizeCountryCode(batch.countryCode);
        const anyUnresolved = (batch.cases || []).some((item) => {
          const entry = byKey.get(`${runId}:${countryCode}:${Number(item.anomalyIndex)}`);
          if (!entry) return false;
          return entry.verdictMissing === true || entry.status === "timed_out" || entry.status === "failed";
        });
        if (anyUnresolved) retryable.push(batch);
      }
      return retryable;
    },

    async finalizeAiFirstMetabasePatrol({ runId, startedAt, countryRuns, countryConfigs, schedule, detailUrl, wattrelSummary, dsSchedulerSummary, dsSchedulerError, trigger }) {
      const limits = getBatchInvestigationLimits();
      const deadlineAt = Date.parse(startedAt) + limits.deadlineMs;
      await this.savePendingMetabasePatrolRun({ id: runId, startedAt, trigger, schedule, runs: countryRuns, wattrelSummary, dsSchedulerSummary, dsSchedulerError });
      batchScheduleRunProgress = updateBatchScheduleRunProgressStage(batchScheduleRunProgress, "notification", { status: "queued", detail: "等待 AI 取证结论后再发送最终通知" });
      batchScheduleRunProgress = updateBatchScheduleRunProgressStage(batchScheduleRunProgress, "ai_analysis", { status: "running", detail: "正在准备看板分析证据" });
      let queueResult = { total: 0, completed: 0, failed: 0, timedOut: 0, settled: [], notSubmitted: [] };
     if (getMetabaseAnomalyAgentSettings().enabled) {
       const prepared = await this.prepareMetabaseInvestigationBatches({ runId, wattrelSummary, dsSchedulerSummary });
        const analysisResult = await runBoundedInvestigationQueue({
          batches: prepared.batches,
          limits,
          deadlineAt,
          submit: async (batch) => this.submitMetabaseInvestigationBatch(batch),
          waitForSettlement: async (batch) => this.waitForMetabaseInvestigationBatch(batch, { deadlineAt }),
          onProgress: (event) => { batchScheduleRunProgress = updateBatchScheduleAiBatchProgress(batchScheduleRunProgress, event); },
        });
        queueResult = analysisResult;
        for (let attempt = 2; attempt <= MAX_METABASE_ANALYSIS_ATTEMPTS && Date.now() < deadlineAt; attempt++) {
          const retryBatches = await this.collectRetryableMetabaseBatches({
            settled: queueResult.settled || [],
            runId,
            analysesFile: resolve("metabaseAnomalyAnalyses"),
          });
          if (!retryBatches.length) break;
          batchScheduleRunProgress = updateBatchScheduleRunProgressStage(batchScheduleRunProgress, "ai_analysis", {
            status: "running",
            detail: `正在重刷 ${retryBatches.length} 个未出结论的看板分析（第 ${attempt}/${MAX_METABASE_ANALYSIS_ATTEMPTS} 次）`,
          });
          const retryResult = await runBoundedInvestigationQueue({
            batches: retryBatches,
            limits,
            deadlineAt,
            submit: async (batch) => this.submitMetabaseInvestigationBatch(batch),
            waitForSettlement: async (batch) => this.waitForMetabaseInvestigationBatch(batch, { deadlineAt }),
            onProgress: (event) => { batchScheduleRunProgress = updateBatchScheduleAiBatchProgress(batchScheduleRunProgress, { ...event, retry: true, attempt }); },
          });
          queueResult = mergeBatchInvestigationResults(queueResult, retryResult);
        }
        for (const batch of queueResult.notSubmitted || []) {
          await this.markMetabaseInvestigationBatchTimedOut(batch, { reason: "巡检达到 45 分钟全局截止，未再投递 Dify" });
        }
     } else {
       const prepared = await this.prepareMetabaseInvestigationBatches({ runId, wattrelSummary, dsSchedulerSummary });
       for (const batch of prepared.batches) await this.markMetabaseInvestigationBatchTimedOut(batch, { reason: "Dify 批量取证未配置，已按保守策略通知" });
        queueResult = { total: prepared.batches.length, completed: 0, failed: 0, timedOut: prepared.batches.length, settled: [], notSubmitted: [] };
     }
      const finalizedRuns = await buildAiFinalizedCountryRuns({ countryRuns, runId, analysesFile: resolve("metabaseAnomalyAnalyses") });
      batchScheduleRunProgress = updateBatchScheduleRunProgressStage(batchScheduleRunProgress, "ai_analysis", {
        status: queueResult.failed || queueResult.timedOut || queueResult.notSubmitted.length ? "partial_failed" : "success",
        detail: (() => {
          const parts = [`看板分析 ${queueResult.completed || 0}/${queueResult.total || 0}`];
          if (queueResult.failed) parts.push(`失败 ${queueResult.failed}`);
          if (queueResult.timedOut) parts.push(`超时 ${queueResult.timedOut}`);
          if (queueResult.notSubmitted?.length) parts.push(`未投递 ${queueResult.notSubmitted.length}`);
          return parts.join("；");
        })(),
      });
      batchScheduleRunProgress = updateBatchScheduleRunProgressStage(batchScheduleRunProgress, "notification", { status: "running", detail: "AI 结论已收敛，正在发送最终通知" });
      const notificationSentCount = await sendScheduledAggregateNotifications({ countryRuns: finalizedRuns, countryConfigs, rulesFile: resolve("rules"), notifyTextFn, detailUrl, wattrelSummary, dsSchedulerSummary });
      batchScheduleRunProgress = updateBatchScheduleRunProgressStage(batchScheduleRunProgress, "notification", { status: "success", detail: notificationSentCount ? `已发送 ${notificationSentCount} 条最终通知` : "无需要通知的数据侧异常" });
      return { countryRuns: finalizedRuns, notificationSentCount, queueResult };
    },

    async getFluctuationVisualSeries(body = {}) {
      const anomaly = body.anomaly && typeof body.anomaly === "object" ? body.anomaly : body;
      const inventory = await readPlatformInventory(rootDir, resolve("inventory"));
      const rulesConfig = await readJsonFile(resolve("rules"), { rules: [], ruleDefaults: {} });
      const { dashboard, card } = findInventoryCardForAnomaly(inventory, anomaly);
      if (!dashboard || !card) {
        throw badRequest("Fluctuation card not found", ["未能在看板清单中找到该异常对应的看板卡片，请先重新发现该国家看板。"]);
      }
      const matchingRules = (rulesConfig.rules || [])
        .filter((rule) => ruleMatchesCard(rule, dashboard, card))
        .map((rule) => applyDashboardRuleDefaults(applyRuleTypeDefaults(rule, rulesConfig.ruleDefaults || {}), dashboard));
      // Fifteen calendar days gives hourly cards fourteen complete prior days,
      // without deciding the chart axis from an alert message.
      const historyLookbackDays = 15;
      const anomalyDate = extractAnomalyDate(anomaly.message || "");
      const ruleForSeries = matchingRules.find((rule) => String(rule.type || "") === String(anomaly.type || ""))
        || matchingRules[0]
        || {};
      const historyParameters = buildFluctuationSeriesHistoryParameters(
        dashboard,
        card,
        historyLookbackDays,
        anomalyDate,
        body.now,
        ruleForSeries,
      );
      const urlParameters = buildFluctuationSeriesUrlParameters(dashboard, card, anomaly.dashboardUrl);
      const ruleParameters = matchingRules.reduce(
        (parameters, rule) => mergeParameters(parameters, rule.parameters || []),
        [],
      );
      const parameters = mergeParameters(
        mergeParameters(
          mergeParameters(buildDefaultCardParameters(dashboard, card), ruleParameters),
          urlParameters,
        ),
        historyParameters,
      );
      const client = metabaseClientFactory(dashboard);
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
      let rows = await client.queryDashcardJson(request);
      let formattedSeries = buildFluctuationChartSeries(rows, ruleForSeries, anomaly, card, body);
      // Retry only insufficient history with a wider lookback while retaining URL filters.
      if (formattedSeries.length < 2 && historyParameters.length) {
        const fallbackParameters = mergeParameters(
          mergeParameters(
            mergeParameters(buildDefaultCardParameters(dashboard, card), ruleParameters),
            urlParameters,
          ),
          buildFluctuationSeriesHistoryParameters(dashboard, card, 30, anomalyDate, body.now, ruleForSeries),
        );
        const fallbackRows = await client.queryDashcardJson({ ...request, parameters: fallbackParameters });
        const fallbackSeries = buildFluctuationChartSeries(fallbackRows, ruleForSeries, anomaly, card, body);
        if (fallbackSeries.length > formattedSeries.length) {
          rows = fallbackRows;
          formattedSeries = fallbackSeries;
        }
      }
      return {
        ok: formattedSeries.length >= 2,
        dashboard: {
          countryCode: dashboard.countryCode || dashboard.country?.code || "",
          dashboardUuid: dashboard.uuid || "",
          dashboardUrl: dashboard.url || "",
          cardId: card.cardId,
          dashcardId: card.dashcardId,
          cardTitle: card.title || "",
        },
        rowCount: Array.isArray(rows) ? rows.length : 0,
        series: formattedSeries,
        message: formattedSeries.length >= 2
          ? ""
          : `看板查询返回 ${Array.isArray(rows) ? rows.length : 0} 行，但只匹配到 ${formattedSeries.length} 个趋势点；可能是历史日期过滤未映射到该卡片，或告警维度无法与看板返回行匹配。`,
      };
    },

    async analyzeMetabaseAnomaly(body = {}) {
      const runId = String(body.runId || body.historyRunId || "").trim();
      const countryCode = normalizeCountryCode(body.countryCode);
      const anomalyIndex = Number(body.anomalyIndex);
      if (!runId || !countryCode || !Number.isInteger(anomalyIndex) || anomalyIndex < 0) {
        throw badRequest("Invalid Metabase anomaly analysis request", ["请提供巡检记录、国家和异常序号。"]);
      }
      const { run, countryRun, anomaly } = await findMetabasePatrolAnomaly({ runId, countryCode, anomalyIndex });
      const anomalies = countryRun?.result?.anomalies || [];
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
      // A pending callback may be stuck after n8n fails. Keep normal clicks
      // deduplicated, but let an explicit force retry create a new job.
      if (existing && existing.status === "pending" && !body.force && !isExpiredMetabaseAnalysis(existing)) {
        return { ...existing, cached: true };
      }
      // Completed results are cacheable. Failed/timed-out entries must be
      // dispatchable again; otherwise the UI retry button only re-renders the
      // old error and never reaches n8n.
      if (existing && existing.status === "completed" && !body.force && !isExpiredMetabaseAnalysis(existing)) {
        return { ...existing, cached: true };
      }
      const agentSettings = getMetabaseAnomalyAgentSettings();
      if (agentSettings.transport === "n8n") {
        // The n8n workflow only accepts protocolVersion 5 dashboard-analysis
        // jobs. Route the single anomaly through the same batch submission so
        // it reuses the webhook, Dify agent, and /batch-callback path. A fast
        // callback may have already completed the entry before we read it back.
        const dashboardUuid = resolveAnomalyDashboardUuid(anomaly);
        const dashboardTitle = String(anomaly.dashboardTitle || "").trim();
        console.error(`[metabase-anomaly] dispatching single analysis: runId=${runId} country=${countryCode} idx=${anomalyIndex} dashboard=${dashboardTitle} n8nUrl=${agentSettings.n8nWebhookUrl}`);
        try {
          await this.submitMetabaseInvestigationBatch({
            runId,
            countryCode,
            batchId: `single-${randomUUID()}`,
            snapshotId: `snapshot-${randomUUID()}`,
            dashboardUuid,
            dashboardTitle,
            sourceTable: "",
            cases: [{
              anomalyIndex,
              countryCode,
              dashboardUuid,
              dashboardTitle,
              anomaly: compactMetabaseAnomaly(anomaly),
            }],
          });
        } catch (dispatchError) {
          // Return a failed entry with HTTP 200 so the frontend always gets
          // JSON (nginx otherwise intercepts 502 and returns HTML, hiding the
          // actual error message from the user).
          console.error(`[metabase-anomaly] single analysis dispatch FAILED for ${cacheKey}: ${dispatchError.message}`);
          const failedEntry = {
            key: cacheKey, runId, countryCode, anomalyIndex,
            createdAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            status: "failed", pending: false,
            provider: "n8n-evidence", model: "n8n-configured-model",
            jobId: "",
            analysis: normalizeMetabaseAnomalyAnalysis({}),
            error: String(dispatchError.message || dispatchError),
            observability: { enabled: false, written: false, reason: String(dispatchError.message || dispatchError) },
          };
          await updateJsonAtomic(resolve("metabaseAnomalyAnalyses"), DEFAULT_METABASE_ANOMALY_ANALYSES, (failStore) => ({
            updatedAt: new Date().toISOString(),
            analyses: keepRecentMetabaseAnalyses([failedEntry, ...(failStore.analyses || []).filter((item) => item.key !== cacheKey)]),
          }));
          return { ...failedEntry, cached: false };
        }
        const refreshedCache = await readJsonFile(resolve("metabaseAnomalyAnalyses"), DEFAULT_METABASE_ANOMALY_ANALYSES);
        const entry = (refreshedCache.analyses || []).find((item) => item.key === cacheKey);
        return entry ? { ...entry, cached: false } : {
          key: cacheKey, runId, countryCode, anomalyIndex,
          createdAt: new Date().toISOString(), status: "pending", pending: true, cached: false,
        };
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
      let earlyCompletion = null;
      await updateJsonAtomic(resolve("metabaseAnomalyAnalyses"), DEFAULT_METABASE_ANOMALY_ANALYSES, (refreshedCache) => {
        earlyCompletion = (refreshedCache.analyses || []).find((item) => (
          item.key === cacheKey
          && item.status === "completed"
          && entry.jobId
          && String(item.jobId || "") === String(entry.jobId)
        ));
        if (earlyCompletion) return refreshedCache;
        return {
          updatedAt: new Date().toISOString(),
          analyses: keepRecentMetabaseAnalyses([entry, ...(refreshedCache.analyses || []).filter((item) => item.key !== cacheKey)]),
        };
      });
      if (earlyCompletion) {
        return { ...earlyCompletion, cached: false };
      }
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

    async getMetabaseAnomalyAnalysisDisplayIndex(filters = {}) {
      const runId = String(filters.runId || filters.historyRunId || "").trim();
      if (!runId) {
        throw badRequest("Invalid Metabase anomaly display index request", ["请提供巡检记录。"]);
      }
      const cache = await readJsonFile(resolve("metabaseAnomalyAnalyses"), DEFAULT_METABASE_ANOMALY_ANALYSES);
      const items = (cache.analyses || [])
        .filter((item) => String(item.runId || "") === runId && item.status === "completed")
        .map((item) => ({
          countryCode: item.countryCode,
          anomalyIndex: item.anomalyIndex,
          verificationStatus: "completed",
          summary: item.analysis?.summary || "",
          confidence: item.analysis?.confidence || "",
          limitations: item.analysis?.limitations || "",
          possibleCauses: item.analysis?.possibleCauses || [],
          verificationSteps: item.analysis?.verificationSteps || [],
          recommendedActions: item.analysis?.recommendedActions || [],
          finalVerdict: item.analysis?.finalVerdict || item.analysis?.dataSideVerdict || "",
          dataSideVerdict: item.analysis?.dataSideVerdict || "",
          notificationAction: item.analysis?.notificationAction || "",
          chartVisibility: item.analysis?.chartVisibility === "hide_verified_normal" ? "hide_verified_normal" : "show",
          verificationReason: item.analysis?.chartVisibility === "hide_verified_normal" ? item.analysis?.verificationReason || "" : "",
        }));
      return { runId, items };
    },

    async getMetabaseAnomalyAnalysesForRun(filters = {}) {
      const runId = String(filters.runId || "").trim();
      if (!runId) throw badRequest("Invalid Metabase anomaly analyses request", ["请提供巡检记录。"]);
      const cache = await readJsonFile(resolve("metabaseAnomalyAnalyses"), DEFAULT_METABASE_ANOMALY_ANALYSES);
      return { runId, analyses: (cache.analyses || []).filter((item) => String(item.runId || "") === runId) };
   },

   async diagnoseMetabaseAnomalyAgent() {
      const settings = getMetabaseAnomalyAgentSettings();
      const batchUrl = (settings.n8nBatchWebhookUrl || settings.n8nWebhookUrl).replace(
        "/webhook/metabase-anomaly-evidence-batch",
        "/webhook/metabase-anomaly-evidence-agent",
      );
      let n8nReachable = false;
      let n8nError = null;
      let n8nHttpStatus = null;
      const n8nTestUrl = batchUrl ? String(batchUrl).replace(/\/webhook\//, "/webhook-test/").replace(/\/webhook$/, "/webhook-test") : "";
      try {
        if (batchUrl) {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5_000);
          const response = await fetchCompatible(batchUrl, {
            method: "GET",
            headers: { Accept: "application/json" },
            signal: controller.signal,
          }).catch((err) => {
            n8nError = String(err?.message || err);
            throw err;
          });
          clearTimeout(timeout);
          n8nHttpStatus = response.status;
          n8nReachable = true;
          if (response.status === 404) {
            n8nError = "n8n 主机可达，但该 webhook 路径返回 404；请确认工作流已激活，并核对 metabase-anomaly-evidence-agent / metabase-anomaly-dynamic-evidence-agent 路径。";
          }
        }
      } catch (err) {
        n8nError = n8nError || String(err?.message || err);
      }
      const cache = await readJsonFile(resolve("metabaseAnomalyAnalyses"), DEFAULT_METABASE_ANOMALY_ANALYSES);
      const recent = (cache.analyses || []).slice(0, 20).map((item) => ({
        key: item.key,
        status: item.status,
        runId: String(item.runId || "").slice(0, 20),
        countryCode: item.countryCode,
        anomalyIndex: item.anomalyIndex,
        jobId: String(item.jobId || "").slice(0, 20),
        provider: item.provider,
        error: item.error || null,
        createdAt: item.createdAt,
        completedAt: item.completedAt || null,
      }));
      const statusCounts = (cache.analyses || []).reduce((acc, item) => {
        acc[item.status] = (acc[item.status] || 0) + 1;
        return acc;
      }, {});
      return {
        timestamp: new Date().toISOString(),
        settings: {
          enabled: settings.enabled,
          configured: settings.configured,
          transport: settings.transport,
          n8nAsync: settings.n8nAsync,
          n8nWebhookUrl: settings.n8nWebhookUrl,
          n8nBatchWebhookUrl: settings.n8nBatchWebhookUrl,
          hasN8nToken: Boolean(settings.n8nToken),
          callbackUrl: settings.callbackUrl,
          hasCallbackToken: Boolean(settings.callbackToken),
          requestedMode: settings.requestedMode,
        },
        n8nConnectivity: {
          reachable: n8nReachable,
          httpStatus: n8nHttpStatus,
          error: n8nError,
          testedUrl: batchUrl,
        },
        analysisStats: {
          total: (cache.analyses || []).length,
          byStatus: statusCounts,
        },
        recentAnalyses: recent,
      };
    },

   async startRerunMetabaseAnomalyAnalysis(body = {}) {
      const historyRunId = String(body.historyRunId || body.runId || "").trim();
      const history = await readJsonFile(resolve("batchHistory"), DEFAULT_BATCH_HISTORY);
      const entry = (history.runs || []).find((item) => String(item.id || "") === historyRunId);
      if (!entry) throw badRequest("History run not found", ["未找到该历史巡检记录。"]);
      const countries = (entry.runs || []).filter((item) => item.ok && item.result?.anomalies?.length).map((item) => ({ countryCode: item.countryCode, countryName: item.countryName, enabled: true }));
      if (!countries.length) throw badRequest("No anomalies to analyze", ["该历史巡检记录没有可分析的异常。"]);
      const progressId = `rerun-${randomUUID()}`;
      batchScheduleRunProgress = createBatchScheduleRunProgress({ id: progressId, trigger: `rerun:${historyRunId}`, startedAt: new Date().toISOString(), countryConfigs: countries });
      batchScheduleRunProgress = { ...batchScheduleRunProgress, status: "ai_analyzing", completedCountries: countries.length, countries: countries.map((item) => ({ ...item, status: "success" })), stages: batchScheduleRunProgress.stages.map((stage) => stage.key === "country_scan" || stage.key === "data_check" ? { ...stage, status: "success", detail: "复用历史巡检结果" } : stage) };
      const analysisRunId = `rerun-${randomUUID()}`;
      void this.rerunMetabaseAnomalyAnalysis({ historyRunId, targetRunId: analysisRunId }).then((result) => {
        batchScheduleRunProgress = { ...batchScheduleRunProgress, status: "success", finishedAt: new Date().toISOString(), result: result.queueResult || {} };
        batchScheduleRunProgress = updateBatchScheduleRunProgressStage(batchScheduleRunProgress, "finished", { status: "success", detail: "历史 AI 分析完成" });
      }).catch((error) => {
        batchScheduleRunProgress = { ...batchScheduleRunProgress, status: "failed", error: error.message, finishedAt: new Date().toISOString() };
      });
      return { started: true, progressId, runId: analysisRunId, historyRunId };
    },

   async rerunMetabaseAnomalyAnalysis(body = {}) {
      const historyRunId = String(body.historyRunId || body.runId || "").trim();
      if (!historyRunId) throw badRequest("Invalid rerun request", ["请提供历史巡检记录 ID。"]);
      const history = await readJsonFile(resolve("batchHistory"), DEFAULT_BATCH_HISTORY);
      const entry = (history.runs || []).find((item) => String(item.id || "") === historyRunId);
      if (!entry) throw badRequest("History run not found", ["未找到该历史巡检记录。"]);
      const countryRuns = (entry.runs || []).filter((item) => item.ok && item.result?.anomalies?.length);
      if (!countryRuns.length) throw badRequest("No anomalies to analyze", ["该历史巡检记录没有可分析的异常。"]);
      const runId = String(body.targetRunId || `rerun-${randomUUID()}`);
      const startedAt = new Date().toISOString();
      const schedule = { intervalMinutes: null };
      const detailUrl = buildBatchHistoryDetailUrl(runId);
      const wattrelSummary = entry.wattrelSummary || null;
      const dsSchedulerSummary = entry.dsSchedulerSummary || null;
      const countriesConfig = await readJsonFile(resolve("countries"), { countries: [] });
      const countryConfigs = (countriesConfig.countries || []).map((item) => ({ countryCode: item.code, countryName: item.name, enabled: true }));
      const result = await this.finalizeAiFirstMetabasePatrol({
        runId, startedAt, countryRuns, countryConfigs, schedule, detailUrl, wattrelSummary, dsSchedulerSummary, dsSchedulerError: null, trigger: `rerun:${historyRunId}`,
      });
      return { runId, historyRunId, ...result };
    },

   async getMetabaseAnomalyEvidenceSnapshot(body = {}) {
      const runId = String(body.runId || body.historyRunId || "").trim();
      const countryCode = normalizeCountryCode(body.countryCode);
      const anomalyIndex = body.anomalyIndex === undefined || body.anomalyIndex === null || body.anomalyIndex === "" ? null : Number(body.anomalyIndex);
      if (!runId || !countryCode || (anomalyIndex !== null && (!Number.isInteger(anomalyIndex) || anomalyIndex < 0))) {
        throw badRequest("Invalid Metabase anomaly evidence snapshot identity", ["请提供巡检记录、国家，以及可选的异常序号。"]);
      }
      const snapshotId = String(body.snapshotId || "").trim();
      if (!snapshotId) return { complete: false, missing: ["snapshotId"] };
      const snapshots = await readJsonFile(resolve("metabaseAnomalyEvidenceSnapshots"), DEFAULT_METABASE_ANOMALY_EVIDENCE_SNAPSHOTS);
      const snapshot = (snapshots.snapshots || []).find((item) => item.snapshotId === snapshotId
        && item.runId === runId && item.countryCode === countryCode
        && (anomalyIndex === null || item.anomalyIndex === undefined || item.anomalyIndex === anomalyIndex));
      if (!snapshot) return { complete: false, missing: ["current_snapshot"] };
      const ttlMs = getMetabaseAnomalyAccelerationSettings().snapshotTtlSeconds * 1000;
      if (!snapshot.collectedAt || Date.now() - Date.parse(snapshot.collectedAt) > ttlMs) {
        return { complete: false, missing: ["fresh_snapshot"] };
      }
      return { complete: Boolean(snapshot.complete), snapshotId, collectedAt: snapshot.collectedAt, evidence: snapshot.evidence || {}, missing: snapshot.missing || [] };
    },

    async saveMetabaseAnomalyEvidenceSnapshot(body = {}) {
      const { runId, countryCode, anomalyIndex } = normalizeMetabaseAnalysisIdentity(body);
      const snapshotId = String(body.snapshotId || "").trim();
      if (!/^[A-Za-z0-9._:-]{8,128}$/.test(snapshotId)) {
        throw badRequest("Invalid Metabase anomaly evidence snapshot", ["snapshotId 格式不正确。"]);
      }
      const { anomaly } = await findMetabasePatrolAnomaly({ runId, countryCode, anomalyIndex });
      if (!anomaly) {
        throw badRequest("Invalid Metabase anomaly evidence snapshot", ["快照必须绑定现有巡检异常。"]);
      }
      const snapshot = {
        snapshotId, runId, countryCode, anomalyIndex,
        collectedAt: new Date().toISOString(),
        complete: body.complete === true,
        evidence: body.evidence && typeof body.evidence === "object" ? body.evidence : {},
        missing: Array.isArray(body.missing) ? body.missing.filter((item) => typeof item === "string").slice(0, 20) : [],
      };
      await updateJsonAtomic(resolve("metabaseAnomalyEvidenceSnapshots"), DEFAULT_METABASE_ANOMALY_EVIDENCE_SNAPSHOTS, (store) => ({
        updatedAt: snapshot.collectedAt,
        snapshots: [snapshot, ...(store.snapshots || []).filter((item) => item.snapshotId !== snapshotId)].slice(0, 500),
      }));
      return { success: true, snapshotId, complete: snapshot.complete };
    },

    async getMetabaseAnomalyCardSql(body = {}) {
      const { runId, countryCode, anomalyIndex } = normalizeMetabaseAnalysisIdentity(body);
      const { anomaly } = await findMetabasePatrolAnomaly({ runId, countryCode, anomalyIndex });
      if (!anomaly?.cardId) {
        throw badRequest("Metabase anomaly card is unavailable", ["该异常没有可读取的 Card ID。"]);
      }
      // Dashboard links are commonly public URLs behind SSO. Card metadata must
      // always use the same internal Metabase API endpoint as the scanner.
      const baseUrl = resolveInternalMetabaseApiBaseUrl(getMetabaseBaseUrl(anomaly.dashboardUrl));
      const card = await metabaseInternalClientFactory(baseUrl).getCard(anomaly.cardId);
      return {
        success: true,
        card: {
          id: card.id || anomaly.cardId,
          name: card.name || anomaly.cardTitle || "",
          database_id: card.database_id || null,
          dataset_query: card.dataset_query || null,
          native_query: card.native_query || null,
        },
      };
    },

    async completeMetabaseAnomalyAnalysis(body = {}) {
      const { runId, countryCode, anomalyIndex, key } = normalizeMetabaseAnalysisIdentity(body);
      if (!body.analysis || typeof body.analysis !== "object") {
        throw badRequest("Invalid Metabase anomaly analysis callback", ["回调必须包含结构化 analysis 结果。"]);
      }
      const entryKey = key || `${runId}:${countryCode}:${anomalyIndex}`;
      let completed = null;
      await updateJsonAtomic(resolve("metabaseAnomalyAnalyses"), DEFAULT_METABASE_ANOMALY_ANALYSES, async (cache) => {
        const existing = (cache.analyses || []).find((item) => item.key === entryKey);
        if (!existing) {
          // A fast n8n workflow can post its result before the pending record.
          const { anomaly } = await findMetabasePatrolAnomaly({ runId, countryCode, anomalyIndex });
          if (!anomaly) {
            const error = new Error("分析任务不存在或历史记录已清理。");
            error.statusCode = 404;
            throw error;
          }
          completed = buildCompletedMetabaseAnalysis({
            key: entryKey, runId, countryCode, anomalyIndex, jobId: body.jobId, body,
            createdAt: new Date().toISOString(), callbackReceivedBeforePending: true,
          });
        } else {
          if (existing.jobId && String(body.jobId || "") !== String(existing.jobId)) {
            console.error(`[metabase-anomaly] callback jobId mismatch: key=${entryKey} expected=${existing.jobId} actual=${body.jobId || ""} batchId=${existing.batchId || ""}`);
            throw badRequest("Invalid Metabase anomaly analysis callback", ["回调任务编号与待处理任务不一致。"]);
          }
          completed = buildCompletedMetabaseAnalysis({
            ...existing, key: entryKey, runId, countryCode, anomalyIndex,
            jobId: body.jobId || existing.jobId, body, createdAt: existing.createdAt,
          });
        }
        return {
          updatedAt: new Date().toISOString(),
          analyses: keepRecentMetabaseAnalyses([completed, ...(cache.analyses || []).filter((item) => item.key !== entryKey)]),
        };
      });
      return completed;
    },

    async completeMetabaseAnomalyBatch(body = {}) {
      const runId = String(body.runId || "").trim();
      const countryCode = normalizeCountryCode(body.countryCode);
      const jobId = String(body.jobId || "").trim();
      const results = Array.isArray(body.results) ? body.results : [];
      console.error(`[metabase-anomaly] batch-callback received: runId=${runId} country=${countryCode} jobId=${jobId.slice(0,20)} results=${results.length}`);
      if (!runId || !countryCode || !jobId || results.length === 0 || results.length > 100) {
        throw badRequest("Invalid Metabase anomaly batch callback", ["批量回调必须包含 runId、countryCode、jobId 和 1-100 条结果。"]);
      }
      const indexes = results.map((item) => Number(item?.anomalyIndex));
      if (indexes.some((index) => !Number.isInteger(index) || index < 0) || new Set(indexes).size !== indexes.length) {
        throw badRequest("Invalid Metabase anomaly batch callback", ["批量回调中的异常序号必须唯一且有效。"]);
      }
      const completed = [];
      for (const result of results) {
        if (!result?.analysis || typeof result.analysis !== "object") {
          throw badRequest("Invalid Metabase anomaly batch callback", ["批量回调的每条结果必须包含 analysis。"]);
        }
        completed.push(await this.completeMetabaseAnomalyAnalysis({
          ...result,
          runId,
          countryCode,
          jobId,
        }));
      }
      return { success: true, runId, countryCode, jobId, results: completed };
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
      await appendHistoryEntry(entry);
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
      batchScheduleStopRequested = false;
      batchScheduleAbortController = new AbortController();
      batchScheduleRunProgress = createBatchScheduleRunProgress({
        id: historyRunId,
        trigger: "manual_test",
        startedAt,
        countryConfigs: enabledCountryConfigs,
      });
      try {
        const countryRuns = await runScheduledCountryChecks(enabledCountryConfigs, (body) => this.runBatchCheck({ ...body, signal: batchScheduleAbortController.signal }), (event) => {
          batchScheduleRunProgress = updateBatchScheduleRunProgress(batchScheduleRunProgress, event);
        }, 1, () => batchScheduleStopRequested);
        if (batchScheduleStopRequested) throw new Error("巡检已由用户停止");
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
        let hiveSchedulerSummary = null;
        let hiveSchedulerError = null;
        try {
          hiveSchedulerSummary = await runIntegratedHiveCheck(schedule);
        } catch (error) {
          hiveSchedulerError = error.message;
        }
        batchScheduleRunProgress = updateBatchScheduleRunProgressStage(batchScheduleRunProgress, "data_check", {
          status: dsSchedulerError || hiveSchedulerError ? "partial_failed" : "success",
          detail: [
            dsSchedulerError ? `DS 失败：${dsSchedulerError}` : schedule.includeDsScheduler ? "DS 调度核查完成" : "未启用 DS",
            hiveSchedulerError ? `HIVE 失败：${hiveSchedulerError}` : schedule.includeHiveScheduler ? "HIVE 调度核查完成" : "未启用 HIVE",
          ].join("；"),
        });
        if (aiFirstMetabasePatrolEnabled) {
          const aiFirst = await this.finalizeAiFirstMetabasePatrol({
            runId: historyRunId, startedAt, countryRuns, countryConfigs: enabledCountryConfigs, schedule, detailUrl,
            wattrelSummary, dsSchedulerSummary, dsSchedulerError, trigger: "manual_test",
          });
          const finalizedRuns = aiFirst.countryRuns;
          const failedRuns = finalizedRuns.filter((item) => !item.ok);
          const lastResult = { ...summarizeCountryScheduleRuns(finalizedRuns, { wattrelSummary }), dsSchedulerSummary, dsSchedulerError, hiveSchedulerSummary, hiveSchedulerError };
          const saved = {
            ...schedule, lastRunAt: startedAt, nextRunAt,
            lastError: [failedRuns.map((item) => `${item.countryCode}: ${item.error}`).join("; "), dsSchedulerError ? `DS: ${dsSchedulerError}` : "", hiveSchedulerError ? `HIVE: ${hiveSchedulerError}` : ""].filter(Boolean).join("; ") || null,
            lastResult,
          };
          await writeJsonAtomic(resolve("batchSchedule"), saved);
          await appendHistoryEntry(buildBatchHistoryEntry({
            trigger: "manual_test", id: historyRunId, startedAt, finishedAt: new Date().toISOString(), nextRunAt, schedule,
            countryRuns: finalizedRuns, notificationSentCount: aiFirst.notificationSentCount, wattrelSummary, dsSchedulerSummary, dsSchedulerError, hiveSchedulerSummary, hiveSchedulerError,
          }));
          await this.removePendingMetabasePatrolRun(historyRunId);
          batchScheduleRunProgress = updateBatchScheduleRunProgressStage(batchScheduleRunProgress, "finished", { status: failedRuns.length || dsSchedulerError || hiveSchedulerError ? "partial_failed" : "success", detail: "AI 取证、最终通知和历史记录已完成" });
          batchScheduleRunProgress = { ...batchScheduleRunProgress, status: failedRuns.length || dsSchedulerError || hiveSchedulerError ? "partial_failed" : "success", finishedAt: new Date().toISOString(), result: lastResult, notificationSentCount: aiFirst.notificationSentCount };
          return { ran: true, schedule: saved, result: lastResult, agentTriggerResult: aiFirst.queueResult };
        }
        batchScheduleRunProgress = updateBatchScheduleRunProgressStage(batchScheduleRunProgress, "notification", {
          status: "running",
          detail: "正在汇总异常并发送通知",
        });
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
          hiveSchedulerSummary,
          hiveSchedulerError,
        };
        const saved = {
          ...schedule,
          lastRunAt: startedAt,
          nextRunAt,
          lastError: [failedRuns.map((item) => `${item.countryCode}: ${item.error}`).join("; "), dsSchedulerError ? `DS: ${dsSchedulerError}` : "", hiveSchedulerError ? `HIVE: ${hiveSchedulerError}` : ""].filter(Boolean).join("; ") || null,
          lastResult,
        };
        batchScheduleRunProgress = updateBatchScheduleRunProgressStage(batchScheduleRunProgress, "notification", {
          status: "success",
          detail: notificationSentCount ? `已发送 ${notificationSentCount} 条通知` : "无异常通知，已跳过发送",
        });
        batchScheduleRunProgress = {
          ...batchScheduleRunProgress,
          status: "ai_analyzing",
          finalStatus: failedRuns.length || dsSchedulerError || hiveSchedulerError ? "partial_failed" : "success",
          finishedAt: new Date().toISOString(),
          result: saved.lastResult,
          notificationSentCount,
        };
        await writeJsonAtomic(resolve("batchSchedule"), saved);
        await appendHistoryEntry(buildBatchHistoryEntry({
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
          hiveSchedulerSummary,
          hiveSchedulerError,
        }));
        const agentTriggerResult = await this.dispatchDashboardGroupedAnalysis(historyRunId, countryRuns, (event) => {
          batchScheduleRunProgress = updateBatchScheduleAiProgress(batchScheduleRunProgress, event);
        });
        return { ran: true, schedule: saved, result: saved.lastResult, agentTriggerResult };
      } catch (error) {
        const stopped = batchScheduleStopRequested;
        batchScheduleRunProgress = {
          ...(batchScheduleRunProgress || {}),
          status: stopped ? "stopped" : "failed",
          error: error.message,
          finishedAt: new Date().toISOString(),
        };
        const saved = stopped ? {
          ...schedule,
          nextRunAt,
          lastManualTestAt: startedAt,
          lastManualTestStatus: "stopped",
          lastManualTestError: "巡检已由用户手动停止",
        } : {
          ...schedule,
          lastRunAt: startedAt,
          nextRunAt,
          lastError: error.message,
          lastResult: null,
          lastManualTestAt: startedAt,
          lastManualTestStatus: "failed",
          lastManualTestError: error.message,
        };
        await writeJsonAtomic(resolve("batchSchedule"), saved);
        await appendHistoryEntry({
          id: historyRunId,
          trigger: "manual_test",
          startedAt,
          finishedAt: new Date().toISOString(),
          nextRunAt,
          status: stopped ? "stopped" : "failed",
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
        batchScheduleAbortController = null;
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

      const sourcePath = runtimePanelSourceFilePath(rootDir, countryCode);
      const source = await readJsonFile(sourcePath, {});
      const panels = Array.isArray(source.panels) ? source.panels : [];
      const normalizedUrl = dashboardUrlIdentity(url);
      const existing = panels.find((panel) => (panel.links || []).some((link) => dashboardUrlIdentity(link.url) === normalizedUrl));
      const panel = {
        ...(existing || {}),
        id: existing?.id || `manual:${randomUUID()}`,
        title,
        type: "manual_metabase",
        manual: true,
        pendingDiscovery: true,
        links: [{ url }],
      };
      const pendingDashboard = panelSourceToDashboard({
        countryCode: country.code,
        countryName: country.name,
        timezone: country.timezone,
      }, panel);
      const remainingSourceDeletions = removeDashboardDeletionForDashboard(source.deletedDashboards || [], pendingDashboard);
      if (!existing || existing.title !== panel.title || remainingSourceDeletions.length !== (source.deletedDashboards || []).length) {
        await writeJsonAtomic(sourcePath, {
          ...source,
          country: source.country || { code: country.code, name: country.name, timezone: country.timezone },
          panels: existing ? panels.map((item) => item === existing ? panel : item) : [...panels, panel],
          deletedDashboards: remainingSourceDeletions,
        });
      }

      // Deletion tombstones keep removed dashboards out of future scans. A
      // deliberate re-add of the same URL is an explicit opt-in, so clear
      // only the tombstone matching this dashboard from both runtime stores.
      const inventoryPath = runtimeCountryInventoryFilePath(rootDir, countryCode);
      const runtimeInventory = await readJsonFile(inventoryPath, {});
      const remainingInventoryDeletions = removeDashboardDeletionForDashboard(runtimeInventory.deletedDashboards || [], pendingDashboard);
      if (remainingInventoryDeletions.length !== (runtimeInventory.deletedDashboards || []).length) {
        await writeJsonAtomic(inventoryPath, {
          ...runtimeInventory,
          deletedDashboards: remainingInventoryDeletions,
          updatedAt: new Date().toISOString(),
        });
      }
      return pendingDashboard;
    },

    async deleteDashboard({ countryCode: countryCodeInput, dashboardUuid = "", sourcePanelId = "", dashboardId = "", url = "" } = {}) {
      const countryCode = String(countryCodeInput || "").trim().toUpperCase();
      if (!countryCode) {
        throw badRequest("Invalid dashboard deletion", ["请选择需要删除的国家。"]);
      }
      const [countries, readyInventory] = await Promise.all([
        readJsonFile(resolve("countries"), { countries: [] }),
        readPlatformInventory(rootDir, resolve("inventory")),
      ]);
      const panelSources = await loadPanelSources(rootDir, countries.countries || [], { countryCode });
      const inventory = mergeDashboardSources(readyInventory, panelSources);
      const dashboard = (inventory.dashboards || []).find((item) => (
        getDashboardCountryCode(item) === countryCode
        && dashboardMatchesDeleteRequest(item, { countryCode, dashboardUuid, sourcePanelId, dashboardId, url })
      ));
      if (!dashboard) {
        throw badRequest("Dashboard not found", ["未找到该看板，请刷新页面后重试。"]);
      }

      const deletion = buildDashboardDeletionRef(dashboard);
      const sourcePath = runtimePanelSourceFilePath(rootDir, countryCode);
      const source = await readJsonFile(sourcePath, {});
      const panels = (source.panels || []).filter((panel) => !panelMatchesDeletion(panel, deletion));
      const deletedDashboards = appendUniqueDashboardDeletions(source.deletedDashboards || [], [deletion]);
      await writeJsonAtomic(sourcePath, {
        ...source,
        country: source.country || dashboard.country || { code: countryCode, name: dashboard.countryName || countryCode, timezone: dashboard.timezone },
        panels,
        deletedDashboards,
      });

      const inventoryPath = runtimeCountryInventoryFilePath(rootDir, countryCode);
      let runtimeInventory = null;
      try {
        runtimeInventory = await readJsonFile(inventoryPath, null);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const runtimeDashboards = runtimeInventory
        ? (runtimeInventory.dashboards || [])
        : (readyInventory.dashboards || []).filter((item) => getDashboardCountryCode(item) === countryCode);
      await writeJsonAtomic(inventoryPath, {
        ...(runtimeInventory || {}),
        country: runtimeInventory?.country || dashboard.country || { code: countryCode, name: dashboard.countryName || countryCode, timezone: dashboard.timezone },
        dashboards: runtimeDashboards.filter((item) => !dashboardMatchesDeletion(item, deletion)),
        deletedDashboards: appendUniqueDashboardDeletions(runtimeInventory?.deletedDashboards || [], [deletion]),
        updatedAt: new Date().toISOString(),
      });

      return {
        ok: true,
        countryCode,
        dashboardUuid: dashboard.uuid || "",
        dashboardId: dashboard.dashboardId || "",
        sourcePanelId: dashboard.sourcePanelId || "",
        title: dashboard.title || dashboard.sourcePanelTitle || "",
      };
    },

    async discoverManualDashboard({ countryCode: countryCodeInput, sourcePanelId } = {}) {
      const countryCode = String(countryCodeInput || "").trim().toUpperCase();
      const panelId = String(sourcePanelId || "").trim();
      const countries = await readJsonFile(resolve("countries"), { countries: [] });
      const country = (countries.countries || []).find((item) => String(item.code || "").toUpperCase() === countryCode);
      if (!country || !panelId) {
        throw badRequest("Invalid dashboard", ["请选择需要发现卡片的看板。"]);
      }
      const source = await readMergedPanelSource(rootDir, countryCode);
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
        throw dashboardDiscoveryFailed(error);
      } finally {
        await fs.rm(temporaryInputFile, { force: true });
      }
      if ((rawDiscovered.sourceErrors || []).length > 0) {
        throw dashboardDiscoveryFailed(rawDiscovered.sourceErrors.map((item) => item.error).filter(Boolean).join("；"));
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
      const executableDiscovered = discovered.filter((dashboard) => (dashboard.cards || []).length > 0);
      if (executableDiscovered.length === 0) {
        throw badRequest("Dashboard discovery failed", [
          "错误类型：未发现可巡检卡片。请确认链接指向 Metabase 看板、当前服务账号有访问权限，且看板中至少有一张可查询卡片。",
        ]);
      }
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
      const outputFile = runtimeCountryInventoryFilePath(rootDir, countryCode);
      const discoveredAt = new Date().toISOString();
      await writeJsonAtomic(outputFile, { ...merged, discoveredAt });
      const runtimeSourcePath = runtimePanelSourceFilePath(rootDir, countryCode);
      const runtimeSource = await readJsonFile(runtimeSourcePath, {});
      const runtimePanels = Array.isArray(runtimeSource.panels) ? runtimeSource.panels : [];
      const pendingPanelIndex = runtimePanels.findIndex((item) => String(item.id) === panelId);
      if (pendingPanelIndex >= 0 && runtimePanels[pendingPanelIndex].pendingDiscovery === true) {
        await writeJsonAtomic(runtimeSourcePath, {
          ...runtimeSource,
          panels: runtimePanels.map((item, index) => index === pendingPanelIndex ? {
            ...item,
            pendingDiscovery: false,
          } : item),
        });
      }
      return {
        ok: true,
        countryCode,
        sourcePanelId: panel.id,
        discoveredAt,
        discoveredDashboardCount: discovered.length,
        executableDashboardCount: executableDiscovered.length,
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
      const outputFile = runtimeCountryInventoryFilePath(rootDir, countryCode);
      await writeJsonAtomic(outputFile, { ...discovered, discoveredAt });
      return {
        ok: true,
        countryCode,
        discoveredAt,
        discoveredDashboardCount: (discovered.dashboards || []).length,
        executableDashboardCount: (discovered.dashboards || []).filter((item) => (item.cards || []).length > 0).length,
      };
    },

    async discoverAllCountryDashboards({ onProgress } = {}) {
      const countries = await readJsonFile(resolve("countries"), { countries: [] });
      const results = [];
      const progressItems = (runningCountry = null) => results.map((item) => ({
        ...item,
        countryName: (countries.countries || []).find((country) => String(country.code || "").toUpperCase() === item.countryCode)?.name || item.countryCode,
        status: item.ok ? (item.skipped ? "skipped" : "success") : "failed",
      })).concat(runningCountry ? [{
        countryCode: runningCountry.code,
        countryName: runningCountry.name || runningCountry.code,
        status: "running",
      }] : []);
      for (const country of countries.countries || []) {
        const countryCode = String(country.code || "").toUpperCase();
        onProgress?.({
          phase: "running",
          currentCountryCode: countryCode,
          countries: progressItems({ code: countryCode, name: country.name || countryCode }),
        });
        try {
          if (await isCountryInventoryFullyDiscovered(rootDir, country.code)) {
            results.push({ ok: true, skipped: true, countryCode });
            onProgress?.({ phase: "running", currentCountryCode: "", countries: progressItems() });
            continue;
          }
          const discovered = await this.discoverCountryDashboards(country.code);
          results.push(discovered);
        } catch (error) {
          results.push({
            ok: false,
            countryCode,
            error: error.errors?.join("；") || error.message,
          });
        }
        onProgress?.({ phase: "running", currentCountryCode: "", countries: progressItems() });
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
        currentCountryCode: "",
        countries: [],
      };
      const completed = this.discoverAllCountryDashboards({
        onProgress: ({ currentCountryCode, countries }) => {
          dashboardDiscoveryProgress = {
            ...dashboardDiscoveryProgress,
            status: "running",
            currentCountryCode,
            countries,
          };
        },
      })
        .then((result) => {
          dashboardDiscoveryProgress = {
            status: "completed",
            result,
            error: null,
            startedAt: dashboardDiscoveryProgress.startedAt,
            finishedAt: new Date().toISOString(),
            currentCountryCode: "",
            countries: (result.results || []).map((item) => ({
              ...item,
              status: item.ok ? (item.skipped ? "skipped" : "success") : "failed",
            })),
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
            currentCountryCode: "",
            countries: dashboardDiscoveryProgress.countries || [],
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
      // Pass the client factory rather than a private queryCardFn: this used to
      // duplicate the monitor's query logic, which meant the stale-dashcard
      // remap never ran on the batch-check path and the missing-auth check
      // compared against the wrong factory.
      const result = await checkPublicDashboards({
        signal: body.signal,
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
        metabaseClientFactory,
      });
      // Persist default tags as soon as a scan finds a drawable fluctuation.
      // History persistence repeats this safely, but manual checks do not always
      // create a history record and must still initialize their tag rows.
      try {
        await fluctuationMetricTagStore.ensureIdentities(collectFluctuationMetricTagIdentities(buildTagSyncRun(result)));
      } catch (error) {
        console.error(`[fluctuation-metric-tags] scan sync failed: ${error.message}`);
      }
      return result;
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

    async triggerDashboardGroupedAnalysis(historyRunId, countryRuns, onProgress = null) {
      const settings = getMetabaseAnomalyAgentSettings();
      const acceleration = getMetabaseAnomalyAccelerationSettings();
      const autoTrigger = String(process.env.METABASE_ANOMALY_AGENT_AUTO_TRIGGER || "1").trim().toLowerCase();
      if (autoTrigger === "0" || autoTrigger === "false" || autoTrigger === "off" || autoTrigger === "no") {
        onProgress?.({ type: "skipped", reason: "已关闭自动 AI 分析" });
        return { triggered: 0, reason: "auto-trigger disabled" };
      }
      if (!settings.enabled) {
        onProgress?.({ type: "skipped", reason: "未配置 Dify Agent" });
        return { triggered: 0, reason: "agent not configured" };
      }
      // A dashboard may produce several independent metric/dimension anomalies.
      // The Agent gets sameDashboardAnomalies as shared context, but every
      // anomaly still needs its own task, callback cache entry and verdict.
      const anomalyJobs = [];
      const dashboardKeys = new Set();
      for (const run of countryRuns) {
        if (!run.ok || !run.result?.anomalies) continue;
        for (let i = 0; i < run.result.anomalies.length; i++) {
          const anomaly = run.result.anomalies[i];
          const dashboardKey = `${run.countryCode}:${anomaly.dashboardUuid || anomaly.dashboardTitle || "unknown"}`;
          dashboardKeys.add(dashboardKey);
          anomalyJobs.push({
            jobKey: `${dashboardKey}:${i}`,
            dashboardKey,
            countryCode: run.countryCode,
            anomalyIndex: i,
            dashboardTitle: anomaly.dashboardTitle || "",
            cardTitle: anomaly.cardTitle || "",
          });
        }
      }
      let triggered = 0;
      const skipped = [];
      const totalAnomalies = anomalyJobs.length;
      const totalDashboards = dashboardKeys.size;
      if (!totalAnomalies) {
        onProgress?.({ type: "skipped", reason: "本次没有需要取证的异常看板" });
        return { triggered: 0, totalAnomalies: 0, totalDashboards: 0, skipped, acceleration: acceleration.enabled ? { enabled: true, maxConcurrency: acceleration.maxConcurrency } : undefined };
      }
      onProgress?.({ type: "queued", totalAnomalies, totalDashboards });
      const analyzeAnomaly = async (job) => {
        onProgress?.({ type: "start", jobKey: job.jobKey, job, totalAnomalies, totalDashboards, completed: triggered + skipped.length });
        try {
          const analysis = await this.analyzeMetabaseAnomaly({
            runId: historyRunId,
            countryCode: job.countryCode,
            anomalyIndex: job.anomalyIndex,
            force: false,
          });
          triggered += 1;
          onProgress?.({ type: analysis.pending ? "submitted" : "completed", jobKey: job.jobKey, job, totalAnomalies, totalDashboards, completed: triggered + skipped.length });
        } catch (error) {
          skipped.push({ jobKey: job.jobKey, error: error.message });
          onProgress?.({ type: "failed", jobKey: job.jobKey, job, totalAnomalies, totalDashboards, completed: triggered + skipped.length, error: error.message });
        }
      };
      if (acceleration.enabled) {
        const queue = createBoundedTaskQueue({ concurrency: acceleration.maxConcurrency });
        await Promise.all(anomalyJobs.map((job) => queue.add(() => analyzeAnomaly(job))));
      } else {
        for (const job of anomalyJobs) {
          await analyzeAnomaly(job);
        }
      }
      const result = { triggered, totalAnomalies, totalDashboards, skipped, acceleration: acceleration.enabled ? { enabled: true, maxConcurrency: acceleration.maxConcurrency } : undefined };
      onProgress?.({ type: "finished", result });
      return result;
    },

    dispatchDashboardGroupedAnalysis(historyRunId, countryRuns, onProgress = null) {
      const acceleration = getMetabaseAnomalyAccelerationSettings();
      if (!acceleration.enabled) {
        return this.triggerDashboardGroupedAnalysis(historyRunId, countryRuns, onProgress);
      }
      // A patrol has already persisted its history and notifications at this point.
      // Do not hold its completion state hostage to long-running Agent evidence jobs.
      void this.triggerDashboardGroupedAnalysis(historyRunId, countryRuns, onProgress).catch((error) => {
        console.error(`[metabase-anomaly-acceleration] batch ${historyRunId} dispatch failed: ${error.message}`);
        onProgress?.({ type: "failed", error: error.message });
      });
      return {
        queued: true,
        acceleration: { enabled: true, maxConcurrency: acceleration.maxConcurrency },
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
      batchScheduleStopRequested = false;
      batchScheduleAbortController = new AbortController();
      try {
        const enabledCountryConfigs = schedule.countryConfigs.filter((item) => item.enabled);
        batchScheduleRunProgress = createBatchScheduleRunProgress({
          id: historyRunId,
          trigger: "schedule",
          startedAt,
          countryConfigs: enabledCountryConfigs,
        });
        const countryRuns = await runScheduledCountryChecks(enabledCountryConfigs, (body) => this.runBatchCheck({ ...body, signal: batchScheduleAbortController.signal }), (event) => {
          batchScheduleRunProgress = updateBatchScheduleRunProgress(batchScheduleRunProgress, event);
        }, 1, () => batchScheduleStopRequested);
        if (batchScheduleStopRequested) throw new Error("巡检已由用户停止");
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
        let hiveSchedulerSummary = null;
        let hiveSchedulerError = null;
        try {
          hiveSchedulerSummary = await runIntegratedHiveCheck(schedule);
        } catch (error) {
          hiveSchedulerError = error.message;
        }
        batchScheduleRunProgress = updateBatchScheduleRunProgressStage(batchScheduleRunProgress, "data_check", {
          status: dsSchedulerError || hiveSchedulerError ? "partial_failed" : "success",
          detail: [
            dsSchedulerError ? `DS 失败：${dsSchedulerError}` : schedule.includeDsScheduler ? "DS 调度核查完成" : "未启用 DS",
            hiveSchedulerError ? `HIVE 失败：${hiveSchedulerError}` : schedule.includeHiveScheduler ? "HIVE 调度核查完成" : "未启用 HIVE",
          ].join("；"),
        });
        if (aiFirstMetabasePatrolEnabled) {
          const aiFirst = await this.finalizeAiFirstMetabasePatrol({
            runId: historyRunId, startedAt, countryRuns, countryConfigs: enabledCountryConfigs, schedule, detailUrl,
            wattrelSummary, dsSchedulerSummary, dsSchedulerError, trigger: "schedule",
          });
          const finalizedRuns = aiFirst.countryRuns;
          const failedRuns = finalizedRuns.filter((item) => !item.ok);
          const lastResult = { ...summarizeCountryScheduleRuns(finalizedRuns, { wattrelSummary }), dsSchedulerSummary, dsSchedulerError, hiveSchedulerSummary, hiveSchedulerError };
          const saved = {
            ...schedule, lastRunAt: startedAt, nextRunAt,
            lastError: [failedRuns.map((item) => `${item.countryCode}: ${item.error}`).join("; "), dsSchedulerError ? `DS: ${dsSchedulerError}` : "", hiveSchedulerError ? `HIVE: ${hiveSchedulerError}` : ""].filter(Boolean).join("; ") || null,
            lastResult,
          };
          await writeJsonAtomic(resolve("batchSchedule"), saved);
          await appendHistoryEntry(buildBatchHistoryEntry({
            trigger: "schedule", id: historyRunId, startedAt, finishedAt: new Date().toISOString(), nextRunAt, schedule,
            countryRuns: finalizedRuns, notificationSentCount: aiFirst.notificationSentCount, wattrelSummary, dsSchedulerSummary, dsSchedulerError, hiveSchedulerSummary, hiveSchedulerError,
          }));
          await this.removePendingMetabasePatrolRun(historyRunId);
          batchScheduleRunProgress = updateBatchScheduleRunProgressStage(batchScheduleRunProgress, "finished", { status: failedRuns.length || dsSchedulerError || hiveSchedulerError ? "partial_failed" : "success", detail: "AI 取证、最终通知和历史记录已完成" });
          batchScheduleRunProgress = { ...batchScheduleRunProgress, status: failedRuns.length || dsSchedulerError || hiveSchedulerError ? "partial_failed" : "success", finishedAt: new Date().toISOString(), result: lastResult, notificationSentCount: aiFirst.notificationSentCount };
          return { ran: true, schedule: saved, result: lastResult, agentTriggerResult: aiFirst.queueResult };
        }
        batchScheduleRunProgress = updateBatchScheduleRunProgressStage(batchScheduleRunProgress, "notification", {
          status: "running",
          detail: "正在汇总异常并发送通知",
        });
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
          hiveSchedulerSummary,
          hiveSchedulerError,
        };
        const saved = {
          ...schedule,
          lastRunAt: startedAt,
          nextRunAt,
          lastError: [failedRuns.map((item) => `${item.countryCode}: ${item.error}`).join("; "), dsSchedulerError ? `DS: ${dsSchedulerError}` : "", hiveSchedulerError ? `HIVE: ${hiveSchedulerError}` : ""].filter(Boolean).join("; ") || null,
          lastResult,
        };
        batchScheduleRunProgress = updateBatchScheduleRunProgressStage(batchScheduleRunProgress, "notification", {
          status: "success",
          detail: notificationSentCount ? `已发送 ${notificationSentCount} 条通知` : "无异常通知，已跳过发送",
        });
        batchScheduleRunProgress = {
          ...batchScheduleRunProgress,
          status: "ai_analyzing",
          finalStatus: failedRuns.length || dsSchedulerError || hiveSchedulerError ? "partial_failed" : "success",
          finishedAt: new Date().toISOString(),
          result: saved.lastResult,
          notificationSentCount,
        };
        await writeJsonAtomic(resolve("batchSchedule"), saved);
        await appendHistoryEntry(buildBatchHistoryEntry({
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
          hiveSchedulerSummary,
          hiveSchedulerError,
        }));
        const agentTriggerResult = await this.dispatchDashboardGroupedAnalysis(historyRunId, countryRuns, (event) => {
          batchScheduleRunProgress = updateBatchScheduleAiProgress(batchScheduleRunProgress, event);
        });
        return { ran: true, schedule: saved, result: saved.lastResult, agentTriggerResult };
      } catch (error) {
        const stopped = batchScheduleStopRequested;
        batchScheduleRunProgress = {
          ...(batchScheduleRunProgress || {}),
          status: stopped ? "stopped" : "failed",
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
        await appendHistoryEntry({
          id: historyRunId,
          trigger: "schedule",
          startedAt,
          finishedAt: new Date().toISOString(),
          nextRunAt,
          status: stopped ? "stopped" : "failed",
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
        batchScheduleAbortController = null;
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

    async getHiveSchedulerConfig() {
      const config = await loadHiveSchedulerConfig(rootDir);
      return { ...config, projectStatus: buildHiveProjectStatus(config) };
    },

    async saveHiveSchedulerConfig(input = {}) {
      return saveHiveSchedulerConfig(rootDir, input);
    },

    async checkAllHiveCountries() {
      return checkAllHiveCountries(rootDir, await this.getHiveSchedulerConfig());
    },

    async getHiveSchedule() {
      const stored = await readJsonFile(resolve("hiveSchedule"), DEFAULT_HIVE_SCHEDULE);
      return normalizeHiveSchedule(stored, { preserveNextRunAt: true });
    },

    async saveHiveSchedule(input = {}) {
      const schedule = normalizeHiveSchedule(input);
      await writeJsonAtomic(resolve("hiveSchedule"), schedule);
      return schedule;
    },

    async getHiveHistory(filters = {}) {
      const history = await readJsonFile(resolve("hiveHistory"), DEFAULT_HIVE_HISTORY);
      const limit = Math.max(1, Math.min(200, Number(filters.limit || 50)));
      return { ...history, runs: keepRecentHistoryRuns(history.runs || []).slice(0, limit) };
    },

    async runHiveScheduleNow() {
      if (hiveScheduleRunning || batchScheduleRunning) {
        throw badRequest("HIVE schedule already running", ["HIVE 或定时巡检正在运行中，请等待完成后再试。"]);
      }
      hiveScheduleRunning = true;
      try {
        return await runHiveSchedule({ api: this, schedule: await this.getHiveSchedule(), trigger: "manual", scheduleFile: resolve("hiveSchedule"), historyFile: resolve("hiveHistory") });
      } finally {
        hiveScheduleRunning = false;
      }
    },

    async runDueHiveSchedule(now = new Date()) {
      const schedule = await this.getHiveSchedule();
      if (!schedule.enabled || !schedule.nextRunAt || new Date(schedule.nextRunAt) > now) return { ran: false, schedule };
      if (hiveScheduleRunning) return { ran: false, reason: "already running", schedule };
      if (batchScheduleRunning) return { ran: false, reason: "batch check running", schedule };
      hiveScheduleRunning = true;
      try {
        return await runHiveSchedule({ api: this, schedule, trigger: "schedule", scheduleFile: resolve("hiveSchedule"), historyFile: resolve("hiveHistory"), now });
      } finally {
        hiveScheduleRunning = false;
      }
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

    async getDsFailureLogs(filters = {}) {
      const country = String(filters.country || "").trim().toLowerCase();
      const result = await inspectDsFailureLogs(rootDir, { countries: country || undefined });
      return dsAutoRetryManager?.decorate ? dsAutoRetryManager.decorate(result) : result;
    },

    getDsFailureRetryControl() {
      return dsAutoRetryManager?.control?.() || { enabled: false, startAt: null, countries: [], activeCount: 0, logCount: 0 };
    },

    startDsFailureRetry(input = {}) {
      if (!dsAutoRetryManager?.enable) throw new Error("DS 失败重跑管理器未启用");
      return dsAutoRetryManager.enable(input);
    },

    stopDsFailureRetry() {
      return dsAutoRetryManager?.disable?.() || { enabled: false, startAt: null, countries: [], activeCount: 0, logCount: 0 };
    },

    getDsFailureRetryLogs(filters = {}) {
      return { logs: dsAutoRetryManager?.getLogs?.(filters.limit) || [] };
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
      if (dsScheduleRunning || batchScheduleRunning) {
        throw badRequest("DS schedule already running", ["DS 或定时巡检正在运行中，请等待完成后再试。"]);
      }
      dsScheduleRunning = true;
      try {
        const schedule = await this.getDsSchedule();
        return await runDsSchedule({ api: this, schedule, trigger: "manual", rootDir, scheduleFile: resolve("dsSchedule"), historyFile: resolve("dsHistory") });
      } finally {
        dsScheduleRunning = false;
      }
    },

    async runDueDsSchedule(now = new Date()) {
      const schedule = await this.getDsSchedule();
      if (!schedule.enabled || !schedule.nextRunAt || new Date(schedule.nextRunAt) > now) {
        return { ran: false, schedule };
      }
      if (batchScheduleRunning) {
        return { ran: false, reason: "batch check running", schedule };
      }
      if (dsScheduleRunning) {
        return { ran: false, reason: "already running", schedule };
      }
      dsScheduleRunning = true;
      try {
        return await runDsSchedule({ api: this, schedule, trigger: "schedule", rootDir, scheduleFile: resolve("dsSchedule"), historyFile: resolve("dsHistory"), now });
      } finally {
        dsScheduleRunning = false;
      }
    },
  };
}

function normalizeHiveSchedule(input = {}, { preserveNextRunAt = false } = {}) {
  const enabled = Boolean(input.enabled);
  const intervalMinutes = Math.max(5, Number(input.intervalMinutes || DEFAULT_HIVE_SCHEDULE.intervalMinutes));
  return {
    ...DEFAULT_HIVE_SCHEDULE,
    ...input,
    enabled,
    intervalMinutes,
    nextRunAt: enabled
      ? (preserveNextRunAt && input.nextRunAt ? input.nextRunAt : new Date(Date.now() + intervalMinutes * 60_000).toISOString())
      : null,
  };
}

async function runHiveSchedule({ api, schedule, trigger, scheduleFile, historyFile, now = new Date() }) {
  const startedAt = now.toISOString();
  try {
    const config = await api.getHiveSchedulerConfig();
    const enabledCountries = Object.values(config.countries || {}).filter((item) => item.enabled);
    if (!enabledCountries.length) throw badRequest("No HIVE countries enabled", ["请至少选择一个需要监控的国家，并配置项目。"]);
    const result = await checkAllHiveCountries(null, config);
    result.notification = await notifyHiveSchedulerCheck(config, result);
    const finishedAt = new Date().toISOString();
    const next = {
      ...schedule,
      nextRunAt: nextIntervalRunAt(schedule, trigger),
      lastRunAt: finishedAt,
      lastError: null,
      lastResult: result,
    };
    await writeJsonAtomic(scheduleFile, next);
    await appendHiveHistory(historyFile, { id: randomUUID(), trigger, startedAt, finishedAt, ok: true, result });
    return { ran: true, schedule: next, result };
  } catch (error) {
    const finishedAt = new Date().toISOString();
    await writeJsonAtomic(scheduleFile, { ...schedule, nextRunAt: nextIntervalRunAt(schedule, trigger), lastRunAt: finishedAt, lastError: error.message });
    await appendHiveHistory(historyFile, { id: randomUUID(), trigger, startedAt, finishedAt, ok: false, error: error.message });
    throw error;
  }
}

async function appendHiveHistory(filePath, entry) {
  await updateJsonAtomic(filePath, DEFAULT_HIVE_HISTORY, (history) => ({
    updatedAt: new Date().toISOString(),
    runs: keepRecentHistoryRuns([entry, ...(history.runs || [])]),
  }));
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
  const startedAt = now.toISOString();
  try {
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
    const result = await checkAllCountries(rootDir, scopedConfig);
    result.notification = await notifyDsSchedulerCheck(scopedConfig, result);
    const finishedAt = new Date().toISOString();
    const next = {
      ...schedule,
      nextRunAt: nextIntervalRunAt(schedule, trigger),
      lastRunAt: finishedAt,
      lastError: null,
      lastResult: result,
    };
    await writeJsonAtomic(scheduleFile, next);
    await appendDsHistory(historyFile, { id: randomUUID(), trigger, startedAt, finishedAt, ok: true, result });
    return { ran: true, schedule: { ...next, alerts: config.alerts || {} }, result };
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const next = { ...schedule, nextRunAt: nextIntervalRunAt(schedule, trigger), lastRunAt: finishedAt, lastError: error.message };
    await writeJsonAtomic(scheduleFile, next);
    await appendDsHistory(historyFile, { id: randomUUID(), trigger, startedAt, finishedAt, ok: false, error: error.message });
    throw error;
  }
}

function nextIntervalRunAt(schedule, trigger) {
  if (!schedule.enabled) return null;
  if (trigger !== "schedule") return schedule.nextRunAt || null;
  return new Date(Date.now() + schedule.intervalMinutes * 60_000).toISOString();
}

async function appendDsHistory(filePath, entry) {
  await updateJsonAtomic(filePath, DEFAULT_DS_HISTORY, (history) => ({
    updatedAt: new Date().toISOString(),
    runs: keepRecentHistoryRuns([entry, ...(history.runs || [])]),
  }));
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

function buildHiveProjectStatus(config = {}) {
  return Object.fromEntries(Object.keys(config.countries || {}).map((code) => {
    const projects = config.projects?.[code] || [];
    return [code, {
      status: projects.length
        ? (projects.every((item) => item.code) ? "resolved" : projects.some((item) => item.code) ? "partial" : "unresolved")
        : "unresolved",
      projectName: config.projectNames?.[code] || "",
      projects,
      error: projects.filter((item) => !item.code).map((item) => `${item.name}：${item.error || "尚未匹配"}`).join("；"),
    }];
  }));
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
  // Preserve the user's KN Chat target when an older saved schedule still
  // carries notifyChannel=tv. A TV configuration is only valid when it has a
  // bot id; recipient emails/chat_id are the unambiguous KN Chat target.
  const hasKnTarget = Boolean(String(mergedConfig.recipientEmails || mergedConfig.chatId || "").trim());
  const hasTvTarget = Boolean(String(mergedConfig.botId || "").trim());
  if (hasKnTarget && !hasTvTarget && String(incomingConfig.notifyChannel || "").toLowerCase() !== "tv") {
    return "knBot";
  }
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
    includeHiveScheduler: Boolean(input.includeHiveScheduler ?? previousSchedule.includeHiveScheduler),
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
      ownerEmails: String(merged.ownerEmails ?? previousConfig.ownerEmails ?? "").trim(),
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

function buildTagSyncRun(result = {}) {
  const byCountry = new Map();
  for (const anomaly of result.anomalies || []) {
    const countryCode = normalizeCountryCode(anomaly.countryCode);
    if (!countryCode) continue;
    const country = byCountry.get(countryCode) || {
      countryCode,
      countryName: anomaly.countryName || countryDisplayName(countryCode),
      result: { anomalies: [] },
    };
    country.result.anomalies.push(anomaly);
    byCountry.set(countryCode, country);
  }
  return { runs: [...byCountry.values()] };
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

async function runScheduledCountryChecks(countryConfigs, runBatchCheckFn, onProgress = null, concurrency = 1, shouldStop = () => false) {
  const countryRuns = new Array(countryConfigs.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < countryConfigs.length) {
      if (shouldStop()) break;
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
        if (error?.name === "AbortError") throw error;
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
  return countryRuns.filter(Boolean);
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
    stages: [
      { key: "country_scan", label: "国家巡检", status: "running", detail: "正在读取 Metabase 并执行规则" },
      { key: "data_check", label: "DS 调度核查", status: "pending", detail: "等待国家巡检完成" },
      { key: "ai_analysis", label: "AI 取证队列", status: "pending", detail: "每看板一次分析，最多并行 3 个请求" },
      { key: "notification", label: "告警通知", status: "pending", detail: "等待 AI 取证结论收敛" },
      { key: "finished", label: "巡检完成", status: "pending", detail: "等待所有必要阶段完成" },
    ],
  };
}

function updateBatchScheduleRunProgress(progress, event) {
  if (!progress || !event?.countryConfig) {
    return progress;
  }
  if (progress.status === "stopped") return progress;
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
  const next = {
    ...progress,
    status: "running",
    countries,
    completedCountries,
    currentCountryCode: runningCountry?.countryCode || (event.type === "start" ? countryCode : ""),
    currentCountryName: runningCountry?.countryName || (event.type === "start" ? event.countryConfig.countryName || "" : ""),
  };
  if (completedCountries === Number(progress.totalCountries || countries.length)) {
    return updateBatchScheduleRunProgressStage(next, "country_scan", {
      status: countries.some((item) => item.status === "failed") ? "partial_failed" : "success",
      detail: `已完成 ${completedCountries}/${progress.totalCountries || countries.length} 个国家巡检`,
    });
  }
  return next;
}

function updateBatchScheduleRunProgressStage(progress, key, patch) {
  if (!progress) return progress;
  if (progress.status === "stopped") return progress;
  return {
    ...progress,
    stages: (progress.stages || []).map((stage) => stage.key === key ? { ...stage, ...patch } : stage),
  };
}

function updateBatchScheduleAiProgress(progress, event = {}) {
  if (!progress) return progress;
  if (progress.status === "stopped") return progress;
  const current = (progress.stages || []).find((stage) => stage.key === "ai_analysis") || {};
  const total = Number(event.totalAnomalies ?? event.result?.totalAnomalies ?? current.totalAnomalies ?? current.totalDashboards ?? 0);
  const completed = Number(event.completed ?? event.result?.totalAnomalies ?? current.completed ?? 0);
  let stagePatch = { totalAnomalies: total, totalDashboards: Number(event.totalDashboards ?? event.result?.totalDashboards ?? current.totalDashboards ?? 0), completed };
  let status = "ai_analyzing";
  if (event.type === "skipped") {
    stagePatch = { ...stagePatch, status: "skipped", detail: event.reason || "本次未触发自动 AI 分析" };
    status = progress.finalStatus || "success";
  } else if (event.type === "queued") {
    stagePatch = { ...stagePatch, status: "queued", detail: `已排队 ${total} 条异常指标，AI 将逐条独立取证` };
  } else if (event.type === "start") {
    stagePatch = { ...stagePatch, status: "running", detail: `正在提交 ${Math.min(completed + 1, total)}/${total} 条异常指标的 AI 取证` };
  } else if (event.type === "submitted") {
    stagePatch = { ...stagePatch, status: "queued", detail: `已提交 ${completed}/${total} 条异常指标，等待 Dify 结论回写` };
  } else if (event.type === "completed" || event.type === "failed") {
    stagePatch = { ...stagePatch, status: "running", detail: `已完成 ${completed}/${total} 条异常指标${event.type === "failed" ? "（含失败项）" : ""}` };
  } else if (event.type === "finished") {
    const failedCount = Number(event.result?.skipped?.length || 0);
    stagePatch = {
      ...stagePatch,
      status: failedCount ? "partial_failed" : "queued",
      detail: failedCount ? `已提交 ${event.result?.triggered || 0}/${total} 条 AI 任务，${failedCount} 条提交失败` : `已提交 ${event.result?.triggered || total}/${total} 条 AI 任务，结论将异步回写`,
      completed: total,
    };
    status = progress.finalStatus || "success";
  } else {
    stagePatch = { ...stagePatch, status: "failed", detail: event.error || "AI 取证调度失败" };
    status = progress.finalStatus || "partial_failed";
  }
  let next = updateBatchScheduleRunProgressStage(progress, "ai_analysis", stagePatch);
  if (status !== "ai_analyzing") {
    next = updateBatchScheduleRunProgressStage(next, "finished", {
      status: status === "success" ? "success" : "partial_failed",
      detail: status === "success" ? "巡检和通知已完成，AI 结论会在回写后展示" : "巡检已完成，存在需要关注的失败项",
    });
  }
  return { ...next, status };
}

function updateBatchScheduleAiBatchProgress(progress, event = {}) {
  if (!progress) return progress;
  if (progress.status === "stopped") return progress;
  const current = (progress.stages || []).find((stage) => stage.key === "ai_analysis") || {};
  const total = Number(event.total ?? current.total ?? 0);
  const completed = Number(event.completed ?? current.completed ?? 0);
  const errors = Array.isArray(current.errors) ? [...current.errors] : [];
  const details = upsertAiBatchProgressDetail(current.details || [], event);
  if (event.type === "batch_settled" && event.result?.status === "failed" && event.result?.error) {
    const dashTitle = event.batch?.dashboardTitle || event.batch?.dashboardUuid || event.batch?.groupKey || "?";
    errors.push(`${dashTitle}: ${event.result.error}`.slice(0, 200));
  }
  if (event.type === "batch_settled" && event.result?.status === "timed_out") {
    const dashTitle = event.batch?.dashboardTitle || event.batch?.dashboardUuid || event.batch?.groupKey || "?";
    const reason = event.result?.entries?.[0]?.analysis?.limitations || "等待 Dify 回调超过等待窗口";
    errors.push(`${dashTitle}: ${reason}`.slice(0, 200));
  }
  let status = "running";
  let detail = `看板分析 ${completed}/${total}，最多同时运行 3 个请求`;
  if (event.type === "batch_submitted") {
    detail = `${event.retry ? "重刷看板分析" : "看板分析"}已提交 ${Math.min(event.submitted || 0, total)}/${total}，等待 Dify 回写`;
  }
  if (event.type === "batch_settled") {
    detail = `${event.retry ? "重刷看板分析" : "看板分析"} ${completed}/${total}，等待 Dify 回写`;
    if (errors.length) detail += `；失败 ${errors.length}：${errors[errors.length - 1]}`;
  }
  if (event.type === "global_deadline") {
    status = "partial_failed";
    detail = `已达到 45 分钟截止，${event.notSubmitted?.length || 0} 个请求标记为 AI 未核验`;
  }
  const next = updateBatchScheduleRunProgressStage(progress, "ai_analysis", {
    status,
    total,
    completed,
    errors: errors.slice(-5),
    details,
    detail,
  });
  return { ...next, status: status === "partial_failed" ? "partial_failed" : "ai_analyzing" };
}

function upsertAiBatchProgressDetail(existing = [], event = {}) {
  if (!event.batch) return Array.isArray(existing) ? existing : [];
  const next = Array.isArray(existing) ? [...existing] : [];
  const detail = buildAiBatchProgressDetail(event);
  const index = next.findIndex((item) => item.key === detail.key);
  if (index >= 0) {
    next[index] = { ...next[index], ...detail };
  } else {
    next.push(detail);
  }
  return next.slice(-30);
}

function buildAiBatchProgressDetail(event = {}) {
  const batch = event.batch || {};
  const result = event.result || {};
  const entries = Array.isArray(result.entries) ? result.entries : [];
  const firstEntry = entries[0] || {};
  const status = event.type === "batch_submitted"
    ? "submitted"
    : event.type === "batch_start"
      ? "running"
      : result.status || "running";
  const reason = result.error
    || firstEntry.analysis?.limitations
    || (status === "timed_out" ? "等待 Dify 回调超过等待窗口" : "");
  return {
    key: String(batch.batchId || batch.groupKey || `${batch.countryCode || ""}:${batch.dashboardUuid || ""}`),
    batchId: String(batch.batchId || ""),
    groupKey: String(batch.groupKey || ""),
    countryCode: normalizeCountryCode(batch.countryCode),
    dashboardTitle: String(batch.dashboardTitle || batch.dashboardUuid || batch.groupKey || "-"),
    dashboardUuid: String(batch.dashboardUuid || ""),
    caseCount: Array.isArray(batch.cases) ? batch.cases.length : 0,
    anomalyIndexes: (batch.cases || []).map((item) => Number(item.anomalyIndex)).filter(Number.isFinite),
    status,
    retry: Boolean(event.retry),
    submitted: Number(event.submitted || 0),
    total: Number(event.total || 0),
    reason,
    updatedAt: new Date().toISOString(),
  };
}

function mergeBatchInvestigationResults(initial = {}, retry = {}) {
  const keyForBatch = (batch = {}) => String(batch.batchId || batch.groupKey || "");
  const keyForSettled = (item = {}) => keyForBatch(item.batch);
  const byBatch = new Map();
  for (const item of initial.settled || []) byBatch.set(keyForSettled(item), item);
  for (const item of retry.settled || []) byBatch.set(keyForSettled(item), item);
  const settled = [...byBatch.values()];
  const settledKeys = new Set(settled.map(keyForSettled));
  const notSubmitted = [
    ...(initial.notSubmitted || []),
    ...(retry.notSubmitted || []),
  ].filter((batch, index, all) => {
    const key = keyForBatch(batch);
    return key && !settledKeys.has(key) && all.findIndex((item) => keyForBatch(item) === key) === index;
  });
  return {
    total: initial.total || retry.total || settled.length,
    completed: settled.filter((item) => item.result?.status === "completed").length,
    settled,
    failed: settled.filter((item) => item.result?.status === "failed").length,
    timedOut: settled.filter((item) => item.result?.status === "timed_out").length,
    notSubmitted,
  };
}

async function buildAiFinalizedCountryRuns({ countryRuns, runId, analysesFile }) {
  const cache = await readJsonFile(analysesFile, DEFAULT_METABASE_ANOMALY_ANALYSES);
  const byKey = new Map((cache.analyses || []).filter((item) => item.runId === runId).map((item) => [item.key, item]));
  return (countryRuns || []).map((countryRun) => {
    if (!countryRun.ok || !countryRun.result) return countryRun;
    const countryCode = normalizeCountryCode(countryRun.countryCode);
    const anomalies = countryRun.result.anomalies || [];
    const aiAudit = anomalies.map((anomaly, anomalyIndex) => {
      const entry = byKey.get(`${runId}:${countryCode}:${anomalyIndex}`) || null;
      const verdict = entry?.analysis?.dataSideVerdict || "insufficient_evidence";
      const chartVisibility = entry?.analysis?.chartVisibility || "show";
      const verifiedNormal = chartVisibility === "hide_verified_normal";
      const businessChange = verdict === "business_change" || entry?.analysis?.notificationAction === "downgrade";
      const notifiable = !verifiedNormal && !businessChange;
      return {
        anomalyIndex,
        status: entry?.status || "timed_out",
        verdict,
        notificationAction: entry?.analysis?.notificationAction || "send",
        chartVisibility,
       verificationReason: entry?.analysis?.verificationReason || "",
       dashboardSummary: entry?.dashboardSummary || "",
       summary: entry?.analysis?.summary || "AI 未核验，请人工确认。",
        confidence: entry?.analysis?.confidence || "low",
        possibleCauses: entry?.analysis?.possibleCauses || [],
        verificationSteps: entry?.analysis?.verificationSteps || [],
        recommendedActions: entry?.analysis?.recommendedActions || [],
        limitations: entry?.analysis?.limitations || "AI 未返回完整结论。",
        statusLabel: verifiedNormal ? "AI 查数正常" : businessChange ? "AI 核验为业务变化" : entry?.status === "completed" ? "AI 已核验数据侧异常" : "AI 未核验",
        notifiable,
      };
    });
    const notifiableAnomalies = anomalies.filter((_item, index) => aiAudit[index].notifiable);
    const aiVerdictCounts = aiAudit.reduce((counts, item) => {
      const key = item.verdict || "insufficient_evidence";
      counts[key] = (counts[key] || 0) + 1;
      return counts;
    }, {});
    return {
      ...countryRun,
      result: {
        ...countryRun.result,
        rawAnomalyCount: Number(countryRun.result.anomalyCount || anomalies.length || 0),
        anomalyCount: notifiableAnomalies.length,
        aiAudit,
        aiVerdictCounts,
        notifiableAnomalies,
      },
    };
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
    const notificationRuns = group.countryRuns.map((countryRun) => ({
      ...countryRun,
      result: {
        ...countryRun.result,
        anomalies: Array.isArray(countryRun.result?.notifiableAnomalies)
          ? countryRun.result.notifiableAnomalies
          : countryRun.result?.anomalies || [],
      },
    }));
    const result = {
      ...combineScheduledCountryResults(notificationRuns),
      wattrelSummary,
    };
    if (Number(result.anomalyCount || 0) + Number(result.dataQualityAnomalyCount || 0) <= 0) {
      const notification = {
        sent: false,
        skipped: true,
        reason: "no data-side anomalies after AI verification",
        sentMessages: 0,
        results: [],
        channel: group.alerts.channel,
        botId: group.alerts.botId || "",
        chatId: group.alerts.chatId || "",
        recipientEmails: group.alerts.recipientEmails || "",
        mentions: group.alerts.mentions || [],
        webhookUrl: group.alerts.webhookUrl || "",
        detailUrl: group.alerts.detailUrl || "",
        sentAt: new Date().toISOString(),
      };
      for (const countryRun of group.countryRuns) countryRun.result.notification = notification;
      continue;
    }
    const messages = buildPublicCheckMessages(result, {
      ...group.alerts,
      countryDetailMode: "summary",
      messageStyle: "dutySummary",
      wattrelSummary,
      dsScheduleSummary: dsSchedulerSummary,
    });
    if (messages.length === 0) {
      const notification = {
        sent: false,
        skipped: true,
        reason: "no data-side anomalies after AI verification",
        sentMessages: 0,
        results: [],
        channel: group.alerts.channel,
        botId: group.alerts.botId || "",
        chatId: group.alerts.chatId || "",
        recipientEmails: group.alerts.recipientEmails || "",
        mentions: group.alerts.mentions || [],
        webhookUrl: group.alerts.webhookUrl || "",
        detailUrl: group.alerts.detailUrl || "",
        sentAt: new Date().toISOString(),
      };
      for (const countryRun of group.countryRuns) countryRun.result.notification = notification;
      continue;
    }
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
  hiveSchedulerSummary = null,
  hiveSchedulerError = null,
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
    status: summary.failedCount > 0 || dsSchedulerError || hiveSchedulerError ? "partial_failed" : "success",
    ok: summary.failedCount === 0 && !dsSchedulerError && !hiveSchedulerError,
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
    hiveSchedulerSummary,
    hiveSchedulerError,
    runs: countryRuns,
  };
}

async function appendBatchHistoryRun(historyFile, entry) {
  await updateJsonAtomic(historyFile, DEFAULT_BATCH_HISTORY, (history) => ({
    updatedAt: new Date().toISOString(),
    runs: keepRecentHistoryRuns([entry, ...(history.runs || [])]),
  }));
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

function isAiFirstMetabasePatrolEnabled(env = process.env) {
  return ["1", "true", "on", "yes"].includes(String(env.METABASE_ANOMALY_BATCH_MODE || "").trim().toLowerCase());
}

function extractQualifiedSqlTables(sql) {
  const tables = [];
  for (const match of String(sql || "").matchAll(/(?:from|join)\s+`?([\w.]+)`?/gi)) {
    const table = String(match[1] || "").replace(/[`"]/g, "").toLowerCase();
    if (table.includes(".")) tables.push(table);
  }
  return [...new Set(tables)].slice(0, 10);
}

function compactMetabaseAnomaly(anomaly = {}) {
  return {
    dashboardTitle: anomaly.dashboardTitle || "",
    dashboardUuid: anomaly.dashboardUuid || "",
    dashboardUrl: anomaly.dashboardUrl || "",
    cardTitle: anomaly.cardTitle || "",
    cardId: anomaly.cardId ?? null,
    dashcardId: anomaly.dashcardId ?? null,
    type: anomaly.type || "",
    message: anomaly.message || "",
    rule: anomaly.rule || null,
  };
}

function resolveAnomalyDashboardUuid(anomaly = {}) {
  const explicit = String(anomaly.dashboardUuid || "").trim();
  if (explicit) return explicit;
  try {
    return String(parsePublicDashboardUrl(anomaly.dashboardUrl || "")?.uuid || "").trim();
  } catch {
    return String(anomaly.dashboardTitle || anomaly.dashboardUrl || "").trim();
  }
}

function getMetabaseBaseUrl(value) {
  try {
    return new URL(String(value || "https://data.kuainiu.io")).origin;
  } catch {
    return "https://data.kuainiu.io";
  }
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
    verdictMissing: isMetabaseVerdictMissingAnalysis(body.analysis),
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
    .filter((fileName) => /^(?:runtime-)?discovered-public-dashboards\.[a-z]+\.json$/i.test(fileName))
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
  const deletedDashboards = await readRuntimeDashboardDeletions(configDir);

  return filterInventoryDeletedDashboards(mergeInventories(inventories), deletedDashboards);
}

async function filterInventoryByCurrentPanelSources(configDir, inventoryFilePath, inventory) {
  const sourceRefs = await readCurrentPanelSourceRefs(configDir, inventoryFilePath);
  const isRuntimeInventory = /^runtime-discovered-public-dashboards\./i.test(path.basename(inventoryFilePath));
  if (sourceRefs.urls.size === 0 && sourceRefs.panelIds.size === 0) {
    return filterInventoryDeletedDashboards(inventory, sourceRefs.deletedDashboards || []);
  }

  return {
    ...inventory,
    dashboards: (inventory.dashboards || []).filter((dashboard) => {
      if (isExcludedScanDashboard(dashboard)) {
        return false;
      }
      if (dashboardMatchesAnyDeletion(dashboard, sourceRefs.deletedDashboards || [])) {
        return false;
      }
      if (isRuntimeInventory && !sourceRefs.hasPublicDashboardSources && isPublicInventoryDashboard(dashboard)) {
        return false;
      }
      const sourcePanelId = dashboard.sourcePanelId == null ? "" : String(dashboard.sourcePanelId);
      const matchesUrl = sourceRefs.urls.has(dashboard.sourceUrl || "")
        || sourceRefs.urls.has(dashboard.url || "");
      const matchesPanel = sourcePanelId && sourceRefs.panelIds.has(sourcePanelId);
      if (matchesPanel && sourceRefs.internalPanelIds.has(sourcePanelId) && !isInternalInventoryDashboard(dashboard)) {
        return false;
      }
      if (matchesPanel && sourceRefs.internalPanelIds.has(sourcePanelId)) {
        const expectedDashboardIds = sourceRefs.internalDashboardIdsByPanelId.get(sourcePanelId);
        const actualDashboardId = getInternalInventoryDashboardId(dashboard);
        if (expectedDashboardIds?.size && (!actualDashboardId || !expectedDashboardIds.has(actualDashboardId))) {
          return false;
        }
      }
      return matchesUrl || matchesPanel || isRuntimeInventory;
    }),
  };
}

function getInternalInventoryDashboardId(dashboard = {}) {
  if (dashboard.dashboardId != null && dashboard.dashboardId !== "") {
    return String(dashboard.dashboardId);
  }
  for (const rawUrl of [dashboard.url, dashboard.sourceUrl]) {
    if (!rawUrl) continue;
    try {
      const parsed = parseInternalMetabaseUrl(rawUrl);
      if (parsed?.type === "dashboard") return String(parsed.id);
    } catch {
      // Ignore malformed legacy URLs; they cannot establish dashboard identity.
    }
  }
  return "";
}

function isInternalInventoryDashboard(dashboard = {}) {
  if (dashboard.access === "internal") return true;
  if (dashboard.access === "public") return false;
  for (const rawUrl of [dashboard.url, dashboard.sourceUrl]) {
    if (!rawUrl) continue;
    try {
      if (parseInternalMetabaseUrl(rawUrl)?.type === "dashboard") return true;
    } catch {
      // Fall through to the dashboard ID used by older discovery records.
    }
  }
  return dashboard.dashboardId != null && dashboard.dashboardId !== "";
}

function isPublicInventoryDashboard(dashboard = {}) {
  if (dashboard.access === "public") return true;
  if (dashboard.access === "internal") return false;
  return [dashboard.url, dashboard.sourceUrl].some((rawUrl) => {
    if (!rawUrl) return false;
    try {
      return Boolean(parsePublicDashboardUrl(rawUrl));
    } catch {
      return false;
    }
  });
}

async function readCurrentPanelSourceRefs(configDir, inventoryFilePath) {
  const match = path.basename(inventoryFilePath).match(/^(?:runtime-)?discovered-public-dashboards\.([a-z]+)\.json$/i);
  if (!match) {
    return { urls: new Set(), panelIds: new Set(), internalPanelIds: new Set(), hasPublicDashboardSources: false };
  }

  const panels = await readMergedPanelSource(path.dirname(configDir), match[1].toUpperCase());
  const panelItems = (panels?.panels || []).filter((panel) => !isExcludedScanDashboard(panel));
  const internalDashboardIdsByPanelId = new Map();
  for (const panel of panelItems) {
    if (panel.id == null) continue;
    const dashboardIds = new Set((panel.links || []).flatMap((link) => {
      try {
        const parsed = parseInternalMetabaseUrl(link.url || "");
        return parsed?.type === "dashboard" ? [String(parsed.id)] : [];
      } catch {
        return [];
      }
    }));
    if (dashboardIds.size) internalDashboardIdsByPanelId.set(String(panel.id), dashboardIds);
  }
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
    internalPanelIds: new Set(
      panelItems
        .filter((panel) => (panel.links || []).some((link) => {
          try {
            return parseInternalMetabaseUrl(link.url || "")?.type === "dashboard";
          } catch {
            return false;
          }
        }))
        .map((panel) => panel.id)
        .filter((id) => id != null)
        .map(String),
    ),
    internalDashboardIdsByPanelId,
    hasPublicDashboardSources: panelItems.some((panel) => (panel.links || []).some((link) => {
      try {
        return Boolean(parsePublicDashboardUrl(link.url || ""));
      } catch {
        return false;
      }
    })),
    deletedDashboards: panels.deletedDashboards || [],
  };
}

async function discoverCountryInventoryFromPanelSources(rootDir, countryCode, discoverDashboardsFn) {
  if (!countryCode || typeof discoverDashboardsFn !== "function") {
    return { dashboards: [] };
  }

  const inputFile = await writeTemporaryMergedPanelSource(rootDir, countryCode);
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
  } finally {
    await fs.rm(inputFile, { force: true });
  }
}

async function hasCountryPanelSources(rootDir, countryCode) {
  if (!countryCode) {
    return false;
  }
  const source = await readMergedPanelSource(rootDir, countryCode);
  return Array.isArray(source.panels) && source.panels.length > 0;
}

async function isCountryInventoryFullyDiscovered(rootDir, countryCode) {
  const code = String(countryCode || "").trim().toLowerCase();
  if (!code) return false;
  const inventoryFile = code === "ine"
    ? "config/discovered-public-dashboards.json"
    : `config/discovered-public-dashboards.${code}.json`;
  const [sources, inventory] = await Promise.all([
    readMergedPanelSource(rootDir, code.toUpperCase()),
    readPlatformInventory(rootDir, path.join(rootDir, inventoryFile)),
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
  const skippedPublic = [];

  for (const inventory of inventories) {
    sourceErrors.push(...(inventory.sourceErrors || []));
    for (const dashboard of inventory.dashboards || []) {
      // Public sharing is turned off on the Metabase instance, so every
      // /public/dashboard link is dead and only produces 404 noise. Drop these
      // before they reach runBatchCheck. Runtime discovery can still write them
      // into its inventory file, which is why the filter lives here rather than
      // in the saved config.
      if (isPublicDashboard(dashboard)) {
        skippedPublic.push({
          countryCode: getDashboardCountryCode(dashboard),
          title: dashboard.sourcePanelTitle || dashboard.title || "",
          uuid: dashboard.uuid || "",
          url: dashboard.url || "",
        });
        continue;
      }
      const key = [
        dashboard.countryCode || dashboard.country?.code || "",
        dashboard.access || "public",
        dashboard.dashboardId || dashboard.uuid || dashboard.url || dashboard.title || "",
      ].join("::");
      dashboardsByKey.set(key, dashboard);
    }
  }

  // This merge feeds runBatchCheck directly. A dashboard can arrive once from
  // saved inventory and once from fresh internal discovery, with different
  // access/ID fields but the same physical Metabase page. Deduplicate before
  // cards are queried so it cannot create duplicate alerts or notifications.
  const dashboards = deduplicateDashboards([...dashboardsByKey.values()]);
  return {
    ...(inventories[0] || {}),
    dashboardCount: dashboards.length,
    totalCardCount: dashboards.reduce((sum, dashboard) => sum + (dashboard.cards?.length || 0), 0),
    sourceErrorCount: sourceErrors.length,
    sourceErrors,
    dashboards,
    ...(skippedPublic.length ? { skippedPublicDashboards: skippedPublic } : {}),
  };
}

// Keyed on the access field alone. Discovery always sets it explicitly
// (metabase-discovery.mjs writes "public" or "internal"), so a url heuristic
// would only add false positives for entries whose access is already known.
function isPublicDashboard(dashboard) {
  return String(dashboard?.access || "").toLowerCase() === "public";
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

function buildFluctuationChartSeries(rows, ruleForSeries = {}, anomaly = {}, card = {}, body = {}) {
  const hourlyAxis = detectHourlyAxisFromRows(rows);
  const seriesRule = hourlyAxis.timeColumn
    ? { ...ruleForSeries, timeColumn: hourlyAxis.timeColumn }
    : ruleForSeries;
  const series = buildAnomalyMetricSeries(Array.isArray(rows) ? rows : [], seriesRule, anomaly.message || "", {
    maxPoints: Number(body.maxPoints || 16),
    forceHourlyAxis: hourlyAxis.isHourly,
  });
  const metricName = series.find((point) => point.metric)?.metric || "";
  const seriesPercent = isPercentSeriesFromCard(card, metricName, ruleForSeries);
  return series.map((point) => ({ ...point, percent: seriesPercent }));
}

function findInventoryCardForAnomaly(inventory = {}, anomaly = {}) {
  const countryCode = normalizeCountryCode(anomaly.countryCode);
  const dashboardUuid = String(anomaly.dashboardUuid || "").trim();
  const dashboardUrl = dashboardUrlIdentity(anomaly.dashboardUrl || "");
  const cardId = String(anomaly.cardId ?? "").trim();
  const dashcardId = String(anomaly.dashcardId ?? "").trim();
  const cardTitle = String(anomaly.cardTitle || "").trim();
  const countryDashboards = (inventory.dashboards || []).filter((dashboard) => {
    if (countryCode && normalizeCountryCode(dashboard.countryCode || dashboard.country?.code) !== countryCode) {
      return false;
    }
    return true;
  });
  const dashboards = countryDashboards.filter((dashboard) => {
    if (dashboardUuid && String(dashboard.uuid || "") === dashboardUuid) {
      return true;
    }
    if (dashboardUrl && dashboardUrlIdentity(dashboard.url || "") === dashboardUrl) {
      return true;
    }
    return !dashboardUuid && !dashboardUrl;
  });

  for (const dashboard of dashboards) {
    const cards = dashboard.cards || [];
    const card = cards.find((item) => cardId && String(item.cardId ?? "") === cardId)
      || cards.find((item) => dashcardId && String(item.dashcardId ?? "") === dashcardId)
      || cards.find((item) => cardTitle && String(item.title || "").trim() === cardTitle);
    if (card) {
      return { dashboard, card };
    }
  }

  // Discovery can replace a dashboard UUID/URL while an older inspection run
  // is still being viewed. Fall back only to a unique card inside the country.
  const idMatches = countryDashboards.flatMap((dashboard) => (dashboard.cards || [])
    .filter((card) => (cardId && String(card.cardId ?? "") === cardId)
      || (dashcardId && String(card.dashcardId ?? "") === dashcardId))
    .map((card) => ({ dashboard, card })));
  if (idMatches.length === 1) {
    return idMatches[0];
  }

  const dashboardTitle = canonicalDashboardTitle(anomaly.dashboardTitle || "");
  const titleMatches = countryDashboards.flatMap((dashboard) => {
    const dashboardMatches = dashboardTitle
      && [dashboard.title, dashboard.sourcePanelTitle].some((title) => canonicalDashboardTitle(title) === dashboardTitle);
    if (!dashboardMatches || !cardTitle) return [];
    return (dashboard.cards || [])
      .filter((card) => String(card.title || "").trim() === cardTitle)
      .map((card) => ({ dashboard, card }));
  });
  if (titleMatches.length === 1) {
    return titleMatches[0];
  }
  return { dashboard: null, card: null };
}

function buildFluctuationSeriesHistoryParameters(dashboard, card, lookbackDays = 45, anomalyDate = "", now = Date.now(), rule = {}) {
  const days = clampNumber(lookbackDays, 14, 90, 45);
  const dashboardParameters = new Map((dashboard.parameters || []).map((parameter) => [parameter.id, parameter]));
  const dateMappings = (card.parameterMappings || []).filter((mapping) => {
    const parameter = dashboardParameters.get(mapping.parameter_id);
    return parameter?.type?.startsWith("date/");
  });
  const historyMappingIds = selectHistoryDateMappingIds(dateMappings, dashboardParameters, rule);
  return dateMappings.flatMap((mapping) => {
    const parameter = dashboardParameters.get(mapping.parameter_id);
    if (!historyMappingIds.has(mapping.parameter_id)) return [];
    return [{
      id: parameter.id,
      type: parameter.type,
      target: mapping.target,
      value: buildAnchoredHistoryWindow(days, anomalyDate, now),
    }];
  });
}

function selectHistoryDateMappingIds(mappings = [], dashboardParameters = new Map(), rule = {}) {
  if (mappings.length <= 1) {
    return new Set(mappings.map((mapping) => mapping.parameter_id));
  }

  const context = String(rule.context || "");
  const dateColumn = String(rule.dateColumn || "");
  const contextual = mappings.filter((mapping) => {
    const parameter = dashboardParameters.get(mapping.parameter_id);
    return parameter?.name && context.includes(parameter.name);
  });
  if (contextual.length) {
    return new Set(contextual.map((mapping) => mapping.parameter_id));
  }

  const columnMatched = mappings.filter((mapping) => {
    const target = JSON.stringify(mapping.target || []);
    return dateColumn && target.includes(dateColumn);
  });
  if (columnMatched.length) {
    return new Set(columnMatched.map((mapping) => mapping.parameter_id));
  }

  // A multi-date card without a clear axis must retain its defaults. Rewriting
  // every date filter can remove the cohorts needed to calculate delayed metrics.
  return new Set();
}

function extractAnomalyDate(message = "") {
  return String(message || "").match(/\d{4}-\d{2}-\d{2}/)?.[0] || "";
}

export function buildAnchoredHistoryWindow(days, anomalyDate, now = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(anomalyDate || ""))) {
    return `past${days}days~`;
  }
  const target = Date.parse(`${anomalyDate}T00:00:00Z`);
  const current = new Date(now);
  const currentUtc = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate());
  const daysAgo = Math.floor((currentUtc - target) / 86_400_000);
  if (!Number.isFinite(daysAgo) || daysAgo < days - 1) {
    return `past${days}days~`;
  }
  return `past${days}days-from-${daysAgo}days`;
}

function buildFluctuationSeriesUrlParameters(dashboard, card, dashboardUrl) {
  if (!dashboardUrl) return [];
  let searchParams;
  try {
    searchParams = new URL(dashboardUrl).searchParams;
  } catch {
    return [];
  }

  const dashboardParameters = new Map((dashboard.parameters || []).map((parameter) => [parameter.id, parameter]));
  return (card.parameterMappings || []).flatMap((mapping) => {
    const parameter = dashboardParameters.get(mapping.parameter_id);
    if (!parameter) return [];
    const keys = [parameter.name, parameter.id].filter(Boolean);
    const key = keys.find((candidate) => searchParams.has(candidate));
    if (!key) return [];
    const values = searchParams.getAll(key);
    return [{
      id: parameter.id,
      type: parameter.type,
      target: mapping.target,
      value: values.length > 1 ? values : values[0] ?? "",
    }];
  });
}

function detectHourlyAxisFromRows(rows = []) {
  const safeRows = Array.isArray(rows) ? rows.filter((row) => row && typeof row === "object") : [];
  if (!safeRows.length) return { isHourly: false, timeColumn: "" };

  const columns = [...new Set(safeRows.flatMap((row) => Object.keys(row)))];
  const wideHourColumnCount = columns.filter((column) => {
    const hour = Number(String(column).trim());
    return Number.isInteger(hour) && hour >= 0 && hour <= 23;
  }).length;
  if (wideHourColumnCount >= 2) {
    return { isHourly: true, timeColumn: "" };
  }

  for (const column of columns) {
    const clockValues = new Set(
      safeRows
        .map((row) => String(row[column] ?? "").trim())
        .filter((value) => /^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(value)),
    );
    if (clockValues.size >= 2) {
      return { isHourly: true, timeColumn: column };
    }
  }

  return { isHourly: false, timeColumn: "" };
}

function shouldUseHourlyFluctuationWindow(rules = [], anomaly = {}, card = {}) {
  const type = String(anomaly.type || "");
  if (type === "intradayTimePointChange" || type === "intradaySameTimeChange") {
    return true;
  }
  if ((rules || []).some((rule) => (
    rule.type === "intradayTimePointChange"
    || rule.type === "intradaySameTimeChange"
    || Boolean(rule.timeColumn)
  ))) {
    return true;
  }
  const text = [
    anomaly.message,
    anomaly.metricColumn,
    anomaly.column,
    card.title,
  ].filter(Boolean).join(" ");
  if (/(?:[01]?\d|2[0-3]):[0-5]\d/.test(text)) {
    return true;
  }
  return /小时|同时间点|hour|intraday/i.test(text);
}

function isPercentSeriesFromCard(card = {}, metricName = "", rule = {}) {
  const setting = findColumnVisualizationSetting(card, metricName);
  if (setting) {
    return isPercentColumnSetting(setting);
  }
  return rule.valueFormat === "percent";
}

function findColumnVisualizationSetting(card = {}, metricName = "") {
  if (!metricName) return null;
  const settings = card.visualizationSettings || card.visualization_settings || {};
  const columnSettings = settings.column_settings || settings["column_settings"] || {};
  for (const [key, value] of Object.entries(columnSettings || {})) {
    if (String(key).includes(metricName)) {
      return value && typeof value === "object" ? value : null;
    }
  }
  const seriesSettings = settings.series_settings || settings["series_settings"] || {};
  for (const [key, value] of Object.entries(seriesSettings || {})) {
    if (String(key) === metricName || String(key).includes(metricName)) {
      return value && typeof value === "object" ? value : null;
    }
  }
  return null;
}

function isPercentColumnSetting(setting = {}) {
  const values = [
    setting.number_style,
    setting.numberStyle,
    setting.style,
    setting.format,
    setting.unit,
    setting.suffix,
    setting.prefix,
  ].map((value) => String(value || "").toLowerCase());
  return values.some((value) => value === "%" || value.includes("percent") || value.includes("percentage"));
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
  const dashboards = (inventory?.dashboards || [])
    .filter((dashboard) => !isExcludedScanDashboard(dashboard))
    .map((dashboard) => ({
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
      if (isExcludedScanDashboard(panel)) {
        continue;
      }
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
          && !hasConflictingInternalDashboardIds(dashboard, pending)
          && canonicalDashboardTitle(dashboard.sourcePanelTitle || dashboard.title) === pendingTitle
        ));
        if (match < 0) match = undefined;
      }
      if (match !== undefined) {
        const matchedDashboard = dashboards[match];
        const sameSourcePanel = String(matchedDashboard.sourcePanelId ?? "") === String(pending.sourcePanelId ?? "");
        const manualOverride = panel.manual === true || panel.type === "manual_metabase";
        if (manualOverride && panel.pendingDiscovery === true) {
          dashboards[match] = pending;
          dashboardIdentities(pending).forEach((identity) => identities.set(identity, match));
          continue;
        }
        if (sameSourcePanel && hasConflictingInternalDashboardIds(matchedDashboard, pending)) {
          dashboards[match] = pending;
          dashboardIdentities(pending).forEach((identity) => identities.set(identity, match));
          continue;
        }
        dashboards[match] = {
          ...pending,
          ...matchedDashboard,
          sourcePanelId: matchedDashboard.sourcePanelId ?? panel.id,
          ...(manualOverride ? {
            title: pending.title,
            sourcePanelTitle: pending.sourcePanelTitle,
          } : {
            sourcePanelTitle: matchedDashboard.sourcePanelTitle || panel.title,
          }),
        };
        dashboardIdentities(dashboards[match]).forEach((identity) => identities.set(identity, match));
        continue;
      }
     const index = dashboards.push(pending) - 1;
     dashboardIdentities(pending).forEach((identity) => identities.set(identity, index));
   }
 }

  const deduped = deduplicateDashboards(dashboards);

  return { ...inventory, dashboards: deduped };
}

function hasConflictingInternalDashboardIds(left = {}, right = {}) {
  const leftId = getInternalInventoryDashboardId(left);
  const rightId = getInternalInventoryDashboardId(right);
  return Boolean(leftId && rightId && leftId !== rightId);
}

function isExcludedScanDashboard(item = {}) {
  const title = String(item.sourcePanelTitle || item.title || "");
  const urls = [item.url, item.sourceUrl, ...(item.links || []).map((link) => link?.url)]
    .filter(Boolean)
    .join(" ");

  return title.includes("营销过程数据统计")
    || /\/dashboard\/(?:993|994)(?:[/?#]|$)/.test(urls);
}

function deduplicateDashboards(dashboards) {
  const seen = new Map();
  const result = [];
  for (const dashboard of dashboards) {
    const countryCode = getDashboardCountryCode(dashboard);
    const urlKey = dashboard.url ? `${countryCode}:${dashboardUrlIdentity(dashboard.url)}` : null;
    const hasStableIdentity = Boolean(
      dashboard.dashboardId != null && dashboard.dashboardId !== ""
      || dashboard.uuid
      || dashboard.url
      || dashboard.sourceUrl
    );
    const titleKey = hasStableIdentity
      ? null
      : `${countryCode}:${canonicalDashboardTitle(dashboard.sourcePanelTitle || dashboard.title)}`;
    const cardSetKey = dashboardCardSetIdentity(dashboard);
    const keys = [urlKey, titleKey, cardSetKey && `${countryCode}:cards:${cardSetKey}`].filter(Boolean);
    let duplicateIndex = -1;
    for (const key of keys) {
      const existing = seen.get(key);
      if (existing !== undefined) {
        duplicateIndex = existing;
        break;
      }
    }
    if (duplicateIndex >= 0) {
      const existing = result[duplicateIndex];
      const existingCards = existing.cards?.length || 0;
      const newCards = dashboard.cards?.length || 0;
      if (newCards > existingCards) {
        result[duplicateIndex] = dashboard;
        for (const key of keys) {
          seen.set(key, duplicateIndex);
        }
      }
      continue;
    }
    for (const key of keys) {
      seen.set(key, result.length);
    }
    result.push(dashboard);
  }
  return result;
}

function dashboardCardSetIdentity(dashboard = {}) {
  const cards = Array.isArray(dashboard.cards) ? dashboard.cards : [];
  const identities = cards
    .map((card) => {
      const dashcardId = String(card?.dashcardId ?? "").trim();
      const cardId = String(card?.cardId ?? "").trim();
      return dashcardId && cardId ? `${dashcardId}:${cardId}` : "";
    })
    .filter(Boolean)
    .sort();
  return identities.length ? identities.join("|") : "";
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
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
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
    const source = await readMergedPanelSource(rootDir, country.code);
    if (!source || !Array.isArray(source.panels) || source.panels.length === 0) {
      continue;
    }
    const visiblePanels = source.panels.filter((panel) => (
      !isExcludedScanDashboard(panel)
      && !dashboardMatchesAnyDeletion(panelSourceToDashboard({
        countryCode: country.code,
        countryName: country.name,
        timezone: country.timezone,
      }, panel), source.deletedDashboards || [])
      && !panelMatchesAnyDeletion(panel, source.deletedDashboards || [])
    ));
    if (visiblePanels.length === 0) {
      continue;
    }

    sources.push({
      countryCode: country.code,
      countryName: country.name,
      timezone: country.timezone,
      sourceTitle: source.title || "",
      sourceUid: source.uid || "",
      panels: visiblePanels.map((panel) => ({
        id: panel.id,
        title: panel.title || "-",
        type: panel.type || "",
        manual: panel.manual === true,
        pendingDiscovery: panel.pendingDiscovery === true,
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

function runtimePanelSourceFilePath(rootDir, countryCode) {
  return path.join(rootDir, `config/runtime-discovered-panels.${String(countryCode || "").toLowerCase()}.json`);
}

function runtimeCountryInventoryFilePath(rootDir, countryCode) {
  return path.join(rootDir, `config/runtime-discovered-public-dashboards.${String(countryCode || "").toLowerCase()}.json`);
}

async function readRuntimeDashboardDeletions(configDir) {
  let fileNames = [];
  try {
    fileNames = await fs.readdir(configDir);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const deletions = [];
  for (const fileName of fileNames) {
    if (!/^runtime-discovered-(?:panels|public-dashboards)\.[a-z]+\.json$/i.test(fileName)) continue;
    const source = await readJsonFile(path.join(configDir, fileName), {});
    deletions.push(...(source.deletedDashboards || []));
  }
  return appendUniqueDashboardDeletions([], deletions);
}

function filterInventoryDeletedDashboards(inventory = {}, deletedDashboards = []) {
  if (!deletedDashboards.length) return inventory;
  return {
    ...inventory,
    dashboards: (inventory.dashboards || []).filter((dashboard) => !dashboardMatchesAnyDeletion(dashboard, deletedDashboards)),
  };
}

function dashboardMatchesAnyDeletion(dashboard = {}, deletedDashboards = []) {
  return deletedDashboards.some((deletion) => dashboardMatchesDeletion(dashboard, deletion));
}

function panelMatchesAnyDeletion(panel = {}, deletedDashboards = []) {
  return deletedDashboards.some((deletion) => panelMatchesDeletion(panel, deletion));
}

function dashboardMatchesDeleteRequest(dashboard = {}, request = {}) {
  const deletion = {
    countryCode: request.countryCode || getDashboardCountryCode(dashboard),
    uuid: request.dashboardUuid,
    dashboardId: request.dashboardId,
    sourcePanelId: request.sourcePanelId,
    url: request.url,
  };
  return dashboardMatchesDeletion(dashboard, deletion);
}

function buildDashboardDeletionRef(dashboard = {}) {
  return {
    countryCode: getDashboardCountryCode(dashboard),
    uuid: dashboard.uuid || "",
    dashboardId: dashboard.dashboardId == null ? "" : String(dashboard.dashboardId),
    sourcePanelId: dashboard.sourcePanelId == null ? "" : String(dashboard.sourcePanelId),
    url: dashboard.url || "",
    sourceUrl: dashboard.sourceUrl || "",
    title: dashboard.title || dashboard.sourcePanelTitle || "",
    deletedAt: new Date().toISOString(),
  };
}

function appendUniqueDashboardDeletions(existing = [], additions = []) {
  const result = [];
  const seen = new Set();
  for (const deletion of [...existing, ...additions]) {
    const normalized = normalizeDashboardDeletion(deletion);
    const key = dashboardDeletionKey(normalized);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function removeDashboardDeletionForDashboard(deletions = [], dashboard = {}) {
  return deletions.filter((deletion) => !dashboardMatchesDeletion(dashboard, deletion));
}

function normalizeDashboardDeletion(deletion = {}) {
  return {
    ...deletion,
    countryCode: String(deletion.countryCode || "").toUpperCase(),
    uuid: String(deletion.uuid || deletion.dashboardUuid || ""),
    dashboardId: deletion.dashboardId == null ? "" : String(deletion.dashboardId),
    sourcePanelId: deletion.sourcePanelId == null ? "" : String(deletion.sourcePanelId),
    url: deletion.url || "",
    sourceUrl: deletion.sourceUrl || "",
    title: deletion.title || "",
  };
}

function dashboardDeletionKey(deletion = {}) {
  const countryCode = String(deletion.countryCode || "").toUpperCase();
  return [
    deletion.dashboardId ? `id:${countryCode}:${deletion.dashboardId}` : "",
    deletion.uuid ? `uuid:${countryCode}:${deletion.uuid}` : "",
    deletion.sourcePanelId ? `panel:${countryCode}:${deletion.sourcePanelId}` : "",
    deletion.url ? `url:${countryCode}:${dashboardUrlIdentity(deletion.url)}` : "",
    deletion.sourceUrl ? `url:${countryCode}:${dashboardUrlIdentity(deletion.sourceUrl)}` : "",
  ].filter(Boolean)[0] || "";
}

function dashboardMatchesDeletion(dashboard = {}, deletionInput = {}) {
  const deletion = normalizeDashboardDeletion(deletionInput);
  const countryCode = getDashboardCountryCode(dashboard);
  if (deletion.countryCode && countryCode && deletion.countryCode !== countryCode) return false;
  if (deletion.dashboardId && String(dashboard.dashboardId ?? "") === deletion.dashboardId) return true;
  if (deletion.uuid && String(dashboard.uuid || "") === deletion.uuid) return true;
  if (deletion.sourcePanelId && String(dashboard.sourcePanelId ?? "") === deletion.sourcePanelId) return true;
  const deletedUrls = [deletion.url, deletion.sourceUrl].filter(Boolean).map(dashboardUrlIdentity);
  const dashboardUrls = [dashboard.url, dashboard.sourceUrl].filter(Boolean).map(dashboardUrlIdentity);
  return deletedUrls.some((deletedUrl) => dashboardUrls.includes(deletedUrl));
}

function panelMatchesDeletion(panel = {}, deletionInput = {}) {
  const deletion = normalizeDashboardDeletion(deletionInput);
  if (deletion.sourcePanelId && String(panel.id ?? "") === deletion.sourcePanelId) return true;
  const deletedUrls = [deletion.url, deletion.sourceUrl].filter(Boolean).map(dashboardUrlIdentity);
  const panelUrls = (panel.links || []).map((link) => dashboardUrlIdentity(link?.url || "")).filter(Boolean);
  return deletedUrls.some((deletedUrl) => panelUrls.includes(deletedUrl));
}

async function readMergedPanelSource(rootDir, countryCode) {
  const [base, runtime, countries] = await Promise.all([
    readJsonFile(panelSourceFilePath(rootDir, countryCode), {}),
    readJsonFile(runtimePanelSourceFilePath(rootDir, countryCode), {}),
    readJsonFile(path.join(rootDir, FILES.countries), { countries: [] }),
  ]);
  const merged = mergePanelSources(runtime, base);
  if (!merged.country) {
    const code = String(countryCode || "").trim().toUpperCase();
    const country = (countries.countries || []).find((item) => String(item.code || "").toUpperCase() === code) || {};
    merged.country = {
      code,
      name: country.name || code,
      timezone: country.timezone,
    };
  }
  return merged;
}

function mergePanelSources(...sources) {
  const panels = [];
  const deletedDashboards = [];
  const seen = new Set();
  let country = null;
  let title = "";
  let uid = "";
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    country = country || source.country || null;
    title = title || source.title || "";
    uid = uid || source.uid || "";
    deletedDashboards.push(...(source.deletedDashboards || []));
    for (const panel of Array.isArray(source.panels) ? source.panels : []) {
      const identities = panelSourceIdentities(panel);
      const duplicate = identities.some((identity) => seen.has(identity));
      if (duplicate) continue;
      panels.push(panel);
      identities.forEach((identity) => seen.add(identity));
    }
  }
  return { country, title, uid, panels, deletedDashboards: appendUniqueDashboardDeletions([], deletedDashboards) };
}

function panelSourceIdentities(panel = {}) {
  const values = [];
  if (panel.id != null) values.push(`id:${String(panel.id)}`);
  for (const link of panel.links || []) {
    const identity = dashboardUrlIdentity(link?.url || "");
    if (identity) values.push(`url:${identity}`);
  }
  if (!values.length && panel.title) values.push(`title:${canonicalDashboardTitle(panel.title)}`);
  return values;
}

async function writeTemporaryMergedPanelSource(rootDir, countryCode) {
  const source = await readMergedPanelSource(rootDir, countryCode);
  const temporaryInputFile = path.join(rootDir, `config/.merged-discovery-${String(countryCode || "").toLowerCase()}-${randomUUID()}.json`);
  await writeJsonAtomic(temporaryInputFile, source);
  return temporaryInputFile;
}

async function explainUnavailableCountryInventory(rootDir, countryCode, countries = []) {
  const country = countries.find((item) => item.code === countryCode) || {};
  const label = [country.name, countryCode].filter(Boolean).join(" / ") || countryCode || "该国家";
  const source = await readJsonFile(panelSourceFilePath(rootDir, countryCode), {});
  const sourceCount = Array.isArray(source.panels) ? source.panels.length : 0;
  if (sourceCount > 0) {
    return `${label} 当前有 ${sourceCount} 个来源看板，但尚未发现可巡检的卡片；请确认已配置 Metabase 登录态（METABASE_SESSION / METABASE_COOKIE）并重新发现后再上线巡检。`;
  }
  return `${label} 当前没有可巡检的看板清单，请先补充 Metabase collection/dashboard 链接并重新发现。`;
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

function dashboardDiscoveryFailed(error) {
  const message = String(error?.message || error || "Metabase 看板发现失败").trim();
  let type = "Metabase 接口或卡片发现失败";
  if (/401|403|unauthori[sz]ed|forbidden/i.test(message)) {
    type = "Metabase 访问权限或认证失败";
  } else if (/404|not found/i.test(message)) {
    type = "看板不存在或链接失效";
  } else if (/timeout|timed out|abort/i.test(message)) {
    type = "Metabase 请求超时";
  } else if (/invalid|malformed|url/i.test(message)) {
    type = "看板链接无效";
  }
  return badRequest("Dashboard discovery failed", [`错误类型：${type}。${message}`]);
}

// ---------------------------------------------------------------------------
// Metabase AI-first single-stage anomaly analysis
// ---------------------------------------------------------------------------

const DATA_SIDE_VERDICTS = new Set([
  "data_issue",
  "business_change",
  "verified_normal",
  "insufficient_evidence",
]);

const NOTIFICATION_ACTIONS = new Set([
  "send",
  "downgrade",
  "enrich_only",
]);

const CHART_VISIBILITIES = new Set([
  "show",
  "hide_verified_normal",
]);

export function prepareMetabaseInvestigationBatches(cases) {
  return buildDashboardAnalysisJobs(cases);
}

export async function completeMetabaseAnomalyBatch({ rootDir = process.cwd(), batchId, results }) {
  if (!batchId) {
    throw badRequest("batchId is required", ["batchId 不能为空。"]);
  }
  if (!Array.isArray(results)) {
    throw badRequest("results must be an array", ["results 必须是数组。"]);
  }
  if (results.length > 100) {
    throw badRequest("单个 batch 结果不能超过 100 条", ["单个 batch 结果不能超过 100 条。"]);
  }

  const filePath = path.join(rootDir, FILES.anomalyAnalyses);
  const cache = await readJsonFile(filePath, {
    analyzedAt: null,
    verdicts: {},
    batches: [],
  });

  const verdicts = { ...cache.verdicts };
  for (const result of results) {
    const normalized = normalizeDashboardAnalysisVerdict(result);
    verdicts[String(normalized.anomalyIndex)] = normalized;
  }

  const batches = [...cache.batches];
  const existingIndex = batches.findIndex((item) => item.batchId === batchId);
  const batchRecord = {
    batchId,
    status: "completed",
    completedAt: new Date().toISOString(),
    resultCount: results.length,
  };
  if (existingIndex >= 0) {
    batches[existingIndex] = batchRecord;
  } else {
    batches.push(batchRecord);
  }

  const next = {
    ...cache,
    analyzedAt: new Date().toISOString(),
    verdicts,
    batches,
  };
  await writeJsonAtomic(filePath, next);
  return { ok: true, batchId, processed: results.length };
}

export async function completeMetabaseAnomalyAnalysis({ rootDir = process.cwd(), analysis }) {
  const normalized = normalizeDashboardAnalysisVerdict(analysis);
  const filePath = path.join(rootDir, FILES.anomalyAnalyses);
  const cache = await readJsonFile(filePath, {
    analyzedAt: null,
    verdicts: {},
    batches: [],
  });

  const next = {
    ...cache,
    analyzedAt: new Date().toISOString(),
    verdicts: {
      ...cache.verdicts,
      [String(normalized.anomalyIndex)]: normalized,
    },
  };
  await writeJsonAtomic(filePath, next);
  return { ok: true, anomalyIndex: normalized.anomalyIndex };
}

export function normalizeDashboardAnalysisVerdict(verdict) {
  const base = {
    anomalyIndex: Number(verdict?.anomalyIndex ?? -1),
    dataSideVerdict: "insufficient_evidence",
    notificationAction: "enrich_only",
    chartVisibility: "show",
    summary: "",
    possibleCauses: [],
    verificationSteps: [],
    recommendedActions: [],
    confidence: 0,
    limitations: [],
    verificationReason: "",
  };

  if (!verdict || typeof verdict !== "object") {
    return base;
  }

  const dataSideVerdict = String(verdict.dataSideVerdict || "").trim();
  if (DATA_SIDE_VERDICTS.has(dataSideVerdict)) {
    base.dataSideVerdict = dataSideVerdict;
  }

  const notificationAction = String(verdict.notificationAction || "").trim();
  if (NOTIFICATION_ACTIONS.has(notificationAction)) {
    base.notificationAction = notificationAction;
  }

  const chartVisibility = String(verdict.chartVisibility || "").trim();
  if (CHART_VISIBILITIES.has(chartVisibility)) {
    base.chartVisibility = chartVisibility;
  }

  base.summary = String(verdict.summary || "").trim();
  base.verificationReason = String(verdict.verificationReason || verdict.reason || "").trim();
  base.possibleCauses = normalizeStringArray(verdict.possibleCauses);
  base.verificationSteps = normalizeStringArray(verdict.verificationSteps);
  base.recommendedActions = normalizeStringArray(verdict.recommendedActions);
  base.limitations = normalizeStringArray(verdict.limitations);
  base.confidence = clampNumber(verdict.confidence, 0, 1, 0);

  return base;
}

export async function finalizeAiFirstMetabasePatrol(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const cases = options.cases || [];
  const agentEnabled = options.agentEnabled ?? String(process.env.METABASE_ANOMALY_AGENT_ENABLED || "1") === "1";
  const requestFn = options.requestFn || analyzeMetabaseAnomalyBatch;
  const filePath = path.join(rootDir, FILES.anomalyAnalyses);

  const batches = prepareMetabaseInvestigationBatches(cases);
  const startedAt = new Date().toISOString();

  if (!agentEnabled) {
    const cache = await readJsonFile(filePath, { verdicts: {}, batches: [] });
    const timedOutBatches = batches.map((batch) => ({
      batchId: batch.id,
      status: "timed_out",
      timedOutAt: startedAt,
      reason: "METABASE_ANOMALY_AGENT_ENABLED=0",
    }));
    const next = {
      ...cache,
      analyzedAt: startedAt,
      batches: [...cache.batches, ...timedOutBatches],
    };
    await writeJsonAtomic(filePath, next);
    return {
      ok: true,
      phases: { analysis: { submitted: 0, completed: 0, timedOut: batches.length, errors: 0 } },
      agentEnabled: false,
      batches: timedOutBatches,
    };
  }

  const batchStatuses = new Map(batches.map((batch) => [batch.id, { batch, status: "pending" }]));

  const stats = await runBoundedInvestigationQueue(batches, {
    concurrency: options.concurrency,
    timeoutMs: options.timeoutMs,
    async execute(batch) {
      await requestFn(batch);
      batchStatuses.get(batch.id).status = "submitted";
    },
    async onTimeout(batch) {
      batchStatuses.get(batch.id).status = "timed_out";
      const cache = await readJsonFile(filePath, { verdicts: {}, batches: [] });
      await writeJsonAtomic(filePath, {
        ...cache,
        batches: [
          ...cache.batches,
          {
            batchId: batch.id,
            status: "timed_out",
            timedOutAt: new Date().toISOString(),
            reason: "global timeout",
          },
        ],
      });
    },
    async onError(batch, error) {
      batchStatuses.get(batch.id).status = "error";
      batchStatuses.get(batch.id).error = error.message;
    },
  });

  return {
    ok: true,
    phases: {
      analysis: {
        submitted: [...batchStatuses.values()].filter((item) => item.status === "submitted").length,
        completed: stats.completed,
        timedOut: stats.timedOut,
        errors: stats.errors,
      },
    },
    agentEnabled: true,
    batchStatuses: Object.fromEntries([...batchStatuses.entries()].map(([id, item]) => [id, item.status])),
    stats,
  };
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => item !== undefined && item !== null).map(String);
  }
  if (value === undefined || value === null || value === "") {
    return [];
  }
  return [String(value)];
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, number));
}
