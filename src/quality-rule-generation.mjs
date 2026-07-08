import https from "node:https";

export const DEFAULT_QUALITY_RULE_SHEET_URL = "https://docs.google.com/spreadsheets/d/1xh4MSxN-sgdfKZnpGmnY-OujnneimfAp7cgVdtct6SQ/edit?gid=160372088#gid=160372088";

const DEFAULT_COLUMNS = {
  submittedAt: ["时间", "第 1 列", "submitted_at"],
  country: ["国家", "country"],
  database: ["数据库", "database", "db"],
  table: ["表名", "tbl", "table"],
  autoGenerate: ["是否需要自动生成", "auto_generate"],
  needApply: ["是否上线", "need_apply"],
  metricField: ["需要校验的内容字段", "metric_field"],
  candidateKey: ["唯一键", "candidate_key"],
  srcSql: ["src_sql", "源端 SQL"],
  destSql: ["dest_sql", "目标 SQL"],
  humanCheck: ["human_check"],
  operator: ["operator", "操作人"],
  notes: ["notes", "备注"],
};

export async function readQualityRuleGenerationSheet({
  config = {},
  mode = "auto",
  fetchText = fetchHttpsText,
  readWebhookFn = postJsonWebhook,
} = {}) {
  if (mode === "mock" || config.mock === true || config.enabled === false) {
    return buildQualityRuleGenerationSnapshot(mockQualityRuleRows(), { source: "mock" });
  }
  const sheetUrl = config.sheetUrl || config.spreadsheetUrl || DEFAULT_QUALITY_RULE_SHEET_URL;
  const readWebhookUrl = resolveEnvString(config.readWebhookUrl || config.reader?.webhookUrl || "");
  if (readWebhookUrl) {
    const payload = {
      action: "read_quality_rule_generation_rows",
      sheetUrl,
      gid: String(config.gid || ""),
      requestedAt: new Date().toISOString(),
    };
    const response = await readWebhookFn(readWebhookUrl, payload, {
      headers: resolveWebhookHeaders(config.readWebhookHeaders || config.reader?.headers || {}),
    });
    const rawRows = normalizeWebhookRows(response);
    const rows = rawRows.map((row, index) => normalizeQualityRuleRow(row, Number(row.sheetRowNumber || row.rowNumber || 0) || index + 2));
    return buildQualityRuleGenerationSnapshot(rows, {
      source: "read_webhook",
      sheetUrl,
      csvUrl: "",
    });
  }
  const csvUrl = buildGoogleSheetCsvUrl(sheetUrl, config.gid);
  let csvText = "";
  try {
    csvText = await fetchText(csvUrl);
  } catch (error) {
    throw enhanceGoogleSheetReadError(error, csvUrl);
  }
  const rows = parseCsvRows(csvText).map((row, index) => normalizeQualityRuleRow(row, index + 2));
  return buildQualityRuleGenerationSnapshot(rows, {
    source: "google_sheet",
    sheetUrl,
    csvUrl,
  });
}

function normalizeWebhookRows(response) {
  if (Array.isArray(response)) {
    return response;
  }
  if (Array.isArray(response?.rows)) {
    return response.rows;
  }
  if (Array.isArray(response?.data)) {
    return response.data;
  }
  if (Array.isArray(response?.result?.rows)) {
    return response.result.rows;
  }
  return [];
}

function enhanceGoogleSheetReadError(error, csvUrl) {
  const message = String(error?.message || error || "");
  const enhanced = new Error(message);
  enhanced.statusCode = error?.statusCode || 502;
  enhanced.errors = [
    message,
    "当前平台使用 Google Sheet CSV 导出读取确认表。返回 401 通常表示该表没有开放“知道链接的人可查看”，或者当前服务没有 Google 登录态。",
    "操作方式 1：在 Google Sheet 右上角点“共享”，把常规访问改为“知道链接的任何人可查看”，再点击“读取 Google 表”。",
    "操作方式 2：如果不能公开表格，请配置 config/quality-rule-generation.config.json 里的 readWebhookUrl，让 n8n/Apps Script 带权限读取表格并返回 rows 数组。",
    `当前尝试读取的 CSV 地址：${csvUrl}`,
  ];
  return enhanced;
}

