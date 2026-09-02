import path from "node:path";
import { N8nClient } from "./n8n-client.mjs";
import { resolveN8nDsFailureEvidence } from "./ds-failure-log-monitor.mjs";
import { deepMapStrings, loadEnvFile, readJsonFile } from "./utils.mjs";

const COUNTRIES = ["cn", "ine", "ph", "th", "pk", "mx"];
const COUNTRY_NAMES = {
  cn: "中国",
  ine: "印尼",
  ph: "菲律宾",
  th: "泰国",
  pk: "巴基斯坦",
  mx: "墨西哥",
};
const DEFAULT_WORKFLOW_NAME = "各国-DS失败自动重跑统一入口";
const DEFAULT_WEBHOOK_PATH = "ds-failed-auto-rerun";
const ENV_PATTERN = /\$\{([A-Z0-9_]+)\}/g;
const CACHE_TTL_MS = 30_000;
const cache = new Map();

function resolveEnv(value) {
  if (typeof value !== "string") return value;
  return value.replace(ENV_PATTERN, (_, key) => process.env[key] ?? "");
}

function normalizeCountry(value) {
  const text = String(value || "").trim().toLowerCase();
  if (["cn", "chn", "中国"].includes(text)) return "cn";
  if (["ine", "id", "ina", "indonesia", "印尼"].includes(text)) return "ine";
  if (["ph", "菲律宾"].includes(text)) return "ph";
  if (["th", "泰国"].includes(text)) return "th";
  if (["pk", "巴铁", "巴基斯坦"].includes(text)) return "pk";
  if (["mx", "mex", "墨西哥"].includes(text)) return "mx";
  return "";
}

function normalizeCountries(value) {
  const requested = Array.isArray(value) ? value : String(value || "").split(",");
  const result = [];
  for (const item of requested) {
    const country = normalizeCountry(item);
    if (country && !result.includes(country)) result.push(country);
  }
  return result.length ? result : [...COUNTRIES];
}

function parseJsonString(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || (!text.startsWith("{") && !text.startsWith("["))) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isDsRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return [
    "workflowInstanceId",
    "workflow_instance_id",
    "workflowDefinitionCode",
    "workflow_definition_code",
    "workflowInstanceName",
    "workflow_instance_name",
    "commandType",
    "workflowExecutionStatus",
  ].some((key) => value[key] !== undefined && value[key] !== null);
}

/**
 * n8n execution data has changed shape across versions. This intentionally
 * walks the webhook input and SSH output instead of assuming one fixed path.
 */
export function extractDsAutoRetryRecords(executionDetail) {
  const records = [];
  const seen = new Set();
  const visit = (value, inherited = {}, depth = 0) => {
    if (depth > 30 || value === null || value === undefined) return;
    if (typeof value === "string") {
      const parsed = parseJsonString(value);
      if (parsed !== null) visit(parsed, inherited, depth + 1);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, inherited, depth + 1);
      return;
    }
    if (typeof value !== "object") return;

    const base = { ...inherited };
    for (const key of ["country", "projectCode", "projectName", "workflowInstanceId", "workflowDefinitionCode", "workflowInstanceName", "commandType", "workflowExecutionStatus", "modifyBy", "runTimes", "workflowStartTime", "workflowEndTime", "workflowHost", "taskInstanceId", "taskName", "taskCode", "taskType", "failureReason", "failureMessage", "retryResult", "repairStatus", "retryCount", "recoveryState", "recoveryInstanceId"]) {
      if (value[key] !== undefined && value[key] !== null && value[key] !== "") base[key] = value[key];
    }
    if (isDsRecord(value) || (base.workflowInstanceId && base.commandType)) {
      const key = [base.country, base.projectCode, base.workflowInstanceId, base.workflowDefinitionCode, base.workflowInstanceName].map((item) => String(item || "")).join("|");
      if (key && !seen.has(key)) {
        seen.add(key);
        records.push({ ...base, ...value });
      }
    }
    // The DS alert body normally stores the actual record in `message` as a
    // JSON string (sometimes as a one-element array).
    if (value.message !== undefined) visit(value.message, base, depth + 1);
    if (value.json !== undefined) visit(value.json, base, depth + 1);
    for (const [key, child] of Object.entries(value)) {
      if (["message", "json", "binary", "stack"].includes(key)) continue;
      if (typeof child === "object") visit(child, base, depth + 1);
    }
  };
  visit(executionDetail);
  return records;
}

