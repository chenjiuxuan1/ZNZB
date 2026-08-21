import path from "node:path";
import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";
import { readJsonFile, writeJsonFileAtomic } from "./utils.mjs";

const DEFAULT_CONFIG_PATH = "config/ds-scheduler.config.json";
const DEFAULT_SNAPSHOT_PATH = "config/ds-scheduler-usage-snapshot.json";
const DEFAULT_AUDIT_TABLE = "ds_operation_audit_log";
const DEFAULT_TOKEN_MAP_PATH = "config/ds-token-user-map.json";
const GATEWAY_TIMEOUT_MS = 60_000;
const SSH_TIMEOUT_MS = 45_000;

// token -> DS 平台用户名 映射（缺失的显示 未知，可按需补充）
export const TOKEN_USER_MAP = {
  "a934e2b1d032aa0b421be40a1e6f7814": "yannhao",
  "289e723fd059f1ea95ef0bb377eb1a95": "jiangchuanchen",
  "59005866829ffabd3f4b84cdce2c2a3f": "binzhao",
  "291a30d2348c1c58d06563accaaf0130": "admin",
  "521dddb2f3ded022fa4dbb6cf9d995e4": "sylviashi",
  "5af69ef71d2fc62860a7f0e5584f6afa": "sylviashi",
  "374b21aa20d8958ef378f0fce2fe7b83": "hansonxiang",
  "466bec2a4fb77a63ea6fa927286d3ac5": "moonmu",
  "31fda8fa8c1decb6958819159f54b294": "laurasun",
  "e5163ae952b05255c04be58e427dd26b": "binzhao",
};

export function tokenUser(token, tokenUserMap) {
  if (!token || token === "-") return "";
  const key = String(token);
  if (tokenUserMap && Object.prototype.hasOwnProperty.call(tokenUserMap, key)) {
    return String(tokenUserMap[key] || "").trim();
  }
  return TOKEN_USER_MAP[key] || "";
}

export const DEFAULT_TOKEN_SQL =
  "SELECT u.user_name, a.token FROM t_ds_access_token a JOIN t_ds_user u ON u.id = a.user_id WHERE a.token IS NOT NULL AND a.token <> ''";

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
    tokenMap: { ...((raw && raw.tokenMap) || {}) },
  };
  const rawTokenMap = (raw && raw.tokenMap) || {};
  base.tokenMap = {
    enabled: Boolean(base.tokenMap.enabled),
    sql: String(base.tokenMap.sql || DEFAULT_TOKEN_SQL).trim() || DEFAULT_TOKEN_SQL,
    helperScript: resolveEnvString(base.tokenMap.helperScript || ""),
    ssh: { command: "ssh", options: ["StrictHostKeyChecking=no", "ConnectTimeout=15"], ...((rawTokenMap && rawTokenMap.ssh) || {}) },
    countries: {},
  };
  for (const [code, c] of Object.entries((rawTokenMap && rawTokenMap.countries) || {})) {
    const ssh = { ...base.tokenMap.ssh, ...((c && c.ssh) || {}) };
    base.tokenMap.countries[String(code).toUpperCase()] = {
      name: String((c && c.name) || "").trim(),
      ssh: {
        host: String(ssh.host || "").trim(),
        port: Number(ssh.port) || 22,
        user: String(ssh.user || "root").trim(),
        identityFile: resolveEnvString(ssh.identityFile || ""),
        options: Array.isArray(ssh.options) ? ssh.options.map((item) => String(item)) : (base.tokenMap.ssh.options || []),
      },
      database: {
        host: resolveEnvString((c && c.database && c.database.host) || ""),
        port: Number((c && c.database && c.database.port) || 3306),
        user: resolveEnvString((c && c.database && c.database.user) || ""),
        password: resolveEnvString((c && c.database && c.database.password) || ""),
        name: resolveEnvString((c && c.database && c.database.name) || ""),
      },
    };
  }
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
    token: String(r.token || r.ds_token || "").trim(),
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
    countryUsage: buildCountryUsage(normalized, { tokenUserMap: (options && options.tokenUserMap) || null }),
    days,
  };
}


/**
 * Aggregate normalized audit rows into a per-country usage report. Each country
 * keeps a per-day breakdown (with per-day operators) so the UI can apply an
 * independent time window per country.
 */
