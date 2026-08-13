import path from "node:path";
import { fetchCompatible } from "./fetch-compatible.mjs";
import { readJsonFile, writeJsonFileAtomic } from "./utils.mjs";
import { notifyText } from "./notifier.mjs";

const DS_FETCH_TIMEOUT_MS = 60_000;
const DS_CHECK_RETRY_COUNT = 1;

function fetchWithTimeout(url, options = {}, timeoutMs = DS_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();
  console.log(`[ds-scheduler] fetch START -> ${url} (timeout=${timeoutMs}ms)`);
  return fetchCompatible(url, { ...options, signal: controller.signal })
    .then((res) => {
      console.log(`[ds-scheduler] fetch OK <- ${url} (${Date.now() - t0}ms) status=${res.status}`);
      return res;
    })
    .catch((error) => {
      console.log(`[ds-scheduler] fetch FAIL <- ${url} (${Date.now() - t0}ms) ${error.name}: ${error.message}`);
      if (error.name === "AbortError") {
        throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}秒），n8n 网关未响应，可能 DS 服务器连接缓慢或不可达`);
      }
      throw error;
    })
    .finally(() => clearTimeout(timer));
}

async function fetchDsProjectCheck(url, options, { timeoutMs = DS_FETCH_TIMEOUT_MS, retries = DS_CHECK_RETRY_COUNT, retryDelayMs = 1_000 } = {}) {
  let lastError;
  const attempts = Math.max(1, Number(retries) + 1);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchWithTimeout(url, options, timeoutMs);
    } catch (error) {
      lastError = error;
      const retryable = /请求超时|AbortError|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(error.message || error.name || "");
      if (!retryable || attempt === attempts) break;
      console.warn(`[ds-scheduler] project check retry ${attempt}/${attempts - 1} after: ${error.message}`);
      if (retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }
  throw new Error(`巡检请求连续 ${attempts} 次失败：${lastError?.message || "unknown error"}`);
}

const DEFAULT_CONFIG_PATH = "config/ds-scheduler.config.json";

const DEFAULT_DS_SCHEDULER_WEBHOOK_URL = "http://127.0.0.1:5678/webhook/ds-scheduler";

function resolveEnvString(value) {
  return String(value ?? "").replace(/\$\{([^}]+)\}/g, (_match, key) => process.env[key] || "").trim();
}

export function resolveDsWebhookUrl(value) {
  return resolveEnvString(value)
    || resolveEnvString(process.env.DS_SCHEDULER_WEBHOOK_URL)
    || DEFAULT_DS_SCHEDULER_WEBHOOK_URL;
}

export function parseProjectNames(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[\n,，;；]+/);
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
}

function normalizeProjects(config, code) {
  const detailed = Array.isArray(config.projects?.[code]) ? config.projects[code] : [];
  if (detailed.length > 0) {
    return detailed
      .map((item) => ({ name: String(item.name || "").trim(), code: String(item.code || "").trim(), error: String(item.error || "") }))
      .filter((item) => item.name || item.code);
  }
  const names = parseProjectNames(config.projectNames?.[code]);
  const legacyCode = String(config.projectCodes?.[code] || "").trim();
  return names.map((name, index) => ({ name, code: index === 0 ? legacyCode : "", error: "" }));
}

function normalizeDsCheckTimeout(value) {
  const timeout = Number(value);
  return Number.isFinite(timeout) ? Math.max(15_000, Math.min(120_000, timeout)) : DS_FETCH_TIMEOUT_MS;
}

function normalizeDsCheckRetries(value) {
  const retries = Number(value);
  return Number.isFinite(retries) ? Math.max(0, Math.min(2, Math.floor(retries))) : DS_CHECK_RETRY_COUNT;
}

function normalizeDsCheckRetryDelay(value) {
  const delay = Number(value);
  return Number.isFinite(delay) ? Math.max(0, Math.min(10_000, delay)) : 1_000;
}

export async function loadDsSchedulerConfig(rootDir) {
  const configPath = path.resolve(typeof rootDir === "string" ? rootDir : process.cwd(), DEFAULT_CONFIG_PATH);
  let config = null;
  try {
    config = await readJsonFile(configPath, null);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!config) {
    return { n8nWebhookUrl: resolveDsWebhookUrl(), countries: {}, alerts: {} };
  }
  return {
    n8nWebhookUrl: resolveDsWebhookUrl(config.n8nWebhookUrl),
    countries: config.countries || {},
    projectCodes: config.projectCodes || {},
    projectNames: config.projectNames || {},
    projects: config.projects || {},
    checkTimeoutMs: config.checkTimeoutMs,
    checkRetries: config.checkRetries,
    checkRetryDelayMs: config.checkRetryDelayMs,
    alerts: config.alerts || {},
  };
}

export async function getDsSchedulerScope(rootDir) {
  const config = await loadDsSchedulerConfig(rootDir);
  const countries = config.countries || {};
  const result = {};
  for (const [code, c] of Object.entries(countries)) {
    result[code] = {
      name: c.name || code,
      configured: Boolean(c.token && c.token.length > 0),
    };
  }
  return result;
}

function gatewayErrorMessage(status, body) {
  if (status === 403 || body.includes("403") || body.includes("Forbidden")) {
    return "n8n 网关拒绝访问，请确认服务器 IP 已加入公司网络白名单";
  }
  return `n8n 网关返回异常: ${body.slice(0, 200)}`;
}

function describeGatewayError(parsed) {
  const err = parsed?.error;
  if (!err) return "unknown error";
  const msg = err.message;
  if (typeof msg === "string" && msg.trim()) return msg;
  if (msg && typeof msg === "object") {
    const status = msg.status;
    const url = String(msg.url || "").split("?")[0];
    if (status === 401) return `DS Token 无效或未授权 (HTTP 401)${url ? `：${url}` : ""}`;
    if (status) return `DS API 返回 HTTP ${status}${url ? `：${url}` : ""}`;
    return JSON.stringify(msg).slice(0, 200);
  }
  return err.code || "unknown error";
}

function unwrapGatewayData(parsed) {
  return parsed?.data && typeof parsed.data === "object" ? parsed.data : {};
}

function taskInstanceRecords(data) {
  if (Array.isArray(data)) return data;
  for (const key of ["records", "list", "task_instances", "taskInstances"]) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  return [];
}

function isFailedTaskInstance(task) {
  const state = String(task.state || task.task_state || task.taskState || task.execution_status || task.executionStatus || "").toUpperCase();
  return ["FAILURE", "KILL", "STOP", "STOPPED"].includes(state);
}

function normalizeTaskInstance(task) {
  return {
    id: String(task.task_instance_id || task.taskInstanceId || task.id || "").trim(),
    name: String(task.task_name || task.taskName || task.name || task.task?.name || "").trim(),
    code: String(task.task_code || task.taskCode || task.code || task.task?.code || "").trim(),
    state: String(task.state || task.task_state || task.taskState || task.execution_status || task.executionStatus || "").trim(),
  };
}

function extractTaskLogFailure(log) {
  const lines = String(log || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const meaningful = lines.filter((line) => /(?:ERROR|Exception|Caused by|SQLSTATE|FAILED)/i.test(line)
    && !/\brun etl fail\b/i.test(line));
  const candidate = meaningful.at(-1);
  if (!candidate) return "任务日志未返回可识别的底层异常";
  return candidate
    .replace(/^.*?(?:console\s*-\s*)?(?:ERROR|Exception|Caused by)\s*[-:：]?\s*/i, "")
    .trim() || candidate;
}

async function postDsAction(webhookUrl, countryCode, token, action, payload, config) {
  const response = await fetchDsProjectCheck(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ country: countryCode, action, ds_token: token, payload }),
  }, {
    timeoutMs: normalizeDsCheckTimeout(config.checkTimeoutMs),
    retries: normalizeDsCheckRetries(config.checkRetries),
    retryDelayMs: normalizeDsCheckRetryDelay(config.checkRetryDelayMs),
  });
  const body = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(gatewayErrorMessage(response.status, body));
  }
  if (!parsed.success) throw new Error(describeGatewayError(parsed));
  return unwrapGatewayData(parsed);
}

async function enrichFailureWithTaskLog(failure, { webhookUrl, countryCode, token, projectCode, config }) {
  if (!failure.instanceId || failure.taskInstanceId) return failure;
  try {
    const taskData = await postDsAction(webhookUrl, countryCode, token, "list_task_instances", {
      project_code: projectCode,
      instance_id: failure.instanceId,
      process_instance_id: failure.instanceId,
      page_no: 1,
      page_size: 100,
      state_type: "FAILURE",
    }, config);
    const failedTask = taskInstanceRecords(taskData).filter(isFailedTaskInstance).map(normalizeTaskInstance).find((task) => task.id);
    if (!failedTask) return failure;

    const logData = await postDsAction(webhookUrl, countryCode, token, "get_task_log", {
      project_code: projectCode,
      task_instance_id: failedTask.id,
    }, config);
    const log = logData.log || logData.task_log || logData.content || "";
    return {
      ...failure,
      taskName: failedTask.name || failure.taskName,
      taskCode: failedTask.code || failure.taskCode,
      taskInstanceId: failedTask.id,
      taskState: failedTask.state || failure.taskState,
      failureMessage: extractTaskLogFailure(log),
    };
  } catch (error) {
    console.warn(`[ds-scheduler] failure enrichment country=${countryCode} project=${projectCode} instance=${failure.instanceId}: ${error.message}`);
    return failure;
  }
}

/**
 * Resolve a project name to a project code by calling the n8n gateway.
 */
export async function resolveProjectName(webhookUrl, countryCode, token, projectName) {
  if (!projectName || !projectName.trim()) {
    return { success: false, error: "project name is empty" };
  }
  try {
    const response = await fetchWithTimeout(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        country: countryCode,
        action: "resolve_project",
        ds_token: token,
        payload: {
          project_name: projectName.trim(),
        },
      }),
    });
    const body = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      console.error(`[ds-scheduler] resolve_project ${countryCode} -> ${webhookUrl} HTTP ${response.status}: ${body.slice(0, 200)}`);
      return { success: false, error: gatewayErrorMessage(response.status, body) };
    }
    if (!parsed.success) {
      return { success: false, error: describeGatewayError(parsed) };
    }
    const projectCode = parsed.data?.project_code || parsed.data?.projectCode || "";
    if (!projectCode) {
      return { success: false, error: `未找到项目"${projectName}"，请确认项目名称是否正确` };
    }
    return { success: true, projectCode };
  } catch (error) {
    console.error(`[ds-scheduler] resolve_project ${countryCode} -> ${webhookUrl} request failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

export async function saveDsSchedulerConfig(rootDir, config) {
  const filePath = path.resolve(typeof rootDir === "string" ? rootDir : process.cwd(), DEFAULT_CONFIG_PATH);
  const previous = await readJsonFile(filePath, {});

  // Resolve project names to codes
  const webhookUrl = resolveDsWebhookUrl(config.n8nWebhookUrl);
  const countries = config.countries || {};
  const projectNames = config.projectNames || {};
  const requestedProjectCodes = config.projectCodes || {};
  const previousProjectCodes = previous.projectCodes || {};
  const previousProjectNames = previous.projectNames || {};
  const requestedProjects = config.projects || {};
  const previousProjects = previous.projects || {};
  const projectCodes = {};
  const projects = {};
  const resolveResults = [];

  for (const [code, c] of Object.entries(countries)) {
    const token = String(c.token || "").trim();
    const names = parseProjectNames(projectNames[code]);
    projectNames[code] = names.join("，");
    const requestedProjectCode = String(requestedProjectCodes[code] || "").trim();
    const unchangedProjectCode = previousProjectNames[code] === projectNames[code]
      ? String(previousProjectCodes[code] || "").trim()
      : "";
    const supplied = Array.isArray(requestedProjects[code]) ? requestedProjects[code] : [];
    const prior = Array.isArray(previousProjects[code]) ? previousProjects[code] : [];
    projects[code] = [];
    for (const [index, name] of names.entries()) {
      const suppliedMatch = supplied.find((item) => String(item.name || "").trim() === name);
      const priorMatch = prior.find((item) => String(item.name || "").trim() === name);
      let projectCode = String(suppliedMatch?.code || priorMatch?.code || (index === 0 ? requestedProjectCode || unchangedProjectCode : "")).trim();
      let error = "";
      if (!projectCode && token && webhookUrl) {
        const result = await resolveProjectName(webhookUrl, code, token, name);
        if (result.success && result.projectCode) {
          projectCode = result.projectCode;
          resolveResults.push({ country: code, name, code: projectCode, ok: true });
        } else {
          error = result.error;
          resolveResults.push({ country: code, name, code: "", error, ok: false });
        }
      }
      projects[code].push({ name, code: projectCode, error });
    }
    projectCodes[code] = projects[code].find((item) => item.code)?.code || "";
  }

  const fullConfig = {
    n8nWebhookUrl: String(config.n8nWebhookUrl || "").trim(),
    projectNames,
    projectCodes,
    projects,
    countries,
    alerts: config.alerts || {},
  };

  await writeJsonFileAtomic(filePath, fullConfig);
  return { ...fullConfig, resolved: resolveResults.filter((r) => r.ok).length, resolveErrors: resolveResults.filter((r) => !r.ok) };
}

export async function checkAllCountries(rootDir, config) {
  const webhookUrl = config.n8nWebhookUrl || "";
  if (!webhookUrl) {
    throw new Error("n8n webhook URL not configured");
  }

  const countries = Object.entries(config.countries || {});
  const results = [];

  console.log(`[ds-scheduler] checkAllCountries START: ${countries.length} countries, webhook=${webhookUrl}`);
  for (const [countryCode, countryConfig] of countries) {
    const token = String(countryConfig.token || "").trim();
    console.log(`[ds-scheduler] country=${countryCode} token=${token ? "yes" : "no"}`);
    if (!token) {
      results.push({
        country: countryCode,
        countryName: countryConfig.name || countryCode,
        success: false,
        error: "token not configured",
        stuckCount: 0,
        checkedWorkflows: 0,
        stuckWorkflows: [],
      });
      continue;
    }

    const configuredProjects = normalizeProjects(config, countryCode).filter((item) => item.code);
    const projectTargets = configuredProjects.length > 0
      ? configuredProjects
      : [{ name: "", code: String(config.projectCodes?.[countryCode] || "") }];
    const projectResults = [];
    console.log(`[ds-scheduler] country=${countryCode} projects=${projectTargets.length} -> ${projectTargets.map((p) => p.code || p.name).join(",")}`);
    for (const project of projectTargets) try {
      console.log(`[ds-scheduler] country=${countryCode} project=${project.code || project.name || "-"} START`);
      const response = await fetchDsProjectCheck(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          country: countryCode,
          action: "check_failed_instances",
          ds_token: token,
          payload: {
            consecutive_failures: 3,
            page_size: 20,
            project_code: project.code,
            stale_policy: "one_full_schedule_cycle",
            include_checked_workflows: true,
            failure_policy: "scheduled_today_final_failure",
            include_failed_workflows: true,
          },
        }),
      }, {
        timeoutMs: normalizeDsCheckTimeout(config.checkTimeoutMs),
        retries: normalizeDsCheckRetries(config.checkRetries),
        retryDelayMs: normalizeDsCheckRetryDelay(config.checkRetryDelayMs),
      });

      const body = await response.text();
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        console.error(`[ds-scheduler] check_failed_instances ${countryCode} project=${project.code || project.name || "-"} -> ${webhookUrl} HTTP ${response.status}: ${body.slice(0, 200)}`);
        const errorMsg = gatewayErrorMessage(response.status, body);
        projectResults.push({
          projectName: project.name,
          projectCode: project.code,
          success: false,
          error: errorMsg,
          stuckCount: 0,
          checkedWorkflows: 0,
          stuckWorkflows: [],
        });
        continue;
      }

      if (!parsed.success) {
        projectResults.push({
          projectName: project.name,
          projectCode: project.code,
          success: false,
          error: describeGatewayError(parsed),
          stuckCount: 0,
          checkedWorkflows: 0,
          stuckWorkflows: [],
        });
        continue;
      }

      const data = parsed.data || {};
      const checkedWorkflowDetails = normalizeCheckedWorkflowDetails(data.checked_workflows || data.workflows);
      console.log(`[ds-scheduler] country=${countryCode} project=${project.code || "-"} workflows=${checkedWorkflowDetails.length ? checkedWorkflowDetails.map((workflow) => workflow.workflowName || workflow.workflowCode).join(",") : "not returned by gateway"}`);
      // The gateway determines schedule lateness from DS's schedule definition.
      // Legacy "no_recent_run" entries have an unspecified fixed lookback and
      // must not create false alerts for infrequent schedules such as monthly jobs.
      const staleWorkflows = (data.stale_workflows || [])
        .filter((wf) => wf.schedule_status === "ONLINE" && wf.stale_reason === "missed_schedule_cycle")
        .map((wf) => ({
          projectName: project.name,
          projectCode: project.code,
          workflowCode: wf.workflow_code,
          workflowName: wf.workflow_name,
          scheduleId: wf.schedule_id,
          scheduleStatus: wf.schedule_status,
          staleReason: wf.stale_reason,
          staleMessage: wf.stale_message,
          scheduleCycle: wf.schedule_cycle || "",
          lastRunAt: wf.last_run_at || null,
          nextRunAt: wf.next_run_at || null,
          totalInstancesChecked: wf.total_instances_checked,
        }));
      const failedWorkflows = normalizeFailedSchedulerInstances(data)
        .filter((wf) => wf.schedule_status === "ONLINE" && wf.failure_reason === "scheduled_instance_failed" && wf.has_later_success !== true)
        .map((wf) => ({
          projectName: project.name,
          projectCode: project.code,
          workflowCode: wf.workflow_code,
          workflowName: wf.workflow_name,
          scheduleId: wf.schedule_id,
          scheduleStatus: wf.schedule_status,
          failureReason: wf.failure_reason,
          failureMessage: wf.failure_message,
          instanceId: wf.instance_id,
          instanceState: wf.instance_state,
          taskName: wf.task_name || wf.failed_task_name || wf.task?.name || "",
          taskCode: wf.task_code || wf.failed_task_code || wf.task?.code || "",
          taskInstanceId: wf.task_instance_id || wf.failed_task_instance_id || wf.task?.instance_id || "",
          taskState: wf.task_state || wf.failed_task_state || wf.task?.state || "",
          hasLaterSuccess: wf.has_later_success === true,
          startTime: wf.start_time || null,
          endTime: wf.end_time || null,
        }));
      // The current legacy gateway only returns raw workflow instances. Enrich
      // those records here; the documented failed_workflows response already
      // carries task-level failure details and must remain a single request.
      const enrichedFailedWorkflows = Array.isArray(data.failed_workflows)
        ? failedWorkflows
        : await Promise.all(failedWorkflows.map((failure) => enrichFailureWithTaskLog(failure, {
          webhookUrl,
          countryCode,
          token,
          projectCode: project.code,
          config,
        })));
      console.log(`[ds-scheduler] country=${countryCode} project=${project.code || "-"} DONE stuck=${data.stuck_count || 0} stale=${staleWorkflows.length} failed=${enrichedFailedWorkflows.length} checked=${data.total_checked || 0}`);
      projectResults.push({
        projectName: project.name,
        projectCode: project.code,
        success: true,
        error: null,
        stuckCount: data.stuck_count || 0,
        staleCount: staleWorkflows.length,
        failedCount: enrichedFailedWorkflows.length,
        checkedWorkflows: data.total_checked || 0,
        checkedWorkflowDetails,
        stuckWorkflows: (data.stuck_workflows || []).map((wf) => ({
          projectName: project.name,
          projectCode: project.code,
          workflowCode: wf.workflow_code,
          workflowName: wf.workflow_name,
          scheduleId: wf.schedule_id,
          scheduleStatus: wf.schedule_status,
          consecutiveFailures: wf.consecutive_failures,
          totalChecked: wf.total_checked,
          recentFailures: (wf.recent_failures || []).slice(0, 5),
        })),
        staleWorkflows,
        failedWorkflows: enrichedFailedWorkflows,
      });
    } catch (error) {
      console.error(`[ds-scheduler] check_failed_instances ${countryCode} project=${project.code || project.name || "-"} -> ${webhookUrl} request failed: ${error.message}`);
      projectResults.push({
        projectName: project.name,
        projectCode: project.code,
        success: false,
        error: error.message,
        stuckCount: 0,
        checkedWorkflows: 0,
        stuckWorkflows: [],
      });
    }
    results.push({
      country: countryCode,
      countryName: countryConfig.name || countryCode,
      success: projectResults.some((item) => item.success),
      partialFailure: projectResults.some((item) => !item.success),
      error: projectResults.filter((item) => !item.success).map((item) => `${item.projectName || item.projectCode}: ${item.error}`).join("；") || null,
      stuckCount: projectResults.reduce((sum, item) => sum + (item.stuckCount || 0), 0),
      staleCount: projectResults.reduce((sum, item) => sum + (item.staleWorkflows?.length || 0), 0),
      failedCount: projectResults.reduce((sum, item) => sum + (item.failedWorkflows?.length || 0), 0),
      checkedWorkflows: projectResults.reduce((sum, item) => sum + (item.checkedWorkflows || 0), 0),
      checkedWorkflowDetails: projectResults.flatMap((item) => item.checkedWorkflowDetails || []),
      stuckWorkflows: projectResults.flatMap((item) => item.stuckWorkflows || []),
      staleWorkflows: projectResults.flatMap((item) => item.staleWorkflows || []),
      failedWorkflows: projectResults.flatMap((item) => item.failedWorkflows || []),
      projects: projectResults,
    });
  }

  const totalStuck = results.reduce((sum, r) => sum + r.stuckCount, 0);
  const totalStale = results.reduce((sum, r) => sum + (r.staleCount || 0), 0);
  const totalFailed = results.reduce((sum, r) => sum + (r.failedCount || 0), 0);
  const totalChecked = results.reduce((sum, r) => sum + r.checkedWorkflows, 0);
  const failedCountries = results.filter((r) => !r.success).length;

  console.log(`[ds-scheduler] checkAllCountries DONE: stuck=${totalStuck} stale=${totalStale} failed=${totalFailed} checked=${totalChecked}`);
  return {
    checkedAt: new Date().toISOString(),
    totalStuck,
    totalStale,
    totalFailed,
    totalChecked,
    totalCountries: countries.length,
    failedCountries,
    countries: results,
  };
}

