import http from "node:http";
import https from "node:https";

const DEFAULT_TAG = "二级";
const TAG_VALUES = new Set(["一级", "二级", "三级"]);
const FLUCTUATION_TYPES = new Set([
  "completeDayChange",
  "robustCompleteDayChange",
  "intradayTimePointChange",
  "intradaySameTimeChange",
  "latestNonZeroToZero",
]);

export function buildFluctuationMetricTagIdentity(anomaly = {}, countryName = "") {
  const metricName = normalizeText(
    anomaly.metricName
    || anomaly.metricColumn
    || anomaly.column
    || anomaly.series?.find?.((point) => point?.metric)?.metric
    || extractMetricName(anomaly.message)
    || anomaly.cardTitle
    || "未命名指标",
  );
  return {
    country_name: normalizeText(countryName || anomaly.countryName || anomaly.countryCode || "未知国家"),
    dashboard_name: normalizeText(anomaly.dashboardTitle || "未命名看板"),
    card_name: normalizeText(anomaly.cardTitle || "未命名卡片"),
    metric_name: metricName,
    dimension_name: extractDimensionName(anomaly.message),
    time_granularity: detectTimeGranularity(anomaly),
    dashboard_url: normalizeText(anomaly.dashboardUrl || ""),
  };
}

export function metricTagKey(identity = {}) {
  return [
    identity.country_name,
    identity.dashboard_name,
    identity.card_name,
    identity.metric_name,
    identity.dimension_name,
    identity.time_granularity,
  ].map(normalizeText).join("\u001f");
}

export function collectFluctuationMetricTagIdentities(run = {}) {
  const unique = new Map();
  for (const countryRun of run.runs || []) {
    const countryName = countryRun.countryName || countryRun.countryCode || "";
    for (const anomaly of countryRun.result?.anomalies || []) {
      if (!isDrawableFluctuationAnomaly(anomaly, countryRun.countryCode)) continue;
      const identity = buildFluctuationMetricTagIdentity(anomaly, countryName);
      unique.set(metricTagKey(identity), identity);
    }
  }
  return [...unique.values()];
}

export function isDrawableFluctuationAnomaly(anomaly = {}, countryCode = "") {
  const type = String(anomaly.type || "");
  const text = `${anomaly.message || ""} ${anomaly.reason || ""}`;
  if (String(countryCode || anomaly.countryCode || "").toUpperCase() === "CN" && ["noData", "emptyMetrics", "latestNonZeroToZero", "latestZeroRate", "notEmpty"].includes(type)) return false;
  if (["noData", "emptyMetrics", "queryError", "metabaseConfigError", "metabaseStalePublicLink", "notEmpty", "requiredDatePresent", "intradayTimePointCompleteness", "staleLatestDate"].includes(type)) return false;
  if (/缺失|没有数据|无数据|no\s*data|empty/i.test(text)) return false;
  return FLUCTUATION_TYPES.has(type) || /波动|变化|降为|到/.test(text);
}

export function createFluctuationMetricTagStore({ env = process.env, requestFn = null } = {}) {
  const config = getTagGatewayConfig(env);
  const request = requestFn || createGatewayRequester(config);
  return {
    enabled: config.enabled,
    async ensureIdentities(identities = []) {
      if (!config.enabled) return { enabled: false, inserted: 0 };
      const unique = dedupeIdentities(identities);
      if (!unique.length) return { enabled: true, inserted: 0 };
      const payload = await request({ action: "ensure", items: unique });
      return { enabled: true, inserted: Number(payload.inserted ?? unique.length) || 0 };
    },
    async getTags(identities = []) {
      if (!config.enabled) return { enabled: false, tags: {} };
      const unique = dedupeIdentities(identities);
      if (!unique.length) return { enabled: true, tags: {} };
      const payload = await request({ action: "lookup", items: unique });
      const tags = Object.fromEntries(Object.entries(payload.tags || {}).map(([key, tag]) => [key, TAG_VALUES.has(tag) ? tag : DEFAULT_TAG]));
      return { enabled: true, tags };
    },
    async updateTag(identity = {}, tag = "") {
      if (!config.enabled) throw new Error("波动图谱标签服务未配置，请设置 FLUCTUATION_TAG_GATEWAY_WEBHOOK_URL。");
      if (!TAG_VALUES.has(tag)) throw new Error("标签只能选择一级、二级或三级。");
      const normalized = normalizeIdentity(identity);
      await request({ action: "update", identity: normalized, tag });
      return { ...normalized, tag };
    },
  };
}