export function buildCountryUsage(normalizedRows = [], options = {}) {
  const tokenUserMap = (options && options.tokenUserMap) || null;
  const byCountry = new Map();
  for (const row of normalizedRows) {
    const date = row.date;
    if (!date) continue;
    const country = row.country || "unknown";
    if (!byCountry.has(country)) byCountry.set(country, { daily: new Map() });
    const c = byCountry.get(country);
    if (!c.daily.has(date)) c.daily.set(date, { date, requests: 0, success: 0, failed: 0, riskActions: 0, operators: new Map(), actions: new Map(), tokens: new Set() });
    const d = c.daily.get(date);
    d.requests += 1;
    if (row.success) d.success += 1;
    else d.failed += 1;
    if (row.riskLevel === "high" || row.riskLevel === "medium") d.riskActions += 1;
    const tokenKey = String(row.token || "-");
    const op = d.operators.get(tokenKey) || { token: tokenKey, requests: 0, success: 0, failed: 0, riskActions: 0, durationTotalMs: 0, actions: new Map(), tools: new Set() };
    op.requests += 1;
    if (row.success) op.success += 1;
    else op.failed += 1;
    if (row.riskLevel === "high" || row.riskLevel === "medium") op.riskActions += 1;
    op.durationTotalMs += row.durationMs;
    if (row.operator) op.tools.add(row.operator);
    plus(op.actions, row.action || "unknown");
    d.operators.set(tokenKey, op);
    if (!d.tokens) d.tokens = new Set();
    if (row.token) d.tokens.add(row.token);
    if (!d.tokens) d.tokens = new Set();
    if (row.token) d.tokens.add(row.token);
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
        token: op.token,
        user: tokenUser(op.token, tokenUserMap),
        requests: op.requests,
        success: op.success,
        failed: op.failed,
        successRate: op.requests ? Math.round((op.success / op.requests) * 1000) / 10 : 0,
        riskActions: op.riskActions,
        avgDurationMs: op.requests ? Math.round(op.durationTotalMs / op.requests) : 0,
        actions: Object.fromEntries([...op.actions.entries()].sort((a, b) => b[1] - a[1])),
        tools: [...op.tools].sort(),
      })).sort((a, b) => b.requests - a.requests),
      actions: Object.fromEntries([...d.actions.entries()].sort((a, b) => b[1] - a[1])),
      tokens: d.tokens ? [...d.tokens].sort() : [],
    }));

    let requests = 0, success = 0, failed = 0, riskActions = 0;
    for (const d of daily) { requests += d.requests; success += d.success; failed += d.failed; riskActions += d.riskActions; }
    const operatorsMap = new Map();
    for (const d of daily) {
      for (const op of d.operators) {
        const key = op.token;
        const agg = operatorsMap.get(key) || { token: key, requests: 0, success: 0, failed: 0, riskActions: 0, durationTotalMs: 0, actions: new Map(), tools: new Set() };
        agg.requests += op.requests;
        agg.success += op.success;
        agg.failed += op.failed;
        agg.riskActions += op.riskActions;
        agg.durationTotalMs += op.avgDurationMs * op.requests;
        for (const [a, n] of Object.entries(op.actions || {})) plus(agg.actions, a, n);
        for (const t of (op.tools || [])) agg.tools.add(t);
        operatorsMap.set(key, agg);
      }
    }
    const operators = [...operatorsMap.values()].map((op) => ({
      token: op.token,
      user: tokenUser(op.token, tokenUserMap),
      requests: op.requests,
      success: op.success,
      failed: op.failed,
      successRate: op.requests ? Math.round((op.success / op.requests) * 1000) / 10 : 0,
      riskActions: op.riskActions,
      avgDurationMs: op.requests ? Math.round(op.durationTotalMs / op.requests) : 0,
      actions: Object.fromEntries([...op.actions.entries()].sort((a, b) => b[1] - a[1])),
      tools: [...op.tools].sort(),
    })).sort((a, b) => b.requests - a.requests);

    const actions = new Map();
    const tokens = new Set();
    for (const d of daily) {
      for (const [a, n] of Object.entries(d.actions || {})) plus(actions, a, n);
      for (const t of (d.tokens || [])) tokens.add(t);
    }

    countries.push({
      country,
      requests,
      success,
      failed,
      successRate: requests ? Math.round((success / requests) * 1000) / 10 : 0,
      riskActions,
      uniqueOperators: operators.length,
      operators,
      tokens: [...tokens].sort(),
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

function buildTokenMapRemoteScript(config, countryCode) {
  const tm = config.tokenMap || {};
  const country = (tm.countries && tm.countries[countryCode]) || {};
  const db = country.database || {};
  const sqlB64 = Buffer.from(tm.sql || DEFAULT_TOKEN_SQL, "utf8").toString("base64");
  const lines = [
    "set -euo pipefail",
    `DS_DB_HOST=${shellQuote(db.host || "")}`,
    `DS_DB_PORT=${shellQuote(String(db.port || 3306))}`,
    `DS_DB_USER=${shellQuote(db.user || "")}`,
    `DS_DB_PASSWORD=${shellQuote(db.password || "")}`,
    `DS_DB_NAME=${shellQuote(db.name || "")}`,
    `SQL_B64=${shellQuote(sqlB64)}`,
    "if [ -n \"$DS_DB_HOST\" ] && [ -n \"$DS_DB_USER\" ] && [ -n \"$DS_DB_PASSWORD\" ]; then",
    "  printf %s \"$SQL_B64\" | base64 -d | MYSQL_PWD=\"$DS_DB_PASSWORD\" mysql --batch --raw --skip-column-names --host=\"$DS_DB_HOST\" --port=\"$DS_DB_PORT\" --user=\"$DS_DB_USER\" --default-character-set=utf8mb4 \"$DS_DB_NAME\"",
    "else",
    "  echo \"__DS_TOKEN_MAP_SKIP__ no DS DB credentials configured for country\" >&2",
    "  exit 2",
    "fi",
  ];
  return lines.join("\n");
}

function queryDsTokenMapViaSsh(config, countryCode) {
  return new Promise((resolve, reject) => {
    const tm = config.tokenMap || {};
    const country = (tm.countries && tm.countries[countryCode]) || {};
    const ssh = country.ssh || tm.ssh || { host: "", port: 22, user: "root" };
    if (!ssh.host) return reject(new Error(`tokenMap: 国家 ${countryCode} 未配置 SSH`));
    const args = [];
    if (ssh.port) args.push("-p", String(ssh.port));
    if (ssh.identityFile) args.push("-i", ssh.identityFile);
    for (const option of ssh.options || []) args.push("-o", option);
    args.push(`${ssh.user ? `${ssh.user}@` : ""}${ssh.host}`);

    const remoteScript = buildTokenMapRemoteScript(config, countryCode);
    const child = spawn(tm.ssh.command || "ssh", args, { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), SSH_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== 2) {
        reject(new Error(`tokenMap SSH 查询失败 ${countryCode} (exit ${code}): ${stderr.slice(0, 500)}`));
        return;
      }
      const map = {};
      for (const line of String(stdout).split(/\r?\n/)) {
        if (!line.trim()) continue;
        const [user, token] = line.split("\t");
        if (token && token.trim()) map[String(token).trim()] = (user || "").trim();
      }
      resolve(map);
    });
    child.stdin.end(`${remoteScript}\n`);
  });
}

