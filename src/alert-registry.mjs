/**
 * 告警注册表（Alert Registry）。
 *
 * 把 n8n / 夜莺等来源的告警抽象为可配置条目，支持动态新增 / 编辑 / 删除，
 * 以及"测试执行"（SSH 到目标机跑 dry-run，或本地执行任意命令）。
 *
 * 持久化：config/alert-registry.json（运行时文件，已 gitignore）。
 * 示例：config/alert-registry.example.json（入库，含 PL / 墨西哥 / 投放 DWD 三个预置条目）。
 *
 * 条目结构：
 *   {
 *     "id": "pl_global_consistency",
 *     "name": "PL 全球损益对账",
 *     "country": "CN",
 *     "sourceType": "n8n | nightingale | custom",
 *     "n8nWorkflowId": "O2Ppfn5GgtAJVKsD",
 *     "trigger": "webhook | schedule | manual",
 *     "webhookPath": "CWSJJY",
 *     "command": "cd /root/starrocks-pl-monitor-tv-alert && python3 alert/run_alert.py --alert fin_ods_quality --dry-run",
 *     "runVia": "ssh | local",
 *     "sshHost": "root@10.20.47.14",
 *     "sshPort": 36000,
 *     "mentions": "adamyu@kn.group,gretchenhe@kn.group",
 *     "enabled": true,
 *     "note": ""
 *   }
 */
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { deepMapStrings, loadEnvFile, readJsonFile, writeJsonFileAtomic } from "./utils.mjs";
import { fetchCompatible } from "./fetch-compatible.mjs";
import { createAlertScriptTemplate } from "./alert-script-template.mjs";

const DEFAULT_CONFIG_FILE = "config/alert-registry.json";
const EXAMPLE_CONFIG_FILE = "config/alert-registry.example.json";
const MULTI_COUNTRY_RESULTS_FILE = "config/multi-country-check-results.json";
const DEFAULT_MULTI_COUNTRY_RESULTS = { runs: [] };
const MULTI_COUNTRY_RESULTS_KEEP = 200;
const DEFAULT_TEST_TIMEOUT_MS = 90_000;
const DEFAULT_SSH_HOST = "root@10.20.47.14";
const DEFAULT_SSH_PORT = 36000;

const ENV_PATTERN = /\$\{([A-Z0-9_]+)\}/g;

/** 内联环境变量占位 ${KEY}。 */
function resolveEnv(value) {
  if (typeof value !== "string") {
    return value;
  }
  return value.replace(ENV_PATTERN, (_, key) => process.env[key] ?? "");
}

