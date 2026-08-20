import path from "node:path";
import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";
import { readJsonFile, writeJsonFileAtomic } from "./utils.mjs";

const DEFAULT_CONFIG_PATH = "config/ds-scheduler.config.json";
const DEFAULT_SNAPSHOT_PATH = "config/ds-scheduler-usage-snapshot.json";
const DEFAULT_AUDIT_TABLE = "ds_operation_audit_log";
const GATEWAY_TIMEOUT_MS = 60_000;
const SSH_TIMEOUT_MS = 45_000;

export const USAGE_DEFAULT_CONFIG = {
  enabled: false,
  source: "gateway",
  days: 30,
  gateway: {
    webhookUrl: "http://127.0.0.1:5678/webhook/ds-usage-report",
    action: "usage_report",
    token: "",
    requestIdPrefix: "duty-usage-",
  },
  ssh: {
    command: "ssh",
    host: "10.20.47.14",
    port: 36000,
    user: "root",
    identityFile: "",
    options: ["StrictHostKeyChecking=no", "ConnectTimeout=10"],
  },
  auditDb: {
    host: "10.20.47.19",
    port: 3306,
    user: "root",
    password: "",
    database: "warning_rule",
    table: DEFAULT_AUDIT_TABLE,
  },
};

function resolveEnvString(value) {
  return String(value ?? "").replace(/\$\{([^}]+)\}/g, (_match, key) => process.env[key] || "").trim();
}

function resolveOptionalEnv(value) {
  return String(value ?? "").replace(/\$\{([^}]+)\}/g, (_match, key) => process.env[key] || "");
}

export function normalizeUsageConfig(raw = {}) {
  const base = {
    ...USAGE_DEFAULT_CONFIG,
    ...(raw || {}),
    gateway: { ...USAGE_DEFAULT_CONFIG.gateway, ...((raw && raw.gateway) || {}) },
    ssh: { ...USAGE_DEFAULT_CONFIG.ssh, ...((raw && raw.ssh) || {}) },
    auditDb: { ...USAGE_DEFAULT_CONFIG.auditDb, ...((raw && raw.auditDb) || {}) },
  };
  const source = String(base.source || "gateway").trim().toLowerCase();
  base.source = ["gateway", "ssh", "snapshot"].includes(source) ? source : "gateway";
  base.enabled = Boolean(base.enabled);
  base.days = Math.max(1, Math.min(90, Number(base.days || 30)));
  base.gateway.webhookUrl = resolveEnvString(base.gateway.webhookUrl);
  base.gateway.action = String(base.gateway.action || "usage_report").trim() || "usage_report";
  base.gateway.token = resolveEnvString(base.gateway.token);
  base.gateway.requestIdPrefix = resolveEnvString(base.gateway.requestIdPrefix);
  base.ssh.host = String(base.ssh.host || "").trim();
  base.ssh.port = Number(base.ssh.port) || 22;
  base.ssh.user = String(base.ssh.user || "root").trim();
  base.ssh.identityFile = resolveEnvString(base.ssh.identityFile);
  base.ssh.options = Array.isArray(base.ssh.options) ? base.ssh.options.map((item) => String(item)) : [];
  base.auditDb.host = String(base.auditDb.host || "").trim();
  base.auditDb.port = Number(base.auditDb.port) || 3306;
  base.auditDb.user = String(base.auditDb.user || "").trim();
  base.auditDb.password = resolveEnvString(base.auditDb.password);
  base.auditDb.database = String(base.auditDb.database || "").trim();
  base.auditDb.table = String(base.auditDb.table || DEFAULT_AUDIT_TABLE).trim();
  return base;
}

