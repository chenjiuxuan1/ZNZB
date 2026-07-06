import path from "node:path";
import { readJsonFile, deepMapStrings, ensureNumber } from "./utils.mjs";

const ENV_PATTERN = /\$\{([A-Z0-9_]+)\}/g;
const RELATIVE_TIME_PATTERN = /^now(?:(?<sign>[+-])(?<amount>\d+)(?<unit>[smhdw]))?$/i;

export async function loadConfig(configPath) {
  const absolutePath = path.resolve(configPath);
  const rawConfig = await readJsonFile(absolutePath);
  const expanded = deepMapStrings(rawConfig, interpolateEnvString);
  const urlMetadata = expanded.grafana?.dashboardUrl
    ? parseDashboardUrl(expanded.grafana.dashboardUrl)
    : null;

  const config = {
    stateFile: ".state/monitor-state.json",
    schedule: { intervalMinutes: 10 },
    browserAuth: {
      enabled: true,
      headless: true,
      storageStateFile: ".state/grafana-storage-state.json",
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    },
    alerts: { channel: "console", sendRecovery: true },
    variables: {},
    builtInChecks: { queryError: true, noData: true },
    ...expanded,
  };

  config.grafana = {
    ...config.grafana,
    baseUrl: config.grafana?.baseUrl || urlMetadata?.baseUrl,
    dashboardUid: config.grafana?.dashboardUid || urlMetadata?.dashboardUid,
    orgId: config.grafana?.orgId ?? urlMetadata?.orgId,
  };

  if (!config.timeRange && urlMetadata?.timeRange) {
    config.timeRange = urlMetadata.timeRange;
  }

  if (urlMetadata?.variables) {
    config.variables = {
      ...urlMetadata.variables,
      ...config.variables,
    };
  }

  validateConfig(config);
  return config;
}

export function parseDashboardUrl(urlString) {
  const parsed = new URL(urlString);
  const match = parsed.pathname.match(/^\/d\/([^/]+)(?:\/([^/]+))?/);

  if (!match) {
    throw new Error(`Dashboard URL does not look like a Grafana dashboard link: ${urlString}`);
  }

  const variables = {};
  for (const [key, value] of parsed.searchParams.entries()) {
    if (key.startsWith("var-")) {
      variables[key.slice(4)] = value;
    }
  }

  const from = parsed.searchParams.get("from");
  const to = parsed.searchParams.get("to");

  return {
    baseUrl: parsed.origin,
    dashboardUid: match[1],
    orgId: ensureNumber(parsed.searchParams.get("orgId"), undefined),
    variables,
    timeRange: from || to ? { from: from || "now-6h", to: to || "now" } : undefined,
  };
}

export function resolveTimeRange(rawRange, nowMs = Date.now()) {
  const fallback = { fromMs: nowMs - (6 * 60 * 60 * 1000), toMs: nowMs };
  if (!rawRange) {
    return fallback;
  }

  return {
    fromMs: resolveTimeValue(rawRange.from, nowMs),
    toMs: resolveTimeValue(rawRange.to, nowMs),
  };
}

function resolveTimeValue(value, nowMs) {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value !== "string" || value.length === 0) {
    return nowMs;
  }

  if (/^\d+$/.test(value)) {
    return Number(value);
  }

  const relative = value.match(RELATIVE_TIME_PATTERN);
  if (relative) {
    const { sign, amount, unit } = relative.groups;
    if (!sign) {
      return nowMs;
    }

    const multiplier = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
      w: 7 * 24 * 60 * 60 * 1000,
    }[unit.toLowerCase()];
    const delta = Number(amount) * multiplier;
    return sign === "-" ? nowMs - delta : nowMs + delta;
  }

  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    return dateMs;
  }

  throw new Error(`Unsupported time value: ${value}`);
}

function interpolateEnvString(value) {
  return value.replace(ENV_PATTERN, (_, envKey) => process.env[envKey] ?? "");
}

function validateConfig(config) {
  if (!config.grafana?.baseUrl) {
    throw new Error("Missing grafana.baseUrl or grafana.dashboardUrl in config.");
  }

  if (!config.grafana?.dashboardUid) {
    throw new Error("Missing grafana.dashboardUid or a valid grafana.dashboardUrl in config.");
  }

  if (!config.grafana.token && !config.grafana.cookie && !config.grafana.username) {
    throw new Error(
      "Provide grafana.token, grafana.cookie, or grafana.username/password for authentication.",
    );
  }

  if (!Array.isArray(config.rules)) {
    throw new Error("config.rules must be an array.");
  }
}