function findText(value, pattern) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return pattern.test(value) ? value : "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = findText(item, pattern);
      if (result) return result;
    }
    return "";
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) {
      const result = findText(item, pattern);
      if (result) return result;
    }
  }
  return "";
}

function extractRemoteLogPath(executionDetail) {
  const candidate = findText(executionDetail, /(?:auto_repair|ds_failed_auto_retry)[^\s"']*\.log/i);
  if (!candidate) return "";
  const match = candidate.match(/(?:\/|[A-Za-z]:\\)[^\s"']*(?:auto_repair|ds_failed_auto_retry)[^\s"']*\.log/i);
  return match?.[0] || candidate.slice(0, 500);
}

function extractAck(executionDetail) {
  const text = findText(executionDetail, /background_started|accepted|request_id/);
  const parsed = parseJsonString(text);
  if (parsed && typeof parsed === "object") return parsed;
  const requestId = text.match(/request_id["':= ]+([A-Za-z0-9._-]+)/i)?.[1] || "";
  return { request_id: requestId, raw: text.slice(0, 500) };
}

function executionTime(execution) {
  return execution?.startedAt || execution?.createdAt || execution?.started_at || "";
}

function withinLookback(value, now, days) {
  const time = Date.parse(value || "");
  if (!Number.isFinite(time)) return true;
  return time >= now.getTime() - days * 24 * 60 * 60 * 1000;
}

function normalizedStatus(execution, detail) {
  const status = String(detail?.status || execution?.status || "").toLowerCase();
  if (["error", "failed", "failure", "crashed"].includes(status)) return "n8n_failed";
  if (["running", "waiting", "new"].includes(status)) return "n8n_running";
  return "n8n_accepted";
}

function deriveRepairOutcome(record = {}, detail = {}, triggerStatus = "") {
  const explicit = String(record.retryResult || record.repairStatus || record.recoveryState || "").trim().toLowerCase();
  let text = "";
  try {
    text = JSON.stringify({ record, detail });
  } catch {
    text = `${record.failureMessage || ""} ${record.failureReason || ""}`;
  }
  if (["recovered", "success", "succeed", "succeeded"].includes(explicit)
    || /(?:自动重跑|重跑后).{0,20}(?:恢复成功|已恢复|修复成功)|自动修复成功/i.test(text)) {
    return { repairStatus: "recovered", retryResult: "recovered" };
  }
  if (["failed", "failure", "unresolved", "timeout_needs_owner"].includes(explicit)
    || /自动重跑.{0,30}(?:全部失败|仍未恢复)|重跑后仍失败|需要负责人查看/i.test(text)) {
    return { repairStatus: "unresolved", retryResult: "failed" };
  }
  if (["running", "repairing", "retrying"].includes(explicit)
    || /目前自动失败重试中|自动重跑中|正在重跑|正在重试/i.test(text)
    || triggerStatus === "n8n_running") {
    return { repairStatus: "repairing", retryResult: "running" };
  }
  if (triggerStatus === "ignored_start_workflow") return { repairStatus: "not_retried", retryResult: "not_triggered" };
  if (triggerStatus === "n8n_failed") return { repairStatus: "unresolved", retryResult: "failed" };
  // An accepted asynchronous request is not proof that DS recovered. Keep it
  // explicitly unknown until the n8n execution or notification returns a
  // concrete retry outcome.
  return { repairStatus: "unknown", retryResult: "unknown" };
}

function executionResultData(detail = {}) {
  return detail?.data?.resultData || detail?.resultData || {};
}

function executionErrorMessage(detail = {}) {
  const resultData = executionResultData(detail);
  const error = resultData.error || detail.error;
  if (typeof error === "string") return error;
  return String(error?.message || error?.description || detail.errorMessage || "");
}

function executionLastNode(detail = {}) {
  const resultData = executionResultData(detail);
  return String(resultData.lastNodeExecuted || detail.lastNode || "");
}

function normalizeRecord(record, execution, detail) {
  const country = normalizeCountry(record.country) || normalizeCountry(record.projectName) || normalizeCountry(record.workflowInstanceName);
  const commandType = String(record.commandType || "").toUpperCase();
  const n8nStatus = normalizedStatus(execution, detail);
  const ignoredStartWorkflow = commandType === "START_PROCESS" || commandType === "START_WORKFLOW";
  const triggerStatus = ignoredStartWorkflow ? "ignored_start_workflow" : n8nStatus;
  const repairOutcome = deriveRepairOutcome(record, detail, triggerStatus);
  const failureMessage = record.failureReason || record.failureMessage || executionErrorMessage(detail) || (n8nStatus === "n8n_failed" ? "n8n 自动重跑入口执行失败，请查看 n8n 节点错误" : "DS 告警已触发 n8n，远端失败重跑程序已异步启动");
  const ack = extractAck(detail);
  const projectCode = record.projectCode ?? record.project_code ?? "";
  const projectName = record.projectName ?? record.project_name ?? "";
  const workflowCode = record.workflowDefinitionCode ?? record.workflow_definition_code ?? "";
  const instanceId = record.workflowInstanceId ?? record.workflow_instance_id ?? "";
  const workflowName = record.workflowInstanceName ?? record.workflow_instance_name ?? "";
  return {
    country,
    projectCode: String(projectCode || ""),
    projectName: String(projectName || ""),
    workflowCode: String(workflowCode || ""),
    workflowName: String(workflowName || ""),
    instanceId: String(instanceId || ""),
    taskInstanceId: String(record.taskInstanceId || record.task_instance_id || ""),
    taskName: String(record.taskName || record.task_name || record.failedTaskName || record.failed_task_name || ""),
    taskCode: String(record.taskCode || record.task_code || record.failedTaskCode || record.failed_task_code || ""),
    taskType: String(record.taskType || record.task_type || ""),
    failureMessage: String(failureMessage),
    failureReason: String(failureMessage),
    instanceState: String(record.workflowExecutionStatus || "FAILURE"),
    startTime: record.workflowStartTime || executionTime(execution),
    endTime: record.workflowEndTime || detail?.stoppedAt || execution?.stoppedAt || "",
    retryCount: Math.max(0, Number(record.retryCount ?? record.runTimes ?? 0) - (record.retryCount == null ? 1 : 0)),
    repairStatus: repairOutcome.repairStatus,
    retryResult: repairOutcome.retryResult,
    recoveryState: String(record.recoveryState || ""),
    recoveryInstanceId: String(record.recoveryInstanceId || ""),
    failureType: "n8n_auto_trigger",
    retryDecision: ignoredStartWorkflow
      ? "启动工作流类型仅扫描，不执行失败重跑"
      : "DS 告警已自动触发 n8n 失败重跑入口；页面仅展示 n8n 执行日志，不重复扫描 DS",
    originalScheduledFailure: true,
    scheduleCategory: "n8n_auto_trigger",
    n8nTriggerStatus: triggerStatus,
    n8nExecutionId: String(execution?.id || ""),
    n8nWorkflowId: String(execution?.workflowId || detail?.workflowId || ""),
    n8nWorkflowName: detail?.workflowName || execution?.workflowName || "",
    n8nRequestId: String(ack?.request_id || ack?.requestId || ""),
    n8nLogPath: extractRemoteLogPath(detail),
    // Kept for response compatibility with older consumers. Project inclusion
    // is now determined solely by the DS project fields parsed from n8n detail;
    // no ZNZB-saved project scope is consulted.
    n8nProjectScopeConfigured: false,
    n8nProjectScopeMatched: true,
    n8nLastNode: executionLastNode(detail),
    n8nError: executionErrorMessage(detail),
  };
}

async function loadN8nClient(rootDir, supplied) {
  if (supplied) return supplied;
  await loadEnvFile(path.join(rootDir, ".env"));
  const raw = await readJsonFile(path.join(rootDir, "config/alerts.config.json"), {});
  const config = deepMapStrings(raw || {}, resolveEnv);
  const baseUrl = process.env.N8N_BASE_URL || config.n8n?.baseUrl || "";
  const apiKey = process.env.N8N_API_KEY || config.n8n?.apiKey || "";
  if (!baseUrl || !apiKey) throw new Error("n8n 未配置：请设置 N8N_BASE_URL 和 N8N_API_KEY");
  return new N8nClient({ baseUrl, apiKey, timeoutMs: 20_000 });
}

async function listAllWorkflows(client) {
  const workflows = [];
  let cursor;
  do {
    const payload = await client.listWorkflows({ limit: 250, cursor });
    workflows.push(...(payload?.data || []));
    cursor = payload?.nextCursor || "";
  } while (cursor && workflows.length < 1000);
  return workflows;
}

function isTargetWorkflow(workflow, workflowName, webhookPath) {
  if (String(workflow?.name || "") === workflowName) return true;
  if (/DS失败自动重跑/.test(String(workflow?.name || ""))) return true;
  if ([workflow?.webhookPath, workflow?.path, workflow?.webhook?.path]
    .filter(Boolean)
    .some((value) => String(value).replace(/^\//, "") === webhookPath)) return true;
  return (workflow?.nodes || []).some((node) => {
    const pathValue = node?.parameters?.path || node?.parameters?.webhookPath || "";
    return String(pathValue).replace(/^\//, "") === webhookPath && /webhook|告警|ds/i.test(`${node?.type || ""} ${node?.name || ""}`);
  });
}

async function mapWithConcurrency(values, concurrency, fn) {
  const result = new Array(values.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      result[index] = await fn(values[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return result;
}

function emptyCountry(country, error = "") {
  return {
    country,
    countryName: COUNTRY_NAMES[country] || country,
    configured: true,
    success: !error,
    queryFailed: Boolean(error),
    error,
    failures: [],
    projects: [],
    checkedProjects: 0,
    checkedInstances: 0,
    n8nProjectScopeConfigured: false,
    n8nProjectScopeMatched: true,
    targetDate: "",
  };
}

/**
 * Read only the executions of the DS alert -> n8n auto-retry workflow.
 * This is deliberately separate from inspectOriginalScheduledFailures(), which
 * is the ZNZB page's own DS polling scan.
 */
export async function inspectN8nAutoRetryExecutions(rootDir, {
  now = new Date(),
  countries: requestedCountries,
  lookbackDays = 7,
  // Deprecated compatibility parameters. The monitor no longer filters by a
  // ZNZB project scope; DS projectCode/projectName from n8n execution detail
  // are the sole source of project identity.
  projectScope: _projectScope = {},
  projectScopeConfigured: _projectScopeConfigured = false,
  n8nClient,
  dsEvidenceResolver = resolveN8nDsFailureEvidence,
  enrichDsEvidence = true,
  workflowName = DEFAULT_WORKFLOW_NAME,
  webhookPath = DEFAULT_WEBHOOK_PATH,
  limit = 250,
  bypassCache = false,
} = {}) {
  const selectedCountries = normalizeCountries(requestedCountries);
  const days = Math.max(1, Math.min(90, Math.trunc(Number(lookbackDays) || 7)));
  const cacheKey = JSON.stringify([rootDir, selectedCountries, days, workflowName, webhookPath, Boolean(enrichDsEvidence)]);
  const cached = cache.get(cacheKey);
  if (!bypassCache && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  // Avoid lint/no-unused regressions while keeping the old options accepted by
  // callers that have not yet removed them.
  void _projectScope;
  void _projectScopeConfigured;
  const countries = selectedCountries.map((country) => emptyCountry(country));
  const countryMap = new Map(countries.map((country) => [country.country, country]));
  const client = await loadN8nClient(rootDir, n8nClient);
  const workflows = await listAllWorkflows(client);
  const workflow = workflows.find((item) => isTargetWorkflow(item, workflowName, webhookPath));
  if (!workflow?.id) {
    const error = `未找到 n8n 工作流“${workflowName}”（Webhook 路径 ${webhookPath}）`;
    for (const country of countries) {
      country.success = false;
      country.queryFailed = true;
      country.error = error;
    }
    const value = { source: "n8n-auto-trigger-execution-log", mode: "n8n-auto-trigger-execution-log", checkedAt: now.toISOString(), lookbackDays: days, n8nWorkflow: null, n8nConfigured: true, n8nProjectScopeConfigured: false, totalExecutions: 0, totalFailures: 0, countries };
    cache.set(cacheKey, { at: Date.now(), value });
    return value;
  }

  // n8n's public GET /executions endpoint currently rejects the documented
  // startedAfter/startedBefore query parameters (HTTP 400: Unknown query
  // parameter). Query the workflow's latest executions and apply the lookback
  // window locally instead, which keeps the monitor compatible with both the
  // affected and older n8n versions.
  const executionPayload = await client.listExecutions({
    workflowId: workflow.id,
    limit: Math.min(limit, 250),
  });
  const executions = (executionPayload?.data || []).filter((execution) => withinLookback(executionTime(execution), now, days));
  const details = await mapWithConcurrency(executions, 8, async (execution) => {
    try {
      return { execution, detail: await client.getExecution(execution.id, { includeData: true }) };
    } catch (error) {
      return { execution, detail: { id: execution.id, workflowId: execution.workflowId, status: "error", errorMessage: error.message, startedAt: execution.startedAt, stoppedAt: execution.stoppedAt } };
    }
  });
  const discovered = [];
  for (const { execution, detail } of details) {
    const records = extractDsAutoRetryRecords(detail);
    const effectiveRecords = records.length ? records : [{ country: "", failureReason: detail?.errorMessage || "n8n 执行未返回 DS 告警载荷", commandType: "" }];
    for (const record of effectiveRecords) {
      const item = normalizeRecord(record, execution, detail);
      const country = item.country;
      // A record is included when n8n execution detail identifies a supported
      // country. Its DS projectCode/projectName are already parsed into item;
      // there is intentionally no second filter against ZNZB configuration.
      if (!country || !countryMap.has(country)) continue;
      discovered.push(item);
    }
  }
  const evidenceByInstance = new Map();
  const enriched = await mapWithConcurrency(discovered, 6, async (item) => {
    if (!enrichDsEvidence || item.taskName || item.taskCode || !item.instanceId || !item.projectCode) return item;
    const evidenceKey = `${item.country}:${item.projectCode}:${item.instanceId}`;
    if (!evidenceByInstance.has(evidenceKey)) {
      evidenceByInstance.set(evidenceKey, Promise.resolve(dsEvidenceResolver(rootDir, { country: item.country, failure: item })));
    }
    try {
      const evidence = await evidenceByInstance.get(evidenceKey);
      return { ...item, ...(evidence || {}) };
    } catch (error) {
      return { ...item, taskLookupStatus: "failed", taskLookupError: error.message };
    }
  });
  let totalFailures = 0;
  for (const item of enriched) {
    const countryResult = countryMap.get(item.country);
    countryResult.failures.push(item);
    countryResult.checkedInstances += 1;
    const projectKey = item.projectCode || item.projectName;
    if (projectKey && !countryResult.projects.some((project) => String(project.projectCode || project.projectName) === String(projectKey))) {
      countryResult.projects.push({ projectCode: item.projectCode, projectName: item.projectName, success: true });
    }
    totalFailures += 1;
  }
  for (const country of countries) {
    country.checkedProjects = country.projects.length;
    country.targetDate = now.toISOString().slice(0, 10);
    country.failures.sort((a, b) => Date.parse(b.startTime || 0) - Date.parse(a.startTime || 0));
  }
  const value = {
    source: "n8n-auto-trigger-execution-log",
    mode: "n8n-auto-trigger-execution-log",
    checkedAt: now.toISOString(),
    lookbackDays: days,
    n8nWorkflow: { id: String(workflow.id), name: workflow.name || workflowName, webhookPath },
    n8nConfigured: true,
    n8nProjectScopeConfigured: false,
    totalExecutions: executions.length,
    totalFailures,
    countries,
  };
  cache.set(cacheKey, { at: Date.now(), value });
  return value;
}

export function clearN8nAutoRetryMonitorCache() {
  cache.clear();
}
