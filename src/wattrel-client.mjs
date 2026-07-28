import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";

// A quality rule can execute repeatedly. Its latest result is its current status.
const DEFAULT_WATTREL_SQL = "SELECT r.id, r.quality_id, r.name, r.type, r.`desc`, r.src_db, r.src_tbl, r.dest_db, r.dest_tbl, r.src_value, r.dest_value, r.diff, r.`begin`, r.`end`, r.result, r.status, r.src_error, r.dest_error, r.is_repaired, r.created_at, r.updated_at, s.src_sql AS src_sql, s.dest_sql AS dest_sql, s.msg_template AS msg_template FROM wattrel_quality_result r INNER JOIN (SELECT COALESCE(CAST(quality_id AS CHAR), CONCAT('name:', name)) AS rule_key, MAX(id) AS latest_id FROM wattrel_quality_result GROUP BY COALESCE(CAST(quality_id AS CHAR), CONCAT('name:', name))) latest ON latest.latest_id = r.id LEFT JOIN wattrel_quality_setting s ON r.quality_id = s.id WHERE r.result = 1 AND r.is_repaired = 0 ORDER BY r.created_at DESC LIMIT ?";
const DEFAULT_WATTREL_GATEWAY_WEBHOOK_URL = "http://127.0.0.1:5678/webhook/wattrel-query";
const WATTREL_GATEWAY_TIMEOUT_MS = 45_000;

export async function queryWattrelAlerts({ config = {}, limit = 100, queryFn = null } = {}) {
  const normalized = normalizeWattrelConfig(config, limit);
  if (typeof queryFn === "function") {
    return normalizeRows(await queryFn(normalized));
  }
  if (!normalized.enabled) {
    return [];
  }
  if (normalized.gateway.webhookUrl) {
    return normalizeRows(await queryWithGateway(normalized));
  }
  if (normalized.ssh.host) {
    return normalizeRows(await queryWithSshMysqlCli(normalized));
  }

  try {
    return normalizeRows(await queryWithMysql2(normalized));
  } catch (error) {
    if (!isMissingMysql2(error)) {
      throw error;
    }
    return normalizeRows(await queryWithMysqlCli(normalized));
  }
}

export function mapWattrelRowsToAnomalies(rows = [], defaults = {}) {
  const anomalies = rows.map((inputRow) => {
    const row = normalizeWattrelRow(inputRow);
    const value = (...keys) => getWattrelRowValue(row, ...keys);
    const malformedColumns = hasMalformedWattrelColumns(row);
    const countryCode = firstPresent(value("country_code", "countryCode", "country"), defaults.countryCode);
    const countryName = firstPresent(value("country_name", "countryName"), defaults.countryName);
    const destTbl = value("dest_tbl", "destTable", "table_name", "tableName", "dest_table", "target_table", "targetTable");
    const srcTbl = value("src_tbl", "srcTable", "src_table", "source_table", "sourceTable");
    const checkName = value("check_name", "checkName", "setting_name", "name", "rule_name", "ruleName", "metric_name", "metric");
    const expectedValue = value("src_value", "src_cnt", "expected_value", "expected", "expect_value", "source_value", "sourceValue");
    const actualValue = value("dest_value", "dest_cnt", "actual_value", "actual", "real_value", "target_value", "targetValue");
    const diff = value("diff_value", "diff", "diff_cnt", "difference", "delta");
    const message = value("message", "msg", "setting_desc", "desc", "msg_template", "description");
    const begin = value("begin", "start_time", "startTime");
    const end = value("end", "end_time", "endTime");
    const srcSql = value("src_sql", "srcSql", "source_sql", "sourceSql");
    const destSql = value("dest_sql", "destSql", "target_sql", "targetSql");
    const checkSql = value("check_sql", "checkSql", "sql");

    return {
      source: "wattrel",
      type: "wattrelQualityAlert",
      qualityId: value("quality_id", "qualityId"),
      countryCode: countryCode ? String(countryCode) : "",
      countryName: countryName ? String(countryName) : "",
      dashboardTitle: firstPresent(value("dashboard_title", "dashboardTitle"), "Wattrel 数据质量"),
      cardTitle: String(malformedColumns ? "Wattrel 字段解析失败" : (destTbl || checkName || value("id") || "Wattrel 告警")),
      name: checkName ? String(checkName) : "",
      srcTbl: srcTbl ? String(srcTbl) : "",
      destTbl: destTbl ? String(destTbl) : "",
      // A few Wattrel rules do not persist dest_tbl; the rule name is the only table identifier returned.
      tableName: String(destTbl || checkName || value("table", "target", "target_name") || ""),
      expectedValue,
      actualValue,
      diff,
      window: firstPresent(value("check_window", "time_range", "window"), begin && end ? `${begin} 至 ${end}` : begin, value("biz_date", "created_at")),
      begin,
      end,
      srcDb: value("src_db", "srcDb", "source_db", "sourceDb"),
      destDb: value("dest_db", "destDb", "target_db", "targetDb"),
      srcSql: srcSql ? String(srcSql) : "",
      destSql: destSql ? String(destSql) : "",
      checkSql: checkSql ? String(checkSql) : "",
      srcError: value("src_error", "srcError", "source_error", "sourceError"),
      destError: value("dest_error", "destError", "target_error", "targetError"),
      severity: firstPresent(value("alert_level", "level"), "warning"),
      row,
      message: malformedColumns
        ? "n8n 未返回 Wattrel 查询列名，无法解析表名和值；请更新 Wattrel 查询网关。"
        : (message ? String(message) : undefined),
    };
  });
  const seenRules = new Set();
  return anomalies.filter((anomaly) => {
    const key = String(anomaly.qualityId || `${anomaly.name}\u0000${anomaly.destTbl}` || "").trim();
    if (!key || seenRules.has(key)) {
      return !key;
    }
    seenRules.add(key);
    return true;
  });
}