export async function loadUsageConfig(rootDir) {
  const configPath = path.resolve(typeof rootDir === "string" ? rootDir : process.cwd(), DEFAULT_CONFIG_PATH);
  let config = null;
  try {
    config = await readJsonFile(configPath, null);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return normalizeUsageConfig((config && config.usage) || {});
}

export function normalizeAuditRow(row = {}) {
  const r = row && typeof row === "object" ? row : {};
  const operationTime = String(r.operation_time || r.operationTime || r.created_at || r.createdAt || "").trim();
  let date = operationTime ? operationTime.slice(0, 10) : (String(r.date || "").trim() || null);
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) date = null;
  return {
    requestId: String(r.request_id || r.requestId || "").trim(),
    traceId: String(r.trace_id || r.traceId || "").trim(),
    operator: String(r.operator || r.operator_name || "").trim() || "unknown",
    source: String(r.source_system || r.sourceSystem || r.source || "").trim() || "unknown",
    country: String(r.country || "").trim().toLowerCase(),
    action: String(r.action || "").trim(),
    targetType: String(r.target_type || r.targetType || "").trim(),
    projectCode: String(r.project_code || r.projectCode || "").trim(),
    workflowCode: String(r.workflow_code || r.workflowCode || "").trim(),
    workflowName: String(r.workflow_name || r.workflowName || "").trim(),
    instanceId: String(r.instance_id || r.instanceId || "").trim(),
    success: Boolean(r.success === true || r.success === 1 || String(r.success) === "1"),
    errorCode: String(r.error_code || r.errorCode || "").trim(),
    riskLevel: String(r.risk_level || r.riskLevel || "").trim().toLowerCase() || "low",
    durationMs: Number(r.duration_ms || r.durationMs || 0) || 0,
    operationTime,
    date,
  };
}

function plus(map, key, n = 1) {
  map.set(key, (map.get(key) || 0) + n);
}

