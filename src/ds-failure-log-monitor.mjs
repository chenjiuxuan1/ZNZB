import { fetchCompatible } from "./fetch-compatible.mjs";
import { loadDsSchedulerConfig } from "./ds-scheduler-monitor.mjs";

const REQUEST_TIMEOUT_MS = 60_000;
const INSTANCE_PAGE_SIZE = 100;
const MAX_INSTANCE_PAGES = 50;
const TASK_PAGE_SIZE = 100;
const MAX_TASK_PAGES = 50;
const PROJECT_QUERY_CONCURRENCY = 4;
const FAILURE_ENRICH_CONCURRENCY = 3;
const ORIGINAL_FAILURE_CACHE_TTL_MS = 90_000;
const MAX_SUB_WORKFLOW_DEPTH = 8;
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
  cn: "https://dolphin.kuainiujinke.com/dolphinscheduler/ui",
  ine: "https://ds.empoweroceanin.com/dolphinscheduler/ui",
  ph: "https://ds.iloanmotor.com/dolphinscheduler/ui",
  th: "https://ds.jsxjdk.com/dolphinscheduler/ui",
  pk: "https://dolphin.wealthleaptech.com/dolphinscheduler/ui",
  mx: "https://ds.mxgbus.com/dolphinscheduler/ui",
};

const originalFailureResultCache = new Map();
const originalFailureInFlight = new Map();

const FAILED_STATES = new Set(["FAILURE", "KILL", "STOP", "STOPPED", "6", "9", "5"]);
const STOPPED_STATES = new Set(["KILL", "STOP", "STOPPED", "9", "5"]);
const SUCCESS_STATES = new Set(["SUCCESS", "7"]);
const RUNNING_STATES = new Set(["SUBMITTED_SUCCESS", "RUNNING_EXECUTION", "WAITING_THREAD", "WAITING_DEPEND", "DELAY_EXECUTION", "0", "1", "10", "11", "12"]);

const SQL_CODE_ERROR_PATTERNS = [
  /\bsyntax error\b/i, /\bsqlsyntaxerrorexception\b/i, /\bparse(?:r)? exception\b/i,
  /\bsemantic exception\b/i, /\banalysis exception\b/i, /\bmismatched input\b/i,
  /\bunknown (?:column|table|function|database)\b/i,
  /\b(?:column|table|function|database) .+ (?:does not exist|not found)\b/i,
  /\bno such (?:column|table|function|database)\b/i,
  /\b(?:cannot|could not|unable to) resolve (?:column|field|table|function)\b/i,
  /\b(?:not defined var|undefined variable|variable .+ (?:is )?not defined)\b/i,
  /\binvalid identifier\b/i, /\bno matching function\b/i,
  /\btype mismatch\b|\bcannot cast\b|\bincompatible type\b|\bunsupported operand\b/i,
  /字段.+不存在|表.+不存在|函数.+不存在|变量.+(?:未定义|不存在)|无法解析.+(?:字段|列|表|函数|变量)|SQL.+语法错误/i,
];

const PERMISSION_ERROR_PATTERNS = [
  /\bpermission denied\b|\baccess denied\b|\bunauthorized\b|\bforbidden\b/i,
  /\bnot authorized\b|\binsufficient privileges?\b/i,
  /\bpermission.+(?:denied|required|missing)\b/i,
  /\bdoes not have (?:the )?(?:required )?(?:permission|privilege)\b/i,
  /\b(?:accesscontrol|authorization)exception\b/i,
  /\buser .+ has no privilege\b/i,
  /没有权限|无权限|权限不足|拒绝访问|未授权|禁止访问|缺少权限|权限被拒绝/i,
];

const RETRYABLE_FAILURE_PATTERNS = [
  /\bout of memory\b|\boom\b|\bmemory limit\b|内存(?:不足|超限|溢出)/i,
  /\bcpu limit\b|\bcpu quota\b|CPU.+(?:超限|不足)/i,
  /\bexit(?:ed)? (?:code )?137\b|\bsigkill\b|\bkilled by (?:yarn|system|kernel|signal|oom)\b/i,
  /\bexecutor lost\b|\bworker (?:lost|unavailable|disconnected)\b|\bnode lost\b/i,
  /\bno available worker\b|\bworker.+(?:offline|down)\b/i,
  /\bconnection (?:reset|refused|closed|timed out)\b|\bsocket hang up\b|\bbroken pipe\b|\bnetwork (?:error|unreachable)\b/i,
  /\btemporary(?:ily)? unavailable\b|\bservice unavailable\b|\btoo many requests\b/i,
  /\bresource (?:limit|quota|shortage|insufficient|unavailable)\b|资源(?:不足|超限|紧张)/i,
  /\btimeout\b|\btimed out\b|超时/i,
  /\bno associated load channel\b/i,
];

const DATA_SOURCE_CONFIG_ERROR_PATTERNS = [
  /数据源\s*\d*\s*创建连接失败/i,
  /JDBC 地址无效/i,
  /JDBC 驱动匹配发生冲突/i,
  /Create adhoc connection error/i,
  /url is not valid/i,
];

