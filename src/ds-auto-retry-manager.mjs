import fs from "node:fs";
import path from "node:path";
import { loadDsSchedulerConfig } from "./ds-scheduler-monitor.mjs";
import { countryDateKey, dsStateOf, inspectDsFailureLogs, postDsFailureAction } from "./ds-failure-log-monitor.mjs";
import { notifyText } from "./notifier.mjs";
import { readJsonFile } from "./utils.mjs";

const SUCCESS_STATES = new Set(["SUCCESS", "7"]);
const RUNNING_STATES = new Set(["SUBMITTED_SUCCESS", "RUNNING_EXECUTION", "WAITING_THREAD", "WAITING_DEPEND", "DELAY_EXECUTION", "0", "1", "10", "11", "12"]);
const STOP_STATES = new Set(["STOP", "STOPPED", "KILL", "KILLING", "5", "9"]);
const FAILURE_STATES = new Set(["FAILURE", "FAILED", "6"]);
const ACTIVE_RETRY_STATUSES = new Set(["retrying", "running", "retry_wait"]);
const RETRY_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function failureKey(country, failure) {
  return `${country}:${failure.projectCode}:${failure.instanceId}`;
}

async function loadCountryOwnerConfig(rootDir) {
  const shared = await readJsonFile(path.join(rootDir, "config", "ds-scheduled-failure-watch.json"), { owners: {} });
  const legacy = await readJsonFile(path.join(rootDir, "config", "batch-check-schedule.json"), { countryConfigs: [] });
  return { ...legacy, sharedOwners: shared.owners || {} };
}

function findCountryOwnerConfig(schedule, country) {
  const normalizedCountry = String(country || "").trim().toLowerCase();
  const sharedOwner = String(schedule?.sharedOwners?.[normalizedCountry] || "").trim();
  const legacy = (schedule?.countryConfigs || []).find((item) => String(item?.countryCode || "").trim().toLowerCase() === normalizedCountry) || {};
  return sharedOwner ? { ...legacy, ownerEmails: sharedOwner } : legacy;
}

function buildEmptyRunTimeoutMessage(country, failure, attempts, reference = new Date()) {
  return [
    "DS 空跑任务确认",
    `国家：${String(country || "").toUpperCase()}`,
    `项目：${failure.projectName || failure.projectCode || "-"}`,
    `工作流：${failure.workflowName || failure.workflowCode || "-"}`,
    `实例 ID：${failure.instanceId || "-"}`,
    `失败原因：${failure.failureMessage || failure.retryDecision || "失败节点尚未定位，可能空跑，具体原因需人工确认"}`,
    `原失败实例运行时长：${formatDuration(failureRuntimeMs(failure, reference))}`,
    `自动重跑次数：${attempts}`,
    "处理结果：原失败实例运行超过 1 小时，已判定为空跑；系统未提交重跑，请人工确认。",
  ].join("\n");
}

function failureRuntimeMs(failure = {}, reference = new Date()) {
  const explicit = failure.durationMs ?? failure.runDurationMs ?? failure.duration ?? failure.runDuration;
  if (Number.isFinite(Number(explicit)) && Number(explicit) > 0) return Number(explicit);
  const text = String(explicit || "").trim();
  if (text) {
    const hours = Number(text.match(/(\d+(?:\.\d+)?)\s*h/i)?.[1] || 0);
    const minutes = Number(text.match(/(\d+(?:\.\d+)?)\s*m/i)?.[1] || 0);
    const seconds = Number(text.match(/(\d+(?:\.\d+)?)\s*s/i)?.[1] || 0);
    if (hours || minutes || seconds) return ((hours * 60 + minutes) * 60 + seconds) * 1000;
  }
  const startedAt = Date.parse(failure.startTime || "");
  const endedAt = Date.parse(failure.endTime || "") || reference.getTime();
  return Number.isFinite(startedAt) && endedAt > startedAt ? endedAt - startedAt : 0;
}

