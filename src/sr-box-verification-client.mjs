import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_BASE_URL = "https://data-map-dev.kuainiu.io";
const DEFAULT_TIMEOUT_SECONDS = 60;
const DEFAULT_PAGE_SIZE = 100;
const READ_ONLY_START = /^(select|with|show|desc|describe|explain)\b/i;
const FORBIDDEN_SQL = /\b(insert|update|delete|create|drop|alter|truncate|replace|merge|grant|revoke|load|set|use|call)\b/i;

export class SrBoxVerificationClient {
  constructor(config = {}) {
    const skillRoot = expandHome(
      resolveEnvString(config.skillPath || process.env.SR_BOX_SKILL_PATH || "~/.codex/skills/sr-box"),
    );
    this.pythonExecutable = resolveEnvString(config.pythonExecutable || process.env.SR_BOX_PYTHON || "python3");
    this.scriptPath = expandHome(
      resolveEnvString(config.scriptPath || path.join(skillRoot, "scripts/sr_gateway_client.py")),
    );
    this.baseUrl = resolveEnvString(config.baseUrl || process.env.FUXI_BASE_URL || DEFAULT_BASE_URL);
    this.timeoutSeconds = positiveInteger(config.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS);
    this.pageSize = positiveInteger(config.pageSize, DEFAULT_PAGE_SIZE);
    this.accessMode = config.accessMode === "local" ? "local" : "remote";
    this.purpose = String(config.purpose || "anomaly-verification");
    this.taskName = String(config.taskName || "anomaly-verifier-agent");
    this.execFileFn = config.execFileFn || execFileAsync;
  }

  async execute({ country, sql, purpose, taskName } = {}) {
    const route = mapCountryToSrRoute(country);
    assertReadOnlySql(sql);

    const args = [
      this.scriptPath,
      "execute",
      "--base-url",
      this.baseUrl,
      "--country",
      route,
      "--access-mode",
      this.accessMode,
      "--purpose",
      String(purpose || this.purpose),
      "--sql-mode",
      "query",
      "--task-name",
      String(taskName || this.taskName),
      "--sql",
      sql,
      "--page-size",
      String(this.pageSize),
      "--timeout-sec",
      String(this.timeoutSeconds),
    ];

    let stdout;
    let stderr;
    try {
      ({ stdout, stderr } = await this.execFileFn(this.pythonExecutable, args, {
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
        timeout: (this.timeoutSeconds + 15) * 1000,
      }));
    } catch (error) {
      const payload = parseJsonOutput(error.stdout);
      const detail = payload?.message || payload?.error || String(error.stderr || error.message || error);
      throw new Error(`SR Box verification query failed: ${detail}`.slice(0, 1200));
    }

    const payload = parseJsonOutput(stdout);
    if (!payload) {
      throw new Error(`SR Box verification returned invalid JSON: ${String(stderr || stdout || "").slice(0, 500)}`);
    }
    if (payload.success === false) {
      throw new Error(`SR Box verification query failed: ${payload.message || payload.error || "unknown error"}`);
    }

    return {
      success: true,
      country: route,
      rows: extractRows(payload),
      rowCount: extractRows(payload).length,
      traceId: payload.traceId || payload.trace_id || payload.data?.traceId || payload.data?.trace_id || null,
      durationMs: payload.durationMs || payload.duration_ms || payload.data?.durationMs || payload.data?.duration_ms || null,
    };
  }
}

export function createSrBoxVerificationExecutor(config = {}) {
  const client = new SrBoxVerificationClient(config);
  return (request) => client.execute(request);
}

export function mapCountryToSrRoute(country) {
  const normalized = String(country || "").trim().toLowerCase();
  const aliases = {
    cn: "cn",
    china: "cn",
    id: "id",
    ine: "id",
    indonesia: "id",
    mx: "mx",
    mexico: "mx",
    ph: "ph",
    philippines: "ph",
    pk: "pk",
    pakistan: "pk",
    th: "th",
    thailand: "th",
  };
  const route = aliases[normalized];
  if (!route) {
    throw new Error(`Unsupported SR Box country route: ${country || "(empty)"}`);
  }
  return route;
}

export function assertReadOnlySql(sql) {
  const text = String(sql || "").trim();
  if (!text) {
    throw new Error("Verification SQL is required");
  }

  const normalized = stripCommentsAndQuotedText(text);
  const withoutTrailingSemicolon = normalized.replace(/;\s*$/, "");
  if (withoutTrailingSemicolon.includes(";")) {
    throw new Error("Verification SQL must contain exactly one read-only statement");
  }
  if (!READ_ONLY_START.test(withoutTrailingSemicolon.trim())) {
    throw new Error("Verification SQL must start with SELECT, WITH, SHOW, DESC, DESCRIBE, or EXPLAIN");
  }
  const safetyScan = withoutTrailingSemicolon.replace(/^\s*show\s+create\s+(table|view)\b/i, "SHOW_OBJECT_DEFINITION");
  if (FORBIDDEN_SQL.test(safetyScan)) {
    throw new Error("Verification SQL contains a forbidden mutating statement");
  }

  return text;
}

function stripCommentsAndQuotedText(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n\r]*/g, " ")
    .replace(/'(?:''|\\'|[^'])*'/g, "''")
    .replace(/"(?:\\"|[^"])*"/g, "\"\"");
}

function parseJsonOutput(value) {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function extractRows(payload) {
  const candidates = [
    payload?.rows,
    payload?.data?.rows,
    payload?.result?.rows,
    payload?.result?.data?.rows,
    payload?.data?.result?.rows,
  ];
  return candidates.find(Array.isArray) || [];
}

function expandHome(value) {
  const text = String(value || "");
  if (text === "~") {
    return os.homedir();
  }
  if (text.startsWith("~/")) {
    return path.join(os.homedir(), text.slice(2));
  }
  return text;
}

function resolveEnvString(value) {
  return String(value || "").replace(/\$\{([^}]+)\}/g, (_, key) => process.env[key] || "");
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}