function toId(name) {
  const base = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return base || `alert_${randomUUID().slice(0, 8)}`;
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeEntry(entry, index = 0) {
  const raw = entry && typeof entry === "object" ? entry : {};
  const id = String(raw.id || "").trim() || toId(raw.name || `alert_${index + 1}`);
  return {
    id,
    name: String(raw.name || raw.id || id),
    country: String(raw.country || ""),
    sourceType: String(raw.sourceType || "custom"),
    n8nWorkflowId: String(raw.n8nWorkflowId || ""),
    trigger: String(raw.trigger || "manual"),
    webhookPath: String(raw.webhookPath || ""),
    command: String(raw.command || ""),
    runVia: String(raw.runVia || "local"),
    sshHost: String(raw.sshHost || DEFAULT_SSH_HOST),
    sshPort: raw.sshPort != null ? Number(raw.sshPort) : DEFAULT_SSH_PORT,
    mentions: String(raw.mentions || ""),
    enabled: raw.enabled !== false,
    note: String(raw.note || ""),
    // 校验语句 / 脚本模板相关
    templateName: String(raw.templateName || ""),
    sqlBlocks: raw.sqlBlocks && typeof raw.sqlBlocks === "object"
      ? Object.fromEntries(Object.entries(raw.sqlBlocks).map(([k, v]) => [k, String(v).replace(/^\n+|\n+$/g, "")]))
      : {},
    scriptPath: String(raw.scriptPath || ""),
    remoteScriptPath: String(raw.remoteScriptPath || ""),
    repoDir: String(raw.repoDir || ""),
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/** 通过 n8n 的 SSH 测试 webhook 在目标机执行命令，返回 { stdout, stderr, exitCode, ok }。 */
async function runViaN8n(command, { sshHost, sshPort, timeoutMs } = {}) {
  const base = process.env.N8N_BASE_URL || "";
  const webhookPath = process.env.N8N_SSH_TEST_WEBHOOK || "alert-registry-ssh-test";
  if (!base) {
    return {
      stdout: "",
      stderr: "未配置 N8N_BASE_URL，无法通过 n8n 执行远程 SSH 测试",
      exitCode: -1,
      ok: false,
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TEST_TIMEOUT_MS);
  try {
    const resp = await fetchCompatible(`${base}/webhook/${webhookPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        host: sshHost || DEFAULT_SSH_HOST,
        port: sshPort || DEFAULT_SSH_PORT,
        command,
      }),
      signal: controller.signal,
    });
    const data = await resp.json().catch(() => ({}));
    const exitCode = typeof data.code === "number" ? data.code : (resp.ok ? 0 : -1);
    return {
      stdout: String(data.stdout || ""),
      stderr: String(data.stderr || ""),
      exitCode,
      ok: resp.ok && exitCode === 0,
    };
  } catch (error) {
    const aborted = error && error.name === "AbortError";
    return {
      stdout: "",
      stderr: aborted ? `SSH 测试超时（${timeoutMs || DEFAULT_TEST_TIMEOUT_MS}ms）` : String(error && error.message || error),
      exitCode: -1,
      ok: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 在目标机执行命令（ssh | local），返回 { stdout, stderr, exitCode, ok }。 */
function runCommandSync(runVia, command, options = {}) {
  // ssh 方式统一走 n8n SSH 测试 webhook（本机/生产机系统 ssh 常无法直连目标机）
  if (runVia === "ssh") {
    return runViaN8n(command, options);
  }
  const { timeoutMs } = options;
  return new Promise((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TEST_TIMEOUT_MS);
    let child;
    try {
      child = spawn(command, {
        shell: true,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      resolve({ stdout: "", stderr: String(error && error.message || error), exitCode: -1, ok: false });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: `${stderr}\n${String(error && error.message || error)}`.trim(), exitCode: -1, ok: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code == null ? -1 : code, ok: code === 0 });
    });
  });
}

export function createAlertRegistry({ rootDir = process.cwd(), configFile } = {}) {
  const resolve = (name) => path.join(rootDir, name);

  async function registryPath() {
    await loadEnvFile(path.join(rootDir, ".env"));
    return resolve(configFile || DEFAULT_CONFIG_FILE);
  }

  async function load() {
    const file = await registryPath();
    const raw = await readJsonFile(file, { alerts: [] });
    const alerts = ensureArray(raw.alerts || raw).map(normalizeEntry).map((entry) => ({
      ...entry,
      repoDir: resolveEnv(entry.repoDir),
    }));
    return {
      file,
      alerts,
    };
  }

  async function save(alerts) {
    const file = await registryPath();
    await writeJsonFileAtomic(file, { alerts });
    return alerts;
  }

  async function list() {
    const { alerts } = await load();
    return alerts;
  }

  async function get(id) {
    const { alerts } = await load();
    return alerts.find((item) => item.id === id) || null;
  }

  /** 从环境变量 / example 文件注入缺失的条目。首次运行把 example 预置条目合并进来。 */
  async function seedExamples() {
    const { alerts } = await load();
    let exampleAlerts = [];
    try {
      const exampleFile = resolve(EXAMPLE_CONFIG_FILE);
      const example = await readJsonFile(exampleFile, null);
      exampleAlerts = ensureArray(example && example.alerts || example);
    } catch {
      exampleAlerts = [];
    }
    if (!exampleAlerts.length) return alerts;
    const existingById = new Map(alerts.map((item) => [item.id, item]));
    // 新增：example 中有但注册表中没有的条目
    const toAdd = exampleAlerts
      .map(normalizeEntry)
      .filter((item) => !existingById.has(item.id));
    // 补字段：example 中已存在条目，用 example 的值补充缺失字段（用户已有值优先）
    let changed = false;
    const next = alerts.map((item) => {
      const example = exampleAlerts.find((e) => (e.id || e.name) === item.id);
      if (!example) return item;
      const exampleNorm = normalizeEntry(example);
      let dirty = false;
      const merged = { ...item };
      for (const key of ["templateName", "scriptPath", "remoteScriptPath", "repoDir"]) {
        const exValue = exampleNorm[key] || "";
        if (!merged[key] && exValue) {
          merged[key] = exValue;
          dirty = true;
        }
      }
      // sqlBlocks：仅当条目尚未配置任何块时，用 example 的块填充
      if (!Object.keys(merged.sqlBlocks || {}).length && Object.keys(exampleNorm.sqlBlocks || {}).length) {
        merged.sqlBlocks = exampleNorm.sqlBlocks;
        dirty = true;
      }
      if (dirty) {
        merged.updatedAt = new Date().toISOString();
        changed = true;
        return merged;
      }
      return item;
    });
    if (toAdd.length) next.push(...toAdd);
    if (toAdd.length || changed) {
      await save(next);
      return next;
    }
    return next;
  }

  async function create(input) {
    const { alerts } = await load();
    const entry = normalizeEntry(input);
    if (alerts.some((item) => item.id === entry.id)) {
      throw Object.assign(new Error(`告警条目已存在：${entry.id}`), { statusCode: 409 });
    }
    const next = [...alerts, entry];
    await save(next);
    return entry;
  }

  async function update(id, input) {
    const { alerts } = await load();
    const index = alerts.findIndex((item) => item.id === id);
    if (index === -1) {
      throw Object.assign(new Error(`告警条目不存在：${id}`), { statusCode: 404 });
    }
    const merged = normalizeEntry({ ...alerts[index], ...input, id, updatedAt: new Date().toISOString() });
    alerts[index] = merged;
    await save(alerts);
    return merged;
  }

  async function remove(id) {
    const { alerts } = await load();
    const next = alerts.filter((item) => item.id !== id);
    if (next.length === alerts.length) {
      throw Object.assign(new Error(`告警条目不存在：${id}`), { statusCode: 404 });
    }
    await save(next);
    return { ok: true, id };
  }

  async function setEnabled(id, enabled) {
    return update(id, { enabled: Boolean(enabled) });
  }

  /** 测试执行：按条目的 runVia/command 跑 dry-run，返回 stdout/stderr/exitCode。 */
  async function runTest(id, { timeoutMs } = {}) {
    const entry = await get(id);
    if (!entry) {
      throw Object.assign(new Error(`告警条目不存在：${id}`), { statusCode: 404 });
    }
    if (!entry.command) {
      throw Object.assign(new Error(`告警条目 ${entry.name} 未配置 command`), { statusCode: 400 });
    }
    const command = resolveEnv(entry.command);
    const result = await runCommandSync(entry.runVia || "local", command, {
      sshHost: entry.sshHost,
      sshPort: entry.sshPort,
      timeoutMs,
    });
    return { ...result, id, name: entry.name };
  }

  /** 任意命令测试：不落库，直接跑，用于新增条目前验证。 */
  async function runTestByCommand({ runVia, command, sshHost, sshPort, timeoutMs } = {}) {
    if (!command) {
      throw Object.assign(new Error("command 不能为空"), { statusCode: 400 });
    }
    const resolvedCommand = resolveEnv(command);
    const result = await runCommandSync(runVia || "local", resolvedCommand, {
      sshHost,
      sshPort,
      timeoutMs,
    });
    return { ...result, command: resolvedCommand };
  }

  // 脚本模板引擎（校验语句合成 + 部署 + git）
  const template = createAlertScriptTemplate({ rootDir });

  /** 渲染脚本预览（不落盘）。返回渲染内容 + 与仓库当前脚本 diff。 */
  async function previewScript(id) {
    const entry = await get(id);
    if (!entry) {
      throw Object.assign(new Error(`告警条目不存在：${id}`), { statusCode: 404 });
    }
    return template.previewUpdate(entry);
  }

  /** 全链路更新代码：渲染 → 写仓库 → git commit+push → SSH 部署目标机。 */
  async function applyScript(id, { commitMessage, skipGit, skipDeploy } = {}) {
    const entry = await get(id);
    if (!entry) {
      throw Object.assign(new Error(`告警条目不存在：${id}`), { statusCode: 404 });
    }
    return template.applyUpdate(entry, { commitMessage, skipGit, skipDeploy });
  }

  // ---- 多国一致性校验结果（保留最近 7 次） ----

  async function resultsPath() {
    await loadEnvFile(path.join(rootDir, ".env"));
    return resolve(MULTI_COUNTRY_RESULTS_FILE);
  }

  async function loadResults() {
    const file = await resultsPath();
    return readJsonFile(file, DEFAULT_MULTI_COUNTRY_RESULTS);
  }

  /** 读取最近 7 次多国校验结果（最新在前）。 */
  async function listCheckResults() {
    const data = await loadResults();
    return data.runs || [];
  }

  /**
   * 追加一次多国校验结果，保留最近 7 次（超出的旧记录丢弃）。
   * result: { checkedAt?, id?, countries: [{code, label, mismatches: [{check_item, mismatch_cnt}]}], hasAlert, hasError, text? }
   */
  async function appendCheckResult(result = {}) {
    const data = await loadResults();
    const run = {
      id: result.id || randomUUID(),
      checkedAt: result.checkedAt || new Date().toISOString(),
      source: result.source || "multi-country",
      countries: Array.isArray(result.countries) ? result.countries : [],
      hasAlert: Boolean(result.hasAlert),
      hasError: Boolean(result.hasError),
      text: result.text || "",
      summary: result.summary || null,
    };
    const runs = [run, ...(data.runs || [])].slice(0, MULTI_COUNTRY_RESULTS_KEEP);
    await writeJsonFileAtomic(await resultsPath(), { runs });
    return { ok: true, kept: runs.length, limit: MULTI_COUNTRY_RESULTS_KEEP, run };
  }

  return {
    list,
    get,
    create,
    update,
    remove,
    setEnabled,
    runTest,
    runTestByCommand,
    previewScript,
    applyScript,
    seedExamples,
    normalizeEntry,
    resolveEnv,
    listCheckResults,
    appendCheckResult,
  };
}