// Keep the n8n restart-watch decision aligned with
// Global-Intelligent-Alarm-Repair-Assistant/tools/ds_failed_auto_retry.py.
const N8N_SQL_ERROR_PATTERNS = [
  /syntax\s+error/i, /sqlsyntaxerrorexception/i, /parse\s+exception/i,
  /semantic\s+exception/i, /analysis\s+exception/i, /unknown\s+column/i,
  /column\s+.+(?:not\s+found|does\s+not\s+exist)/i,
  /table\s+.+(?:not\s+found|does\s+not\s+exist|doesn't\s+exist)/i,
  /no\s+such\s+(?:table|column|function)/i, /function\s+.+not\s+found/i,
  /no\s+matching\s+function/i, /type\s+mismatch/i, /cannot\s+cast/i,
  /incompatible\s+type/i, /unsupported\s+operand/i,
];
const N8N_RECOVERABLE_ERROR_PATTERNS = [
  /cpu.+(?:limit|exceed)/i, /out\s+of\s+memory/i, /oom/i,
  /memory.+(?:limit|exceed|insufficient)/i, /exit\s*(?:code)?\s*137/i,
  /killed\s+by\s+(?:signal|oom)/i, /resource\s+(?:queue|pool).+(?:full|insufficient|unavailable)/i,
  /no\s+available\s+worker/i, /worker.+(?:unavailable|offline|down|lost)/i,
  /connection\s+(?:reset|refused|timed?\s*out|closed)/i, /network\s+(?:error|unreachable)/i,
  /temporary\s+(?:failure|unavailable)/i, /transient/i, /socket\s+hang\s+up/i,
  /broken\s+pipe/i, /remote\s+host/i, /no\s+associated\s+load\s+channel/i,
];
const N8N_MAX_RETRIES = 3;
const N8N_MONITOR_TIMEOUT_MS = 30 * 60 * 1000;

export function classifyN8nFailureReason(reason = "") {
  const normalized = String(reason || "").replace(/\s+/g, " ").trim();
  if (!normalized || normalized === "未从 DS 实例详情中解析到明确失败原因，请查看 DS 实例日志") return "unknown";
  if (N8N_SQL_ERROR_PATTERNS.some((pattern) => pattern.test(normalized))) return "sql_error";
  if (N8N_RECOVERABLE_ERROR_PATTERNS.some((pattern) => pattern.test(normalized))) return "recoverable";
  return "unknown";
}

function withN8nProjectDecision(failure = {}) {
  if (!failure.originalScheduledFailure) return failure;
  const n8nFailureType = classifyN8nFailureReason(failure.failureMessage || failure.failureReason || "");
  const n8nDecision = n8nFailureType === "recoverable"
    ? `命中可恢复故障规则；由 n8n 最多重跑 ${N8N_MAX_RETRIES} 次，并在 ${N8N_MONITOR_TIMEOUT_MS / 60_000} 分钟内观察结果`
    : n8nFailureType === "sql_error"
      ? "命中 SQL/代码错误规则；n8n 不自动重跑，转人工修复"
      : "未命中可恢复故障规则；n8n 不自动重跑，转人工确认";
  return {
    ...failure,
    n8nFailureType,
    n8nRetryEligible: n8nFailureType === "recoverable",
    n8nDecision,
  };
}

export function classifyDsFailureType(failure = {}) {
  const commandType = commandTypeOf(failure);
  if (commandType === "START_PROCESS") {
    return {
      failureType: "start_workflow_scan_only",
      retryable: false,
      retryDecision: "运行类型为启动工作流，仅记录失败扫描结果，不执行自动重跑",
    };
  }
  const evidence = [failure.failureMessage, failure.logError, failure.taskScript].filter(Boolean).join("\n");
  if (SQL_CODE_ERROR_PATTERNS.some((pattern) => pattern.test(evidence))) {
    return { failureType: "sql_code_error", retryable: false, retryDecision: "SQL/代码错误，需人工修改" };
  }
  if (PERMISSION_ERROR_PATTERNS.some((pattern) => pattern.test(evidence))) {
    return { failureType: "permission_error", retryable: false, retryDecision: "权限不足，需人工处理" };
  }
  if (DATA_SOURCE_CONFIG_ERROR_PATTERNS.some((pattern) => pattern.test(evidence))) {
    return { failureType: "datasource_configuration_error", retryable: false, retryDecision: "数据源/JDBC 配置错误，需检查连接地址和 Worker 驱动" };
  }
  if (!String(failure.taskName || "").trim() && !String(failure.taskCode || "").trim()) {
    return { failureType: "suspected_empty_run", retryable: true, retryDecision: "疑似空跑；原失败实例运行超过 1 小时则判定为空跑，不执行重跑" };
  }
  if (RETRYABLE_FAILURE_PATTERNS.some((pattern) => pattern.test(evidence))) {
    return { failureType: "retryable", retryable: true, retryDecision: "资源、网络或运行环境故障，自动持续重跑" };
  }
  return { failureType: "retryable", retryable: true, retryDecision: "非 SQL/代码或权限问题，自动持续重跑" };
}

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
  for (const key of ["records", "list", "instances", "workflow_instances", "workflowInstances", "totalList", "taskList", "task_list", "task_instances", "taskInstances"]) {
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
  return new Set([
    "START_FAILURE_TASK_PROCESS",
    "REPEAT_RUNNING",
    "RECOVER_SUSPENDED_PROCESS",
    "START_CURRENT_TASK_PROCESS",
    "RECOVER_TOLERANCE_FAULT_PROCESS",
  ]).has(commandTypeOf(item)) || runTimesOf(item) > 1;
}

export function normalizeLookbackDays(value, fallback = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(90, Math.trunc(parsed)));
}