function normalizeFailedSchedulerInstances(data = {}) {
  const classified = Array.isArray(data.failed_workflows) ? data.failed_workflows : [];
  if (classified.length > 0) return classified;

  // Some deployed n8n routers return raw DolphinScheduler instances instead
  // of the documented failed_workflows envelope. Normalize that shape so a
  // scheduled failure cannot be silently reported as healthy.
  const rawItems = Array.isArray(data)
    ? data
    : (data.records || data.list || data.workflows || data.instances || []);
  if (!Array.isArray(rawItems)) return [];
  return rawItems
    .filter((item) => {
      const commandType = String(item.command_type || item.commandType || "").toUpperCase();
      const state = String(item.instance_state || item.workflow_execution_status || item.workflowExecutionStatus || "").toUpperCase();
      return commandType === "SCHEDULER" && ["FAILURE", "KILL", "STOP", "STOPPED"].includes(state);
    })
    .map((item) => ({
      workflow_code: item.workflow_code || item.workflowCode || item.workflow_definition_code || item.workflowDefinitionCode,
      workflow_name: item.workflow_name || item.workflowName || item.workflow_instance_name || item.workflowInstanceName,
      schedule_status: item.schedule_status || item.scheduleStatus || "ONLINE",
      failure_reason: "scheduled_instance_failed",
      failure_message: item.failure_message || item.failureMessage || item.error_message || item.errorMessage || "定时调度实例执行失败",
      instance_id: item.instance_id || item.instanceId || item.workflow_instance_id || item.workflowInstanceId,
      instance_state: item.instance_state || item.instanceState || item.workflow_execution_status || item.workflowExecutionStatus,
      has_later_success: item.has_later_success === true || item.hasLaterSuccess === true,
      task_name: item.task_name || item.taskName,
      task_code: item.task_code || item.taskCode,
      task_instance_id: item.task_instance_id || item.taskInstanceId,
      task_state: item.task_state || item.taskState,
      start_time: item.start_time || item.startTime || item.workflow_start_time || item.workflowStartTime,
      end_time: item.end_time || item.endTime || item.workflow_end_time || item.workflowEndTime,
    }));
}