export async function submitQualityRuleGenerationRow({ config = {}, row = {}, submitFn = postJsonWebhook } = {}) {
  const normalized = normalizeQualityRuleSubmission(row);
  const errors = validateQualityRuleSubmission(normalized);
  if (errors.length) {
    const error = new Error("Invalid quality rule generation row");
    error.statusCode = 400;
    error.errors = errors;
    throw error;
  }

  const webhookUrl = resolveEnvString(config.writeWebhookUrl || config.writer?.webhookUrl || "");
  if (!webhookUrl) {
    const error = new Error("Quality rule generation write webhook is not configured");
    error.statusCode = 400;
    error.errors = [
      "暂未配置 Google 表写入通道。请在 config/quality-rule-generation.config.json 配置 writeWebhookUrl，指向 n8n Webhook 或 Apps Script。",
    ];
    throw error;
  }

  const payload = {
    action: normalized.sheetRowNumber ? "update_quality_rule_generation_row" : "append_quality_rule_generation_row",
    sheetUrl: config.sheetUrl || config.spreadsheetUrl || DEFAULT_QUALITY_RULE_SHEET_URL,
    gid: String(config.gid || ""),
    row: normalized,
    values: buildGoogleSheetValues(normalized),
    submittedAt: new Date().toISOString(),
  };
  const result = await submitFn(webhookUrl, payload, {
    headers: resolveWebhookHeaders(config.writeWebhookHeaders || config.writer?.headers || {}),
  });
  return {
    ok: true,
    source: "quality_rule_generation_write",
    action: payload.action,
    row: normalized,
    result,
    submittedAt: payload.submittedAt,
  };
}

export function buildQualityRuleGenerationSnapshot(rows = [], meta = {}) {
  const cleanRows = rows.map((row, index) => ({
    id: row.id || `${row.country || "unknown"}-${row.database || "db"}-${row.table || "table"}-${index + 1}`,
    ...row,
  }));
  const countries = groupByCountry(cleanRows);
  const databases = [...groupBy(cleanRows, (row) => row.database || "未填写库").entries()]
    .map(([database, items]) => ({
      database,
      rowCount: items.length,
      tableCount: new Set(items.map((row) => row.table).filter(Boolean)).size,
      rows: items,
    }))
    .sort((a, b) => b.rowCount - a.rowCount || a.database.localeCompare(b.database));
  const pendingRows = cleanRows.filter((row) => isTruthyFlag(row.autoGenerate));
  const applyRows = cleanRows.filter((row) => isTruthyFlag(row.needApply));
  return {
    ok: true,
    source: meta.source || "quality_rule_generation",
    sheetUrl: meta.sheetUrl || DEFAULT_QUALITY_RULE_SHEET_URL,
    csvUrl: meta.csvUrl || "",
    checkedAt: new Date().toISOString(),
    rowCount: cleanRows.length,
    summary: {
      countryCount: countries.length,
      databaseCount: databases.length,
      tableCount: new Set(cleanRows.map((row) => `${row.database}.${row.table}`).filter(Boolean)).size,
      autoGenerateCount: pendingRows.length,
      needApplyCount: applyRows.length,
      generatedSqlCount: cleanRows.filter((row) => row.srcSql || row.destSql).length,
    },
    countries,
    databases,
    rows: cleanRows,
  };
}

export function normalizeQualityRuleSubmission(input = {}) {
  return {
    sheetRowNumber: Number(input.sheetRowNumber || 0) || "",
    submittedAt: cleanText(input.submittedAt),
    country: normalizeCountryCode(input.country || input.countryRaw),
    countryRaw: cleanText(input.countryRaw || input.country),
    database: cleanText(input.database),
    table: cleanText(input.table),
    autoGenerate: normalizeFlagText(input.autoGenerate),
    needApply: normalizeFlagText(input.needApply),
    metricField: cleanText(input.metricField),
    candidateKey: cleanText(input.candidateKey),
    srcSql: cleanText(input.srcSql),
    destSql: cleanText(input.destSql),
    humanCheck: cleanText(input.humanCheck),
    operator: cleanText(input.operator),
    notes: cleanText(input.notes),
  };
}

function validateQualityRuleSubmission(row) {
  const errors = [];
  if (!row.country) {
    errors.push("请填写国家。");
  }
  if (!row.database) {
    errors.push("请填写数据库。");
  }
  if (!row.table) {
    errors.push("请填写表名。");
  }
  if (!row.srcSql && !row.destSql) {
    errors.push("请至少填写 src_sql 或 dest_sql。");
  }
  return errors;
}