function scheduleCategoryOf(item = {}) {
  return commandTypeOf(item) === "SCHEDULER" ? "scheduled_online" : "non_scheduled_online";
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
      commandType: commandTypeOf(recoveredInstance),
      taskInstanceId: String(recoveredInstance.task_instance_id || recoveredInstance.taskInstanceId || recoveredInstance.failed_task_instance_id || recoveredInstance.failedTaskInstanceId || "").trim(),
      taskName: String(recoveredInstance.task_name || recoveredInstance.taskName || recoveredInstance.failed_task_name || recoveredInstance.failedTaskName || "").trim(),
      taskCode: String(recoveredInstance.task_code || recoveredInstance.taskCode || recoveredInstance.failed_task_code || recoveredInstance.failedTaskCode || "").trim(),
      taskState: String(recoveredInstance.task_state || recoveredInstance.taskState || recoveredInstance.failed_task_state || recoveredInstance.failedTaskState || "").trim(),
      scheduleCategory: scheduleCategoryOf(recoveredInstance),
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
      commandType: commandTypeOf(latestFailure),
      taskInstanceId: String(latestFailure.task_instance_id || latestFailure.taskInstanceId || latestFailure.failed_task_instance_id || latestFailure.failedTaskInstanceId || "").trim(),
      taskName: String(latestFailure.task_name || latestFailure.taskName || latestFailure.failed_task_name || latestFailure.failedTaskName || "").trim(),
      taskCode: String(latestFailure.task_code || latestFailure.taskCode || latestFailure.failed_task_code || latestFailure.failedTaskCode || "").trim(),
      taskState: String(latestFailure.task_state || latestFailure.taskState || latestFailure.failed_task_state || latestFailure.failedTaskState || "").trim(),
      scheduleCategory: scheduleCategoryOf(latestFailure),
    });
  }
  return failures.sort((a, b) => timestamp(b.startTime) - timestamp(a.startTime));
}

