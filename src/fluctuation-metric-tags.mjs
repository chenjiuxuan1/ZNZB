const DEFAULT_TAG = "二级";
const TABLE_NAME = "warning_rule.fluctuation_metric_tags";
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

export function createFluctuationMetricTagStore({ env = process.env, queryFn = null } = {}) {
  const config = getTagDatabaseConfig(env);
  const execute = queryFn || createMysqlExecutor(config);
  let schemaReady = false;
  const ensureSchema = async () => {
    if (!config.enabled || schemaReady) return;
    await execute(`CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
      country_name CHAR(32) NOT NULL,
      dashboard_name CHAR(128) NOT NULL,
      card_name CHAR(128) NOT NULL,
      metric_name CHAR(128) NOT NULL,
      dimension_name CHAR(128) NOT NULL,
      time_granularity CHAR(8) NOT NULL,
      dashboard_url CHAR(255) NOT NULL DEFAULT '',
      tag CHAR(2) NOT NULL DEFAULT '二级',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (country_name, dashboard_name, card_name, metric_name, dimension_name, time_granularity)
    ) DEFAULT CHARSET=utf8mb4`);
    schemaReady = true;
  };
  return {
    enabled: config.enabled,
    async ensureIdentities(identities = []) {
      if (!config.enabled) return { enabled: false, inserted: 0 };
      await ensureSchema();
      const unique = dedupeIdentities(identities);
      for (const identity of unique) {
        await execute(
          `INSERT INTO ${TABLE_NAME} (country_name, dashboard_name, card_name, metric_name, dimension_name, time_granularity, dashboard_url, tag, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, '${DEFAULT_TAG}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
           WHERE NOT EXISTS (
             SELECT 1 FROM ${TABLE_NAME}
             WHERE country_name = ? AND dashboard_name = ? AND card_name = ? AND metric_name = ? AND dimension_name = ? AND time_granularity = ?
           )`,
          [...identityValues(identity), identity.dashboard_url, ...identityPrimaryValues(identity)],
        );
      }
      return { enabled: true, inserted: unique.length };
    },
    async getTags(identities = []) {
      if (!config.enabled) return { enabled: false, tags: {} };
      await ensureSchema();
      const unique = dedupeIdentities(identities);
      if (!unique.length) return { enabled: true, tags: {} };
      const where = unique.map(() => "(country_name = ? AND dashboard_name = ? AND card_name = ? AND metric_name = ? AND dimension_name = ? AND time_granularity = ?)").join(" OR ");
      const rows = await execute(`SELECT country_name, dashboard_name, card_name, metric_name, dimension_name, time_granularity, tag FROM ${TABLE_NAME} WHERE ${where}`, unique.flatMap(identityPrimaryValues));
      const tags = {};
      for (const row of rows || []) tags[metricTagKey(row)] = TAG_VALUES.has(row.tag) ? row.tag : DEFAULT_TAG;
      return { enabled: true, tags };
    },
    async updateTag(identity = {}, tag = "") {
      if (!config.enabled) throw new Error("波动图谱标签库未配置，请设置 FLUCTUATION_TAG_DB_* 环境变量。");
      if (!TAG_VALUES.has(tag)) throw new Error("标签只能选择一级、二级或三级。");
      const normalized = normalizeIdentity(identity);
      // Historical charts created before this feature have no row yet. Insert
      // their default tag first so a user's first edit is never lost.
      await this.ensureIdentities([normalized]);
      await execute(
        `UPDATE ${TABLE_NAME} SET tag = ?, updated_at = CURRENT_TIMESTAMP WHERE country_name = ? AND dashboard_name = ? AND card_name = ? AND metric_name = ? AND dimension_name = ? AND time_granularity = ?`,
        [tag, ...identityPrimaryValues(normalized)],
      );
      return { ...normalized, tag };
    },
  };
}

function getTagDatabaseConfig(env = {}) {
  const host = String(env.FLUCTUATION_TAG_DB_HOST || env.DB_HOST || "").trim();
  const user = String(env.FLUCTUATION_TAG_DB_USER || env.DB_USER || "").trim();
  return {
    enabled: Boolean(host && user),
    host,
    port: Number(env.FLUCTUATION_TAG_DB_PORT || env.DB_PORT || 3306),
    user,
    password: String(env.FLUCTUATION_TAG_DB_PASSWORD || env.DB_PASSWORD || ""),
    database: "warning_rule",
    charset: "utf8mb4",
  };
}

function createMysqlExecutor(config) {
  return async (sql, values) => {
    if (!config.enabled) return [];
    try {
      const mysql = await import("mysql2/promise");
      const connection = await mysql.createConnection(config);
      try {
        const [rows] = await connection.execute(sql, values);
        return rows;
      } finally {
        await connection.end();
      }
    } catch (error) {
      if (!/Cannot find package 'mysql2'|ERR_MODULE_NOT_FOUND/.test(String(error?.message || error))) throw error;
      return queryWithMysqlCli(config, sql, values);
    }
  };
}

function queryWithMysqlCli(config, sql, values) {
  return new Promise((resolve, reject) => {
    const child = spawn("mysql", [
      "--batch",
      "--raw",
      "--skip-column-names",
      "--default-character-set=utf8mb4",
      `--host=${config.host}`,
      `--port=${config.port}`,
      `--user=${config.user}`,
      config.database,
    ], { env: { ...process.env, MYSQL_PWD: config.password }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`mysql command failed (${code}): ${stderr.slice(0, 500)}`));
      if (!/^\s*select\b/i.test(sql)) return resolve([]);
      const columns = ["country_name", "dashboard_name", "card_name", "metric_name", "dimension_name", "time_granularity", "tag"];
      return resolve(stdout.trim() ? stdout.trim().split(/\r?\n/).map((line) => Object.fromEntries(line.split("\t").map((value, index) => [columns[index], value]))) : []);
    });
    child.stdin.end(`${interpolateSql(sql, values).replace(/;*\s*$/, "")};\n`);
  });
}

function interpolateSql(sql, values = []) {
  let index = 0;
  return String(sql).replace(/\?/g, () => sqlLiteral(values[index++]));
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
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

function identityPrimaryValues(identity = {}) {
  const item = normalizeIdentity(identity);
  return [item.country_name, item.dashboard_name, item.card_name, item.metric_name, item.dimension_name, item.time_granularity];
}

function identityValues(identity = {}) {
  return identityPrimaryValues(identity);
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
