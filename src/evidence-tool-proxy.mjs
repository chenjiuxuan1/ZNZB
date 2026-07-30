import { fetchCompatible } from "./fetch-compatible.mjs";

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
