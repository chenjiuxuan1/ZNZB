import { fetchCompatible } from "./fetch-compatible.mjs";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const COUNTRY_CODES = new Set(["cn", "ine", "ph", "th", "pk", "mx"]);
const DEFAULT_WATTREL_GATEWAY_URL = "http://127.0.0.1:5678/webhook/wattrel-query";
const DEFAULT_DS_SCHEDULER_GATEWAY_URL = "http://127.0.0.1:5678/webhook/ds-scheduler";
const GATEWAY_TIMEOUT_MS = 45_000;

function normalizeCountryCode(value) {
  const code = String(value || "").trim().toLowerCase();
  const aliases = { id: "ine", indonesia: "ine", indo: "ine", mex: "mx", mexico: "mx", pak: "pk", pakistan: "pk", china: "cn", thailand: "th", philippines: "ph" };
  return aliases[code] || code;
}

export async function proxyWattrelQuery(body = {}, { env = process.env, fetchFn = fetchCompatible } = {}) {
  const country = normalizeCountryCode(body.country);
  const limit = Math.max(1, Math.min(200, Number(body.limit ?? 50)));
  if (!COUNTRY_CODES.has(country)) {
    const error = new Error("Unsupported countryCode; use cn/ine/ph/th/pk/mx");
    error.statusCode = 400;
    throw error;
  }
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS) : null;
  try {
    const gatewayUrl = String(env.WATTREL_GATEWAY_URL || DEFAULT_WATTREL_GATEWAY_URL);
    const response = await fetchFn(gatewayUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ country, limit }),
      signal: controller?.signal,
    });
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { error: "Wattrel gateway returned invalid JSON" }; }
    if (!response.ok) {
      const error = new Error(payload.error || `Wattrel gateway failed (${response.status})`);
      error.statusCode = 502;
      throw error;
    }
    return payload;
  } catch (cause) {
    if (cause.statusCode) throw cause;
    const error = new Error(`Wattrel gateway unavailable: ${cause.message}`);
    error.statusCode = 502;
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const DS_TOKEN_ENV_MAP = {
  cn: "DS_API_TOKEN_CN",
  ine: "DS_API_TOKEN_INE",
  ph: "DS_API_TOKEN_PH",
  th: "DS_API_TOKEN_TH",
  pk: "DS_API_TOKEN_PK",
  mx: "DS_API_TOKEN_MX",
};

const READONLY_DS_ACTIONS = new Set([
  "check_failed_instances", "list_instances", "get_instance",
  "list_task_instances", "get_task_log", "list_workflows",
  "get_workflow", "list_schedules", "get_schedule", "list_projects",
  "resolve_project", "list_datasources", "get_datasource",
  "extract_task_runtime_config", "list_resources", "view_resource_file",
  "search_resource_sql", "find_resource_usage", "search_country_git_sql",
  "dump_workflow_graph",
]);

export async function proxyDsSchedulerRequest(body = {}, { env = process.env, fetchFn = fetchCompatible } = {}) {
  const country = normalizeCountryCode(body.country);
  const action = String(body.action || "").trim();
  const payload = body.payload && typeof body.payload === "object"
    ? body.payload
    : { search_val: String(body.search_val || ""), start_time: String(body.start_time || ""), end_time: String(body.end_time || "") };
  if (!COUNTRY_CODES.has(country)) {
    const error = new Error("Unsupported countryCode; use cn/ine/ph/th/pk/mx");
    error.statusCode = 400;
    throw error;
  }
  if (!READONLY_DS_ACTIONS.has(action)) {
    const error = new Error(`Action "${action}" is not allowed; only read-only DS queries are permitted`);
    error.statusCode = 400;
    throw error;
  }
  const tokenEnv = DS_TOKEN_ENV_MAP[country];
  const dsToken = String(env[tokenEnv] || "").trim();
  if (!dsToken) {
    const error = new Error(`DS API token not configured for country "${country}" (env: ${tokenEnv})`);
    error.statusCode = 503;
    throw error;
  }
  const requestId = String(body.request_id || `ds-${Date.now()}`).slice(0, 128);
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS) : null;
  try {
    const gatewayUrl = String(env.DS_SCHEDULER_GATEWAY_URL || DEFAULT_DS_SCHEDULER_GATEWAY_URL);
    const response = await fetchFn(gatewayUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ country, action, ds_token: dsToken, request_id: requestId, payload }),
      signal: controller?.signal,
    });
    const text = await response.text();
    let result;
    try { result = text ? JSON.parse(text) : {}; } catch { result = { error: "DS scheduler gateway returned invalid JSON" }; }
    if (!response.ok) {
      const error = new Error(result.error || `DS scheduler gateway failed (${response.status})`);
      error.statusCode = 502;
      throw error;
    }
    return result;
  } catch (cause) {
    if (cause.statusCode) throw cause;
    const error = new Error(`DS scheduler gateway unavailable: ${cause.message}`);
    error.statusCode = 502;
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ── SR Box (StarRocks) read-only data query proxy ── */

const SR_COUNTRY_MAP = { cn: "cn", ine: "id", ph: "ph", th: "th", pk: "pk", mx: "mx" };
const DEFAULT_SR_GATEWAY_URL = "https://data-map-dev.kuainiu.io";
const SR_QUERY_TIMEOUT_MS = 60_000;
const READONLY_SQL_PREFIXES = ["select", "with", "show", "desc", "describe", "explain"];

function validateReadOnlySql(sql) {
  const trimmed = String(sql || "").trim().toLowerCase();
  if (!trimmed) throw new Error("SQL is required");
  if (!READONLY_SQL_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
    const error = new Error("Only read-only SQL is allowed (SELECT, WITH, SHOW, DESC, EXPLAIN)");
    error.statusCode = 400;
    throw error;
  }
  const writeKeywords = /\b(insert|update|delete|create|alter|drop|truncate|replace|merge|refresh)\b/i;
  if (writeKeywords.test(trimmed)) {
    const error = new Error("Write/DDL/DML statements are not allowed");
    error.statusCode = 400;
    throw error;
  }
}

function resolveSrSessionToken(env) {
  const sessionFile = String(env.SR_SKILLS_SESSION_FILE || join(homedir(), ".config", "sr-skills", "session-data-map-dev.json"));
  try {
    const raw = readFileSync(sessionFile, "utf8");
    const session = JSON.parse(raw);
    if (!session.sessionToken) return null;
    const now = Date.now();
    const expiresAt = session.expiresAt ? Date.parse(session.expiresAt) : 0;
    if (expiresAt && expiresAt < now) return null;
    const lastAccessed = session.lastAccessedAt ? Date.parse(session.lastAccessedAt) : 0;
    const idleLimit = Number(env.SR_SKILLS_SESSION_IDLE_TIMEOUT_SECONDS || 3600) * 1000;
    if (lastAccessed && now - lastAccessed > idleLimit) return null;
    return session.sessionToken;
  } catch {
    return null;
  }
}

export async function proxySrQuery(body = {}, { env = process.env, fetchFn = fetchCompatible } = {}) {
  const znzbCountry = normalizeCountryCode(body.country);
  if (!COUNTRY_CODES.has(znzbCountry)) {
    const error = new Error("Unsupported countryCode; use cn/ine/ph/th/pk/mx");
    error.statusCode = 400;
    throw error;
  }
  const srCountry = SR_COUNTRY_MAP[znzbCountry];
  if (!srCountry) {
    const error = new Error(`No SR sandbox mapping for country "${znzbCountry}"`);
    error.statusCode = 400;
    throw error;
  }
  const sql = String(body.sql || "").trim();
  validateReadOnlySql(sql);
  const limit = Math.max(1, Math.min(500, Number(body.limit ?? 100)));
  const token = String(env.FUXI_SR_TOKEN || "").trim() || resolveSrSessionToken(env);
  if (!token) {
    const error = new Error("SR query token not available. Set FUXI_SR_TOKEN in .env or run: python3 sr_gateway_client.py sso login");
    error.statusCode = 503;
    throw error;
  }
  const gatewayUrl = String(env.FUXI_SR_GATEWAY_URL || DEFAULT_SR_GATEWAY_URL).replace(/\/+$/, "");
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), SR_QUERY_TIMEOUT_MS) : null;
  try {
    const response = await fetchFn(`${gatewayUrl}/api/rust/v1/sr-sandboxes/sql-executions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({
        taskName: "znzb-evidence-query",
        country: srCountry,
        purpose: "agent",
        accessMode: "local",
        sqlMode: "query",
        sql,
        page: 1,
        pageSize: limit,
        timeoutSec: 55,
      }),
      signal: controller?.signal,
    });
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { error: "SR gateway returned invalid JSON", raw: text.slice(0, 500) }; }
    if (!response.ok) {
      const error = new Error(payload.message || payload.error || `SR gateway failed (${response.status})`);
      error.statusCode = 502;
      error.gatewayPayload = payload;
      throw error;
    }
    return {
      success: payload.success !== false,
      columns: payload.data?.columns || payload.columns || [],
      rows: payload.data?.rows || payload.data?.records || payload.rows || [],
      rowCount: payload.data?.total || (payload.data?.rows || payload.rows || []).length,
      truncated: (payload.data?.total || 0) > limit,
    };
  } catch (cause) {
    if (cause.statusCode) throw cause;
    const error = new Error(`SR gateway unavailable: ${cause.message}`);
    error.statusCode = 502;
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