export async function fetchDsTokenUserMap(config = {}, onProgress) {
  const tm = (config && config.tokenMap) || {};
  if (!tm.enabled) return {};
  const merged = {};
  for (const [code, country] of Object.entries(tm.countries || {})) {
    if (!country || !country.ssh || !country.ssh.host) continue;
    try {
      const map = await queryDsTokenMapViaSsh(config, code);
      Object.assign(merged, map);
      if (typeof onProgress === "function") onProgress(code, Object.keys(map).length, "");
    } catch (error) {
      if (typeof onProgress === "function") onProgress(code, 0, error.message);
    }
  }
  return merged;
}

export async function loadDsTokenUserMap(rootDir) {
  const p = path.resolve(typeof rootDir === "string" ? rootDir : process.cwd(), DEFAULT_TOKEN_MAP_PATH);
  try {
    const value = await readJsonFile(p, null);
    return value && typeof value === "object" ? value : {};
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return {};
  }
}

export async function saveDsTokenUserMap(rootDir, map) {
  const p = path.resolve(typeof rootDir === "string" ? rootDir : process.cwd(), DEFAULT_TOKEN_MAP_PATH);
  await writeJsonFileAtomic(p, map || {});
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
  let tokenUserMap = await loadDsTokenUserMap(rootDir);
  if (options.cache && config.tokenMap && config.tokenMap.enabled) {
    try {
      const fresh = await fetchDsTokenUserMap(config);
      if (fresh && Object.keys(fresh).length) {
        tokenUserMap = { ...tokenUserMap, ...fresh };
        await saveDsTokenUserMap(rootDir, tokenUserMap);
      }
    } catch (error) {
      tokenUserMap.tokenMapRefreshError = String((error && error.message) || error);
    }
  }
  const usageOptions = { tokenUserMap };
  const build = (rows, extra) => buildDailyUsage(rows, { ...(extra || {}), tokenUserMap: usageOptions.tokenUserMap });
  if (!config.enabled && cached && Array.isArray(cached.rows)) {
    return { ...build(cached.rows, { generatedAt: cached.generatedAt }), source: "snapshot", cached: true, enabled: config.enabled };
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
      const report = build(rowsList);
      if (options.cache !== false) {
        await saveUsageSnapshot(rootDir, { generatedAt: report.generatedAt, rows: rowsList });
      }
      return { ...report, source: config.source, cached: config.source === "snapshot", enabled: config.enabled };
    } catch (error) {
      if (cached && Array.isArray(cached.rows)) {
        return { ...build(cached.rows, { generatedAt: cached.generatedAt }), source: "snapshot", cached: true, refreshError: error.message, enabled: config.enabled };
      }
      return { ...build([]), source: config.source, cached: false, refreshError: error.message, error: true, enabled: config.enabled };
    }
  }
  if (cached && Array.isArray(cached.rows)) {
    return { ...build(cached.rows, { generatedAt: cached.generatedAt }), source: "snapshot", cached: true, enabled: config.enabled };
  }
  return { ...build([]), source: "empty", cached: false, enabled: config.enabled };
}