function normalizeCheckedWorkflowDetails(value) {
  if (!Array.isArray(value)) return [];
  return value.map((workflow) => ({
    workflowCode: String(workflow.workflow_code || workflow.workflowCode || workflow.code || "").trim(),
    workflowName: String(workflow.workflow_name || workflow.workflowName || workflow.name || "").trim(),
  })).filter((workflow) => workflow.workflowCode || workflow.workflowName);
}

/**
 * Send notification for DS scheduler check results.
 */
export async function notifyDsSchedulerCheck(config, checkResult) {
  const alertConfig = config.alerts || {};
  if (!alertConfig.channel && !alertConfig.webhookUrl) {
    return { sent: false, reason: "alert not configured" };
  }

  const totalStuck = checkResult.totalStuck || 0;
  const totalStale = checkResult.totalStale || 0;
  const hasAnomalies = totalStuck > 0 || totalStale > 0;

  if (!hasAnomalies && alertConfig.sendWhenHealthy === false) {
    return { sent: false, reason: "healthy notification disabled" };
  }

  const messages = buildDsSchedulerMessages(checkResult, alertConfig);
  const results = [];

  for (const message of messages) {
    results.push(
      await notifyText(config, message.body, {
        title: message.title,
        severity: hasAnomalies ? "warning" : "info",
      }),
    );
  }

  return {
    sent: results.some((resultItem) => resultItem.sent),
    sentMessages: messages.length,
    results,
  };
}

