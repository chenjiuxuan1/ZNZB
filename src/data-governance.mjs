import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

/**
 * 数据治理后端代理。
 * 复用 Pi Package (pi-data-governance) 的工具实现；为 ZNZB 提供：
 *  - 触发零访问/备份表扫描
 *  - 查询已落库结果（含从 n8n 执行记录 fallback）
 *  - 导出 CSV / Excel / DROP SQL 草稿
 * 所有写操作（DROP）仅生成草稿文件，永不执行。
 */

// Pi 包工具（从相对路径导入；若 Pi 包被移动，可用 GOV_PI_PACKAGE_PATH 覆盖）
const COUNTRIES = new Set(["cn", "ine", "mx", "ph", "pk", "th"]);
const LAYERS = new Set(["ods", "dwd", "dws", "ads"]);

function badRequest(message) {
  throw Object.assign(new Error(message), { statusCode: 400 });
}

function piPackageDir(env = process.env) {
  return env.GOV_PI_PACKAGE_PATH
    ? path.resolve(env.GOV_PI_PACKAGE_PATH)
    : path.resolve(__dirname, "..", "..", "..", "deepseek harness", "pi-data-governance");
}

function normalizeCountry(value) {
  const country = String(value || "").trim().toLowerCase();
  if (!COUNTRIES.has(country)) badRequest(`不支持的国家：${value || ""}`);
  return country;
}

function normalizeLayers(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) badRequest("layers 必须是数组");
  return [...new Set(value.map((item) => String(item || "").trim().toLowerCase()).filter((item) => LAYERS.has(item)))];
}

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function normalizeRows(value) {
  if (!Array.isArray(value)) badRequest("rows 必须是数组");
  if (value.length > 10_000) badRequest("单次最多处理 10000 行");
  if (value.some((row) => !row || typeof row !== "object" || Array.isArray(row))) badRequest("rows 中存在无效记录");
  return value;
}

async function loadGovTools(env = process.env) {
  const toolsPath = path.join(piPackageDir(env), "tools", "gov-tools.mjs");
  if (!fs.existsSync(toolsPath)) {
    throw new Error(`Pi 包工具不存在: ${toolsPath}（可设置 GOV_PI_PACKAGE_PATH 指向 pi-data-governance 目录）`);
  }
  return import(pathToFileURL(toolsPath).href);
}

/**
 * 触发扫描（zombie / bak）
 * body: { country, layers?, lookback_days?, bak?, min_gb? }
 */
export async function runDataGovernanceScan(body = {}, { env = process.env } = {}) {
  const gov = await loadGovTools(env);
  const fn = body.bak ? gov.govBakScan : gov.govZombieScan;
  return fn({
    country: normalizeCountry(body.country),
    layers: normalizeLayers(body.layers),
    lookback_days: boundedNumber(body.lookback_days, 30, 1, 90),
    bak: Boolean(body.bak),
  }, { env });
}

/**
 * 查询已落库结果
 * body: { country, offset?, schema?, min_gb?, bak?, layers? }
 */
export async function queryDataGovernance(body = {}, { env = process.env } = {}) {
  const gov = await loadGovTools(env);
  return gov.govQuery({
    country: normalizeCountry(body.country),
    offset: boundedNumber(body.offset, 0, 0, 1_000_000),
    schema: String(body.schema || "").trim().slice(0, 128),
    min_gb: boundedNumber(body.min_gb, 0, 0, 1_000_000),
    bak: Boolean(body.bak),
    layers: normalizeLayers(body.layers),
  }, { env });
}

/**
 * 导出文件（CSV/SQL/XLSX）
 * body: { rows, format, country?, dir?, name? }
 * 返回 { file, format, rowCount }
 */
export async function exportDataGovernance(body = {}, { env = process.env } = {}) {
  const gov = await loadGovTools(env);
  const outDir = path.resolve(env.GOV_OUTPUT_DIR || path.join(rootDir, "..", "gov-output"));
  const format = String(body.format || "csv").trim().toLowerCase();
  if (!new Set(["csv", "xlsx"]).has(format)) badRequest(`不支持的导出格式：${format}`);
  const rows = normalizeRows(body.rows);
  const result = await gov.govExport({
    rows,
    format,
    country: body.country ? normalizeCountry(body.country) : undefined,
    name: String(body.name || "data-governance").replace(/[\\/\0]/g, "_").slice(0, 100),
    dir: outDir,
  }, { env });
  return { ...result, rowCount: Number.isFinite(Number(result?.rowCount)) ? Number(result.rowCount) : rows.length };
}

/**
 * 生成 DROP SQL 草稿（仅文件）
 * body: { rows, country?, dir?, comment? }
 */
export async function dropSqlDataGovernance(body = {}, { env = process.env } = {}) {
  const gov = await loadGovTools(env);
  const outDir = path.resolve(env.GOV_OUTPUT_DIR || path.join(rootDir, "..", "gov-output"));
  return gov.govDropSql({
    rows: normalizeRows(body.rows),
    country: body.country ? normalizeCountry(body.country) : undefined,
    comment: String(body.comment || "").slice(0, 500),
    dir: outDir,
  }, { env });
}

/**
 * 分桶合理性检测
 * body: { country, max_bucket?, min_rows_per_bucket?, limit? }
 */
export async function bucketCheckDataGovernance(body = {}, { env = process.env } = {}) {
  const gov = await loadGovTools(env);
  return gov.govBucketCheck({
    country: normalizeCountry(body.country),
    max_bucket: boundedNumber(body.max_bucket, 10, 1, 10_000),
    min_rows_per_bucket: boundedNumber(body.min_rows_per_bucket, 10_000_000, 1, 10_000_000_000),
    limit: boundedNumber(body.limit, 1_000, 1, 10_000),
  }, { env });
}

/**
 * 列出支持的国家
 */
export async function countriesDataGovernance(_body = {}, { env = process.env } = {}) {
  const gov = await loadGovTools(env);
  return gov.govCountries({}, { env });
}

/**
 * 健康检查：Pi 包是否存在
 */
export function healthDataGovernance(env = process.env) {
  const toolsPath = path.join(piPackageDir(env), "tools", "gov-tools.mjs");
  return {
    toolsExist: fs.existsSync(toolsPath),
    node: process.version,
  };
}