function dateKeyOf(input) {
  const text = String(input || "").trim();
  if (!text) return null;
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function bucketAggregator(rows) {
  const byKey = new Map();
  const first = new Map();
  const last = new Map();
  for (const row of rows) {
    const key = String(row.operator || "unknown");
    const agg = byKey.get(key) || { operator: key, requests: 0, success: 0, failed: 0, riskActions: 0, countries: new Set(), sources: new Set(), actions: new Map(), durationTotalMs: 0, durationMaxMs: 0 };
    agg.requests += 1;
    if (row.success) agg.success += 1;
    else agg.failed += 1;
    if (row.riskLevel === "high" || row.riskLevel === "medium") agg.riskActions += 1;
    if (row.country) agg.countries.add(row.country);
    if (row.source) agg.sources.add(row.source);
    plus(agg.actions, row.action || "unknown");
    agg.durationTotalMs += row.durationMs;
    if (row.durationMs > agg.durationMaxMs) agg.durationMaxMs = row.durationMs;
    if (!first.has(key)) first.set(key, row.operationTime);
    last.set(key, row.operationTime);
    byKey.set(key, agg);
  }
  return { byKey, first, last };
}

function finalizeBucket(agg, { date }) {
  const requests = agg.requests;
  return {
    operator: agg.operator,
    requests,
    success: agg.success,
    failed: agg.failed,
    successRate: requests ? Math.round((agg.success / requests) * 1000) / 10 : 0,
    riskActions: agg.riskActions,
    countries: [...agg.countries].sort(),
    sources: [...agg.sources].sort(),
    actions: Object.fromEntries([...agg.actions.entries()].sort((a, b) => b[1] - a[1])),
    avgDurationMs: requests ? Math.round(agg.durationTotalMs / requests) : 0,
    maxDurationMs: agg.durationMaxMs,
    firstUsedAt: agg.firstUsedAt || null,
    lastUsedAt: agg.lastUsedAt || null,
  };
}

/**
 * Aggregate raw audit rows into a per-day usage report grouped by operator.
 */
export function buildDailyUsage(rows = [], options = {}) {
  const normalized = rows.map(normalizeAuditRow);
  const byDate = new Map();
  const allOperators = new Set();
  const allCountries = new Set();
  const allActions = new Set();
  const allSources = new Set();

  for (const row of normalized) {
    const date = row.date;
    if (!date) continue;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(row);
    if (row.operator) allOperators.add(row.operator);
    if (row.country) allCountries.add(row.country);
    if (row.action) allActions.add(row.action);
    if (row.source) allSources.add(row.source);
  }

  const days = [];
  let totalRequests = 0;
  let totalSuccess = 0;
  let totalFailed = 0;
  let totalRiskActions = 0;

  const sortedDates = [...byDate.keys()].sort();
  for (const date of sortedDates) {
    const rowsOfDay = byDate.get(date);
    const { byKey, first, last } = bucketAggregator(rowsOfDay);
    const operators = [...byKey.values()].map((agg) => {
      agg.firstUsedAt = first.get(agg.operator);
      agg.lastUsedAt = last.get(agg.operator);
      return finalizeBucket(agg, { date });
    }).sort((a, b) => b.requests - a.requests);

    const countries = new Map();
    const actions = new Map();
    const sources = new Map();
    let success = 0;
    let failed = 0;
    let riskActions = 0;

    for (const row of rowsOfDay) {
      if (row.success) success += 1;
      else failed += 1;
      if (row.riskLevel === "high" || row.riskLevel === "medium") riskActions += 1;
      plus(countries, row.country || "unknown");
      plus(actions, row.action || "unknown");
      plus(sources, row.source || "unknown");
    }

    const dayTotal = rowsOfDay.length;
    totalRequests += dayTotal;
    totalSuccess += success;
    totalFailed += failed;
    totalRiskActions += riskActions;

    days.push({
      date,
      requests: dayTotal,
      success,
      failed,
      successRate: dayTotal ? Math.round((success / dayTotal) * 1000) / 10 : 0,
      uniqueOperators: operators.length,
      riskActions,
      countries: Object.fromEntries([...countries.entries()].sort((a, b) => b[1] - a[1])),
      actions: Object.fromEntries([...actions.entries()].sort((a, b) => b[1] - a[1])),
      sources: Object.fromEntries([...sources.entries()].sort((a, b) => b[1] - a[1])),
      operators,
    });
  }

  return {
    generatedAt: options.generatedAt ? new Date(options.generatedAt).toISOString() : new Date().toISOString(),
    dayCount: days.length,
    totalRequests,
    totalSuccess,
    totalFailed,
    totalRiskActions,
    totalSuccessRate: totalRequests ? Math.round((totalSuccess / totalRequests) * 1000) / 10 : 0,
    uniqueOperators: allOperators.size,
    uniqueCountries: allCountries.size,
    uniqueActions: allActions.size,
    uniqueSources: allSources.size,
    countryUsage: buildCountryUsage(normalized),
    days,
  };
}


/**
 * Aggregate normalized audit rows into a per-country usage report. Each country
 * keeps a per-day breakdown (with per-day operators) so the UI can apply an
 * independent time window per country.
 */
export function buildCountryUsage(normalizedRows = []) {
  const byCountry = new Map();
  for (const row of normalizedRows) {
    const date = row.date;
    if (!date) continue;
    const country = row.country || "unknown";
    if (!byCountry.has(country)) byCountry.set(country, { daily: new Map() });
    const c = byCountry.get(country);
    if (!c.daily.has(date)) c.daily.set(date, { date, requests: 0, success: 0, failed: 0, riskActions: 0, operators: new Map(), actions: new Map() });
    const d = c.daily.get(date);
    d.requests += 1;
    if (row.success) d.success += 1;
    else d.failed += 1;
    if (row.riskLevel === "high" || row.riskLevel === "medium") d.riskActions += 1;
    const opKey = String(row.operator || "unknown");
    const op = d.operators.get(opKey) || { operator: opKey, requests: 0, success: 0, failed: 0, riskActions: 0, durationTotalMs: 0, actions: new Map() };
    op.requests += 1;
    if (row.success) op.success += 1;
    else op.failed += 1;
    if (row.riskLevel === "high" || row.riskLevel === "medium") op.riskActions += 1;
    op.durationTotalMs += row.durationMs;
    plus(op.actions, row.action || "unknown");
    d.operators.set(opKey, op);
    plus(d.actions, row.action || "unknown");
  }

  const countries = [];
  for (const [country, c] of byCountry.entries()) {
    const daily = [...c.daily.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, d]) => ({
      date: d.date,
      requests: d.requests,
      success: d.success,
      failed: d.failed,
      successRate: d.requests ? Math.round((d.success / d.requests) * 1000) / 10 : 0,
      riskActions: d.riskActions,
      uniqueOperators: d.operators.size,
      operators: [...d.operators.values()].map((op) => ({
        operator: op.operator,
        requests: op.requests,
        success: op.success,
        failed: op.failed,
        successRate: op.requests ? Math.round((op.success / op.requests) * 1000) / 10 : 0,
        riskActions: op.riskActions,
        avgDurationMs: op.requests ? Math.round(op.durationTotalMs / op.requests) : 0,
        actions: Object.fromEntries([...op.actions.entries()].sort((a, b) => b[1] - a[1])),
      })).sort((a, b) => b.requests - a.requests),
      actions: Object.fromEntries([...d.actions.entries()].sort((a, b) => b[1] - a[1])),
    }));

    let requests = 0, success = 0, failed = 0, riskActions = 0;
    for (const d of daily) { requests += d.requests; success += d.success; failed += d.failed; riskActions += d.riskActions; }
    const operatorsMap = new Map();
    for (const d of daily) {
      for (const op of d.operators) {
        const key = op.operator;
        const agg = operatorsMap.get(key) || { operator: key, requests: 0, success: 0, failed: 0, riskActions: 0, durationTotalMs: 0, actions: new Map() };
        agg.requests += op.requests;
        agg.success += op.success;
        agg.failed += op.failed;
        agg.riskActions += op.riskActions;
        agg.durationTotalMs += op.avgDurationMs * op.requests;
        for (const [a, n] of Object.entries(op.actions || {})) plus(agg.actions, a, n);
        operatorsMap.set(key, agg);
      }
    }
    const operators = [...operatorsMap.values()].map((op) => ({
      operator: op.operator,
      requests: op.requests,
      success: op.success,
      failed: op.failed,
      successRate: op.requests ? Math.round((op.success / op.requests) * 1000) / 10 : 0,
      riskActions: op.riskActions,
      avgDurationMs: op.requests ? Math.round(op.durationTotalMs / op.requests) : 0,
      actions: Object.fromEntries([...op.actions.entries()].sort((a, b) => b[1] - a[1])),
    })).sort((a, b) => b.requests - a.requests);

    const actions = new Map();
    for (const d of daily) for (const [a, n] of Object.entries(d.actions || {})) plus(actions, a, n);

    countries.push({
      country,
      requests,
      success,
      failed,
      successRate: requests ? Math.round((success / requests) * 1000) / 10 : 0,
      riskActions,
      uniqueOperators: operators.length,
      operators,
      actions: Object.fromEntries([...actions.entries()].sort((a, b) => b[1] - a[1])),
      daily,
    });
  }
  countries.sort((a, b) => b.requests - a.requests);
  return countries;
}

