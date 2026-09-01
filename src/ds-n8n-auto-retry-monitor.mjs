import path from "node:path";
import { N8nClient } from "./n8n-client.mjs";
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

function normalizeScope(scope = {}) {
  const result = {};
  for (const country of COUNTRIES) {
    const values = Array.isArray(scope?.[country]) ? scope[country] : [];
    result[country] = [...new Set(values.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))];
  }
  return result;
}

function scopeMatches(record, scope, country) {
  const allowed = scope[country] || [];
  if (!allowed.length) return false;
  const identities = [record.projectCode, record.projectName, record.project_code, record.project_name]
    .filter((value) => value !== undefined && value !== null)
    .map((value) => String(value).trim().toLowerCase());
  return identities.some((identity) => allowed.includes(identity));
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
    for (const key of ["country", "projectCode", "projectName", "workflowInstanceId", "workflowDefinitionCode", "workflowInstanceName", "commandType", "workflowExecutionStatus", "modifyBy", "runTimes", "workflowStartTime", "workflowEndTime", "workflowHost", "failureReason", "failureMessage"]) {
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

function normalizeRecord(record, execution, detail, scope, projectScopeConfigured) {
  const country = normalizeCountry(record.country) || normalizeCountry(record.projectName) || normalizeCountry(record.workflowInstanceName);
  const commandType = String(record.commandType || "").toUpperCase();
  const n8nStatus = normalizedStatus(execution, detail);
  const ignoredStartWorkflow = commandType === "START_PROCESS" || commandType === "START_WORKFLOW";
  const triggerStatus = ignoredStartWorkflow ? "ignored_start_workflow" : n8nStatus;
  const failureMessage = record.failureReason || record.failureMessage || detail?.errorMessage || (n8nStatus === "n8n_failed" ? "n8n 自动重跑入口执行失败，请查看 n8n 节点错误" : "DS 告警已触发 n8n，远端失败重跑程序已异步启动");
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
    taskName: "",
    taskCode: "",
    taskType: "",
    failureMessage: String(failureMessage),
    failureReason: String(failureMessage),
    instanceState: String(record.workflowExecutionStatus || "FAILURE"),
    startTime: record.workflowStartTime || executionTime(execution),
    endTime: record.workflowEndTime || detail?.stoppedAt || execution?.stoppedAt || "",
    retryCount: Math.max(0, Number(record.runTimes || 0) - 1),
    repairStatus: triggerStatus === "n8n_failed" ? "unresolved" : "repairing",
    retryResult: triggerStatus === "n8n_failed" ? "failed" : triggerStatus === "ignored_start_workflow" ? "not_triggered" : "running",
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
    n8nProjectScopeConfigured: projectScopeConfigured,
    n8nProjectScopeMatched: scopeMatches(record, scope, country),
    n8nLastNode: detail?.lastNode || "",
    n8nError: detail?.errorMessage || "",
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

function emptyCountry(country, projectScopeConfigured, error = "") {
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
    n8nProjectScopeConfigured: projectScopeConfigured,
    n8nProjectScopeMatched: false,
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
  projectScope = {},
  projectScopeConfigured = false,
  n8nClient,
  workflowName = DEFAULT_WORKFLOW_NAME,
  webhookPath = DEFAULT_WEBHOOK_PATH,
  limit = 250,
  bypassCache = false,
} = {}) {
  const selectedCountries = normalizeCountries(requestedCountries);
  const days = Math.max(1, Math.min(90, Math.trunc(Number(lookbackDays) || 7)));
  const scope = normalizeScope(projectScope);
  const cacheKey = JSON.stringify([rootDir, selectedCountries, days, scope, workflowName, webhookPath]);
  const cached = cache.get(cacheKey);
  if (!bypassCache && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  const countries = selectedCountries.map((country) => emptyCountry(country, projectScopeConfigured));
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
    const value = { source: "n8n-auto-trigger-execution-log", mode: "n8n-auto-trigger-execution-log", checkedAt: now.toISOString(), lookbackDays: days, n8nWorkflow: null, n8nConfigured: true, n8nProjectScopeConfigured: projectScopeConfigured, totalExecutions: 0, totalFailures: 0, countries };
    cache.set(cacheKey, { at: Date.now(), value });
    return value;
  }

  const executionPayload = await client.listExecutions({
    workflowId: workflow.id,
    limit: Math.min(limit, 250),
    startedAfter: new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString(),
    startedBefore: now.toISOString(),
  });
  const executions = (executionPayload?.data || []).filter((execution) => withinLookback(executionTime(execution), now, days));
  const details = await mapWithConcurrency(executions, 8, async (execution) => {
    try {
      return { execution, detail: await client.getExecution(execution.id, { includeData: true }) };
    } catch (error) {
      return { execution, detail: { id: execution.id, workflowId: execution.workflowId, status: "error", errorMessage: error.message, startedAt: execution.startedAt, stoppedAt: execution.stoppedAt } };
    }
  });
  let totalFailures = 0;
  for (const { execution, detail } of details) {
    const records = extractDsAutoRetryRecords(detail);
    const effectiveRecords = records.length ? records : [{ country: "", failureReason: detail?.errorMessage || "n8n 执行未返回 DS 告警载荷", commandType: "" }];
    for (const record of effectiveRecords) {
      const item = normalizeRecord(record, execution, detail, scope, projectScopeConfigured);
      const country = item.country;
      if (!country || !countryMap.has(country) || !scopeMatches(item, scope, country)) continue;
      const countryResult = countryMap.get(country);
      countryResult.failures.push(item);
      countryResult.checkedInstances += 1;
      const projectKey = item.projectCode || item.projectName;
      if (projectKey && !countryResult.projects.some((project) => String(project.projectCode || project.projectName) === String(projectKey))) {
        countryResult.projects.push({ projectCode: item.projectCode, projectName: item.projectName, success: true });
      }
      totalFailures += 1;
    }
  }
  for (const country of countries) {
    country.checkedProjects = country.projects.length;
    country.n8nProjectScopeMatched = country.failures.length > 0;
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
    n8nProjectScopeConfigured: projectScopeConfigured,
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
