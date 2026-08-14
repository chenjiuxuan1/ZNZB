import { fetchCompatible } from "./fetch-compatible.mjs";
import { loadDsSchedulerConfig } from "./ds-scheduler-monitor.mjs";

const REQUEST_TIMEOUT_MS = 60_000;
const INSTANCE_PAGE_SIZE = 100;
const MAX_INSTANCE_PAGES = 50;
const PROJECT_QUERY_CONCURRENCY = 3;
const FAILURE_ENRICH_CONCURRENCY = 2;
const COUNTRY_ORDER = ["cn", "ine", "ph", "th", "pk", "mx"];
const COUNTRY_LABELS = { cn: "中国", ine: "印尼", ph: "菲律宾", th: "泰国", pk: "巴基斯坦", mx: "墨西哥" };
const COUNTRY_TIMEZONES = {
  cn: "Asia/Shanghai",
  ine: "Asia/Jakarta",
  ph: "Asia/Manila",
  th: "Asia/Bangkok",
  pk: "Asia/Karachi",
  mx: "America/Mexico_City",
};
const COUNTRY_DS_UI_BASE_URLS = {
  cn: "http://10.20.47.14:12345/dolphinscheduler/ui/#",
  ine: "http://192.168.21.236:12345/dolphinscheduler/ui/#",
  ph: "http://10.20.10.12:12345/dolphinscheduler/ui/#",
  th: "http://192.168.20.236:12345/dolphinscheduler/ui/#",
  pk: "http://10.20.84.176:12345/dolphinscheduler/ui/#",
  mx: "http://172.20.220.165:12345/dolphinscheduler/ui/#",
};

const FAILED_STATES = new Set(["FAILURE", "KILL", "STOP", "STOPPED", "6", "9", "5"]);
const SUCCESS_STATES = new Set(["SUCCESS", "7"]);
const RUNNING_STATES = new Set(["SUBMITTED_SUCCESS", "RUNNING_EXECUTION", "WAITING_THREAD", "WAITING_DEPEND", "DELAY_EXECUTION", "0", "1", "10", "11", "12"]);

export function normalizeCountrySelection(value) {
  if (value == null || value === "") return [...COUNTRY_ORDER];
  const requested = (Array.isArray(value) ? value : String(value).split(","))
    .map((item) => String(item || "").trim().toLowerCase())
    .filter(Boolean);
  return COUNTRY_ORDER.filter((country) => requested.includes(country));
}

function stateOf(item = {}) {
  return String(item.state ?? item.instance_state ?? item.instanceState ?? item.workflow_execution_status ?? item.workflowExecutionStatus ?? "").trim().toUpperCase();
}

function recordList(data) {
  if (Array.isArray(data)) return data;
  for (const key of ["records", "list", "instances", "workflow_instances", "workflowInstances", "totalList", "task_instances", "taskInstances"]) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  if (data?.data && data.data !== data) return recordList(data.data);
  return [];
}

function instanceTime(item = {}) {
  return item.start_time || item.startTime || item.workflow_start_time || item.workflowStartTime || item.create_time || item.createTime || null;
}

function endTime(item = {}) {
  return item.end_time || item.endTime || item.workflow_end_time || item.workflowEndTime || null;
}

function workflowCode(item = {}) {
  return String(item.workflow_code || item.workflowCode || item.workflow_definition_code || item.workflowDefinitionCode || item.process_definition_code || item.processDefinitionCode || "").trim();
}

function workflowName(item = {}) {
  return String(item.workflow_name || item.workflowName || item.workflow_instance_name || item.workflowInstanceName || item.process_definition_name || item.processDefinitionName || item.name || "").trim();
}

function instanceId(item = {}) {
  return String(item.instance_id || item.instanceId || item.workflow_instance_id || item.workflowInstanceId || item.process_instance_id || item.processInstanceId || item.id || "").trim();
}

function commandTypeOf(item = {}) {
  return String(item.command_type || item.commandType || "").trim().toUpperCase();
}

