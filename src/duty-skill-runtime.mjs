import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  assertReadOnlySql,
  mapCountryToSrRoute,
} from "./sr-box-verification-client.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_BASE_URL = "https://data-map-dev.kuainiu.io";
const DEFAULT_TIMEOUT_SECONDS = 60;
const DEFAULT_PAGE_SIZE = 100;
const SESSION_REQUIRED_ACTIONS = new Set(["catalog", "permissions", "whoami", "execute"]);
const SUPPORTED_ACTIONS = new Set(["health", "sso-status", ...SESSION_REQUIRED_ACTIONS]);

export class DutySkillRuntime {
  constructor({
    rootDir = process.cwd(),
    pythonExecutable = process.env.SR_BOX_PYTHON || "python3",
    baseUrl = process.env.FUXI_BASE_URL || DEFAULT_BASE_URL,
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
    execFileFn = execFileAsync,
  } = {}) {
    this.rootDir = rootDir;
    this.fullBundleRoot = path.join(rootDir, "runtime/skills/full/sr-dev");
    this.srBoxRoot = path.join(rootDir, "runtime/skills/standalone/sr_box");
    this.srBoxScript = path.join(this.srBoxRoot, "scripts/sr_gateway_client.py");
    this.pythonExecutable = String(pythonExecutable || "python3");
    this.baseUrl = String(baseUrl || DEFAULT_BASE_URL);
    this.timeoutSeconds = positiveInteger(timeoutSeconds, DEFAULT_TIMEOUT_SECONDS);
    this.execFileFn = execFileFn;
  }

  async getStatus() {
    const [skills, packs, scriptAvailable] = await Promise.all([
      listNamedDirectories(path.join(this.fullBundleRoot, "skills"), "SKILL.md"),
      listYamlNames(path.join(this.fullBundleRoot, "skill-packs/packs")),
      fileExists(this.srBoxScript),
    ]);

    let sso = {
      configured: false,
      valid: false,
      source: "unavailable",
      user: null,
      error: null,
    };
    if (scriptAvailable) {
      try {
        sso = summarizeSsoStatus(await this.invoke(["sso", "status"]));
      } catch (error) {
        sso.error = error.message;
      }
    }

    return {
      available: scriptAvailable && skills.length > 0,
      fullBundle: {
        available: skills.length > 0,
        skillCount: skills.length,
        skills,
        packCount: packs.length,
        packs,
      },
      srBox: {
        available: scriptAvailable,
        baseUrl: this.baseUrl,
        script: "runtime/skills/standalone/sr_box/scripts/sr_gateway_client.py",
        supportedCountries: ["cn", "id", "mx", "ph", "pk", "th"],
        allowedActions: [...SUPPORTED_ACTIONS],
        readOnlyOnly: true,
        sso,
      },
    };
  }

  async runSrBoxAction(input = {}) {
    const action = String(input.action || "").trim().toLowerCase();
    if (!SUPPORTED_ACTIONS.has(action)) {
      throw runtimeError(400, `Unsupported SR Box action: ${action || "(empty)"}`);
    }
    if (!await fileExists(this.srBoxScript)) {
      throw runtimeError(503, "Bundled SR Box runtime is unavailable");
    }

    if (SESSION_REQUIRED_ACTIONS.has(action)) {
      const session = summarizeSsoStatus(await this.invoke(["sso", "status"]));
      if (!session.valid) {
        throw runtimeError(
          409,
          "SR Box SSO session is not ready",
          ["请先在值班系统部署主机执行 runtime/skills/standalone/sr_box/scripts/sr_gateway_client.py sso login。"],
        );
      }
    }

    const args = buildSrBoxArgs(action, input, {
      baseUrl: this.baseUrl,
      pageSize: positiveInteger(input.pageSize, DEFAULT_PAGE_SIZE),
      timeoutSeconds: positiveInteger(input.timeoutSeconds, this.timeoutSeconds),
    });
    const result = await this.invoke(args);
    return {
      ok: result?.success !== false,
      action,
      executedAt: new Date().toISOString(),
      result: redactSecrets(result),
    };
  }

