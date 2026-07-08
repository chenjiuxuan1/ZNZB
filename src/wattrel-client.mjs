import { spawn } from "node:child_process";

const DEFAULT_WATTREL_SQL = "SELECT id, quality_id, name, type, `desc`, src_db, src_tbl, dest_db, dest_tbl, src_value, dest_value, diff, `begin`, `end`, result, status, src_error, dest_error, is_repaired, created_at, updated_at FROM wattrel_quality_result WHERE result = 1 AND created_at >= DATE_SUB(NOW(), INTERVAL 3 DAY) ORDER BY created_at DESC LIMIT ?";

export async function queryWattrelAlerts({ config = {}, limit = 100, queryFn = null } = {}) {
  const normalized = normalizeWattrelConfig(config, limit);
  if (typeof queryFn === "function") {
    return normalizeRows(await queryFn(normalized));
  }
  if (!normalized.enabled) {
    return [];
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
  return rows.map((row) => {
    const countryCode = firstPresent(row.country_code, row.countryCode, row.country, defaults.countryCode);
    const countryName = firstPresent(row.country_name, row.countryName, defaults.countryName);
    const destTbl = firstPresent(row.dest_tbl, row.destTable, row.table_name, row.tableName, row.dest_table);
    const srcTbl = firstPresent(row.src_tbl, row.srcTable, row.src_table);
    const checkName = firstPresent(row.check_name, row.checkName, row.setting_name, row.name, row.rule_name, row.metric_name, row.metric);
    const expectedValue = firstPresent(row.src_value, row.src_cnt, row.expected_value, row.expected, row.expect_value);
    const actualValue = firstPresent(row.dest_value, row.dest_cnt, row.actual_value, row.actual, row.real_value);
    const diff = firstPresent(row.diff_value, row.diff, row.diff_cnt);
    const message = firstPresent(row.message, row.msg, row.setting_desc, row.desc, row.msg_template, row.description);
    const begin = firstPresent(row.begin, row.start_time, row.startTime);
    const end = firstPresent(row.end, row.end_time, row.endTime);

    return {
      source: "wattrel",
      type: "wattrelQualityAlert",
      countryCode: countryCode ? String(countryCode) : "",
      countryName: countryName ? String(countryName) : "",
      dashboardTitle: firstPresent(row.dashboard_title, row.dashboardTitle, "Wattrel 数据质量"),
      cardTitle: String(destTbl || checkName || row.id || "Wattrel 告警"),
      name: checkName ? String(checkName) : "",
      srcTbl: srcTbl ? String(srcTbl) : "",
      destTbl: destTbl ? String(destTbl) : "",
      expectedValue,
      actualValue,
      diff,
      window: firstPresent(row.check_window, row.time_range, row.window, begin && end ? `${begin} 至 ${end}` : begin, row.biz_date, row.created_at),
      begin,
      end,
      srcDb: firstPresent(row.src_db, row.srcDb),
      destDb: firstPresent(row.dest_db, row.destDb),
      srcError: firstPresent(row.src_error, row.srcError),
      destError: firstPresent(row.dest_error, row.destError),
      severity: firstPresent(row.alert_level, row.level, "warning"),
      row,
      message: message ? String(message) : undefined,
    };
  });
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
      "--silent",
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

function normalizeRows(rows) {
  return Array.isArray(rows) ? rows : [];
}

function isMissingMysql2(error) {
  return /Cannot find package 'mysql2'|ERR_MODULE_NOT_FOUND/.test(String(error?.message || error));
}

function resolveEnvString(value) {
  return String(value ?? "").replace(/\$\{([^}]+)\}/g, (_match, key) => process.env[key] || "");
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