function buildGoogleSheetValues(row) {
  return {
    "时间": row.submittedAt,
    "国家": row.countryRaw || row.country,
    "数据库": row.database,
    "表名": row.table,
    "是否需要自动生成": row.autoGenerate,
    "唯一键": row.candidateKey,
    "src_sql": row.srcSql,
    "dest_sql": row.destSql,
    "是否上线": row.needApply,
    "需要校验的内容字段": row.metricField,
    "human_check": row.humanCheck,
    "operator": row.operator,
    "备注": row.notes,
  };
}

function normalizeQualityRuleRow(row, rowNumber) {
  const candidateKey = pickColumn(row, DEFAULT_COLUMNS.candidateKey);
  const srcSql = pickColumn(row, DEFAULT_COLUMNS.srcSql);
  const destSql = pickColumn(row, DEFAULT_COLUMNS.destSql);
  const database = pickColumn(row, DEFAULT_COLUMNS.database) || inferDatabase({ candidateKey, srcSql, destSql });
  return {
    sheetRowNumber: rowNumber,
    submittedAt: pickColumn(row, DEFAULT_COLUMNS.submittedAt),
    country: normalizeCountryCode(pickColumn(row, DEFAULT_COLUMNS.country)),
    countryRaw: pickColumn(row, DEFAULT_COLUMNS.country),
    database,
    table: pickColumn(row, DEFAULT_COLUMNS.table),
    autoGenerate: pickColumn(row, DEFAULT_COLUMNS.autoGenerate),
    needApply: pickColumn(row, DEFAULT_COLUMNS.needApply),
    metricField: pickColumn(row, DEFAULT_COLUMNS.metricField),
    candidateKey,
    srcSql,
    destSql,
    humanCheck: pickColumn(row, DEFAULT_COLUMNS.humanCheck),
    operator: pickColumn(row, DEFAULT_COLUMNS.operator),
    notes: pickColumn(row, DEFAULT_COLUMNS.notes),
  };
}

function inferDatabase({ candidateKey = "", srcSql = "", destSql = "" } = {}) {
  const keyDb = String(candidateKey || "").match(/^([A-Za-z_][\w]*)::/)?.[1];
  if (keyDb) {
    return keyDb;
  }
  const sqlDb = String(destSql || srcSql || "").match(/\b(?:FROM|JOIN)\s+`?([A-Za-z_][\w]*)`?\./i)?.[1];
  return sqlDb || "";
}

function pickColumn(row, names) {
  for (const name of names) {
    const value = row[name];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function normalizeFlagText(value) {
  const text = cleanText(value);
  if (!text) {
    return "";
  }
  return isTruthyFlag(text) ? "是" : text;
}

function groupByCountry(rows) {
  return [...groupBy(rows, (row) => row.country || "UNKNOWN").values()]
    .map((items) => {
      const first = items[0] || {};
      return {
        country: first.country || "UNKNOWN",
        countryRaw: first.countryRaw || first.country || "未归属",
        rowCount: items.length,
        autoGenerateCount: items.filter((row) => isTruthyFlag(row.autoGenerate)).length,
        needApplyCount: items.filter((row) => isTruthyFlag(row.needApply)).length,
        generatedSqlCount: items.filter((row) => row.srcSql || row.destSql).length,
        databaseCount: new Set(items.map((row) => row.database).filter(Boolean)).size,
        tableCount: new Set(items.map((row) => `${row.database}.${row.table}`).filter(Boolean)).size,
        rows: items,
      };
    })
    .sort((a, b) => b.rowCount - a.rowCount || a.country.localeCompare(b.country));
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key).push(row);
  }
  return map;
}

function normalizeCountryCode(value) {
  const text = String(value || "").trim();
  const lower = text.toLowerCase();
  const map = {
    中国: "CN",
    cn: "CN",
    印尼: "INE",
    ine: "INE",
    id: "INE",
    菲律宾: "PH",
    ph: "PH",
    泰国: "TH",
    th: "TH",
    巴基斯坦: "PK",
    pk: "PK",
    墨西哥: "MX",
    mx: "MX",
  };
  return map[text] || map[lower] || text.toUpperCase();
}

function isTruthyFlag(value) {
  return ["1", "true", "yes", "y", "是", "需要", "上线"].includes(String(value || "").trim().toLowerCase());
}