function hasMalformedWattrelColumns(row = {}) {
  const keys = Object.keys(row || {});
  if (keys.length === 0) return false;
  const expected = ["id", "quality_id", "name", "dest_tbl", "src_tbl", "src_value", "dest_value", "diff"];
  const normalizedKeys = new Set(keys.map((key) => normalizeWattrelKey(key)));
  if (expected.some((key) => normalizedKeys.has(normalizeWattrelKey(key)))) return false;
  // A headerless tabular response makes the first data row become object keys,
  // such as "0", "495956" or a table name. Those fields cannot be decoded safely.
  return keys.some((key) => /^-?\d+(?:\.\d+)?$/.test(key)) && keys.length >= 3;
}

function normalizeWattrelRow(input) {
  const row = input && typeof input === "object" ? input : {};
  // n8n nodes may wrap their JSON payload in json/data/row depending on the response node.
  for (const key of ["json", "data", "row"]) {
    if (row[key] && typeof row[key] === "object" && !Array.isArray(row[key])) {
      return { ...row, ...row[key] };
    }
  }
  return row;
}

function getWattrelRowValue(row, ...keys) {
  const index = new Map(Object.entries(row || {}).map(([key, value]) => [normalizeWattrelKey(key), value]));
  return firstPresent(...keys.map((key) => index.get(normalizeWattrelKey(key))));
}