function parseMysqlBatchOutput(stdout) {
  const lines = String(stdout || "").split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];
  const headers = lines[0].split("\t");
  return lines.slice(1).map((line) => {
    const cells = line.split("\t");
    const row = {};
    headers.forEach((header, index) => {
      row[header] = cells[index] ?? "";
    });
    return row;
  });
}

function shellQuote(value) {
  return `'${String(value ?? "").replace(/'/g, "'\\''")}'`;
}

function buildRemoteAuditSql(config) {
  const table = config.auditDb.table || DEFAULT_AUDIT_TABLE;
  const days = config.days || 30;
  return [
    `SELECT request_id, trace_id, \`operator\`, source_system, country, action, target_type,`,
    `project_code, workflow_code, workflow_name, instance_id, success, error_code, risk_level,`,
    `duration_ms, operation_time`,
    `FROM \`${table}\``,
    `WHERE operation_time >= DATE_SUB(NOW(), INTERVAL ${Number(days)} DAY)`,
    `ORDER BY operation_time ASC`,
  ].join(" ");
}

function queryAuditViaSsh(config) {
  return new Promise((resolve, reject) => {
    const ssh = config.ssh;
    const args = [];
    if (ssh.port) args.push("-p", String(ssh.port));
    if (ssh.identityFile) args.push("-i", ssh.identityFile);
    for (const option of ssh.options || []) args.push("-o", option);
    args.push(`${ssh.user ? `${ssh.user}@` : ""}${ssh.host}`);

    const db = config.auditDb;
    const remoteScript = [
      "export MYSQL_PWD=" + shellQuote(db.password),
      "mysql --batch --raw --silent " +
        `--host ${shellQuote(db.host)} --port ${String(db.port)} --user ${shellQuote(db.user)} ` +
        `--default-character-set=utf8mb4 ${shellQuote(db.database)} -e ${shellQuote(buildRemoteAuditSql(config))}`,
    ].join("\n");

    const child = spawn(ssh.command || "ssh", args, { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), SSH_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`ssh 审计查询失败 (exit ${code}): ${stderr.slice(0, 800)}`));
        return;
      }
      resolve(parseMysqlBatchOutput(stdout));
    });
    child.stdin.end(`${remoteScript}\n`);
  });
}

function postJson(urlString, body, headers = {}, timeoutMs = GATEWAY_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const data = JSON.stringify(body);
    const client = url.protocol === "https:" ? https : http;
    const request = client.request(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        ...headers,
      },
    }, (response) => {
      let text = "";
      response.on("data", (chunk) => { text += chunk.toString("utf8"); });
      response.on("end", () => {
        let payload = {};
        try {
          payload = text ? JSON.parse(text) : {};
        } catch {
          payload = { error: text };
        }
        resolve({ statusCode: response.statusCode || 0, payload });
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`网关请求超时（${Math.round(timeoutMs / 1000)}秒）`)));
    request.on("error", reject);
    request.end(data);
  });
}

