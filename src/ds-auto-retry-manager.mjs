import path from "node:path";
import { loadDsSchedulerConfig } from "./ds-scheduler-monitor.mjs";
import { countryDateKey, dsStateOf, inspectDsFailureLogs, postDsFailureAction } from "./ds-failure-log-monitor.mjs";
import { notifyText } from "./notifier.mjs";
import { readJsonFile } from "./utils.mjs";

const SUCCESS_STATES = new Set(["SUCCESS", "7"]);
const RUNNING_STATES = new Set(["SUBMITTED_SUCCESS", "RUNNING_EXECUTION", "WAITING_THREAD", "WAITING_DEPEND", "DELAY_EXECUTION", "0", "1", "10", "11", "12"]);
const STOP_STATES = new Set(["STOP", "STOPPED", "KILL", "KILLING", "5", "9"]);
const FAILURE_STATES = new Set(["FAILURE", "FAILED", "6"]);

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
  const active = new Map();
  const statuses = new Map();
  const logs = [];
  let scanTimer = null;
  let scanning = false;
  let enabled = false;
  let startAt = null;
  let countries = [];
  let currentRunId = null;

  const appendLog = (level, event, detail = {}) => {
    logs.push({ id: `${now().getTime()}-${logs.length + 1}`, runId: detail.runId || currentRunId, time: now().toISOString(), level, event, ...detail });
    if (logs.length > 500) logs.splice(0, logs.length - 500);
  };

  const setStatus = (key, patch) => {
    statuses.set(key, { ...(statuses.get(key) || {}), ...patch, updatedAt: now().toISOString() });
  };

  async function runLoop(country, failure) {
    const key = failureKey(country, failure);
    const startedDate = countryDateKey(country, new Date(failure.startTime || now()));
    const retryStartedAt = now().getTime();
    let attempts = Number(statuses.get(key)?.attempts || 0);
    try {
      while (true) {
        if (!enabled) {
          setStatus(key, { autoRetryStatus: "safety_stopped", stopReason: "页面已停止自动重跑", attempts });
          appendLog("info", "retry_stopped", { key, country, attempts, message: "页面已停止自动重跑" });
          return;
        }
        if (failure.failureType === "suspected_empty_run" && now().getTime() - retryStartedAt >= emptyRunRetryLimitMs) {
          setStatus(key, { autoRetryStatus: "safety_stopped", stopReason: "疑似空跑任务重跑已满 1 小时，自动关闭并等待人工确认", attempts });
          appendLog("warn", "empty_run_timeout", { key, country, attempts, message: "疑似空跑任务重跑超过 1 小时，已自动关闭" });
          try {
            const schedule = await ownerConfigLoader(rootDir);
            const ownerConfig = findCountryOwnerConfig(schedule, country);
            const ownerEmails = String(ownerConfig.ownerEmails || ownerConfig.recipientEmails || "").trim();
            if (!ownerEmails) {
              appendLog("warn", "owner_notification_skipped", { key, country, attempts, message: "未配置该国家负责人邮箱，未发送超时告警" });
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
              appendLog("success", "owner_notification_sent", { key, country, attempts, message: `超时告警已发送给负责人：${ownerEmails}` });
            }
          } catch (error) {
            appendLog("error", "owner_notification_failed", { key, country, attempts, message: `负责人告警发送失败：${error.message}` });
          }
          return;
        }
        if (countryDateKey(country, now()) !== startedDate) {
          setStatus(key, { autoRetryStatus: "safety_stopped", stopReason: "失败实例已跨天，自动重跑终止", attempts });
          appendLog("warn", "safety_stopped", { key, country, attempts, message: "失败实例已跨天" });
          return;
        }
        const config = await configLoader(rootDir);
        const countryConfig = config.countries?.[country] || {};
        const token = String(countryConfig.token || "").trim();
        const webhookUrl = String(config.n8nWebhookUrl || "").trim();
        if (!token || !webhookUrl) {
          setStatus(key, { autoRetryStatus: "safety_stopped", stopReason: "DS Token 或网关未配置", attempts });
          appendLog("error", "configuration_error", { key, country, attempts, message: "DS Token 或网关未配置" });
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
          appendLog("error", "instance_check_failed", { key, country, attempts, message: error.message });
          await sleep(retryDelayMs);
          continue;
        }
        const state = dsStateOf(instance?.data || instance);
        if (SUCCESS_STATES.has(state)) {
          setStatus(key, { autoRetryStatus: "recovered", stopReason: "重跑成功", attempts, recoveryState: state });
          appendLog("success", "recovered", { key, country, attempts, state, message: "实例重跑成功" });
          return;
        }
        if (STOP_STATES.has(state)) {
          setStatus(key, { autoRetryStatus: "safety_stopped", stopReason: "实例已被人工停止或终止", attempts, recoveryState: state });
          appendLog("warn", "safety_stopped", { key, country, attempts, state, message: "实例已被人工停止或终止" });
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
            appendLog("warn", "safety_stopped", { key, country, attempts, releaseState, message: "工作流已下线" });
            return;
          }
        } catch (error) {
          setStatus(key, { autoRetryStatus: "retry_wait", lastError: `工作流状态读取失败：${error.message}`, attempts });
          appendLog("error", "workflow_check_failed", { key, country, attempts, message: error.message });
          await sleep(retryDelayMs);
          continue;
        }
        if (RUNNING_STATES.has(state)) {
          setStatus(key, { autoRetryStatus: "running", attempts, recoveryState: state, stopReason: "" });
          await sleep(retryDelayMs);
          continue;
        }
        if (!FAILURE_STATES.has(state)) {
          setStatus(key, { autoRetryStatus: "manual_review", stopReason: `实例状态 ${state || "UNKNOWN"} 无法安全重跑`, attempts });
          appendLog("warn", "manual_review", { key, country, attempts, state, message: "实例状态无法安全重跑" });
          return;
        }
        try {
          await actionFn({ webhookUrl, country, token, action: "retry_instance", payload });
          attempts += 1;
          setStatus(key, { autoRetryStatus: "retrying", attempts, lastAttemptAt: now().toISOString(), lastError: "", stopReason: "" });
          appendLog("info", "retry_submitted", { key, country, attempts, state, message: `已提交第 ${attempts} 次重跑` });
        } catch (error) {
          setStatus(key, { autoRetryStatus: "retry_wait", attempts, lastError: error.message });
          appendLog("error", "retry_failed", { key, country, attempts, message: error.message });
        }
        await sleep(retryDelayMs);
      }
    } finally {
      active.delete(key);
    }
  }

  async function scan() {
    if (!enabled) return { skipped: true, reason: "disabled" };
    if (startAt && now().getTime() < startAt.getTime()) return { skipped: true, reason: "scheduled", startAt: startAt.toISOString() };
    if (scanning) return { skipped: true };
    scanning = true;
    try {
      const result = await inspectFn(rootDir);
      for (const countryResult of result.countries || []) {
        if (countries.length && !countries.includes(countryResult.country)) continue;
        for (const failure of countryResult.failures || []) {
          const key = failureKey(countryResult.country, failure);
          if (failure.repairStatus === "recovered") {
            setStatus(key, { autoRetryStatus: "recovered", stopReason: "已修复" });
            continue;
          }
          if (!failure.retryable) {
            setStatus(key, {
              autoRetryStatus: failure.failureType || "manual_review",
              stopReason: failure.retryDecision || "不满足自动重跑条件",
            });
            appendLog("info", "skipped", { key, country: countryResult.country, message: failure.retryDecision || "不满足自动重跑条件" });
            continue;
          }
          if (!active.has(key)) {
            setStatus(key, { autoRetryStatus: "retrying", attempts: Number(statuses.get(key)?.attempts || 0), stopReason: "" });
            appendLog("info", "retry_started", { key, country: countryResult.country, attempts: Number(statuses.get(key)?.attempts || 0), message: "开始处理符合条件的失败任务" });
            const task = runLoop(countryResult.country, failure).catch((error) => {
              logger.error?.(`[ds-auto-retry] ${key}: ${error.message}`);
              setStatus(key, { autoRetryStatus: "retry_wait", lastError: error.message });
            });
            active.set(key, task);
          }
        }
      }
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
        failures: (country.failures || []).map((failure) => ({
          ...failure,
          ...(statuses.get(failureKey(country.country, failure)) || {}),
        })),
      })),
    };
  }

  function start() {
    if (scanTimer) return;
    scanTimer = setInterval(() => scan().catch((error) => logger.error?.("[ds-auto-retry] scan failed:", error)), scanIntervalMs);
    scanTimer.unref?.();
  }

  function enable(options = {}) {
    const parsed = options.startAt ? new Date(options.startAt) : now();
    if (Number.isNaN(parsed.getTime())) throw new Error("重跑开始时间无效");
    enabled = true;
    startAt = parsed;
    countries = Array.isArray(options.countries) ? [...new Set(options.countries.map((item) => String(item).trim().toLowerCase()).filter(Boolean))] : [];
    currentRunId = `ds-retry-${now().getTime()}`;
    appendLog("info", "control_enabled", { message: `已启用重跑，开始时间：${startAt.toISOString()}`, startAt: startAt.toISOString(), countries });
    if (now().getTime() >= startAt.getTime()) scan().catch((error) => logger.error?.("[ds-auto-retry] manual scan failed:", error));
    return control();
  }

  function disable() {
    enabled = false;
    appendLog("info", "control_disabled", { message: "已从页面停止自动重跑" });
    return control();
  }

  function control() {
    return { enabled, startAt: startAt?.toISOString() || null, countries, activeCount: active.size, logCount: logs.length, currentRunId };
  }

  function getLogs(limit = 200) {
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 200));
    return logs.slice(-safeLimit).reverse();
  }

  function stop() {
    if (scanTimer) clearInterval(scanTimer);
    scanTimer = null;
  }

  return { start, stop, scan, enable, disable, control, getLogs, decorate, statuses, active, logs };
}