function normalizeWattrelKey(key) {
  return String(key || "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function normalizeWattrelConfig(config = {}, limit = 100) {
  const db = config.database || config.connection || {};
  const query = config.query || {};
  const envLimit = Number(process.env.WATTREL_QUERY_LIMIT || "");
  const normalizedLimit = clampNumber(limit ?? query.limit ?? envLimit, 1, 1000, 100);
  return {
    enabled: config.enabled !== false,
    database: {
      host: resolveEnvString(db.host || process.env.WATTREL_DB_HOST || "127.0.0.1"),
      port: Number(resolveEnvString(db.port || process.env.WATTREL_DB_PORT || 3306)),
      user: resolveEnvString(db.user || process.env.WATTREL_DB_USER || ""),
      password: resolveEnvString(db.password || process.env.WATTREL_DB_PASSWORD || ""),
      database: resolveEnvString(db.database || process.env.WATTREL_DB_NAME || ""),
      charset: resolveEnvString(db.charset || "utf8mb4"),
    },
    query: {
      sql: resolveEnvString(query.sql || process.env.WATTREL_ALERT_SQL || DEFAULT_WATTREL_SQL),
      params: normalizeQueryParams(query.params, normalizedLimit),
      limit: normalizedLimit,
    },
    cli: {
      command: resolveEnvString(config.cli?.command || process.env.WATTREL_MYSQL_COMMAND || "mysql"),
    },
    ssh: normalizeSshConfig(config.ssh || config.remote || {}),
    gateway: normalizeGatewayConfig(config.gateway || {}),
    country: {
      code: resolveEnvString(config.defaultCountryCode || config.countryCode || ""),
      name: resolveEnvString(config.defaultCountryName || config.countryName || ""),
    },
  };
}

async function queryWithMysql2(config) {
  const mysql = await import("mysql2/promise");
  const connection = await mysql.createConnection(config.database);
  try {
    const [rows] = await connection.execute(config.query.sql, config.query.params);
    return rows;
  } finally {
    await connection.end();
  }
}

function queryWithMysqlCli(config) {
  return new Promise((resolve, reject) => {
    const args = [
      "--batch",
      "--raw",
      `--host=${config.database.host}`,
      `--port=${config.database.port}`,
      `--user=${config.database.user}`,
    ];
    if (config.database.database) {
      args.push(config.database.database);
    }

    const sql = interpolateSqlForCli(config.query.sql, config.query.params);
    const child = spawn(config.cli.command, args, {
      env: {
        ...process.env,
        MYSQL_PWD: config.database.password || "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`mysql command failed (${code}): ${stderr.slice(0, 500)}`));
        return;
      }
      resolve(parseMysqlBatchOutput(stdout));
    });
    child.stdin.end(`${sql.replace(/;*\s*$/, "")};\n`);
  });
}

function queryWithSshMysqlCli(config) {
  return new Promise((resolve, reject) => {
    const ssh = config.ssh;
    const args = [];
    if (ssh.port) {
      args.push("-p", String(ssh.port));
    }
    if (ssh.identityFile) {
      args.push("-i", ssh.identityFile);
    }
    for (const option of ssh.options) {
      args.push("-o", option);
    }
    args.push(`${ssh.user ? `${ssh.user}@` : ""}${ssh.host}`);
    args.push(buildRemoteMysqlScript(ssh.envFiles));

    const child = spawn(ssh.command, args, {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ssh mysql command failed (${code}): ${stderr.slice(0, 800)}`));
        return;
      }
      resolve(parseMysqlBatchOutput(stdout));
    });

    const sql = interpolateSqlForCli(config.query.sql, config.query.params);
    child.stdin.end(`${sql.replace(/;*\s*$/, "")};\n`);
  });
}

async function queryWithGateway(config) {
  const { statusCode, payload } = await postJson(config.gateway.webhookUrl, {
    source: "duty-platform",
    action: "query_current",
    request_id: config.gateway.requestId || `wattrel-${Date.now()}`,
    country: config.country.code,
    countryCode: config.country.code,
    countryName: config.country.name,
    limit: config.query.limit,
    sql: config.query.sql,
    params: config.query.params,
  }, config.gateway.headers);
  if (statusCode < 200 || statusCode >= 300 || payload.success === false) {
    const message = payload.error?.message || payload.error || `Wattrel gateway request failed: ${statusCode}`;
    throw new Error(String(message));
  }
  return payload.rows || payload.data?.rows || [];
}

function postJson(urlString, body, headers = {}) {
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
      response.on("data", (chunk) => {
        text += chunk.toString("utf8");
      });
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
    request.setTimeout(WATTREL_GATEWAY_TIMEOUT_MS, () => {
      request.destroy(new Error(`Wattrel gateway request timed out after ${WATTREL_GATEWAY_TIMEOUT_MS / 1000} seconds`));
    });
    request.on("error", reject);
    request.end(data);
  });
}

function normalizeGatewayConfig(gateway = {}) {
  const webhookUrl = resolveEnvString(gateway.webhookUrl || gateway.url || process.env.WATTREL_GATEWAY_WEBHOOK_URL || "")
    || DEFAULT_WATTREL_GATEWAY_WEBHOOK_URL;
  return {
    webhookUrl,
    requestId: resolveEnvString(gateway.requestId || ""),
    headers: normalizeGatewayHeaders(gateway.headers),
  };
}

function normalizeGatewayHeaders(headers = {}) {
  const result = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const resolved = resolveEnvString(value);
    if (resolved && !/^Bearer\s*$/i.test(resolved.trim())) {
      result[key] = resolved;
    }
  }
  const token = process.env.WATTREL_GATEWAY_TOKEN || "";
  if (token && !result.Authorization) {
    result.Authorization = `Bearer ${token}`;
  }
  return result;
}

function buildRemoteMysqlScript(envFiles = []) {
  const envFileList = envFiles.map(shellLiteral).join(" ");
  return [
    "bash",
    "-lc",
    shellLiteral(`set -euo pipefail
for env_file in ${envFileList}; do
  if [ -f "$env_file" ]; then
    set -a
    . "$env_file"
    set +a
    break
  fi
done
: "\${DB_HOST:?DB_HOST missing from wattrel env file}"
: "\${DB_PORT:?DB_PORT missing from wattrel env file}"
: "\${DB_USER:?DB_USER missing from wattrel env file}"
: "\${DB_PASSWORD:?DB_PASSWORD missing from wattrel env file}"
: "\${DB_NAME:?DB_NAME missing from wattrel env file}"
MYSQL_PWD="$DB_PASSWORD" mysql --batch --raw --silent --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USER" "$DB_NAME"`),
  ].join(" ");
}

function parseMysqlBatchOutput(output) {
  const lines = String(output || "").split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) {
    return [];
  }
  const headers = lines[0].split("\t");
  return lines.slice(1).map((line) => {
    const values = line.split("\t");
    return Object.fromEntries(headers.map((header, index) => [header, parseCliValue(values[index])]));
  });
}

function parseCliValue(value) {
  if (value === undefined || value === "NULL") {
    return null;
  }
  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    const numberValue = Number(value);
    if (Number.isFinite(numberValue)) {
      return numberValue;
    }
  }
  return value;
}

function interpolateSqlForCli(sql, params = []) {
  let index = 0;
  return String(sql || "").replace(/\?/g, () => sqlLiteral(params[index++]));
}

function sqlLiteral(value) {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

function normalizeQueryParams(params, limit) {
  if (!Array.isArray(params) || params.length === 0) {
    return [limit];
  }
  return params.map((param) => {
    if (param === "${limit}" || param === "{limit}") {
      return limit;
    }
    if (typeof param === "string") {
      return resolveEnvString(param);
    }
    return param;
  });
}

function normalizeSshConfig(ssh = {}) {
  const host = resolveEnvString(ssh.host || "");
  const portValue = resolveEnvString(ssh.port || "");
  return {
    host,
    port: portValue ? Number(portValue) : null,
    user: resolveEnvString(ssh.user || "root"),
    identityFile: resolveEnvString(ssh.identityFile || ssh.keyFile || ""),
    command: resolveEnvString(ssh.command || process.env.WATTREL_SSH_COMMAND || "ssh"),
    options: normalizeSshOptions(ssh.options),
    envFiles: normalizeEnvFiles(ssh.envFiles || ssh.envFile || ssh.remoteEnvFiles),
  };
}

function normalizeSshOptions(options) {
  if (!options) {
    return ["BatchMode=yes", "ConnectTimeout=30"];
  }
  if (Array.isArray(options)) {
    return options.map((option) => resolveEnvString(option)).filter(Boolean);
  }
  return String(options)
    .split(/[\n,]+/)
    .map((option) => resolveEnvString(option).trim())
    .filter(Boolean);
}

function normalizeEnvFiles(value) {
  const defaults = ["/root/Global-Intelligent-Alarm-Repair-Assistant/.env.local"];
  const entries = Array.isArray(value)
    ? value
    : String(value || "").split(/[\n,]+/);
  const normalized = entries.map((entry) => resolveEnvString(entry).trim()).filter(Boolean);
  return normalized.length ? normalized : defaults;
}

function normalizeRows(rows) {
  return Array.isArray(rows) ? rows : [];
}

function isMissingMysql2(error) {
  return /Cannot find package 'mysql2'|ERR_MODULE_NOT_FOUND/.test(String(error?.message || error));
}

function resolveEnvString(value) {
  return String(value ?? "").replace(/\$\{([^}]+)\}/g, (_match, key) => process.env[key] || "");
}

function shellLiteral(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function clampNumber(value, min, max, fallback) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(numberValue)));
}