function formatDuration(milliseconds) {
  const minutes = Math.max(0, Math.floor(Number(milliseconds || 0) / 60_000));
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

function nestedReleaseState(value) {
  if (!value || typeof value !== "object") return "";
  for (const [key, item] of Object.entries(value)) {
    if (["releasestate", "release_state"].includes(key.toLowerCase()) && item != null && item !== "") {
      const normalized = String(item).trim().toUpperCase();
      if (["ONLINE", "OFFLINE", "0", "1"].includes(normalized)) return normalized;
    }
    const nested = nestedReleaseState(item);
    if (nested) return nested;
  }
  return "";
}

export function createDsAutoRetryManager({
  rootDir,
  inspectFn = inspectDsFailureLogs,
  actionFn = postDsFailureAction,
  configLoader = loadDsSchedulerConfig,
  ownerConfigLoader = loadCountryOwnerConfig,
  notifyFn = notifyText,
  scanIntervalMs = 60_000,
  retryDelayMs = 10_000,
  emptyRunRetryLimitMs = 60 * 60 * 1000,
  now = () => new Date(),
  sleep = delay,
  logger = console,
} = {}) {
  const stateFile = rootDir ? path.join(rootDir, "config", "ds-failure-retry-state.json") : "";
  const persisted = loadRetryState(stateFile);
  const active = new Map();
  const statuses = new Map(Array.isArray(persisted.statuses) ? persisted.statuses : []);
  const logs = pruneExpiredRetryLogs(Array.isArray(persisted.logs) ? persisted.logs : [], now()).slice(-500);
  let scanTimer = null;
  let scanning = false;
  let enabled = Boolean(persisted.enabled);
  let startAt = persisted.startAt && !Number.isNaN(Date.parse(persisted.startAt)) ? new Date(persisted.startAt) : null;
  let countries = Array.isArray(persisted.countries) ? persisted.countries : [];
  let excludedProjects = normalizeExcludedTasks(persisted.excludedProjects);
  let currentRunId = persisted.currentRunId || null;
  let intervalMinutes = Math.max(1, Number(persisted.intervalMinutes) || Math.round(scanIntervalMs / 60_000) || 1);
  let retryMinute = normalizeRetryMinute(persisted.retryMinute);
  let nextRunAt = parseDate(persisted.nextRunAt);
  let lastRunAt = parseDate(persisted.lastRunAt);
  let manualRunning = false;
  let manualRunToken = 0;

  const persistState = () => saveRetryState(stateFile, {
    enabled,
    startAt: startAt?.toISOString() || null,
    countries,
    excludedProjects,
    currentRunId,
    intervalMinutes,
    retryMinute,
    nextRunAt: nextRunAt?.toISOString() || null,
    lastRunAt: lastRunAt?.toISOString() || null,
    logs: logs.slice(-500),
    statuses: [...statuses.entries()],
  }, logger);

  const pruneLogs = () => {
    const retained = pruneExpiredRetryLogs(logs, now());
    if (retained.length === logs.length) return false;
    logs.splice(0, logs.length, ...retained);
    return true;
  };

  const appendLog = (level, event, detail = {}) => {
    logs.push({ id: `${now().getTime()}-${logs.length + 1}`, runId: detail.runId || currentRunId, time: now().toISOString(), level, event, ...detail });
    pruneLogs();
    if (logs.length > 500) logs.splice(0, logs.length - 500);
    persistState();
  };

  const setStatus = (key, patch) => {
    statuses.set(key, { ...(statuses.get(key) || {}), ...patch, updatedAt: now().toISOString() });
    persistState();
  };

  async function runLoop(country, failure, { manual = false, runId = currentRunId } = {}) {
    const key = failureKey(country, failure);
    const startedDate = countryDateKey(country, new Date(failure.startTime || now()));
    const taskDetail = failureTaskDetail(failure);
    let attempts = Number(statuses.get(key)?.attempts || 0);
    let submittedThisRun = false;
    const runLog = (level, event, detail = {}) => appendLog(level, event, { runId, ...detail });
    try {
      while (true) {
        if (manual && !manualRunning) {
          setStatus(key, { autoRetryStatus: "safety_stopped", stopReason: "已停止立即运行测试", attempts });
          runLog("info", "manual_run_stopped", { key, country, attempts, ...taskDetail, message: "已停止立即运行测试" });
          return;
        }
        if (!enabled && !manual) {
          setStatus(key, { autoRetryStatus: "safety_stopped", stopReason: "页面已停止自动重跑", attempts });
          runLog("info", "retry_stopped", { key, country, attempts, ...taskDetail, message: "页面已停止自动重跑" });
          return;
        }
        const config = await configLoader(rootDir);
        const countryConfig = config.countries?.[country] || {};
        const token = String(countryConfig.token || "").trim();
        const webhookUrl = String(config.n8nWebhookUrl || "").trim();
        if (!token || !webhookUrl) {
          setStatus(key, { autoRetryStatus: "safety_stopped", stopReason: "DS Token 或网关未配置", attempts });
          runLog("error", "configuration_error", { key, country, attempts, ...taskDetail, message: "DS Token 或网关未配置" });
          return;
        }
        const payload = {
          project_code: failure.projectCode,
          instance_id: failure.instanceId,
          process_instance_id: failure.instanceId,
        };
        let instance;
        try {
          instance = await actionFn({ webhookUrl, country, token, action: "get_instance", payload });
        } catch (error) {
          setStatus(key, { autoRetryStatus: "retry_wait", lastError: error.message, attempts });
          runLog("error", "instance_check_failed", { key, country, attempts, ...taskDetail, message: error.message });
          return;
        }
        const state = dsStateOf(instance?.data || instance);
        if (SUCCESS_STATES.has(state)) {
          setStatus(key, { autoRetryStatus: "recovered", stopReason: "重跑成功", attempts, recoveryState: state });
          runLog("success", "recovered", { key, country, attempts, state, ...taskDetail, message: "实例重跑成功" });
          return;
        }
        const currentDate = countryDateKey(country, now());
        if (currentDate !== startedDate) {
          const stopReason = `DS 最新实例状态为 ${state || "UNKNOWN"}，失败实例日期 ${startedDate} 与当前业务日期 ${currentDate} 不一致；为避免跨日误重跑，已安全停止`;
          setStatus(key, {
            autoRetryStatus: "safety_stopped",
            stopReason,
            attempts,
            recoveryState: state,
            failureDate: startedDate,
            currentDate,
          });
          runLog("warn", "safety_stopped", {
            key,
            country,
            attempts,
            state,
            failureDate: startedDate,
            currentDate,
            ...taskDetail,
            message: stopReason,
          });
          return;
        }
        try {
          const workflow = await actionFn({
            webhookUrl,
            country,
            token,
            action: "get_workflow",
            payload: { project_code: failure.projectCode, workflow_code: failure.workflowCode },
          });
          const releaseState = nestedReleaseState(workflow);
          if (releaseState === "OFFLINE" || releaseState === "0") {
            setStatus(key, { autoRetryStatus: "safety_stopped", stopReason: "工作流已下线", attempts, releaseState });
            runLog("warn", "safety_stopped", { key, country, attempts, releaseState, ...taskDetail, message: "工作流已下线" });
            return;
          }
        } catch (error) {
          setStatus(key, { autoRetryStatus: "retry_wait", lastError: `工作流状态读取失败：${error.message}`, attempts });
          runLog("error", "workflow_check_failed", { key, country, attempts, ...taskDetail, message: error.message });
          return;
        }
        if (RUNNING_STATES.has(state)) {
          setStatus(key, { autoRetryStatus: "running", attempts, recoveryState: state, stopReason: "" });
          if (!submittedThisRun) {
            runLog("info", "retry_already_running", { key, country, attempts, state, ...taskDetail, message: "实例当前正在运行，本轮不重复提交重跑" });
            return;
          }
          await sleep(retryDelayMs);
          continue;
        }
        if (!FAILURE_STATES.has(state) && !STOP_STATES.has(state)) {
          setStatus(key, { autoRetryStatus: "manual_review", stopReason: `实例状态 ${state || "UNKNOWN"} 无法安全重跑`, attempts });
          runLog("warn", "manual_review", { key, country, attempts, state, ...taskDetail, message: "实例状态无法安全重跑" });
          return;
        }
        if (submittedThisRun) {
          setStatus(key, { autoRetryStatus: "unresolved", stopReason: "本轮已重跑 1 次但仍未修复", attempts, recoveryState: state });
          runLog("warn", "retry_not_recovered", { key, country, attempts, state, ...taskDetail, message: "本轮已重跑 1 次，任务仍未修复" });
          return;
        }
        if (manual && !manualRunning) return;
        try {
          const executionType = STOP_STATES.has(state) ? "REPEAT_RUNNING" : "START_FAILURE_TASK_PROCESS";
          await actionFn({
            webhookUrl,
            country,
            token,
            action: "retry_instance",
            payload: { ...payload, execution_type: executionType },
          });
          attempts += 1;
          setStatus(key, { autoRetryStatus: "retrying", attempts, lastAttemptAt: now().toISOString(), lastError: "", stopReason: "" });
          runLog("info", "retry_submitted", {
            key,
            country,
            attempts,
            state,
            executionType,
            ...taskDetail,
            message: STOP_STATES.has(state)
              ? `停止态实例已按整实例方式提交第 ${attempts} 次重跑`
              : `失败态实例已按失败节点恢复方式提交第 ${attempts} 次重跑`,
          });
          submittedThisRun = true;
        } catch (error) {
          setStatus(key, { autoRetryStatus: "retry_wait", attempts, lastError: error.message });
          runLog("error", "retry_failed", { key, country, attempts, ...taskDetail, message: error.message });
          return;
        }
        await sleep(retryDelayMs);
      }
    } finally {
      active.delete(key);
    }
  }

  async function stopConfirmedEmptyRun(country, failure, key, runId) {
    const attempts = Number(statuses.get(key)?.attempts || 0);
    const taskDetail = failureTaskDetail(failure);
    const runtimeMs = failureRuntimeMs(failure, now());
    setStatus(key, { autoRetryStatus: "safety_stopped", stopReason: "原失败实例运行超过 1 小时，已判定为空跑，不执行重跑", attempts, originalRuntimeMs: runtimeMs, emptyRunConfirmed: true });
    appendLog("warn", "empty_run_confirmed", { runId, key, country, attempts, originalRuntimeMs: runtimeMs, ...taskDetail, message: `原失败实例运行 ${formatDuration(runtimeMs)}，已判定为空跑，本轮不提交重跑` });
    try {
      const config = await configLoader(rootDir);
      const countryConfig = config.countries?.[country] || {};
      const token = String(countryConfig.token || "").trim();
      const webhookUrl = String(config.n8nWebhookUrl || "").trim();
      if (!token || !webhookUrl) {
        appendLog("warn", "owner_notification_skipped", { runId, key, country, attempts, ...taskDetail, message: "无法读取 DS 实例实时状态，未发送空跑告警" });
        return;
      }
      const instance = await actionFn({
        webhookUrl,
        country,
        token,
        action: "get_instance",
        payload: { project_code: failure.projectCode, instance_id: failure.instanceId, process_instance_id: failure.instanceId },
      });
      const currentState = dsStateOf(instance?.data || instance);
      if (!RUNNING_STATES.has(currentState)) {
        appendLog("info", "owner_notification_skipped", { runId, key, country, attempts, currentState, ...taskDetail, message: `DS 实例当前状态为 ${currentState || "UNKNOWN"}，不是运行中，不发送负责人告警` });
        return;
      }
      const schedule = await ownerConfigLoader(rootDir);
      const ownerConfig = findCountryOwnerConfig(schedule, country);
      const ownerEmails = String(ownerConfig.ownerEmails || ownerConfig.recipientEmails || "").trim();
      if (!ownerEmails) {
        appendLog("warn", "owner_notification_skipped", { runId, key, country, attempts, ...taskDetail, message: "未配置该国家负责人邮箱，未发送空跑告警" });
        return;
      }
      const notification = await notifyFn({ alerts: { channel: "knBot", botToken: ownerConfig.botToken || "${KN_BOT_TOKEN}", recipientEmails: ownerEmails } }, buildEmptyRunTimeoutMessage(country, failure, attempts, now()), {
        title: "DS 空跑任务确认",
        severity: "warning",
        timestamp: now().toISOString(),
      });
      if (!notification?.sent) throw new Error(notification?.reason || "负责人告警未发送");
      appendLog("success", "owner_notification_sent", { runId, key, country, attempts, ...taskDetail, message: `空跑告警已发送给负责人：${ownerEmails}` });
    } catch (error) {
      appendLog("error", "owner_notification_failed", { runId, key, country, attempts, ...taskDetail, message: `DS 实例状态确认或负责人告警发送失败：${error.message}` });
    }
  }

  async function scan({ force = false, manual = false, runId = currentRunId } = {}) {
    if (!enabled && !force) return { skipped: true, reason: "disabled" };
    if (!force && startAt && now().getTime() < startAt.getTime()) return { skipped: true, reason: "scheduled", startAt: startAt.toISOString() };
    if (scanning) return { skipped: true };
    scanning = true;
    const startedTasks = [];
    try {
      const result = await inspectFn(rootDir);
      if (manual && !manualRunning) return { skipped: true, reason: "manual_stopped" };
      for (const countryResult of result.countries || []) {
        if (countries.length && !countries.includes(countryResult.country)) continue;
        for (const failure of countryResult.failures || []) {
          const key = failureKey(countryResult.country, failure);
          if (isExcludedProject(countryResult.country, failure, excludedProjects)) {
            const previous = statuses.get(key);
            setStatus(key, { autoRetryStatus: "manual_review", stopReason: "已在重跑排除配置中指定为不重跑" });
            if (previous?.stopReason !== "已在重跑排除配置中指定为不重跑") {
              appendLog("info", "excluded", { runId, key, country: countryResult.country, ...failureTaskDetail(failure), message: "该项目已关闭重跑，项目内所有工作流均不执行自动重跑" });
            }
            continue;
          }
          if (failure.repairStatus === "recovered") {
            setStatus(key, { autoRetryStatus: "recovered", stopReason: "已修复" });
            continue;
          }
          if (failure.failureType === "suspected_empty_run" && failureRuntimeMs(failure, now()) > emptyRunRetryLimitMs) {
            if (statuses.get(key)?.emptyRunConfirmed) continue;
            await stopConfirmedEmptyRun(countryResult.country, failure, key, runId);
            continue;
          }
          if (!failure.retryable) {
            setStatus(key, {
              autoRetryStatus: failure.failureType || "manual_review",
              stopReason: failure.retryDecision || "不满足自动重跑条件",
            });
            appendLog("info", "skipped", { runId, key, country: countryResult.country, ...failureTaskDetail(failure), message: failure.retryDecision || "不满足自动重跑条件" });
            continue;
          }
          if (!active.has(key)) {
            setStatus(key, { autoRetryStatus: "retrying", attempts: Number(statuses.get(key)?.attempts || 0), stopReason: "", runId });
            appendLog("info", "retry_started", { runId, key, country: countryResult.country, attempts: Number(statuses.get(key)?.attempts || 0), ...failureTaskDetail(failure), message: "开始处理符合条件的失败任务" });
            const task = runLoop(countryResult.country, failure, { manual, runId }).catch((error) => {
              logger.error?.(`[ds-auto-retry] ${key}: ${error.message}`);
              setStatus(key, { autoRetryStatus: "retry_wait", lastError: error.message });
            });
            active.set(key, task);
            startedTasks.push(task);
          }
        }
      }
      if (startedTasks.length) await Promise.allSettled(startedTasks);
      return { skipped: false, failures: result.totalFailures || 0, active: active.size, started: startedTasks.length };
    } finally {
      scanning = false;
    }
  }

  function decorate(result) {
    return {
      ...result,
      countries: (result.countries || []).map((country) => ({
        ...country,
        failures: (country.failures || []).map((failure) => {
          const decorated = { ...failure, ...(statuses.get(failureKey(country.country, failure)) || {}) };
          return failure.repairStatus === "recovered"
            ? { ...decorated, autoRetryStatus: "recovered", stopReason: "已检测到后续成功实例" }
            : decorated;
        }),
      })),
    };
  }

  function start() {
    if (scanTimer) return;
    if (enabled) scheduleAutomaticScan();
  }

  function scheduleAutomaticScan() {
    if (scanTimer) clearTimeout(scanTimer);
    if (!enabled) return;
    if (nextRunAt && nextRunAt.getTime() <= now().getTime()) {
      nextRunAt = advanceScheduledTime(nextRunAt, intervalMinutes, now());
    } else if (!nextRunAt) {
      nextRunAt = nextMinuteOccurrence(now(), retryMinute);
    }
    persistState();
    const delayMs = Math.max(1, nextRunAt.getTime() - now().getTime());
    scanTimer = setTimeout(async () => {
      const scheduledAt = nextRunAt;
      try {
        lastRunAt = now();
        currentRunId = `ds-retry-scheduled-${now().getTime()}`;
        const runId = currentRunId;
        appendLog("info", "scheduled_run_started", { runId, message: "开始执行本轮定时自动重跑", countries, lastRunAt: lastRunAt.toISOString() });
        const result = await scan({ runId });
        appendLog("success", "scheduled_run_completed", { runId, message: "本轮定时自动重跑检查已完成", countries, failures: Number(result?.failures || 0) });
      } catch (error) {
        logger.error?.("[ds-auto-retry] scan failed:", error);
      } finally {
        nextRunAt = advanceScheduledTime(scheduledAt || now(), intervalMinutes, now());
        scheduleAutomaticScan();
      }
    }, delayMs);
    scanTimer.unref?.();
  }

  function enable(options = {}) {
    const parsed = now();
    if (Number.isNaN(parsed.getTime())) throw new Error("重跑开始时间无效");
    enabled = true;
    startAt = parsed;
    countries = Array.isArray(options.countries) ? [...new Set(options.countries.map((item) => String(item).trim().toLowerCase()).filter(Boolean))] : [];
    excludedProjects = normalizeExcludedTasks(options.excludedProjects ?? excludedProjects);
    intervalMinutes = Math.max(1, Number(options.intervalMinutes) || intervalMinutes || 1);
    retryMinute = normalizeRetryMinute(options.retryMinute);
    nextRunAt = nextMinuteOccurrence(now(), retryMinute);
    lastRunAt = null;
    currentRunId = null;
    persistState();
    scheduleAutomaticScan();
    return control();
  }

  function runNow(options = {}) {
    if (manualRunning) return control();
    if (Array.isArray(options.countries)) {
      countries = [...new Set(options.countries.map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
    }
    excludedProjects = normalizeExcludedTasks(options.excludedProjects ?? excludedProjects);
    currentRunId = `ds-retry-manual-${now().getTime()}`;
    const runId = currentRunId;
    manualRunning = true;
    const token = ++manualRunToken;
    appendLog("info", "manual_run", { runId, message: "已手动立即运行一次重跑检查", countries });
    scan({ force: true, manual: true, runId })
      .catch((error) => logger.error?.("[ds-auto-retry] manual scan failed:", error))
      .finally(() => {
        if (manualRunToken !== token) return;
        manualRunning = false;
        appendLog("success", "manual_run_completed", { runId, message: "立即运行测试已完成", countries });
      });
    return control();
  }

  function stopManualRun() {
    manualRunning = false;
    manualRunToken += 1;
    appendLog("info", "manual_run_stopped", { runId: currentRunId, message: "已从页面停止立即运行测试", countries });
    return control();
  }

  function configure(options = {}) {
    if (options.excludedProjects !== undefined) excludedProjects = normalizeExcludedTasks(options.excludedProjects);
    if (Array.isArray(options.countries)) {
      countries = [...new Set(options.countries.map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
    }
    persistState();
    return control();
  }

  function disable() {
    enabled = false;
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = null;
    nextRunAt = null;
    persistState();
    return control();
  }

  function control() {
    const activeKeys = new Set(active.keys());
    if (enabled || manualRunning) {
      for (const [key, status] of statuses.entries()) {
        if (status?.runId === currentRunId && ACTIVE_RETRY_STATUSES.has(status?.autoRetryStatus)) activeKeys.add(key);
      }
    }
    return { enabled, startAt: startAt?.toISOString() || null, countries, excludedProjects, intervalMinutes, retryMinute, nextRunAt: nextRunAt?.toISOString() || null, lastRunAt: lastRunAt?.toISOString() || null, manualRunning, activeCount: activeKeys.size, logCount: logs.length, currentRunId };
  }

  function getLogs(limit = 200) {
    if (pruneLogs()) persistState();
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 200));
    return logs.slice(-safeLimit).reverse();
  }

  function deleteRunLogs(runId) {
    const target = String(runId || "").trim();
    if (!target) throw new Error("缺少要删除的重跑记录编号");
    const before = logs.length;
    for (let index = logs.length - 1; index >= 0; index -= 1) {
      if (String(logs[index]?.runId || `legacy-${logs[index]?.id}`) === target) logs.splice(index, 1);
    }
    persistState();
    return { deleted: before - logs.length, runId: target, logCount: logs.length };
  }

  async function testOwnerNotification(options = {}) {
    const requestedCountry = String(options.country || "").trim().toLowerCase();
    const schedule = await ownerConfigLoader(rootDir);
    const countryCodes = new Set([
      ...Object.keys(schedule?.sharedOwners || {}),
      ...(schedule?.countryConfigs || []).map((item) => String(item?.countryCode || "").trim().toLowerCase()),
    ]);
    const targets = [...countryCodes]
      .map((country) => {
        const owner = findCountryOwnerConfig(schedule, country);
        return {
          country,
          emails: String(owner.ownerEmails || owner.recipientEmails || "").trim(),
          botToken: owner.botToken || "${KN_BOT_TOKEN}",
        };
      })
      .filter((item) => item.country && item.emails && (!requestedCountry || item.country === requestedCountry));
    if (!targets.length) {
      throw new Error(requestedCountry ? `国家 ${requestedCountry.toUpperCase()} 未配置负责人邮箱` : "未配置可测试的国家负责人邮箱");
    }

    const runId = `ds-owner-notification-test-${now().getTime()}`;
    const results = [];
    for (const target of targets) {
      try {
        const notification = await notifyFn({
          alerts: {
            channel: "knBot",
            botToken: target.botToken,
            recipientEmails: target.emails,
          },
        }, [
          "DS 失败任务负责人通知测试",
          `国家：${target.country.toUpperCase()}`,
          `测试时间：${now().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
          "这是一条通知链路测试消息，不代表真实生产故障，无需处理。",
        ].join("\n"), {
          title: "DS 失败任务负责人通知测试",
          severity: "info",
          timestamp: now().toISOString(),
        });
        if (!notification?.sent) throw new Error(notification?.reason || "负责人测试通知未发送");
        appendLog("success", "owner_notification_test_sent", {
          runId,
          country: target.country,
          message: `负责人通知测试发送成功（${target.emails.split(/[，,；;\n]/).filter(Boolean).length} 个接收人）`,
        });
        results.push({ country: target.country, sent: true });
      } catch (error) {
        appendLog("error", "owner_notification_test_failed", {
          runId,
          country: target.country,
          message: `负责人通知测试发送失败：${error.message}`,
        });
        results.push({ country: target.country, sent: false, reason: error.message });
      }
    }
    return { sent: results.every((item) => item.sent), runId, results };
  }

  function stop() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = null;
  }

  return { start, stop, scan, enable, disable, configure, runNow, stopManualRun, control, getLogs, deleteRunLogs, testOwnerNotification, decorate, statuses, active, logs };
}

function normalizeRetryMinute(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 59) return 0;
  return parsed;
}

function parseDate(value) {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
}

function nextMinuteOccurrence(reference, minute) {
  const next = new Date(reference);
  next.setSeconds(0, 0);
  next.setMinutes(normalizeRetryMinute(minute));
  if (next.getTime() <= reference.getTime()) next.setHours(next.getHours() + 1);
  return next;
}

function advanceScheduledTime(previous, interval, reference) {
  const next = new Date(previous);
  const step = Math.max(60, Number(interval) || 60) * 60_000;
  do next.setTime(next.getTime() + step); while (next.getTime() <= reference.getTime());
  return next;
}

function failureTaskDetail(failure = {}) {
  return {
    projectCode: String(failure.projectCode || ""),
    projectName: String(failure.projectName || ""),
    workflowCode: String(failure.workflowCode || ""),
    workflowName: String(failure.workflowName || ""),
    taskCode: String(failure.taskCode || ""),
    taskName: String(failure.taskName || ""),
    instanceId: String(failure.instanceId || ""),
    dsInstanceUrl: String(failure.dsInstanceUrl || ""),
    failureReason: String(failure.failureMessage || failure.retryDecision || "任务日志未返回明确失败原因"),
  };
}

function normalizeExcludedTasks(value) {
  const result = {};
  for (const [country, tasks] of Object.entries(value && typeof value === "object" ? value : {})) {
    const code = String(country || "").trim().toLowerCase();
    if (!code) continue;
    const normalized = Array.isArray(tasks) ? tasks : String(tasks || "").split(/[，,；;\n]/);
    result[code] = [...new Set(normalized.map((item) => String(item || "").trim()).filter(Boolean))];
  }
  return result;
}

function isExcludedProject(country, failure, excludedProjects) {
  const configured = excludedProjects[String(country || "").trim().toLowerCase()] || [];
  if (!configured.length) return false;
  const identities = [failure.projectName, failure.projectCode]
    .map((item) => String(item || "").trim().toLowerCase())
    .filter(Boolean);
  return configured.some((item) => identities.includes(String(item).trim().toLowerCase()));
}

function loadRetryState(filePath) {
  if (!filePath) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

function saveRetryState(filePath, state, logger) {
  if (!filePath) return;
  try {
    if (!fs.existsSync(path.dirname(filePath))) return;
    const temporary = `${filePath}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, filePath);
  } catch (error) {
    logger.warn?.(`[ds-auto-retry] state persistence failed: ${error.message}`);
  }
}

function pruneExpiredRetryLogs(logs, reference = new Date()) {
  const cutoff = reference.getTime() - RETRY_LOG_RETENTION_MS;
  const newestByRun = new Map();
  for (const item of logs) {
    const runId = String(item?.runId || `legacy-${item?.id || ""}`);
    const timestamp = Date.parse(item?.time || "");
    newestByRun.set(runId, Math.max(newestByRun.get(runId) || 0, Number.isFinite(timestamp) ? timestamp : 0));
  }
  return logs.filter((item) => {
    const runId = String(item?.runId || `legacy-${item?.id || ""}`);
    return (newestByRun.get(runId) || 0) >= cutoff;
  });
}