function getTagGatewayConfig(env = {}) {
  const webhookUrl = String(env.FLUCTUATION_TAG_GATEWAY_WEBHOOK_URL || "").trim();
  return {
    enabled: Boolean(webhookUrl),
    webhookUrl,
    token: String(env.FLUCTUATION_TAG_GATEWAY_TOKEN || "").trim(),
  };
}

function createGatewayRequester(config) {
  return async (payload) => {
    const response = await postJson(config.webhookUrl, payload, config.token);
    if (response.statusCode < 200 || response.statusCode >= 300 || response.payload?.success === false) {
      throw new Error(String(response.payload?.error?.message || response.payload?.error || `波动标签 n8n 请求失败: ${response.statusCode}`));
    }
    return response.payload || {};
  };
}

function postJson(url, payload, token = "") {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const target = new URL(url);
    const client = target.protocol === "https:" ? https : http;
    const request = client.request(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => {
        try {
          resolve({ statusCode: response.statusCode || 0, payload: text ? JSON.parse(text) : {} });
        } catch {
          reject(new Error("波动标签 n8n 返回的不是 JSON。"));
        }
      });
    });
    request.setTimeout(20_000, () => request.destroy(new Error("波动标签 n8n 请求超时（20 秒）。")));
    request.on("error", reject);
    request.end(body);
  });
}

function dedupeIdentities(identities) {
  return [...new Map((identities || []).map((identity) => {
    const normalized = normalizeIdentity(identity);
    return [metricTagKey(normalized), normalized];
  })).values()];
}

function normalizeIdentity(identity = {}) {
  return {
    country_name: normalizeText(identity.country_name || "未知国家").slice(0, 32),
    dashboard_name: normalizeText(identity.dashboard_name || "未命名看板").slice(0, 128),
    card_name: normalizeText(identity.card_name || "未命名卡片").slice(0, 128),
    metric_name: normalizeText(identity.metric_name || "未命名指标").slice(0, 128),
    dimension_name: normalizeText(identity.dimension_name || "无维度").slice(0, 128),
    time_granularity: normalizeText(identity.time_granularity || "day").slice(0, 8),
    dashboard_url: normalizeText(identity.dashboard_url || "").slice(0, 255),
  };
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function extractMetricName(message = "") {
  const text = String(message);
  for (const pattern of [
    /(?:完整日指标|稳健完整日指标|同时间指标|上一日同时间点指标|指标)[「“\"]([^」”\"]+)[」”\"]/,
    /指标\s+([^，,：:]+?)(?:，|,|从|\s+从|$)/,
  ]) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }
  return "";
}

function extractDimensionName(message = "") {
  const parts = [];
  for (const section of String(message).matchAll(/[（(]([^（）()]+)[）)]/g)) {
    for (const value of section[1].split(/[，,]/).map(normalizeText)) {
      if (value.includes("=") && !/^(统计日期|stat_date|注册日期|到期日期|日期|时间|timezone)\s*=/.test(value)) parts.push(value);
    }
  }
  return [...new Set(parts)].sort().join("，") || "无维度";
}

function detectTimeGranularity(anomaly = {}) {
  if (anomaly.series?.some?.((point) => point?.xType === "hour")) return "hour";
  if (["intradayTimePointChange", "intradaySameTimeChange"].includes(String(anomaly.type || ""))) return "hour";
  return "day";
}
import { spawn } from "node:child_process";
