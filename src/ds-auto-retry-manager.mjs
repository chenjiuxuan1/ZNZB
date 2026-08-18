import { loadDsSchedulerConfig } from "./ds-scheduler-monitor.mjs";
import { countryDateKey, dsStateOf, inspectDsFailureLogs, postDsFailureAction } from "./ds-failure-log-monitor.mjs";

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
  scanIntervalMs = 60_000,
  retryDelayMs = 10_000,
  now = () => new Date(),
  sleep = delay,
  logger = console,
} = {}) {
  const active = new Map();
  const statuses = new Map();
  let scanTimer = null;
  let scanning = false;

  const setStatus = (key, patch) => {
    statuses.set(key, { ...(statuses.get(key) || {}), ...patch, updatedAt: now().toISOString() });
  };

  async function runLoop(country, failure) {
    const key = failureKey(country, failure);
    const startedDate = countryDateKey(country, new Date(failure.startTime || now()));
    let attempts = Number(statuses.get(key)?.attempts || 0);
    try {
      while (true) {
        if (countryDateKey(country, now()) !== startedDate) {
          setStatus(key, { autoRetryStatus: "safety_stopped", stopReason: "失败实例已跨天，自动重跑终止", attempts });
          return;
        }
        const config = await configLoader(rootDir);
        const countryConfig = config.countries?.[country] || {};
        const token = String(countryConfig.token || "").trim();
        const webhookUrl = String(config.n8nWebhookUrl || "").trim();
        if (!token || !webhookUrl) {
          setStatus(key, { autoRetryStatus: "safety_stopped", stopReason: "DS Token 或网关未配置", attempts });
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
          await sleep(retryDelayMs);
          continue;
        }
        const state = dsStateOf(instance?.data || instance);
        if (SUCCESS_STATES.has(state)) {
          setStatus(key, { autoRetryStatus: "recovered", stopReason: "重跑成功", attempts, recoveryState: state });
          return;
        }
        if (STOP_STATES.has(state)) {
          setStatus(key, { autoRetryStatus: "safety_stopped", stopReason: "实例已被人工停止或终止", attempts, recoveryState: state });
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
            return;
          }
        } catch (error) {
          setStatus(key, { autoRetryStatus: "retry_wait", lastError: `工作流状态读取失败：${error.message}`, attempts });
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
          return;
        }
        try {
          await actionFn({ webhookUrl, country, token, action: "retry_instance", payload });
          attempts += 1;
          setStatus(key, { autoRetryStatus: "retrying", attempts, lastAttemptAt: now().toISOString(), lastError: "", stopReason: "" });
        } catch (error) {
          setStatus(key, { autoRetryStatus: "retry_wait", attempts, lastError: error.message });
        }
        await sleep(retryDelayMs);
      }
    } finally {
      active.delete(key);
    }
  }

  async function scan() {
    if (scanning) return { skipped: true };
    scanning = true;
    try {
      const result = await inspectFn(rootDir);
      for (const countryResult of result.countries || []) {
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
            continue;
          }
          if (!active.has(key)) {
            setStatus(key, { autoRetryStatus: "retrying", attempts: Number(statuses.get(key)?.attempts || 0), stopReason: "" });
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
    setTimeout(() => scan().catch((error) => logger.error?.("[ds-auto-retry] initial scan failed:", error)), 15_000).unref?.();
  }

  function stop() {
    if (scanTimer) clearInterval(scanTimer);
    scanTimer = null;
  }

  return { start, stop, scan, decorate, statuses, active };
}