function buildGoogleSheetCsvUrl(sheetUrl, fallbackGid = "") {
  const url = new URL(sheetUrl);
  const idMatch = url.pathname.match(/\/spreadsheets\/d\/([^/]+)/);
  const spreadsheetId = idMatch?.[1] || sheetUrl;
  const gid = fallbackGid || url.searchParams.get("gid") || url.hash.match(/gid=(\d+)/)?.[1] || "0";
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${gid}`;
}

function parseCsvRows(csvText) {
  const records = parseCsv(csvText);
  const headers = records.shift() || [];
  return records
    .filter((record) => record.some((cell) => String(cell || "").trim() !== ""))
    .map((record) => Object.fromEntries(headers.map((header, index) => [String(header || "").trim(), record[index] || ""])));
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  const source = String(text || "");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "\"" && inQuotes && next === "\"") {
      cell += "\"";
      index += 1;
      continue;
    }
    if (char === "\"") {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }
    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

function fetchHttpsText(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 30_000,
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        resolve(fetchHttpsText(new URL(response.headers.location, url).toString()));
        response.resume();
        return;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        reject(new Error(`Google Sheet CSV request failed: ${response.statusCode}`));
        response.resume();
        return;
      }
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    request.on("timeout", () => {
      request.destroy(new Error("Google Sheet CSV request timeout"));
    });
    request.on("error", reject);
  });
}

async function postJsonWebhook(url, payload, { headers = {} } = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...headers,
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : {};
  } catch (_error) {
    body = text;
  }
  if (!response.ok) {
    const error = new Error(`Quality rule generation write webhook failed: ${response.status}`);
    error.statusCode = response.status;
    error.errors = [typeof body === "string" ? body : JSON.stringify(body)];
    throw error;
  }
  return body;
}

function resolveWebhookHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers || {})
      .map(([key, value]) => [key, resolveEnvString(value)])
      .filter(([key, value]) => key && value),
  );
}

function resolveEnvString(value) {
  return String(value ?? "").replace(/\$\{([^}]+)\}/g, (_match, key) => process.env[key] || "").trim();
}

function mockQualityRuleRows() {
  return [
    {
      submittedAt: "2026-06-05 16:51:27",
      country: "CN",
      countryRaw: "cn",
      database: "dwd_sec",
      table: "dwd_cst_pay_cost_detail",
      autoGenerate: "1",
      needApply: "1",
      candidateKey: "dwd_sec::dwd_sec.dwd_cst_pay_cost_detail::cnt",
      srcSql: "SELECT COALESCE(ROUND(SUM(fee_amount), 2), 0) AS cnt FROM ods.ods_paysvr_fee WHERE fee_finish_at >= '{begin}' AND fee_finish_at < '{end}'",
      destSql: "SELECT COALESCE(ROUND(SUM(total_cost), 2), 0) AS cnt FROM dwd_sec.dwd_cst_pay_cost_detail WHERE fee_finish_at >= '{begin}' AND fee_finish_at < '{end}'",
    },
    {
      submittedAt: "2026-06-05 18:56:15",
      country: "PH",
      countryRaw: "ph",
      database: "dwd",
      table: "dwd_user_activity_log",
      autoGenerate: "1",
      needApply: "1",
      candidateKey: "dwd::dwd.dwd_user_activity_log::cnt",
      srcSql: "SELECT count(*) AS cnt FROM log.log_dp_request_record WHERE input_date >= '{begin}' AND input_date < '{end}' AND processtype = 'activity'",
      destSql: "SELECT count(*) AS cnt FROM dwd.dwd_user_activity_log WHERE input_date >= '{begin}' AND input_date < '{end}'",
    },
    {
      submittedAt: "2026-06-05 19:02:27",
      country: "PH",
      countryRaw: "ph",
      database: "dwd",
      table: "dwd_mkt_inst_graph",
      autoGenerate: "1",
      needApply: "0",
      candidateKey: "dwd::dwd.dwd_mkt_inst_graph::cnt",
      srcSql: "SELECT COUNT(*) AS cnt FROM hive.dwb_paimon.dwb_m4_inst_graph WHERE created_at >= '{begin}' AND created_at < '{end}'",
      destSql: "SELECT COUNT(*) AS cnt FROM dwd.dwd_mkt_inst_graph WHERE created_at >= '{begin}' AND created_at < '{end}'",
      notes: "生成后待人工确认，暂不上线。",
    },
  ];
}
