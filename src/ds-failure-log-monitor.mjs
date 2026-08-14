import { fetchCompatible } from "./fetch-compatible.mjs";
import { loadDsSchedulerConfig } from "./ds-scheduler-monitor.mjs";

const REQUEST_TIMEOUT_MS = 60_000;
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

const FAILED_STATES = new Set(["FAILURE", "KILL", "STOP", "STOPPED", "6", "9", "5"]);
const SUCCESS_STATES = new Set(["SUCCESS", "7"]);
const RUNNING_STATES = new Set(["SUBMITTED_SUCCESS", "RUNNING_EXECUTION", "WAITING_THREAD", "WAITING_DEPEND", "DELAY_EXECUTION", "0", "1", "10", "11", "12"]);

function stateOf(item = {}) {
  return String(item.state ?? item.instance_state ?? item.instanceState ?? item.workflow_execution_status ?? item.workflowExecutionStatus ?? "").trim().toUpperCase();
}

function recordList(data) {
  if (Array.isArray(data)) return data;
  for (const key of ["records", "list", "instances", "task_instances", "taskInstances"]) {
    if (Array.isArray(data?.[key])) return data[key];
  }
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

function timestamp(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function localDate(value, timeZone) {
  if (!value) return "";
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

async function postAction(webhookUrl, country, token, action, payload = {}) {
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
    if (!failed.length) continue;
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
  const meaningful = lines.filter((line) => /(?:ERROR|Exception|Caused by|SQLSTATE|FAILED|failure|No such|does not exist|Permission denied)/i.test(line));
  const candidate = meaningful.at(-1) || String(fallback || "").trim();
  if (!candidate) return "任务日志未返回明确失败原因";
  return candidate.replace(/^.*?(?:ERROR|Exception|Caused by)\s*[-:：]?\s*/i, "").trim().slice(0, 600) || candidate.slice(0, 600);
}

async function enrichFailure(failure, { webhookUrl, country, token }) {
  if (!failure.instanceId) return { ...failure, failureMessage: extractDsFailureReason("", failure.failureMessage) };
  try {
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
    const logData = taskInstanceId ? await postAction(webhookUrl, country, token, "get_task_log", {
      project_code: failure.projectCode,
      task_instance_id: taskInstanceId,
    }) : {};
    return {
      ...failure,
      taskInstanceId,
      taskName,
      taskCode,
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

async function inspectProject({ webhookUrl, country, token, project, targetDate, timeZone }) {
  try {
    const data = await postAction(webhookUrl, country, token, "list_instances", {
      project_code: project.code,
      page_no: 1,
      page_size: 100,
    });
    const all = recordList(data);
    const dated = all.filter((item) => localDate(instanceTime(item), timeZone) === targetDate);
    const failures = classifyWorkflowFailures(dated, { projectName: project.name, projectCode: project.code });
    const enriched = await Promise.all(failures.map((failure) => enrichFailure(failure, { webhookUrl, country, token })));
    return { projectName: project.name, projectCode: project.code, success: true, checkedInstances: dated.length, failures: enriched };
  } catch (error) {
    return { projectName: project.name, projectCode: project.code, success: false, error: error.message, checkedInstances: 0, failures: [] };
  }
}

export async function inspectDsFailureLogs(rootDir, { date = "", now = new Date() } = {}) {
  const config = await loadDsSchedulerConfig(rootDir);
  const countries = [];
  for (const country of COUNTRY_ORDER) {
    const countryConfig = config.countries?.[country] || {};
    const countryName = countryConfig.name || COUNTRY_LABELS[country];
    const token = String(countryConfig.token || "").trim();
    const projects = projectTargets(config, country);
    const timeZone = COUNTRY_TIMEZONES[country];
    const targetDate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : todayInTimeZone(timeZone, now);
    if (!token || !projects.length) {
      countries.push({
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
      });
      continue;
    }
    const projectResults = [];
    for (const project of projects) {
      projectResults.push(await inspectProject({ webhookUrl: config.n8nWebhookUrl, country, token, project, targetDate, timeZone }));
    }
    const failures = projectResults.flatMap((item) => item.failures || []);
    countries.push({
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
    });
  }
  const failures = countries.flatMap((item) => item.failures || []);
  return {
    checkedAt: new Date().toISOString(),
    date: date || null,
    totalCountries: COUNTRY_ORDER.length,
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