/**
 * Build notification messages for DS scheduler check results.
 */
function buildDsSchedulerMessages(checkResult, alertConfig = {}) {
  const messages = [];
  const totalStuck = checkResult.totalStuck || 0;
  const totalStale = checkResult.totalStale || 0;
  const hasAnomalies = totalStuck > 0 || totalStale > 0;

  // Build overview message
  let body = `## DS 调度监控巡检报告\n\n`;
  body += `**检查时间**: ${new Date(checkResult.checkedAt).toLocaleString("zh-CN")}\n\n`;
  body += `### 概览\n`;
  body += `- 监控国家: ${checkResult.totalCountries}\n`;
  body += `- 检查工作流: ${checkResult.totalChecked}\n`;
  body += `- 卡死工作流: ${totalStuck}\n`;
  body += `- 离线/旷工任务: ${totalStale}\n`;
  body += `- 检查失败国家: ${checkResult.failedCountries}\n\n`;

  if (hasAnomalies) {
    body += `### 异常详情\n\n`;

    // Add stuck workflows
    if (totalStuck > 0) {
      body += `#### ⛔ 卡死工作流 (${totalStuck})\n\n`;
      for (const countryResult of checkResult.countries || []) {
        if (countryResult.stuckWorkflows && countryResult.stuckWorkflows.length > 0) {
          body += `**${countryResult.countryName} (${countryResult.country})**\n`;
          for (const wf of countryResult.stuckWorkflows) {
            body += `- \`${wf.workflowName}\` (${wf.workflowCode})\n`;
            body += `  - 连续失败: ${wf.consecutiveFailures} 次\n`;
            body += `  - 调度状态: ${wf.scheduleStatus || "未知"}\n`;
          }
          body += `\n`;
        }
      }
    }

    // Add stale workflows
    if (totalStale > 0) {
      body += `#### ⚠️ 离线/旷工任务 (${totalStale})\n\n`;
      for (const countryResult of checkResult.countries || []) {
        if (countryResult.staleWorkflows && countryResult.staleWorkflows.length > 0) {
          body += `**${countryResult.countryName} (${countryResult.country})**\n`;
          for (const wf of countryResult.staleWorkflows) {
            body += `- \`${wf.workflowName}\` (${wf.workflowCode})\n`;
            body += `  - 状态: ${wf.staleMessage || wf.staleReason || "离线"}\n`;
            body += `  - 调度状态: ${wf.scheduleStatus || "未知"}\n`;
          }
          body += `\n`;
        }
      }
    }

    // Add failed countries
    if (checkResult.failedCountries > 0) {
      body += `#### ❌ 检查失败国家 (${checkResult.failedCountries})\n\n`;
      for (const countryResult of checkResult.countries || []) {
        if (!countryResult.success) {
          body += `- **${countryResult.countryName} (${countryResult.country})**: ${countryResult.error || "未知错误"}\n`;
        }
      }
      body += `\n`;
    }
  } else {
    body += `### ✅ 一切正常\n\n`;
    body += `所有检查通过，没有发现异常。\n`;
  }

  messages.push({
    title: hasAnomalies ? "⚠️ DS 调度监控异常告警" : "✅ DS 调度监控健康报告",
    body,
  });

  return messages;
}