export function extractDsFailureReason(log, fallback = "") {
  const rawLog = String(log || "");
  const lines = rawLog.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const datasourceId = rawLog.match(/\bdatasource['\"]?\s*(?:=|:)\s*['\"]?(\d+)/i)?.[1] || "";
  const taskType = rawLog.match(/\b(?:type|sql type)['\"]?\s*(?:=|:)\s*['\"]?([A-Z][A-Z0-9_-]+)/i)?.[1] || "";
  if (/Create adhoc connection error/i.test(rawLog) && /url is not valid/i.test(rawLog)) {
    const driverConflict = /com\.dolphindb\.jdbc\.Driver/i.test(rawLog)
      || /Connect strings must start with jdbc:snowflake:\/\//i.test(rawLog);
    const target = datasourceId ? `数据源 ${datasourceId}` : "任务数据源";
    const configuredType = taskType ? `任务配置为 ${taskType}；` : "";
    return `${target} 创建连接失败：JDBC 地址无效${driverConflict ? "，或 JDBC 驱动匹配发生冲突" : ""}。${configuredType}${driverConflict ? "连接过程进入了与任务数据源类型不一致的 JDBC 驱动，请检查数据源 JDBC URL 和 Worker 驱动包" : "请检查数据源 JDBC URL"}`;
  }
  if (/statusCode:\s*401|httpCode:\s*401|HTTP\s*401/i.test(rawLog)) {
    return "接口请求返回 401：认证 Token 无效、已过期或当前账号无接口权限";
  }
  if (/Lost connection to MySQL server during query/i.test(rawLog)) {
    return "查询执行期间与 MySQL/StarRocks 服务端连接中断；需检查查询耗时、服务端超时设置、网络稳定性及数据库节点状态";
  }
  if (/Connection refused/i.test(rawLog)) {
    return "目标服务拒绝连接：服务可能未启动、地址或端口配置错误，或网络策略未放行";
  }
  const stackFrame = (line) => /(?:^|\s)(?:at\s+)?[\w$<>.]+\([^)]*\.(?:java|scala|kt|py):\d+\)\s*$/i.test(line)
    || /^\s*\.\.\.\s+\d+\s+more\s*$/i.test(line);
  const candidates = lines.map((line, index) => {
    if (stackFrame(line)) return null;
    let score = 0;
    if (/Caused by\s*:/i.test(line)) score = 100;
    else if (/(?:SQLSTATE|detailMessage|errCode|does not exist|unknown (?:column|table)|permission denied|syntax error|unsupported operand|no such)/i.test(line)) score = 90;
    else if (/(?:Exception|SQLException|Error)\s*[:：]/i.test(line)) score = 80;
    else if (/(?:stopped|killed|cancelled|canceled|terminated|manual(?:ly)? stop|人工停止|手动停止|任务终止|被终止)/i.test(line)) score = 70;
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

export function classifyOriginalScheduledFailures(instances = [], { projectName = "", projectCode = "", now = new Date() } = {}) {
  const nowMs = timestamp(now) || Date.now();
  const ordered = [...instances].sort((a, b) => timestamp(instanceTime(a)) - timestamp(instanceTime(b)));
  const scheduledFailureIdentities = new Set(ordered
    .filter((item) => commandTypeOf(item) === "SCHEDULER" && FAILED_STATES.has(stateOf(item)))
    .map((item) => workflowCode(item) || workflowName(item))
    .filter(Boolean));
  const originalFailures = ordered.filter((item) => (
    commandTypeOf(item) === "SCHEDULER" && FAILED_STATES.has(stateOf(item))
  ) || (
    // retry_instance reruns the original DS instance in place. After n8n has
    // acted, DS may expose only START_FAILURE_TASK_PROCESS + runTimes > 1.
    commandTypeOf(item) === "START_FAILURE_TASK_PROCESS"
    && runTimesOf(item) > 1
    && !scheduledFailureIdentities.has(workflowCode(item) || workflowName(item))
  ));
  return originalFailures
    .map((item) => {
      const failedAt = timestamp(instanceTime(item));
      const inPlaceRetry = commandTypeOf(item) === "START_FAILURE_TASK_PROCESS" && runTimesOf(item) > 1;
      const identity = workflowCode(item) || workflowName(item);
      const nextScheduledAt = ordered
        .filter((candidate) => (
          commandTypeOf(candidate) === "SCHEDULER"
          && (workflowCode(candidate) || workflowName(candidate)) === identity
          && timestamp(instanceTime(candidate)) > failedAt
        ))
        .map((candidate) => timestamp(instanceTime(candidate)))
        .find(Boolean) || Number.POSITIVE_INFINITY;
      const later = ordered.filter((candidate) => (
        (workflowCode(candidate) || workflowName(candidate)) === identity
        && timestamp(instanceTime(candidate)) > failedAt
        && timestamp(instanceTime(candidate)) < nextScheduledAt
        && isFailureRetry(candidate)
      ));
      const latestRetry = later.at(-1) || (inPlaceRetry ? item : null);
      const latestRetryState = stateOf(latestRetry || {});
      const restarted = latestRetry && SUCCESS_STATES.has(latestRetryState) ? latestRetry : null;
      const restarting = latestRetry && RUNNING_STATES.has(latestRetryState) ? latestRetry : null;
      const retryFailed = latestRetry && !restarted && !restarting;
      const retryCount = Math.min(N8N_MAX_RETRIES, later.reduce((count, candidate) => Math.max(count, runTimesOf(candidate) - 1), inPlaceRetry ? runTimesOf(item) - 1 : later.length));
      const elapsedMs = Math.max(0, (timestamp(endTime(latestRetry || {})) || nowMs) - failedAt);
      const monitorTimedOut = Boolean(latestRetry) && elapsedMs >= N8N_MONITOR_TIMEOUT_MS && !restarted;
      return {
      projectName,
      projectCode,
      workflowCode: workflowCode(item),
      workflowName: workflowName(item),
      instanceId: instanceId(item),
      instanceState: stateOf(item) || "FAILURE",
      startTime: instanceTime(item),
      endTime: endTime(item),
      repairStatus: restarted ? "recovered" : restarting ? "repairing" : "unresolved",
      recoveryInstanceId: instanceId(latestRetry || {}),
      recoveryState: latestRetryState,
      recoveryTime: endTime(latestRetry || {}) || instanceTime(latestRetry || {}),
      retryCount,
      retryTriggered: Boolean(latestRetry),
      retryResult: restarted ? "recovered" : monitorTimedOut ? "timeout_needs_owner" : restarting ? "running" : retryFailed ? "failed" : "not_triggered",
      n8nMonitorTimedOut: monitorTimedOut,
      n8nMaxRetries: N8N_MAX_RETRIES,
      n8nLogicSource: "Global-Intelligent-Alarm-Repair-Assistant/tools/ds_failed_auto_retry.py",
      retryAttempts: later.map((candidate) => ({
        instanceId: instanceId(candidate),
        state: stateOf(candidate),
        commandType: commandTypeOf(candidate),
        runTimes: runTimesOf(candidate),
        startTime: instanceTime(candidate),
        endTime: endTime(candidate),
      })),
      failureMessage: String(item.failure_message || item.failureMessage || item.error_message || item.errorMessage || "").trim(),
      failureCount: 1,
      scheduleCategory: "scheduled_online",
      originalScheduledFailure: true,
      };
    })
    .sort((a, b) => timestamp(b.startTime) - timestamp(a.startTime));
}

function stoppedFailureReason(failure = {}, reason = "") {
  const state = String(failure.instanceState || "").trim().toUpperCase();
  if (!STOPPED_STATES.has(state)) return reason;
  const normalized = String(reason || "").trim();
  if (normalized && normalized !== "任务日志未返回明确失败原因") return normalized;
  return `工作流实例状态为 ${state || "STOP"}；DS 未返回明确停止原因，可能由人工停止、上游终止或系统调度终止`;
}

export function extractTaskScript(data = {}) {
  const runtime = data.runtime_config || data.runtimeConfig || {};
  const taskParams = data.task_params || data.taskParams || {};
  for (const value of [runtime.sql, runtime.raw_script, runtime.rawScript, taskParams.sql, taskParams.raw_script, taskParams.rawScript, data.sql, data.raw_script, data.rawScript]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function taskInstanceIdOf(item = {}) {
  return String(item.task_instance_id || item.taskInstanceId || item.id || "").trim();
}

function taskNameOf(item = {}) {
  return String(item.task_name || item.taskName || item.name || "").trim();
}

function taskCodeOf(item = {}) {
  return String(item.task_code || item.taskCode || item.code || "").trim();
}

function taskTypeOf(item = {}) {
  return String(item.task_type || item.taskType || item.type || "").trim().toUpperCase();
}

function taskRetryCount(item = {}) {
  const value = Number(item.retry_times ?? item.retryTimes ?? item.run_times ?? item.runTimes ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function isSameInstanceRecovery(failure = {}) {
  if (failure.inferredFromRetry) return true;
  const failedInstanceId = String(failure.instanceId || "").trim();
  const recoveryInstanceId = String(failure.recoveryInstanceId || "").trim();
  return Boolean(failedInstanceId && recoveryInstanceId && failedInstanceId === recoveryInstanceId);
}

function objectData(value = {}) {
  if (value?.data && typeof value.data === "object" && !Array.isArray(value.data)) return value.data;
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function hasExplicitFailureEvidence(log = "") {
  return /(?:Caused by\s*:|SQLSTATE|detailMessage|errCode|does not exist|unknown (?:column|table)|permission denied|syntax error|unsupported operand|no such|\bERROR\b|\bFAILED\b|\bfailure\b|Exception)/i.test(String(log || ""));
}

async function listFailureTaskCandidates(failure, context, instanceIdValue) {
  // Prefer DS 3.4's server-side state filter.  Large workflows often have
  // hundreds of successful rows after recovery, while the historical failed
  // row is far beyond page 1.  This query finds that row without scanning the
  // successful rows first.  The unfiltered scan below remains the fallback for
  // STOP/KILL states, sub-workflow wrappers and country-specific API behavior.
  try {
    const filtered = await postAction(context.webhookUrl, context.country, context.token, "list_task_instances", {
      project_code: failure.projectCode,
      instance_id: instanceIdValue,
      process_instance_id: instanceIdValue,
      state_type: "FAILURE",
      page_no: 1,
      page_size: TASK_PAGE_SIZE,
    });
    const filteredFailures = recordList(filtered).filter((item) => {
      const ownerInstanceId = String(item.workflow_instance_id || item.workflowInstanceId || item.process_instance_id || item.processInstanceId || "").trim();
      return (!ownerInstanceId || ownerInstanceId === instanceIdValue) && FAILED_STATES.has(stateOf(item));
    }).sort((a, b) => timestamp(endTime(b) || instanceTime(b)) - timestamp(endTime(a) || instanceTime(a)));
    if (filteredFailures.length) {
      return {
        candidates: filteredFailures,
        pagesRead: 1,
        tasksRead: filteredFailures.length,
        total: pageTotal(filtered),
      };
    }
  } catch {
    // Continue with the compatible unfiltered paging path.
  }

  const seen = new Set();
  const retryTasks = [];
  let tasksRead = 0;
  let reportedTotal = null;

  for (let pageNo = 1; pageNo <= MAX_TASK_PAGES; pageNo += 1) {
    const response = await postAction(context.webhookUrl, context.country, context.token, "list_task_instances", {
      project_code: failure.projectCode,
      instance_id: instanceIdValue,
      process_instance_id: instanceIdValue,
      page_no: pageNo,
      page_size: TASK_PAGE_SIZE,
    });
    const records = recordList(response);
    const responseTotal = pageTotal(response);
    if (responseTotal != null) reportedTotal = responseTotal;

    const ownedTasks = records.filter((item) => {
      const ownerInstanceId = String(item.workflow_instance_id || item.workflowInstanceId || item.process_instance_id || item.processInstanceId || "").trim();
      return !ownerInstanceId || ownerInstanceId === instanceIdValue;
    }).filter((item) => {
      const key = taskInstanceIdOf(item) || `${taskCodeOf(item)}:${instanceTime(item)}:${stateOf(item)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    tasksRead += ownedTasks.length;

    const failedTasks = ownedTasks
      .filter((item) => FAILED_STATES.has(stateOf(item)))
      .sort((a, b) => timestamp(endTime(b) || instanceTime(b)) - timestamp(endTime(a) || instanceTime(a)));
    if (failedTasks.length) {
      return { candidates: failedTasks, pagesRead: pageNo, tasksRead, total: reportedTotal };
    }

    if (isSameInstanceRecovery(failure)) {
      retryTasks.push(...ownedTasks.filter((item) => taskRetryCount(item) > 0 || taskTypeOf(item) === "SUB_WORKFLOW"));
    }

    // A full page can be followed by more rows even when an older gateway has
    // incorrectly reported total == current page length.  Query one more page
    // in that case; an empty/short page terminates the scan cheaply.
    if (!records.length || records.length < TASK_PAGE_SIZE) {
      return {
        candidates: retryTasks.sort((a, b) => taskRetryCount(b) - taskRetryCount(a)
          || timestamp(endTime(b) || instanceTime(b)) - timestamp(endTime(a) || instanceTime(a))),
        pagesRead: pageNo,
        tasksRead,
        total: reportedTotal,
      };
    }
  }

  return {
    candidates: retryTasks.sort((a, b) => taskRetryCount(b) - taskRetryCount(a)
      || timestamp(endTime(b) || instanceTime(b)) - timestamp(endTime(a) || instanceTime(a))),
    pagesRead: MAX_TASK_PAGES,
    tasksRead,
    total: reportedTotal,
  };
}

async function resolveFailureTask(failure, context, options = {}) {
  const instanceIdValue = String(options.instanceId || failure.instanceId || "").trim();
  const workflowCodeValue = String(options.workflowCode || failure.workflowCode || "").trim();
  const depth = Number(options.depth || 0);
  const visited = options.visited || new Set();
  if (!instanceIdValue || depth > MAX_SUB_WORKFLOW_DEPTH || visited.has(instanceIdValue)) return null;
  visited.add(instanceIdValue);

  const taskQuery = await listFailureTaskCandidates(failure, context, instanceIdValue);
  const candidates = taskQuery.candidates;
  let wrapperFallback = null;

  for (const task of candidates) {
    const taskInstanceId = taskInstanceIdOf(task);
    const taskType = taskTypeOf(task);
    const base = {
      task,
      taskInstanceId,
      taskName: taskNameOf(task),
      taskCode: taskCodeOf(task),
      taskType,
      taskState: stateOf(task),
      workflowCode: workflowCodeValue,
      workflowInstanceId: instanceIdValue,
      taskQueryPages: taskQuery.pagesRead,
      taskQueryReadCount: taskQuery.tasksRead,
      taskQueryTotal: taskQuery.total,
      logData: {},
    };
    if (taskType === "SUB_WORKFLOW" && taskInstanceId) {
      wrapperFallback ||= base;
      try {
        const sub = await postAction(context.webhookUrl, context.country, context.token, "get_task_log", {
          project_code: failure.projectCode,
          task_instance_id: taskInstanceId,
          task_type: "SUB_WORKFLOW",
        });
        const subData = objectData(sub);
        const subInstanceId = String(subData.sub_workflow_instance_id || subData.subWorkflowInstanceId || "").trim();
        if (!subInstanceId) continue;
        let subWorkflowCode = "";
        try {
          const subInstance = objectData(await postAction(context.webhookUrl, context.country, context.token, "get_instance", {
            project_code: failure.projectCode,
            instance_id: subInstanceId,
          }));
          subWorkflowCode = workflowCode(subInstance);
        } catch {
          // The child task list and log are still useful if instance detail is unavailable.
        }
        const nested = await resolveFailureTask(failure, context, {
          instanceId: subInstanceId,
          workflowCode: subWorkflowCode || workflowCodeValue,
          depth: depth + 1,
          visited,
        });
        if (nested) return nested;
      } catch {
        // Keep the parent wrapper as a last-resort result without blocking other candidates.
      }
      continue;
    }

    if (!taskInstanceId) continue;
    let logData = {};
    try {
      logData = await postAction(context.webhookUrl, context.country, context.token, "get_task_log", {
        project_code: failure.projectCode,
        task_instance_id: taskInstanceId,
      });
    } catch {
      if (!isSameInstanceRecovery(failure) || FAILED_STATES.has(stateOf(task))) return base;
      continue;
    }
    const log = logData.log || logData.task_log || logData.content || "";
    if (!isSameInstanceRecovery(failure) || FAILED_STATES.has(stateOf(task)) || hasExplicitFailureEvidence(log)) {
      return { ...base, logData };
    }
  }
  return wrapperFallback;
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
  if (!failure.instanceId) {
    const enriched = { ...failure, failureMessage: extractDsFailureReason("", failure.failureMessage) };
    return withN8nProjectDecision({ ...enriched, ...classifyDsFailureType(enriched) });
  }
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
      const enriched = {
        ...failure,
        ...runtime,
        failureMessage: stoppedFailureReason(
          failure,
          extractDsFailureReason(logData.log || logData.task_log || logData.content || "", failure.failureMessage),
        ),
      };
      return withN8nProjectDecision({ ...enriched, ...classifyDsFailureType(enriched) });
    }
    const resolved = await resolveFailureTask(failure, { webhookUrl, country, token });
    if (!resolved) {
      const enriched = {
        ...failure,
        failureMessage: stoppedFailureReason(failure, extractDsFailureReason("", failure.failureMessage)),
      };
      return withN8nProjectDecision({ ...enriched, ...classifyDsFailureType(enriched) });
    }
    const { taskInstanceId, taskName, taskCode, taskType, taskState, logData, workflowCode: resolvedWorkflowCode, workflowInstanceId, taskQueryPages, taskQueryReadCount, taskQueryTotal } = resolved;
    const runtimeFailure = { ...failure, workflowCode: resolvedWorkflowCode || failure.workflowCode };
    const runtime = await loadTaskRuntime(runtimeFailure, { taskName, taskCode, taskType }, { webhookUrl, country, token });
    const enriched = {
      ...failure,
      ...runtime,
      resolvedWorkflowCode: resolvedWorkflowCode || failure.workflowCode,
      resolvedWorkflowInstanceId: workflowInstanceId || failure.instanceId,
      taskInstanceId,
      taskName,
      taskCode,
      taskType: runtime.taskType || taskType,
      taskState,
      taskQueryPages,
      taskQueryReadCount,
      taskQueryTotal,
      failureMessage: stoppedFailureReason(
        failure,
        extractDsFailureReason(logData.log || logData.task_log || logData.content || "", failure.failureMessage),
      ),
    };
    return withN8nProjectDecision({ ...enriched, ...classifyDsFailureType(enriched) });
  } catch (error) {
    const enriched = {
      ...failure,
      failureMessage: stoppedFailureReason(failure, extractDsFailureReason("", failure.failureMessage)),
      logError: error.message,
    };
    return withN8nProjectDecision({ ...enriched, ...classifyDsFailureType(enriched) });
  }
}

function isTransientGatewayError(error) {
  return /(?:connection (?:closed|reset)|closed by remote host|port 22|econnreset|socket hang up|fetch failed|request timeout|请求超时|网关返回非 JSON（HTTP 200）)/i.test(String(error?.message || error || ""));
}

export function classifyDsFailureReason(reason = "") {
  const text = String(reason || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!text) return "unknown";
  const sqlErrors = [
    /syntax error/, /sqlsyntaxerrorexception/, /parse exception/, /semantic exception/,
    /analysis exception/, /unknown column/, /column .+(?:not found|does not exist)/,
    /table .+(?:not found|does not exist|doesn't exist)/, /no such (?:table|column|function)/,
    /function .+not found/, /no matching function/, /type mismatch/, /cannot cast/,
    /incompatible type/, /unsupported operand/,
  ];
  if (sqlErrors.some((pattern) => pattern.test(text))) return "sql_error";
  const recoverable = [
    /cpu.+(?:limit|exceed)/, /out of memory/, /\boom\b/, /memory.+(?:limit|exceed|insufficient)/,
    /exit *(?:code)? *137/, /killed by (?:signal|oom)/,
    /resource (?:queue|pool).+(?:full|insufficient|unavailable)/,
    /no available worker/, /worker.+(?:unavailable|offline|down|lost)/,
    /connection (?:reset|refused|timed? out|closed)/, /network (?:error|unreachable)/,
    /temporary (?:failure|unavailable)/, /transient/, /socket hang up/, /broken pipe/,
    /remote host/, /no associated load channel/,
  ];
  return recoverable.some((pattern) => pattern.test(text)) ? "recoverable" : "unknown";
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

export async function postDsFailureAction({ webhookUrl, country, token, action, payload = {} }) {
  return postAction(webhookUrl, country, token, action, payload);
}

export function dsStateOf(value = {}) {
  return stateOf(value);
}

export function countryDateKey(country, value = new Date()) {
  return dateKey(value, COUNTRY_TIMEZONES[country] || "UTC");
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
      commandType: commandTypeOf(item),
      taskInstanceId: String(item.task_instance_id || item.taskInstanceId || item.failed_task_instance_id || item.failedTaskInstanceId || "").trim(),
      taskName: String(item.task_name || item.taskName || item.failed_task_name || item.failedTaskName || "").trim(),
      taskCode: String(item.task_code || item.taskCode || item.failed_task_code || item.failedTaskCode || "").trim(),
      taskState: String(item.task_state || item.taskState || item.failed_task_state || item.failedTaskState || "").trim(),
      scheduleCategory: String(item.schedule_category || item.scheduleCategory || "").trim()
        || scheduleCategoryOf(item),
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

function shiftDate(date, days) {
  const [year, month, day] = String(date).split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

async function listProjectInstances({ webhookUrl, country, token, projectCode, targetDate, timeZone, lookbackDays = 1 }) {
  const instances = [];
  const seen = new Set();
  const startDate = shiftDate(targetDate, -(Math.max(1, Number(lookbackDays) || 1) - 1));
  for (let pageNo = 1; pageNo <= MAX_INSTANCE_PAGES; pageNo += 1) {
    const data = await postAction(webhookUrl, country, token, "list_instances", {
      project_code: projectCode,
      state_type: "",
      search_val: "",
      page_no: pageNo,
      page_size: INSTANCE_PAGE_SIZE,
      start_time: `${startDate} 00:00:00`,
      end_time: `${targetDate} 23:59:59`,
      timezone_id: timeZone,
    });
    const records = recordList(data);
    const reachedOlderRecords = records.some((item) => {
      const start = instanceTime(item);
      return Boolean(start) && localDate(start, timeZone) < startDate;
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
    const date = start && localDate(start, timeZone);
    return Boolean(date) && date >= startDate && date <= targetDate;
  });
}

async function inspectProject({ webhookUrl, country, token, project, targetDate, timeZone, dsUiBaseUrl, originalScheduledOnly = false, lookbackDays = 1, now = new Date() }) {
  try {
    const instances = await listProjectInstances({
      webhookUrl,
      country,
      token,
      projectCode: project.code,
      targetDate,
      timeZone,
      lookbackDays,
    });
    const failures = (originalScheduledOnly ? classifyOriginalScheduledFailures : classifyWorkflowFailures)(instances, { projectName: project.name, projectCode: project.code, now })
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

async function inspectCountry(config, country, now, originalScheduledOnly = false, lookbackDays = 1) {
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
      lookbackDays,
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
    originalScheduledOnly,
    lookbackDays,
    now,
  }));
  const failures = projectResults.flatMap((item) => item.failures || []);
  return {
    country,
    countryName,
    timeZone,
    targetDate,
    lookbackDays,
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

export async function inspectDsFailureLogs(rootDir, { now = new Date(), countries: requestedCountries, lookbackDays: requestedLookbackDays = 1 } = {}) {
  const config = await loadDsSchedulerConfig(rootDir);
  const selectedCountries = normalizeCountrySelection(requestedCountries);
  const lookbackDays = normalizeLookbackDays(requestedLookbackDays, 1);
  const countries = await Promise.all(selectedCountries.map((country) => inspectCountry(config, country, now, false, lookbackDays)));
  const failures = countries.flatMap((item) => item.failures || []);
  return {
    checkedAt: new Date().toISOString(),
    dateMode: lookbackDays === 1 ? "country-local-today" : "country-local-lookback",
    lookbackDays,
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

export async function inspectOriginalScheduledFailures(rootDir, { now = new Date(), countries: requestedCountries, lookbackDays: requestedLookbackDays = 7, bypassCache = false } = {}) {
  const selectedCountries = normalizeCountrySelection(requestedCountries);
  const lookbackDays = normalizeLookbackDays(requestedLookbackDays, 7);
  const targetDates = selectedCountries.map((country) => `${country}:${todayInTimeZone(COUNTRY_TIMEZONES[country], now)}`).join(",");
  const cacheKey = `${String(rootDir || "")}|${targetDates}|${lookbackDays}`;
  const cached = originalFailureResultCache.get(cacheKey);
  if (!bypassCache && cached && Date.now() - cached.savedAt < ORIGINAL_FAILURE_CACHE_TTL_MS) {
    return { ...cached.result, cacheHit: true, cacheAgeMs: Date.now() - cached.savedAt };
  }
  if (!bypassCache && originalFailureInFlight.has(cacheKey)) return originalFailureInFlight.get(cacheKey);

  const inspection = (async () => {
    const config = await loadDsSchedulerConfig(rootDir);
    const countries = await Promise.all(selectedCountries.map((country) => inspectCountry(config, country, now, true, lookbackDays)));
    const failures = countries.flatMap((item) => item.failures || []);
    const result = {
      checkedAt: new Date().toISOString(),
      dateMode: "country-local-lookback",
      lookbackDays,
      mode: "n8n-failure-restart-watch",
      cacheHit: false,
      cacheAgeMs: 0,
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
    originalFailureResultCache.set(cacheKey, { savedAt: Date.now(), result });
    if (originalFailureResultCache.size > 24) {
      const oldestKey = originalFailureResultCache.keys().next().value;
      originalFailureResultCache.delete(oldestKey);
    }
    return result;
  })();
  originalFailureInFlight.set(cacheKey, inspection);
  try {
    return await inspection;
  } finally {
    originalFailureInFlight.delete(cacheKey);
  }
}