function runTimesOf(item = {}) {
  const value = Number(item.run_times ?? item.runTimes ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function isFailureRetry(item = {}) {
  return commandTypeOf(item) === "START_FAILURE_TASK_PROCESS" || runTimesOf(item) > 1;
}

function timestamp(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function localDate(value, timeZone) {
  if (!value) return "";
  const text = String(value).trim();
  const localTimestamp = text.match(/^(\d{4}-\d{2}-\d{2})[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/);
  if (localTimestamp) return localTimestamp[1];
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return dateKey(date, timeZone);
}

function todayInTimeZone(timeZone, now = new Date()) {
  return dateKey(now, timeZone);
}

function dateKey(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(date).map((item) => [item.type, item.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function projectTargets(config, countryCode) {
  const projects = Array.isArray(config.projects?.[countryCode]) ? config.projects[countryCode] : [];
  const resolved = projects
    .map((item) => ({ name: String(item.name || "").trim(), code: String(item.code || "").trim() }))
    .filter((item) => item.code);
  if (resolved.length) return resolved;
  const code = String(config.projectCodes?.[countryCode] || "").trim();
  return code ? [{ name: String(config.projectNames?.[countryCode] || "").trim(), code }] : [];
}

async function postActionOnce(webhookUrl, country, token, action, payload = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchCompatible(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ country, action, ds_token: token, payload }),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`n8n 网关返回非 JSON（HTTP ${response.status}）：${text.slice(0, 180)}`);
    }
    if (!response.ok || parsed.success === false) {
      const message = parsed?.error?.message || parsed?.error || `HTTP ${response.status}`;
      throw new Error(typeof message === "string" ? message : JSON.stringify(message));
    }
    return parsed.data && typeof parsed.data === "object" ? parsed.data : {};
  } catch (error) {
    if (error.name === "AbortError") throw new Error("DS 网关请求超时（60 秒）");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function classifyWorkflowFailures(instances = [], { projectName = "", projectCode = "" } = {}) {
  const groups = new Map();
  for (const item of instances) {
    const key = workflowCode(item) || workflowName(item);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const failures = [];
  for (const records of groups.values()) {
    const ordered = [...records].sort((a, b) => timestamp(instanceTime(a)) - timestamp(instanceTime(b)));
    const failed = ordered.filter((item) => FAILED_STATES.has(stateOf(item)));
    if (!failed.length) {
      const retried = ordered.filter(isFailureRetry);
      if (!retried.length) continue;
      const recoveredInstance = retried.at(-1);
      const recoveredState = stateOf(recoveredInstance);
      const recovered = SUCCESS_STATES.has(recoveredState);
      const repairing = RUNNING_STATES.has(recoveredState);
      failures.push({
        projectName,
        projectCode,
        workflowCode: workflowCode(recoveredInstance),
        workflowName: workflowName(recoveredInstance),
        instanceId: instanceId(recoveredInstance),
        instanceState: "FAILURE",
        startTime: instanceTime(recoveredInstance),
        endTime: endTime(recoveredInstance),
        repairStatus: recovered ? "recovered" : repairing ? "repairing" : "unresolved",
        recoveryInstanceId: instanceId(recoveredInstance),
        recoveryState: recoveredState,
        recoveryTime: endTime(recoveredInstance) || instanceTime(recoveredInstance),
        failureMessage: String(recoveredInstance.failure_message || recoveredInstance.failureMessage || recoveredInstance.error_message || recoveredInstance.errorMessage || "").trim(),
        failureCount: Math.max(1, runTimesOf(recoveredInstance) - 1),
        inferredFromRetry: true,
      });
      continue;
    }
    const latestFailure = failed.at(-1);
    const failedAt = timestamp(instanceTime(latestFailure));
    const later = ordered.filter((item) => timestamp(instanceTime(item)) > failedAt);
    const recovered = later.find((item) => SUCCESS_STATES.has(stateOf(item)));
    const repairing = !recovered ? later.find((item) => RUNNING_STATES.has(stateOf(item))) : null;
    failures.push({
      projectName,
      projectCode,
      workflowCode: workflowCode(latestFailure),
      workflowName: workflowName(latestFailure),
      instanceId: instanceId(latestFailure),
      instanceState: stateOf(latestFailure),
      startTime: instanceTime(latestFailure),
      endTime: endTime(latestFailure),
      repairStatus: recovered ? "recovered" : repairing ? "repairing" : "unresolved",
      recoveryInstanceId: instanceId(recovered || repairing || {}),
      recoveryState: stateOf(recovered || repairing || {}),
      recoveryTime: instanceTime(recovered || repairing || {}),
      failureMessage: String(latestFailure.failure_message || latestFailure.failureMessage || latestFailure.error_message || latestFailure.errorMessage || "").trim(),
      failureCount: failed.length,
    });
  }
  return failures.sort((a, b) => timestamp(b.startTime) - timestamp(a.startTime));
}

export function extractDsFailureReason(log, fallback = "") {
  const lines = String(log || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const stackFrame = (line) => /(?:^|\s)(?:at\s+)?[\w$<>.]+\([^)]*\.(?:java|scala|kt|py):\d+\)\s*$/i.test(line)
    || /^\s*\.\.\.\s+\d+\s+more\s*$/i.test(line);
  const candidates = lines.map((line, index) => {
    if (stackFrame(line)) return null;
    let score = 0;
    if (/Caused by\s*:/i.test(line)) score = 100;
    else if (/(?:SQLSTATE|detailMessage|errCode|does not exist|unknown (?:column|table)|permission denied|syntax error|unsupported operand|no such)/i.test(line)) score = 90;
    else if (/(?:Exception|SQLException|Error)\s*[:：]/i.test(line)) score = 80;
    else if (/(?:\bERROR\b|\bFAILED\b|\bfailure\b)/i.test(line)) score = 60;
    return score ? { line, score, index } : null;
  }).filter(Boolean).sort((a, b) => b.score - a.score || b.index - a.index);
  if (!candidates.length && lines.some(stackFrame) && !String(fallback || "").trim()) {
    return "任务日志只返回了程序调用栈，未解析到明确业务失败原因";
  }
  const candidate = candidates[0]?.line || String(fallback || "").trim();
  if (!candidate) return "任务日志未返回明确失败原因";
  if (stackFrame(candidate)) return "任务日志只返回了程序调用栈，未解析到明确业务失败原因";
  return candidate
    .replace(/^.*?Caused by\s*:\s*/i, "")
    .replace(/^.*?\bERROR\b\s*[-:：]?\s*/i, "")
    .trim().slice(0, 1000) || candidate.slice(0, 1000);
}

export function extractTaskScript(data = {}) {
  const runtime = data.runtime_config || data.runtimeConfig || {};
  const taskParams = data.task_params || data.taskParams || {};
  for (const value of [runtime.sql, runtime.raw_script, runtime.rawScript, taskParams.sql, taskParams.raw_script, taskParams.rawScript, data.sql, data.raw_script, data.rawScript]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

async function loadTaskRuntime(failure, task, { webhookUrl, country, token }) {
  const taskName = String(task.taskName || failure.taskName || "").trim();
  const taskCode = String(task.taskCode || failure.taskCode || "").trim();
  if (!failure.workflowCode || (!taskName && !taskCode)) return {};
  try {
    const runtime = await postAction(webhookUrl, country, token, "extract_task_runtime_config", {
      project_code: failure.projectCode,
      workflow_code: failure.workflowCode,
      task_name: taskName,
      task_code: taskCode,
    });
    return {
      taskType: String(runtime.task_type || runtime.taskType || task.taskType || "").trim().toUpperCase(),
      taskScript: extractTaskScript(runtime),
    };
  } catch (error) {
    return { taskConfigError: error.message };
  }
}

async function enrichFailure(failure, { webhookUrl, country, token }) {
  if (!failure.instanceId) return { ...failure, failureMessage: extractDsFailureReason("", failure.failureMessage) };
  try {
    if (failure.taskInstanceId) {
      const logData = await postAction(webhookUrl, country, token, "get_task_log", {
        project_code: failure.projectCode,
        task_instance_id: failure.taskInstanceId,
      });
      const runtime = await loadTaskRuntime(failure, {
        taskName: failure.taskName,
        taskCode: failure.taskCode,
        taskType: failure.taskType,
      }, { webhookUrl, country, token });
      return {
        ...failure,
        ...runtime,
        failureMessage: extractDsFailureReason(logData.log || logData.task_log || logData.content || "", failure.failureMessage),
      };
    }
    const tasks = await postAction(webhookUrl, country, token, "list_task_instances", {
      project_code: failure.projectCode,
      instance_id: failure.instanceId,
      process_instance_id: failure.instanceId,
      state_type: "FAILURE",
      page_no: 1,
      page_size: 100,
    });
    const failedTask = recordList(tasks)
      .filter((item) => FAILED_STATES.has(stateOf(item)))
      .sort((a, b) => timestamp(endTime(b) || instanceTime(b)) - timestamp(endTime(a) || instanceTime(a)))[0];
    if (!failedTask) return { ...failure, failureMessage: extractDsFailureReason("", failure.failureMessage) };
    const taskInstanceId = String(failedTask.task_instance_id || failedTask.taskInstanceId || failedTask.id || "").trim();
    const taskName = String(failedTask.task_name || failedTask.taskName || failedTask.name || "").trim();
    const taskCode = String(failedTask.task_code || failedTask.taskCode || failedTask.code || "").trim();
    const taskType = String(failedTask.task_type || failedTask.taskType || failedTask.type || "").trim().toUpperCase();
    const logData = taskInstanceId ? await postAction(webhookUrl, country, token, "get_task_log", {
      project_code: failure.projectCode,
      task_instance_id: taskInstanceId,
    }) : {};
    const runtime = await loadTaskRuntime(failure, { taskName, taskCode, taskType }, { webhookUrl, country, token });
    return {
      ...failure,
      ...runtime,
      taskInstanceId,
      taskName,
      taskCode,
      taskType: runtime.taskType || taskType,
      taskState: stateOf(failedTask),
      failureMessage: extractDsFailureReason(logData.log || logData.task_log || logData.content || "", failure.failureMessage),
    };
  } catch (error) {
    return {
      ...failure,
      failureMessage: extractDsFailureReason("", failure.failureMessage),
      logError: error.message,
    };
  }
}

function isTransientGatewayError(error) {
  return /(?:connection (?:closed|reset)|closed by remote host|port 22|econnreset|socket hang up|fetch failed|request timeout|请求超时|网关返回非 JSON（HTTP 200）)/i.test(String(error?.message || error || ""));
}

async function postAction(webhookUrl, country, token, action, payload = {}) {
  try {
    return await postActionOnce(webhookUrl, country, token, action, payload);
  } catch (error) {
    if (!isTransientGatewayError(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      return await postActionOnce(webhookUrl, country, token, action, payload);
    } catch (retryError) {
      throw new Error(`网关瞬时连接失败，自动重试 1 次后仍未恢复：${retryError.message}`);
    }
  }
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}

function buildDsInstanceUrl(country, projectCode, instanceId, configuredBaseUrl = "") {
  const baseUrl = String(configuredBaseUrl || COUNTRY_DS_UI_BASE_URLS[country] || "").trim().replace(/\/+$/, "");
  if (!baseUrl || !projectCode || !instanceId) return "";
  return `${baseUrl}/projects/${encodeURIComponent(projectCode)}/workflow/instances/${encodeURIComponent(instanceId)}`;
}

export function normalizeGatewayFailures(data = {}, { projectName = "", projectCode = "", targetDate = "", timeZone = "UTC" } = {}) {
  const documented = Array.isArray(data.failed_workflows) ? data.failed_workflows : null;
  const records = documented || recordList(data);
  return records.filter((item) => {
    const scheduleStatus = String(item.schedule_status || item.scheduleStatus || "ONLINE").toUpperCase();
    const failureReason = String(item.failure_reason || item.failureReason || "").toLowerCase();
    const commandType = String(item.command_type || item.commandType || "").toUpperCase();
    const scheduledFailure = documented
      ? failureReason === "scheduled_instance_failed"
      : commandType === "SCHEDULER" && FAILED_STATES.has(stateOf(item));
    const start = instanceTime(item);
    const isTargetDate = !targetDate || !start || localDate(start, timeZone) === targetDate;
    return scheduleStatus === "ONLINE" && scheduledFailure && isTargetDate;
  }).map((item) => {
    const hasLaterSuccess = item.has_later_success === true || item.hasLaterSuccess === true || String(item.recovery || "").toUpperCase() === "YES";
    const recoveryState = String(item.recovery_state || item.recoveryState || item.later_instance_state || item.laterInstanceState || "").toUpperCase();
    const hasLaterRunning = item.has_later_running === true || item.hasLaterRunning === true || RUNNING_STATES.has(recoveryState);
    return {
      projectName,
      projectCode,
      workflowCode: workflowCode(item),
      workflowName: workflowName(item),
      instanceId: instanceId(item),
      instanceState: stateOf(item) || "FAILURE",
      startTime: instanceTime(item),
      endTime: endTime(item),
      repairStatus: hasLaterSuccess ? "recovered" : hasLaterRunning ? "repairing" : "unresolved",
      recoveryInstanceId: String(item.recovery_instance_id || item.recoveryInstanceId || item.later_instance_id || item.laterInstanceId || ""),
      recoveryState: hasLaterSuccess ? recoveryState || "SUCCESS" : recoveryState,
      recoveryTime: item.recovery_time || item.recoveryTime || item.later_instance_time || item.laterInstanceTime || null,
      failureMessage: String(item.failure_message || item.failureMessage || item.error_message || item.errorMessage || "").trim(),
      failureCount: Number(item.failure_count || item.failureCount || item.consecutive_failures || item.consecutiveFailures || 1),
      taskInstanceId: String(item.task_instance_id || item.taskInstanceId || item.failed_task_instance_id || "").trim(),
      taskName: String(item.task_name || item.taskName || item.failed_task_name || "").trim(),
      taskCode: String(item.task_code || item.taskCode || item.failed_task_code || "").trim(),
      taskState: String(item.task_state || item.taskState || item.failed_task_state || "").trim(),
    };
  }).sort((a, b) => timestamp(b.startTime) - timestamp(a.startTime));
}

function pageTotal(data = {}) {
  const source = data?.data && typeof data.data === "object" ? data.data : data;
  for (const key of ["total", "totalCount", "total_count"]) {
    const raw = source?.[key];
    if (raw == null || raw === "") continue;
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function totalPages(data = {}) {
  const source = data?.data && typeof data.data === "object" ? data.data : data;
  for (const key of ["totalPage", "totalPages", "total_page", "total_pages", "pages"]) {
    const raw = source?.[key];
    if (raw == null || raw === "") continue;
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

async function listProjectInstances({ webhookUrl, country, token, projectCode, targetDate, timeZone }) {
  const instances = [];
  const seen = new Set();
  for (let pageNo = 1; pageNo <= MAX_INSTANCE_PAGES; pageNo += 1) {
    const data = await postAction(webhookUrl, country, token, "list_instances", {
      project_code: projectCode,
      state_type: "",
      search_val: "",
      page_no: pageNo,
      page_size: INSTANCE_PAGE_SIZE,
      start_time: `${targetDate} 00:00:00`,
      end_time: `${targetDate} 23:59:59`,
      timezone_id: timeZone,
    });
    const records = recordList(data);
    const reachedOlderRecords = records.some((item) => {
      const start = instanceTime(item);
      return Boolean(start) && localDate(start, timeZone) < targetDate;
    });
    for (const item of records) {
      const key = instanceId(item) || `${workflowCode(item)}:${instanceTime(item)}:${stateOf(item)}`;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      instances.push(item);
    }
    const count = pageTotal(data);
    const pages = totalPages(data);
    if (!records.length || reachedOlderRecords || (count != null && instances.length >= count) || (pages != null && pageNo >= pages) || records.length < INSTANCE_PAGE_SIZE) break;
  }
  return instances.filter((item) => {
    const start = instanceTime(item);
    return Boolean(start) && localDate(start, timeZone) === targetDate;
  });
}

async function inspectProject({ webhookUrl, country, token, project, targetDate, timeZone, dsUiBaseUrl }) {
  try {
    const instances = await listProjectInstances({
      webhookUrl,
      country,
      token,
      projectCode: project.code,
      targetDate,
      timeZone,
    });
    const failures = classifyWorkflowFailures(instances, { projectName: project.name, projectCode: project.code })
      .map((failure) => ({
        ...failure,
        dsInstanceUrl: buildDsInstanceUrl(country, project.code, failure.instanceId, dsUiBaseUrl),
      }));
    const enriched = await mapWithConcurrency(failures, FAILURE_ENRICH_CONCURRENCY,
      (failure) => enrichFailure(failure, { webhookUrl, country, token }));
    return { projectName: project.name, projectCode: project.code, success: true, checkedInstances: instances.length, failures: enriched };
  } catch (error) {
    return { projectName: project.name, projectCode: project.code, success: false, error: error.message, checkedInstances: 0, failures: [] };
  }
}

async function inspectCountry(config, country, now) {
  const countryConfig = config.countries?.[country] || {};
  const countryName = countryConfig.name || COUNTRY_LABELS[country];
  const token = String(countryConfig.token || "").trim();
  const projects = projectTargets(config, country);
  const timeZone = COUNTRY_TIMEZONES[country];
  const targetDate = todayInTimeZone(timeZone, now);
  const dsUiBaseUrl = String(countryConfig.dsUiUrl || countryConfig.ds_ui_url || "").trim();
  if (!token || !projects.length) {
    return {
      country,
      countryName,
      timeZone,
      targetDate,
      configured: false,
      success: false,
      error: !token ? "DS Token 未配置" : "DS 项目尚未匹配",
      checkedProjects: 0,
      checkedInstances: 0,
      failures: [],
      projects: [],
    };
  }
  const projectResults = await mapWithConcurrency(projects, PROJECT_QUERY_CONCURRENCY, (project) => inspectProject({
    webhookUrl: config.n8nWebhookUrl,
    country,
    token,
    project,
    targetDate,
    timeZone,
    dsUiBaseUrl,
  }));
  const failures = projectResults.flatMap((item) => item.failures || []);
  return {
    country,
    countryName,
    timeZone,
    targetDate,
    configured: true,
    success: projectResults.some((item) => item.success),
    partialFailure: projectResults.some((item) => !item.success),
    error: projectResults.filter((item) => !item.success).map((item) => `${item.projectName || item.projectCode}：${item.error}`).join("；") || null,
    checkedProjects: projectResults.filter((item) => item.success).length,
    checkedInstances: projectResults.reduce((sum, item) => sum + Number(item.checkedInstances || 0), 0),
    failures,
    projects: projectResults,
  };
}

export async function inspectDsFailureLogs(rootDir, { now = new Date(), countries: requestedCountries } = {}) {
  const config = await loadDsSchedulerConfig(rootDir);
  const selectedCountries = normalizeCountrySelection(requestedCountries);
  const countries = await Promise.all(selectedCountries.map((country) => inspectCountry(config, country, now)));
  const failures = countries.flatMap((item) => item.failures || []);
  return {
    checkedAt: new Date().toISOString(),
    dateMode: "country-local-today",
    totalCountries: selectedCountries.length,
    configuredCountries: countries.filter((item) => item.configured).length,
    checkedProjects: countries.reduce((sum, item) => sum + item.checkedProjects, 0),
    checkedInstances: countries.reduce((sum, item) => sum + item.checkedInstances, 0),
    totalFailures: failures.length,
    recoveredCount: failures.filter((item) => item.repairStatus === "recovered").length,
    repairingCount: failures.filter((item) => item.repairStatus === "repairing").length,
    unresolvedCount: failures.filter((item) => item.repairStatus === "unresolved").length,
    failedCountries: countries.filter((item) => item.configured && !item.success).length,
    countries,
  };
}