async function queryAuditViaGateway(config) {
  const headers = {};
  if (config.gateway.token) headers.Authorization = `Bearer ${config.gateway.token}`;
  const webhookUrl = config.gateway.webhookUrl || "";
  console.log(`[ds-usage] POST gateway -> ${webhookUrl}`);
  const { statusCode, payload } = await postJson(webhookUrl, {
    source: "duty-platform",
    action: config.gateway.action || "usage_report",
    request_id: `${config.gateway.requestIdPrefix || "duty-usage-"}${Date.now()}`,
    country: "cn",
    payload: { days: config.days, include_checked_workflows: false, auditPassword: config.auditDb.password || "" },
  }, headers);
  const bodyPreview = JSON.stringify(payload || {}).slice(0, 400);
  console.log(`[ds-usage] gateway response status=${statusCode} body=${bodyPreview}`);
  if (statusCode < 200 || statusCode >= 300 || payload.success === false) {
    const message = payload.error?.message || payload.error || `网关请求失败 (HTTP ${statusCode})`;
    throw new Error(String(message));
  }
  const data = payload.data && typeof payload.data === "object" ? payload.data : {};
  const rows = payload.rows || data.rows || data.records || data.list || [];
  return Array.isArray(rows) ? rows : [];
}

export async function queryAuditRows(config) {
  if (config.source === "ssh") {
    return queryAuditViaSsh(config);
  }
  if (config.source === "snapshot") {
    return [];
  }
  return queryAuditViaGateway(config);
}

export async function loadUsageSnapshot(rootDir) {
  const snapshotPath = path.resolve(typeof rootDir === "string" ? rootDir : process.cwd(), DEFAULT_SNAPSHOT_PATH);
  try {
    return await readJsonFile(snapshotPath, null);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}

export async function saveUsageSnapshot(rootDir, value) {
  const snapshotPath = path.resolve(typeof rootDir === "string" ? rootDir : process.cwd(), DEFAULT_SNAPSHOT_PATH);
  await writeJsonFileAtomic(snapshotPath, value);
  return snapshotPath;
}

/**
 * Fetch audit rows and produce a daily usage report. Supports a cached snapshot
 * fallback so the web console can render even when the jump host is unreachable.
 */
export async function fetchAndAggregateUsage(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const config = normalizeUsageConfig(options.config || (await loadUsageConfig(rootDir)));
  const cached = await loadUsageSnapshot(rootDir);
  const snapshotFresh = cached
    && cached.generatedAt
    && Date.now() - new Date(cached.generatedAt).getTime() < 10 * 60 * 1000;

  if (!config.enabled && cached && Array.isArray(cached.rows)) {
    return { ...buildDailyUsage(cached.rows, { generatedAt: cached.generatedAt }), source: "snapshot", cached: true, enabled: config.enabled };
  }
  if (config.enabled) {
    try {
      let rowsList = [];
      if (config.source === "snapshot") {
        rowsList = cached && Array.isArray(cached.rows) ? cached.rows : [];
      } else {
        const rows = await queryAuditRows(config);
        rowsList = Array.isArray(rows) ? rows : [];
      }
      const report = buildDailyUsage(rowsList);
      if (options.cache !== false) {
        await saveUsageSnapshot(rootDir, { generatedAt: report.generatedAt, rows: rowsList });
      }
      return { ...report, source: config.source, cached: config.source === "snapshot", enabled: config.enabled };
    } catch (error) {
      if (cached && Array.isArray(cached.rows)) {
        return { ...buildDailyUsage(cached.rows, { generatedAt: cached.generatedAt }), source: "snapshot", cached: true, refreshError: error.message, enabled: config.enabled };
      }
      return { ...buildDailyUsage([]), source: config.source, cached: false, refreshError: error.message, error: true, enabled: config.enabled };
    }
  }
  if (cached && Array.isArray(cached.rows)) {
    return { ...buildDailyUsage(cached.rows, { generatedAt: cached.generatedAt }), source: "snapshot", cached: true, enabled: config.enabled };
  }
  return { ...buildDailyUsage([]), source: "empty", cached: false, enabled: config.enabled };
}
