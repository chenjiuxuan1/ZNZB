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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function failureKey(country, failure) {
  return `${country}:${failure.projectCode}:${failure.instanceId}`;
}

async function loadCountryOwnerConfig(rootDir) {
  return readJsonFile(path.join(rootDir, "config", "batch-check-schedule.json"), { countryConfigs: [] });
}

function findCountryOwnerConfig(schedule, country) {
  const normalizedCountry = String(country || "").trim().toLowerCase();
  return (schedule?.countryConfigs || []).find((item) => String(item?.countryCode || "").trim().toLowerCase() === normalizedCountry) || {};
}

function buildEmptyRunTimeoutMessage(country, failure, attempts) {
  return [
    "DS 疑似空跑任务自动重跑超时",
    `国家：${String(country || "").toUpperCase()}`,
    `项目：${failure.projectName || failure.projectCode || "-"}`,
    `工作流：${failure.workflowName || failure.workflowCode || "-"}`,
    `实例 ID：${failure.instanceId || "-"}`,
    `失败原因：${failure.failureMessage || failure.retryDecision || "失败节点尚未定位，可能空跑，具体原因需人工确认"}`,
    `自动重跑次数：${attempts}`,
    "处理结果：自动重跑已满 1 小时，系统已停止继续重跑，请人工确认。",
  ].join("\n");
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
  const logs = Array.isArray(persisted.logs) ? persisted.logs.slice(-500) : [];
  let scanTimer = null;
  let scanning = false;
  let enabled = Boolean(persisted.enabled);
  let startAt = persisted.startAt && !Number.isNaN(Date.parse(persisted.startAt)) ? new Date(persisted.startAt) : null;
  let countries = Array.isArray(persisted.countries) ? persisted.countries : [];
  let excludedTasks = normalizeExcludedTasks(persisted.excludedTasks);
  let currentRunId = persisted.currentRunId || null;
  let intervalMinutes = Math.max(1, Number(persisted.intervalMinutes) || Math.round(scanIntervalMs / 60_000) || 1);
  let retryMinute = normalizeRetryMinute(persisted.retryMinute);
  let nextRunAt = parseDate(persisted.nextRunAt);
  let manualRunning = false;
  let manualRunToken = 0;

  const persistState = () => saveRetryState(stateFile, {
    enabled,
    startAt: startAt?.toISOString() || null,
    countries,
    excludedTasks,
    currentRunId,
    intervalMinutes,
    retryMinute,
    nextRunAt: nextRunAt?.toISOString() || null,
    logs: logs.slice(-500),
    statuses: [...statuses.entries()],
  }, logger);

  const appendLog = (level, event, detail = {}) => {
    logs.push({ id: `${now().getTime()}-${logs.length + 1}`, runId: detail.runId || currentRunId, time: now().toISOString(), level, event, ...detail });
    if (logs.length > 500) logs.splice(0, logs.length - 500);
    persistState();
  };

  const setStatus = (key, patch) => {
    statuses.set(key, { ...(statuses.get(key) || {}), ...patch, updatedAt: now().toISOString() });
    persistState();
  };

  async function runLoop(country, failure, { manual = false } = {}) {
    const key = failureKey(country, failure);
    const startedDate = countryDateKey(country, new Date(failure.startTime || now()));
    const retryStartedAt = now().getTime();
    const taskDetail = failureTaskDetail(failure);
    let attempts = Number(statuses.get(key)?.attempts || 0);
    try {
      while (true) {
        if (manual && !manualRunning) {
          setStatus(key, { autoRetryStatus: "safety_stopped", stopReason: "已停止立即运行测试", attempts });
          appendLog("info", "manual_run_stopped", { key, country, attempts, ...taskDetail, message: "已停止立即运行测试" });
          return;
        }
        if (!enabled && !manual) {
          setStatus(key, { autoRetryStatus: "safety_stopped", stopReason: "页面已停止自动重跑", attempts });
          appendLog("info", "retry_stopped", { key, country, attempts, ...taskDetail, message: "页面已停止自动重跑" });
          return;
        }
        if (failure.failureType === "suspected_empty_run" && now().getTime() - retryStartedAt >= emptyRunRetryLimitMs) {
          setStatus(key, { autoRetryStatus: "safety_stopped", stopReason: "疑似空跑任务重跑已满 1 小时，自动关闭并等待人工确认", attempts });
          appendLog("warn", "empty_run_timeout", { key, country, attempts, ...taskDetail, message: "疑似空跑任务重跑超过 1 小时，已自动关闭" });
          try {
            const schedule = await ownerConfigLoader(rootDir);
            const ownerConfig = findCountryOwnerConfig(schedule, country);
            const ownerEmails = String(ownerConfig.ownerEmails || ownerConfig.recipientEmails || "").trim();
            if (!ownerEmails) {
              appendLog("warn", "owner_notification_skipped", { key, country, attempts, ...taskDetail, message: "未配置该国家负责人邮箱，未发送超时告警" });
            } else {
              const notification = await notifyFn({
                alerts: {
                  channel: "knBot",
                  botToken: ownerConfig.botToken || "${KN_BOT_TOKEN}",
                  recipientEmails: ownerEmails,
                },
              }, buildEmptyRunTimeoutMessage(country, failure, attempts), {
                title: "DS 疑似空跑重跑超时",
                severity: "warning",
                timestamp: now().toISOString(),
              });
              if (!notification?.sent) throw new Error(notification?.reason || "负责人告警未发送");
              appendLog("success", "owner_notification_sent", { key, country, attempts, ...taskDetail, message: `超时告警已发送给负责人：${ownerEmails}` });
            }
          } catch (error) {
            appendLog("error", "owner_notification_failed", { key, country, attempts, ...taskDetail, message: `负责人告警发送失败：${error.message}` });
          }
          return;
        }
        if (countryDateKey(country, now()) !== startedDate) {
          setStatus(key, { autoRetryStatus: "safety_stopped", stopReason: "失败实例已跨天，自动重跑终止", attempts });
          appendLog("warn", "safety_stopped", { key, country, attempts, ...taskDetail, message: "失败实例已跨天" });
          return;
        }
        const config = await configLoader(rootDir);
        const countryConfig = config.countries?.[country] || {};
        const token = String(countryConfig.token || "").trim();
        const webhookUrl = String(config.n8nWebhookUrl || "").trim();
        if (!token || !webhookUrl) {
          setStatus(key, { autoRetryStatus: "safety_stopped", stopReason: "DS Token 或网关未配置", attempts });
          appendLog("error", "configuration_error", { key, country, attempts, ...taskDetail, message: "DS Token 或网关未配置" });
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
          appendLog("error", "instance_check_failed", { key, country, attempts, ...taskDetail, message: error.message });
          if (manual) return;
          await sleep(retryDelayMs);
          continue;
        }
        const state = dsStateOf(instance?.data || instance);
        if (SUCCESS_STATES.has(state)) {
          setStatus(key, { autoRetryStatus: "recovered", stopReason: "重跑成功", attempts, recoveryState: state });
          appendLog("success", "recovered", { key, country, attempts, state, ...taskDetail, message: "实例重跑成功" });
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
            appendLog("warn", "safety_stopped", { key, country, attempts, releaseState, ...taskDetail, message: "工作流已下线" });
            return;
          }
        } catch (error) {
          setStatus(key, { autoRetryStatus: "retry_wait", lastError: `工作流状态读取失败：${error.message}`, attempts });
          appendLog("error", "workflow_check_failed", { key, country, attempts, ...taskDetail, message: error.message });
          if (manual) return;
          await sleep(retryDelayMs);
          continue;
        }
        if (RUNNING_STATES.has(state)) {
          setStatus(key, { autoRetryStatus: "running", attempts, recoveryState: state, stopReason: "" });
          if (manual) return;
          await sleep(retryDelayMs);
          continue;
        }
        if (!FAILURE_STATES.has(state) && !STOP_STATES.has(state)) {
          setStatus(key, { autoRetryStatus: "manual_review", stopReason: `实例状态 ${state || "UNKNOWN"} 无法安全重跑`, attempts });
          appendLog("warn", "manual_review", { key, country, attempts, state, ...taskDetail, message: "实例状态无法安全重跑" });
          return;
        }
        if (manual && !manualRunning) return;
        try {
          await actionFn({ webhookUrl, country, token, action: "retry_instance", payload });
          attempts += 1;
          setStatus(key, { autoRetryStatus: "retrying", attempts, lastAttemptAt: now().toISOString(), lastError: "", stopReason: "" });
          appendLog("info", "retry_submitted", { key, country, attempts, state, ...taskDetail, message: `已提交第 ${attempts} 次重跑` });
          if (manual) return;
        } catch (error) {
          setStatus(key, { autoRetryStatus: "retry_wait", attempts, lastError: error.message });
          appendLog("error", "retry_failed", { key, country, attempts, ...taskDetail, message: error.message });
          if (manual) return;
        }
        await sleep(intervalMinutes * 60_000);
      }
    } finally {
      active.delete(key);
    }
  }

  async function scan({ force = false, manual = false } = {}) {
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
          if (isExcludedFailure(countryResult.country, failure, excludedTasks)) {
            const previous = statuses.get(key);
            setStatus(key, { autoRetryStatus: "manual_review", stopReason: "已在重跑排除配置中指定为不重跑" });
            if (previous?.stopReason !== "已在重跑排除配置中指定为不重跑") {
              appendLog("info", "excluded", { key, country: countryResult.country, ...failureTaskDetail(failure), message: "该任务已被重跑排除配置命中，不执行自动重跑" });
            }
            continue;
          }
          if (failure.repairStatus === "recovered") {
            setStatus(key, { autoRetryStatus: "recovered", stopReason: "已修复" });
            continue;
          }
          if (!failure.retryable) {
            setStatus(key, {
              autoRetryStatus: failure.failureType || "manual_review",
              stopReason: failure.retryDecision || "不满足自动重跑条件",
            });
            appendLog("info", "skipped", { key, country: countryResult.country, ...failureTaskDetail(failure), message: failure.retryDecision || "不满足自动重跑条件" });
            continue;
          }
          if (!active.has(key)) {
            setStatus(key, { autoRetryStatus: "retrying", attempts: Number(statuses.get(key)?.attempts || 0), stopReason: "", runId: currentRunId });
            appendLog("info", "retry_started", { key, country: countryResult.country, attempts: Number(statuses.get(key)?.attempts || 0), ...failureTaskDetail(failure), message: "开始处理符合条件的失败任务" });
            const task = runLoop(countryResult.country, failure, { manual }).catch((error) => {
              logger.error?.(`[ds-auto-retry] ${key}: ${error.message}`);
              setStatus(key, { autoRetryStatus: "retry_wait", lastError: error.message });
            });
            active.set(key, task);
            startedTasks.push(task);
          }
        }
      }
      if (manual && startedTasks.length) await Promise.allSettled(startedTasks);
      return { skipped: false, failures: result.totalFailures || 0, active: active.size };
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
        await scan();
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
    excludedTasks = normalizeExcludedTasks(options.excludedTasks ?? excludedTasks);
    intervalMinutes = Math.max(1, Number(options.intervalMinutes) || intervalMinutes || 1);
    retryMinute = normalizeRetryMinute(options.retryMinute);
    nextRunAt = nextMinuteOccurrence(now(), retryMinute);
    currentRunId = `ds-retry-${now().getTime()}`;
    appendLog("info", "control_enabled", { message: `已启用自动重跑，每隔 ${intervalMinutes / 60} 小时运行；首次运行：${nextRunAt.toISOString()}`, startAt: startAt.toISOString(), countries, intervalMinutes, retryMinute, nextRunAt: nextRunAt.toISOString() });
    scheduleAutomaticScan();
    return control();
  }

  function runNow(options = {}) {
    if (manualRunning) return control();
    if (Array.isArray(options.countries)) {
      countries = [...new Set(options.countries.map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
    }
    excludedTasks = normalizeExcludedTasks(options.excludedTasks ?? excludedTasks);
    currentRunId = `ds-retry-manual-${now().getTime()}`;
    const runId = currentRunId;
    manualRunning = true;
    const token = ++manualRunToken;
    appendLog("info", "manual_run", { message: "已手动立即运行一次重跑检查", countries });
    scan({ force: true, manual: true })
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
    appendLog("info", "manual_run_stopped", { message: "已从页面停止立即运行测试", countries });
    return control();
  }

  function configure(options = {}) {
    excludedTasks = normalizeExcludedTasks(options.excludedTasks);
    persistState();
    return control();
  }

  function disable() {
    enabled = false;
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = null;
    nextRunAt = null;
    appendLog("info", "control_disabled", { message: "已从页面停止自动重跑" });
    return control();
  }

  function control() {
    const activeKeys = new Set(active.keys());
    if (enabled || manualRunning) {
      for (const [key, status] of statuses.entries()) {
        if (status?.runId === currentRunId && ACTIVE_RETRY_STATUSES.has(status?.autoRetryStatus)) activeKeys.add(key);
      }
    }
    return { enabled, startAt: startAt?.toISOString() || null, countries, excludedTasks, intervalMinutes, retryMinute, nextRunAt: nextRunAt?.toISOString() || null, manualRunning, activeCount: activeKeys.size, logCount: logs.length, currentRunId };
  }

  function getLogs(limit = 200) {
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

  function stop() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = null;
  }

  return { start, stop, scan, enable, disable, configure, runNow, stopManualRun, control, getLogs, deleteRunLogs, decorate, statuses, active, logs };
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

function isExcludedFailure(country, failure, excludedTasks) {
  const configured = excludedTasks[String(country || "").trim().toLowerCase()] || [];
  if (!configured.length) return false;
  const identities = [failure.taskName, failure.taskCode, failure.workflowName, failure.workflowCode]
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