  async invoke(args) {
    let stdout;
    let stderr;
    try {
      ({ stdout, stderr } = await this.execFileFn(
        this.pythonExecutable,
        [this.srBoxScript, ...args],
        {
          env: process.env,
          maxBuffer: 10 * 1024 * 1024,
          timeout: (this.timeoutSeconds + 15) * 1000,
        },
      ));
    } catch (error) {
      const payload = parseJsonOutput(error.stdout);
      const detail = payload?.message || payload?.error || String(error.stderr || error.message || error);
      throw runtimeError(502, `SR Box command failed: ${detail}`.slice(0, 1600));
    }

    const payload = parseJsonOutput(stdout);
    if (!payload) {
      throw runtimeError(502, `SR Box returned invalid JSON: ${String(stderr || stdout || "").slice(0, 500)}`);
    }
    if (payload.success === false) {
      throw runtimeError(502, payload.message || payload.error || "SR Box command failed");
    }
    return payload;
  }
}

export function createDutySkillRuntime(options = {}) {
  return new DutySkillRuntime(options);
}

function buildSrBoxArgs(action, input, options) {
  if (action === "health") {
    return ["health", "--base-url", options.baseUrl];
  }
  if (action === "sso-status") {
    return ["sso", "status"];
  }
  if (action === "whoami") {
    return ["sso", "whoami", "--base-url", options.baseUrl];
  }
  if (action === "permissions") {
    const country = mapCountryToSrRoute(input.country || "cn");
    return [
      "permissions",
      "--base-url",
      options.baseUrl,
      "--country",
      country,
      "--purpose",
      "duty-skill-runtime",
      "--access-mode",
      "remote",
    ];
  }
  if (action === "catalog") {
    return ["catalog", "--base-url", options.baseUrl];
  }

  const country = mapCountryToSrRoute(input.country || "cn");
  const sql = assertReadOnlySql(input.sql);
  return [
    "execute",
    "--base-url",
    options.baseUrl,
    "--country",
    country,
    "--access-mode",
    "remote",
    "--purpose",
    "duty-skill-runtime",
    "--sql-mode",
    "query",
    "--task-name",
    "duty-platform-sr-box",
    "--sql",
    sql,
    "--page-size",
    String(options.pageSize),
    "--timeout-sec",
    String(options.timeoutSeconds),
  ];
}

function summarizeSsoStatus(payload = {}) {
  return {
    configured: payload.configured === true,
    valid: payload.valid === true,
    source: payload.source || "none",
    expiresAt: payload.expiresAt || null,
    lastAccessedAt: payload.lastAccessedAt || null,
    user: payload.user
      ? {
          displayName: payload.user.displayName || null,
          email: payload.user.email || null,
          srUser: payload.user.srUser || null,
        }
      : null,
    error: null,
  };
}

async function listNamedDirectories(root, requiredFile) {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const names = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (await fileExists(path.join(root, entry.name, requiredFile))) {
        names.push(entry.name);
      }
    }
    return names.sort();
  } catch {
    return [];
  }
}

async function listYamlNames(root) {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
      .map((entry) => entry.name.replace(/\.yaml$/, ""))
      .sort();
  } catch {
    return [];
  }
}

async function fileExists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function parseJsonOutput(value) {
  const text = String(value || "").trim();
  if (!text) return null;
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

function redactSecrets(value) {
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (/(authorization|cookie|password|secret|sessionpreview|token)/i.test(key)) {
      return [key, item == null || item === "" ? item : "[REDACTED]"];
    }
    return [key, redactSecrets(item)];
  }));
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function runtimeError(statusCode, message, errors = undefined) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.errors = errors;
  return error;
}
