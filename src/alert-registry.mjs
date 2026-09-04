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
const MC_SCHEDULE_FILE = "config/mc-schedule.json";
const DEFAULT_MC_SCHEDULE = { minute: 55 };
const MC_WORKFLOW_ID = "E4B4wNzcUG0ow6BL"; // 多国一致性校验告警
const MC_SCHEDULE_TRIGGER_NODE = "每小时定时触发";
// 多国校验 · 电话通知配置（国家 -> 联系人 + 通知开关 + 电话阈值）
const MC_NOTIFY_FILE = "config/mc-notify.json";
const MC_STRIKE_FILE = "config/mc-strike.json";
const MC_COUNTRIES = ["cn", "id", "mx", "th", "ph", "pk"];
// 通用条目能力：每条目自己的历史记录（config/alerts-history/<id>.json），最近 N 次
const ENTRY_HISTORY_DIR = "config/alerts-history";
const ENTRY_HISTORY_KEEP = 200;
const DEFAULT_ENTRY_HISTORY = { runs: [] };
const DEFAULT_MC_NOTIFY = {
  countries: {
    cn: { contacts: [], phone: true, group: true, strikeThreshold: 6 },
    id: { contacts: [], phone: true, group: true, strikeThreshold: 6 },
    mx: { contacts: [], phone: true, group: true, strikeThreshold: 6 },
    th: { contacts: [], phone: true, group: true, strikeThreshold: 6 },
    ph: { contacts: [], phone: true, group: true, strikeThreshold: 6 },
    pk: { contacts: [], phone: true, group: true, strikeThreshold: 6 },
  },
};
const DEFAULT_TEST_TIMEOUT_MS = 25_000;
const DEFAULT_SSH_HOST = "root@10.20.47.14";
const DEFAULT_SSH_PORT = 36000;

// 多国校验 · 发送群配置（群 chat id + 各国家负责人 @ 清单，有报警时在通知末尾 @ 对应负责人）
// 负责人默认留空，由用户在页面「通知配置」里自行填写。
const MC_GROUP_FILE = "config/mc-group.json";
const DEFAULT_MC_GROUP = {
  chatId: -1073807215,
  owners: {
    cn: [],
    id: [],
    mx: [],
    th: [],
    ph: [],
    pk: [],
  },
};

// 多国校验 · 电话语音配置（阿里云语音 dyvmsapi SingleCallByTts）
// 电话语音配置：accessKeyId/accessKeySecret 请通过 config/mc-voice.json 或 ALIBABA_VOICE_* 环境变量提供，避免入仓。
const MC_VOICE_FILE = "config/mc-voice.json";
const DEFAULT_MC_VOICE = {
  enabled: true,
  accessKeyId: "${ALIBABA_VOICE_ACCESS_KEY_ID}",
  accessKeySecret: "${ALIBABA_VOICE_ACCESS_KEY_SECRET}",
  calledShowNumber: "02160556003",
  ttsCode: "TTS_160301133",
  nameTemplate: "{{label}}多国一致性校验",
  systemTemplate: "检测到{{n}}项数据异常，请及时处理",
};

const ENV_PATTERN = /\$\{([A-Z0-9_]+)\}/g;

/** 内联环境变量占位 ${KEY}。 */
function resolveEnv(value) {
  if (typeof value !== "string") {
    return value;
  }
  return value.replace(ENV_PATTERN, (_, key) => process.env[key] ?? "");
}

/** 把 {{var}} 模板替换为变量值。 */
function fillTemplate(tpl, vars) {
  return String(tpl || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) =>
    vars && vars[key] !== undefined ? String(vars[key]) : ""
  );
}

/** 密钥打码显示（保留前 4 后 4）。 */
function maskSecret(s) {
  const str = String(s || "");
  if (str.length <= 8) return "****";
  return `${str.slice(0, 4)}****${str.slice(-4)}`;
}

/** 返回去空格后的非空字符串，否则空串。 */
function nonEmpty(v) {
  return typeof v === "string" ? v.trim() : "";
}

/** 从 cron 表达式提取分钟（如 "55 * * * *" → 55；步进/范围表达式返回 null）。 */
function parseCronMinute(cron) {
  const m = /^(\d{1,2})\s+\*\s+\*\s+\*\s+\*$/.exec(String(cron || "").trim());
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isInteger(v) && v >= 0 && v <= 59 ? v : null;
}

/**
 * 阿里云语音通知（dyvmsapi SingleCallByTts）RPC 调用。
 * voice: { accessKeyId, accessKeySecret, calledShowNumber, ttsCode }
 * ttsParam: { name, system } → 模板参数，即电话播报内容
 */
async function callAliyunVoice(voice, calledNumber, ttsParam = {}) {
  const { createHmac, randomBytes } = await import("node:crypto");
  const percentEncode = (s) => encodeURIComponent(String(s)).replace(/\+/g, "%20").replace(/\*/g, "%2A").replace(/%7E/g, "~");
  const params = {
    Action: "SingleCallByTts",
    Version: "2017-05-25",
    Format: "JSON",
    AccessKeyId: voice.accessKeyId,
    SignatureMethod: "HMAC-SHA1",
    SignatureNonce: randomBytes(16).toString("hex"),
    SignatureVersion: "1.0",
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    CalledNumber: calledNumber,
    CalledShowNumber: voice.calledShowNumber,
    TtsCode: voice.ttsCode,
    TtsParam: JSON.stringify(ttsParam),
  };
  const keys = Object.keys(params).sort();
  const canonical = keys.map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`).join("&");
  const stringToSign = `GET&%2F&${percentEncode(canonical)}`;
  const sig = createHmac("sha1", `${voice.accessKeySecret}&`).update(stringToSign).digest("base64");
  const query = `${canonical}&Signature=${percentEncode(sig)}`;
  const url = `https://dyvmsapi.aliyuncs.com/?${query}`;
  const resp = await fetchCompatible(url, { method: "GET", timeout: 15000 });
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    return { Code: "PARSE_ERROR", Message: text.slice(0, 200) };
  }
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
    // 通用通知配置（每个条目自己的群 / @负责人 / 电话联系人 / 开关 / 阈值）
    notify: raw.notify && typeof raw.notify === "object"
      ? {
          chatId: raw.notify.chatId != null ? Number(raw.notify.chatId) : null,
          owners: Array.isArray(raw.notify.owners) ? raw.notify.owners.map(String) : [],
          contacts: Array.isArray(raw.notify.contacts) ? raw.notify.contacts.map(String) : [],
          phone: raw.notify.phone !== false,
          group: raw.notify.group !== false,
          strikeThreshold: Number.isInteger(raw.notify.strikeThreshold) ? raw.notify.strikeThreshold : 6,
        }
      : null,
    // 通用电话语音配置（null = 用全局默认语音配置）
    voice: raw.voice && typeof raw.voice === "object"
      ? {
          enabled: raw.voice.enabled !== false,
          ttsCode: String(raw.voice.ttsCode || ""),
          nameTemplate: String(raw.voice.nameTemplate || ""),
          systemTemplate: String(raw.voice.systemTemplate || ""),
        }
      : null,
    // 通用定时配置（trigger=schedule 时有效；cron 表达式）
    schedule: raw.schedule && typeof raw.schedule === "object" && String(raw.schedule.cron || "").trim()
      ? { cron: String(raw.schedule.cron).trim() }
      : null,
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
async function runViaN8n(command, { sshHost, sshPort, timeoutMs } = {}) {  const base = process.env.N8N_BASE_URL || "";
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

/**
 * 通过 n8n webhook 触发条目绑定的工作流（推荐通道：n8n 内部配好了访问目标机的凭据，
 * 平台直连各国网段常不可达）。返回 { ok, triggered, workflowId, webhookPath, message, note }。
 */
async function triggerN8nWorkflow({ workflowId, webhookPath, payload = {}, timeoutMs } = {}) {
  const base = process.env.N8N_BASE_URL || "";
  if (!base) {
    return { ok: false, triggered: false, error: "未配置 N8N_BASE_URL，无法调用 n8n 工作流" };
  }
  // 未显式给 webhookPath 时，尝试按 workflowId 解析（目前只有多国校验工作流有对应 webhook）
  let path = webhookPath;
  if (!path && workflowId === MC_WORKFLOW_ID) {
    path = "znzb-mc-verify-v4";
  }
  if (!path) {
    return {
      ok: false,
      triggered: false,
      error: `条目未配置 webhookPath，且 n8n 工作流 ${workflowId || "?"} 无已知 webhook，无法触发测试`,
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TEST_TIMEOUT_MS);
  try {
    const resp = await fetchCompatible(`${base}/webhook/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return {
        ok: false,
        triggered: false,
        workflowId,
        webhookPath: path,
        error: `n8n 工作流触发失败（HTTP ${resp.status}）：${String(data.message || "")}`,
      };
    }
    // n8n webhook 通常异步返回 "Workflow was started"
    const started = Boolean(data.message) || resp.ok;
    return {
      ok: started,
      triggered: started,
      workflowId,
      webhookPath: path,
      message: String(data.message || "已触发"),
      note: "已通过 n8n 触发对应工作流执行；校验结果会由工作流回写平台（多国校验看「校验结果」，其他条目看 n8n 执行历史）",
    };
  } catch (error) {
    const aborted = error && error.name === "AbortError";
    return {
      ok: false,
      triggered: false,
      workflowId,
      webhookPath: path,
      error: aborted
        ? `n8n 工作流触发超时（${timeoutMs || DEFAULT_TEST_TIMEOUT_MS}ms）`
        : String(error && error.message || error),
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
      // 多国校验条目统一关联 n8n 工作流（页面启停 = 开关工作流定时任务）
      n8nWorkflowId: entry.n8nWorkflowId || (entry.id.startsWith("mc_") ? MC_WORKFLOW_ID : ""),
      // 多国校验条目由共享 n8n 工作流定时触发（cron 55 * * * *），触发方式应为「定时」
      trigger: entry.id.startsWith("mc_") ? "schedule" : entry.trigger,
      repoDir: resolveEnv(entry.repoDir),
    }));
    return {
      file,
      alerts,
    };
  }

  async function save(alerts) {
    const file = await registryPath();
    // 多国校验条目触发方式统一为「定时」（共享 n8n 工作流定时触发），防止页面编辑覆盖成 manual
    const normalized = alerts.map((entry) => ({
      ...entry,
      trigger: String(entry.id || "").startsWith("mc_") ? "schedule" : entry.trigger,
    }));
    await writeJsonFileAtomic(file, { alerts: normalized });
    return normalized;
  }

  // ================= 通用条目能力（通知 / 语音 / 定时 / 历史） =================
  // 每个条目一份独立配置与历史：config/alerts/<id>.json
  //   { notify: {chatId, owners[], contacts[], phone, group, strikeThreshold},
  //     voice: {enabled, ttsCode, nameTemplate, systemTemplate} | null,
  //     schedule: {cron} | null,
  //     strikes: {countryCode: count},
  //     history: {runs: [...]} }
  // mc_* 条目向后兼容：notify→mc-notify.json+mc-group.json，voice→mc-voice.json，
  // schedule→mc-schedule.json，history→multi-country-check-results.json（按国家过滤）。

  async function entryDataPath(id) {
    await loadEnvFile(path.join(rootDir, ".env"));
    const safe = toId(id || "entry");
    return resolve(path.join("config", "alerts", `${safe}.json`));
  }

  async function loadEntryData(id) {
    const file = await entryDataPath(id);
    return readJsonFile(file, {});
  }

  async function saveEntryData(id, data) {
    const file = await entryDataPath(id);
    await writeJsonFileAtomic(file, data);
    return data;
  }

  const isMcEntry = (id) => String(id || "").startsWith("mc_") || String(id || "").startsWith("mc-");

  /** 读取条目通知配置。普通条目用内嵌 notify + 独立文件；mc_* 用 mc-notify.json + mc-group.json（按国家）。 */
  async function getEntryNotify(id) {
    const entry = await get(id).catch(() => null);
    if (isMcEntry(id)) {
      const [notify, group] = await Promise.all([loadMcNotify(), loadMcGroup()]);
      const code = String(id).replace(/^mc_?/, "").toLowerCase();
      const c = notify.countries[code] || {};
      return {
        chatId: group.chatId != null ? group.chatId : null,
        owners: Array.isArray(group.owners[code]) ? group.owners[code].map(String) : [],
        contacts: Array.isArray(c.contacts) ? c.contacts.map(String) : [],
        phone: c.phone !== false,
        group: c.group !== false,
        strikeThreshold: Number.isInteger(c.strikeThreshold) ? c.strikeThreshold : 6,
      };
    }
    const data = await loadEntryData(id);
    const n = data.notify || (entry && entry.notify) || {};
    return {
      chatId: n.chatId != null ? Number(n.chatId) : null,
      owners: Array.isArray(n.owners) ? n.owners.map(String) : [],
      contacts: Array.isArray(n.contacts) ? n.contacts.map(String) : [],
      phone: n.phone !== false,
      group: n.group !== false,
      strikeThreshold: Number.isInteger(n.strikeThreshold) ? n.strikeThreshold : 6,
    };
  }

  /** 保存条目通知配置。 */
  async function setEntryNotify(id, cfg = {}) {
    if (isMcEntry(id)) {
      const code = String(id).replace(/^mc_?/, "").toLowerCase();
      const [notify, group] = await Promise.all([loadMcNotify(), loadMcGroup()]);
      const n = cfg.notify || cfg || {};
      notify.countries[code] = {
        contacts: Array.isArray(n.contacts) ? n.contacts.map(String).slice(0, 20) : [],
        phone: n.phone !== false,
        group: n.group !== false,
        strikeThreshold: Number.isInteger(Number(n.strikeThreshold)) ? Math.max(1, Math.min(99, Number(n.strikeThreshold))) : 6,
      };
      await writeJsonFileAtomic(await notifyPath(), notify);
      if (n.chatId != null) {
        group.chatId = Number(n.chatId);
      }
      if (Array.isArray(n.owners)) {
        group.owners[code] = n.owners.map(String).slice(0, 20);
      }
      await writeJsonFileAtomic(await groupPath(), group);
      return getEntryNotify(id);
    }
    const data = await loadEntryData(id);
    const cur = await getEntryNotify(id);
    data.notify = {
      chatId: cfg.chatId != null ? Number(cfg.chatId) : cur.chatId,
      owners: Array.isArray(cfg.owners) ? cfg.owners.map(String).slice(0, 20) : cur.owners,
      contacts: Array.isArray(cfg.contacts) ? cfg.contacts.map(String).slice(0, 20) : cur.contacts,
      phone: cfg.phone !== undefined ? cfg.phone !== false : cur.phone,
      group: cfg.group !== undefined ? cfg.group !== false : cur.group,
      strikeThreshold: Number.isInteger(Number(cfg.strikeThreshold)) ? Math.max(1, Math.min(99, Number(cfg.strikeThreshold))) : cur.strikeThreshold,
    };
    await saveEntryData(id, data);
    return getEntryNotify(id);
  }

  /** 读取条目电话语音配置（未配置时用全局 mc-voice.json）。 */
  async function getEntryVoice(id) {
    if (isMcEntry(id)) {
      return loadMcVoice();
    }
    const data = await loadEntryData(id);
    const v = data.voice;
    if (!v || !v.ttsCode) {
      // 无独立配置 → 用全局语音配置
      const global = await loadMcVoice();
      return {
        enabled: global.enabled,
        accessKeyId: global.accessKeyId,
        accessKeySecret: global.accessKeySecret,
        calledShowNumber: global.calledShowNumber,
        ttsCode: global.ttsCode,
        nameTemplate: v && v.nameTemplate ? v.nameTemplate : global.nameTemplate,
        systemTemplate: v && v.systemTemplate ? v.systemTemplate : global.systemTemplate,
        usesGlobal: true,
      };
    }
    const global = await loadMcVoice();
    return {
      enabled: v.enabled !== false,
      accessKeyId: global.accessKeyId,
      accessKeySecret: global.accessKeySecret,
      calledShowNumber: global.calledShowNumber,
      ttsCode: v.ttsCode,
      nameTemplate: v.nameTemplate || global.nameTemplate,
      systemTemplate: v.systemTemplate || global.systemTemplate,
    };
  }

  /** 保存条目电话语音配置（只保存模板相关；凭据/显号永远用全局）。 */
  async function setEntryVoice(id, cfg = {}) {
    if (isMcEntry(id)) {
      return setMcVoice(cfg);
    }
    const data = await loadEntryData(id);
    const cur = await getEntryVoice(id);
    const v = cfg.voice || cfg || {};
    data.voice = {
      enabled: v.enabled !== undefined ? v.enabled !== false : cur.enabled,
      ttsCode: nonEmpty(v.ttsCode) || cur.ttsCode,
      nameTemplate: nonEmpty(v.nameTemplate) || cur.nameTemplate,
      systemTemplate: nonEmpty(v.systemTemplate) || cur.systemTemplate,
    };
    await saveEntryData(id, data);
    return getEntryVoice(id);
  }

  /** 读取条目定时配置。普通条目从内嵌 schedule + 独立文件；mc_* 用 mc-schedule.json。 */
  async function getEntrySchedule(id) {
    if (isMcEntry(id)) {
      const s = await loadSchedule();
      return { minute: s.minute, cron: `${s.minute} * * * *` };
    }
    const data = await loadEntryData(id);
    const s = data.schedule;
    if (s && s.cron) return { minute: parseCronMinute(s.cron), cron: s.cron };
    const entry = await get(id).catch(() => null);
    if (entry && entry.schedule && entry.schedule.cron) return { minute: parseCronMinute(entry.schedule.cron), cron: entry.schedule.cron };
    return { minute: null, cron: null };
  }

  /** 保存条目定时配置（普通条目仅本地；mc_* 同步 n8n）。cfg: { minute } 或 { cron }。 */
  async function setEntrySchedule(id, cfg = {}) {
    if (isMcEntry(id)) {
      const minute = Number(cfg.minute != null ? cfg.minute : (cfg.cron ? parseCronMinute(cfg.cron) : NaN));
      if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
        throw Object.assign(new Error("定时分钟必须是 0-59 的整数"), { statusCode: 400 });
      }
      const sync = await applyMcScheduleToN8n(minute);
      return { ok: sync.ok, minute, cron: `${minute} * * * *`, sync };
    }
    const minute = Number(cfg.minute != null ? cfg.minute : (cfg.cron ? parseCronMinute(cfg.cron) : NaN));
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
      throw Object.assign(new Error("定时分钟必须是 0-59 的整数"), { statusCode: 400 });
    }
    const data = await loadEntryData(id);
    data.schedule = { cron: `${minute} * * * *` };
    await saveEntryData(id, data);
    return { ok: true, minute, cron: `${minute} * * * *` };
  }

  /** 读取条目执行历史（最新在前）。mc_* 从多国校验结果里过滤该国；普通条目读独立文件。 */
  async function getEntryHistory(id, { limit = 50 } = {}) {
    if (isMcEntry(id)) {
      const code = String(id).replace(/^mc_?/, "").toLowerCase();
      const all = await listCheckResults();
      const runs = all.filter((r) =>
        Array.isArray(r.countries) && r.countries.some((c) => String(c.code || "").toLowerCase() === code)
      ).slice(0, limit);
      return runs;
    }
    const data = await loadEntryData(id);
    return Array.isArray(data.history && data.history.runs) ? data.history.runs.slice(0, limit) : [];
  }

  /** 追加条目执行历史（最新在前，保留最近 N 次）。普通条目独立文件；mc_* 走多国校验结果。 */
  async function appendEntryHistory(id, result = {}) {
    if (isMcEntry(id)) {
      return appendCheckResult(result);
    }
    const data = await loadEntryData(id);
    const history = data.history || { runs: [] };
    const run = {
      id: result.id || randomUUID(),
      checkedAt: result.checkedAt || new Date().toISOString(),
      source: result.source || "entry",
      hasAlert: Boolean(result.hasAlert),
      hasError: Boolean(result.hasError),
      text: result.text || "",
      summary: result.summary || null,
      detail: result.detail || null,
    };
    history.runs = [run, ...(history.runs || [])].slice(0, ENTRY_HISTORY_KEEP);
    data.history = history;
    await saveEntryData(id, data);
    return { ok: true, run, kept: history.runs.length, limit: ENTRY_HISTORY_KEEP };
  }

  /** 全量历史日志：聚合所有条目的执行记录（mc_* 取多国校验结果，普通条目取独立历史），按时间倒序。 */
  /** 全量历史日志：聚合所有条目的执行记录（mc_* 取多国校验结果，普通条目取独立历史），按时间倒序。
   *  days：只返回最近 N 天内的记录（0 / 空 = 全部）。 */
  async function listAllHistory({ limit = 200, days = 0 } = {}) {
    const { alerts } = await load();
    const cutoff = days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : 0;
    const all = [];
    await Promise.all((alerts || []).map(async (entry) => {
      try {
        const runs = await getEntryHistory(entry.id, { limit: 50 });
        for (const r of runs) {
          const ts = Date.parse(r.checkedAt || "");
          if (cutoff && (!Number.isFinite(ts) || ts < cutoff)) continue;
          all.push({
            entryId: entry.id,
            entryName: entry.name,
            country: String(entry.country || ""),
            ...r,
          });
        }
      } catch (e) {
        console.log(`[history] 读取条目 ${entry.id} 历史失败:`, String(e && e.message || e).slice(0, 150));
      }
    }));
    all.sort((a, b) => String(b.checkedAt || "").localeCompare(String(a.checkedAt || "")));
    return all.slice(0, limit);
  }

  async function list() {
    const { alerts } = await load();
    // 多国校验条目（mc_*）为单独控制：状态 = 自身 enabled（该国是否参与校验），n8n 工作流保持 active。
    return alerts.map((entry) => ({ ...entry, n8nActive: null }));
  }

  /** 读取条目描述（note 字段）。 */
  async function getEntryDescription(id) {
    const { alerts } = await load();
    const entry = alerts.find((item) => item.id === id);
    return { id, note: (entry && entry.note) || "" };
  }

  /** 更新条目描述（note 字段）。 */
  async function setEntryDescription(id, note = "") {
    const { alerts } = await load();
    const entry = alerts.find((item) => item.id === id);
    if (!entry) return { ok: false, error: "条目不存在: " + id };
    entry.note = String(note || "").trim();
    await save(alerts);
    return { ok: true, id, note: entry.note };
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
    const prev = alerts[index];
    const merged = normalizeEntry({ ...prev, ...input, id, updatedAt: new Date().toISOString() });
    // 多国校验条目（mc_*）的启停 = 单独控制该国是否参与校验；n8n 工作流保持 active，每次运行时读取启用国家列表。
    // 不做整工作流 active 同步。
    alerts[index] = merged;
    await save(alerts);
    return { ...merged, n8nSync: null, n8nActive: null };
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

  /** 查询 n8n 工作流当前 active 状态；失败返回 null（不覆盖本地 enabled）。 */
  async function getN8nWorkflowActive(workflowId) {
    const base = process.env.N8N_BASE_URL || "";
    const apiKey = process.env.N8N_API_KEY || "";
    if (!workflowId || !base || !apiKey) return null;
    try {
      const resp = await fetchCompatible(`${base}/api/v1/workflows/${workflowId}`, {
        headers: { "X-N8N-API-KEY": apiKey },
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      return Boolean(data && data.active);
    } catch (e) {
      console.log(`查询 n8n 工作流 ${workflowId} 状态失败:`, String(e && (e.message || e)).slice(0, 200));
      return null;
    }
  }

  /** 设置 n8n 工作流 active/deactive；返回 { ok, active }。 */
  async function setN8nWorkflowActive(workflowId, active) {
    const base = process.env.N8N_BASE_URL || "";
    const apiKey = process.env.N8N_API_KEY || "";
    if (!workflowId || !base || !apiKey) {
      return { ok: false, error: "未配置 N8N_BASE_URL / N8N_API_KEY" };
    }
    try {
      const url = active ? "activate" : "deactivate";
      const resp = await fetchCompatible(`${base}/api/v1/workflows/${workflowId}/${url}`, {
        method: "POST",
        headers: { "X-N8N-API-KEY": apiKey, "Content-Type": "application/json" },
        body: "{}",
      });
      if (!resp.ok) {
        return { ok: false, error: `n8n 工作流 ${active ? "激活" : "停用"}失败（HTTP ${resp.status}）` };
      }
      const data = await resp.json();
      return { ok: true, active: Boolean(data && data.active) };
    } catch (e) {
      return { ok: false, error: String(e && (e.message || e)).slice(0, 300) };
    }
  }

  async function setEnabled(id, enabled) {
    const entry = await get(id);
    const want = Boolean(enabled);
    // 多国校验条目（mc_*）启停 = 单独控制该国参与校验（配置层面），不整工作流 active 同步。
    const updated = await update(id, { enabled: want });
    return { ...updated, n8nSync: null, n8nActive: null };
  }

  /** 测试执行：优先触发条目绑定的 n8n 工作流（推荐通道）；无 n8n 绑定时退回 command dry-run。 */
  async function runTest(id, { timeoutMs } = {}) {
    const entry = await get(id);
    if (!entry) {
      throw Object.assign(new Error(`告警条目不存在：${id}`), { statusCode: 404 });
    }
    // 优先走 n8n 工作流触发：条目绑定了 workflow 或属于多国校验（mc_* 共享 E4B4wNzcUG0ow6BL）
    if (entry.n8nWorkflowId || (entry.webhookPath && entry.trigger === "webhook")) {
      // mc_* 条目：id 形如 mc_cn / mc_id → 推导 country 传给 n8n 工作流，只校验该国家
      const mcMatch = /^mc_([a-z]{2})$/.exec(id || "");
      const payload = {
        source: "test",
        entryId: id,
        entryName: entry.name,
        ...(mcMatch ? { country: mcMatch[1] } : {}),
      };
      const result = {
        id,
        name: entry.name,
        mode: "n8n-workflow",
        ...(await triggerN8nWorkflow({
          workflowId: entry.n8nWorkflowId,
          webhookPath: entry.webhookPath,
          payload,
          timeoutMs,
        })),
      };
      // 非多国条目：把本次触发记录进条目历史（mc_* 的结果由 n8n 工作流回写 check-results）
      if (!isMcEntry(id)) {
        await appendEntryHistory(id, {
          source: "test",
          hasAlert: false,
          hasError: !result.ok || !result.triggered,
          text: result.message || result.error || (result.ok ? "已触发 n8n 工作流" : "触发失败"),
        }).catch(() => {});
      }
      return result;
    }
    if (!entry.command) {
      throw Object.assign(new Error(`告警条目 ${entry.name} 未配置 command 且未绑定 n8n 工作流`), { statusCode: 400 });
    }
    const command = resolveEnv(entry.command);
    const result = await runCommandSync(entry.runVia || "local", command, {
      sshHost: entry.sshHost,
      sshPort: entry.sshPort,
      timeoutMs,
    });
    // 命令执行结果记录进条目历史
    if (!isMcEntry(id)) {
      await appendEntryHistory(id, {
        source: "test",
        hasAlert: false,
        hasError: !result.ok,
        text: result.ok ? "命令 dry-run 通过" : `命令执行失败（exit ${result.exitCode}）`,
        detail: { stdout: String(result.stdout || "").slice(0, 2000), stderr: String(result.stderr || "").slice(0, 2000) },
      }).catch(() => {});
    }
    return { ...result, id, name: entry.name, mode: "command" };
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
    // 维护每国连续异常计数（异常 +1，无异常归零），达到阈值且开启电话时标记 phoneNeeded。
    // 注意：只更新本次结果中实际校验过的国家（定时为全部启用国家；单国测试只含 1 国），
    // 未参与本次校验的国家计数保持不变 —— 否则单国测试会把其他国家的计数误清零。
    const notify = await loadMcNotify();
    const strike = await loadMcStrike();
    const counts = { ...strike.counts };
    const checkedCodes = new Set((run.countries || []).map((x) => String(x.code || "").toLowerCase()));
    for (const code of MC_COUNTRIES) {
      if (!checkedCodes.has(code)) continue;
      const c = run.countries.find((x) => (x.code || "").toLowerCase() === code);
      const hasMismatch = Boolean(c && Array.isArray(c.mismatches) && c.mismatches.length > 0);
      counts[code] = hasMismatch ? (counts[code] || 0) + 1 : 0;
    }
    await writeJsonFileAtomic(await strikePath(), { counts });
    const phoneNeeded = MC_COUNTRIES.filter((code) => {
      const cfg = notify.countries[code] || {};
      return cfg.phone !== false && counts[code] >= (cfg.strikeThreshold || 6);
    });
    return { ok: true, kept: runs.length, limit: MULTI_COUNTRY_RESULTS_KEEP, run, phoneNeeded, strikes: counts };
  }

  // ---- 多国校验 · 电话通知配置（页面可调） ----

  async function notifyPath() {
    await loadEnvFile(path.join(rootDir, ".env"));
    return resolve(MC_NOTIFY_FILE);
  }

  async function strikePath() {
    await loadEnvFile(path.join(rootDir, ".env"));
    return resolve(MC_STRIKE_FILE);
  }

  async function loadMcNotify() {
    const file = await notifyPath();
    const data = await readJsonFile(file, {});
    // 合并默认结构，确保 6 国都存在
    const countries = {};
    for (const code of MC_COUNTRIES) {
      const c = (data.countries || {})[code] || {};
      countries[code] = {
        contacts: Array.isArray(c.contacts) ? c.contacts.map(String) : [],
        phone: c.phone !== false,
        group: c.group !== false,
        strikeThreshold: Number.isInteger(c.strikeThreshold) ? c.strikeThreshold : 6,
      };
    }
    return { countries };
  }

  async function loadMcStrike() {
    const file = await strikePath();
    const data = await readJsonFile(file, {});
    return { counts: data.counts || {} };
  }

  /** 读取多国校验电话通知配置。 */
  async function getMcNotify() {
    return loadMcNotify();
  }

  /** 保存多国校验电话通知配置。cfg: { countries: { code: {contacts, phone, group, strikeThreshold} } } */
  async function setMcNotify(cfg = {}) {
    const current = await loadMcNotify();
    const countries = current.countries;
    const next = cfg.countries || {};
    for (const code of MC_COUNTRIES) {
      const n = next[code] || {};
      if (!(code in next)) continue;
      countries[code] = {
        contacts: Array.isArray(n.contacts) ? n.contacts.map(String).slice(0, 20) : [],
        phone: n.phone !== false,
        group: n.group !== false,
        strikeThreshold: Number.isInteger(Number(n.strikeThreshold)) ? Math.max(1, Math.min(99, Number(n.strikeThreshold))) : 6,
      };
    }
    await writeJsonFileAtomic(await notifyPath(), { countries });
    return { ok: true, countries };
  }

  async function groupPath() {
    await loadEnvFile(path.join(rootDir, ".env"));
    return resolve(MC_GROUP_FILE);
  }

  /** 加载发送群配置（chatId + 各国家负责人）。 */
  async function loadMcGroup() {
    const file = await groupPath();
    const raw = await readJsonFile(file, {});
    if (!raw || typeof raw !== "object" || Object.keys(raw).length === 0) {
      return JSON.parse(JSON.stringify(DEFAULT_MC_GROUP));
    }
    const owners = {};
    for (const code of MC_COUNTRIES) {
      const list = Array.isArray(raw.owners && raw.owners[code]) ? raw.owners[code] : [];
      owners[code] = list.map(String).filter((x) => x.trim()).slice(0, 20);
    }
    return {
      chatId: raw.chatId != null ? Number(raw.chatId) : DEFAULT_MC_GROUP.chatId,
      owners,
    };
  }

  async function getMcGroup() {
    return loadMcGroup();
  }

  async function setMcGroup(cfg = {}) {
    const current = await loadMcGroup();
    const owners = { ...current.owners };
    const next = cfg.owners || {};
    for (const code of MC_COUNTRIES) {
      if (!(code in next)) continue;
      const list = Array.isArray(next[code]) ? next[code] : [];
      owners[code] = list.map(String).filter((x) => x.trim()).slice(0, 20);
    }
    let chatId = current.chatId;
    if (cfg.chatId !== undefined && cfg.chatId !== null && String(cfg.chatId).trim() !== "") {
      const n = Number(cfg.chatId);
      if (!Number.isInteger(n)) {
        throw Object.assign(new Error(`发送群 chat id 必须是整数：${cfg.chatId}`), { statusCode: 400 });
      }
      chatId = n;
    }
    const result = { chatId, owners };
    await writeJsonFileAtomic(await groupPath(), result);
    return { ok: true, ...result };
  }

  /** 获取当前连续异常计数。 */
  async function getMcStrikes() {
    return loadMcStrike();
  }

  /**
   * 获取各国多国校验启用状态（n8n 工作流运行时读取，只校验启用的国家）。
   * 来源：告警注册表中 mc_* 条目的 enabled。
   */
  async function getMcEnabledCountries() {
    const { alerts } = await load();
    const map = {};
    for (const code of MC_COUNTRIES) {
      const entry = alerts.find((item) => item.id === `mc_${code}` || item.id === `mc_${code.toUpperCase()}`);
      map[code] = entry ? entry.enabled !== false : true;
    }
    return { countries: map };
  }

  /**
   * 测试拨号：用当前电话语音配置（阿里云凭据 + 模板）给指定号码打一个测试电话。
   * body: { mode:"test", testNumber:"153...", country?, n? }
   * 不落库、不查通知配置，纯粹验证语音通道可用。
   */
  async function callMcPhoneTest(body = {}, { loadMcVoice, callAliyunVoice }) {
    const voice = await loadMcVoice();
    const number = String(body.testNumber || "").replace(/[^\d+]/g, "").trim();
    if (!/^1\d{10}$/.test(number) && !/^\d{6,}$/.test(number)) {
      return { ok: false, mode: "ali-voice", error: "测试号码格式不合法（需 11 位手机号或 6 位以上号码）" };
    }
    if (!voice.enabled) {
      return { ok: false, mode: "ali-voice", error: "电话语音已停用（mc-voice.enabled=false），请先启用" };
    }
    const label = String(body.country || "测试国家");
    const vars = {
      label,
      code: String(body.country || "test").toLowerCase().slice(0, 2),
      country: label,
      n: Math.max(1, Number(body.n) || 1),
      threshold: 6,
      items: "测试异常明细 1 条",
    };
    const name = fillTemplate(voice.nameTemplate, vars);
    const system = fillTemplate(voice.systemTemplate, vars);
    const t0 = Date.now();
    try {
      const resp = await callAliyunVoice(voice, number, { name, system });
      const ok = resp && (resp.Code === "OK" || resp.Code === "200");
      return {
        ok,
        mode: "ali-voice",
        phone: number,
        callId: resp && resp.CallId,
        error: ok ? null : (resp && resp.Message) || "阿里云语音返回失败",
        resp: resp ? { Code: resp.Code, Message: resp.Message } : null,
        name,
        system,
        elapsedMs: Date.now() - t0,
        note: ok ? "测试电话已发起，请留意接听" : "拨号失败，请检查 AccessKeyId/AccessKeySecret/TtsCode",
      };
    } catch (e) {
      return {
        ok: false,
        mode: "ali-voice",
        phone: number,
        error: String(e && e.message ? e.message : e).slice(0, 200),
        elapsedMs: Date.now() - t0,
        note: "拨号异常，请检查凭据与网络",
      };
    }
  }

  /**
   * 电话通知入口（n8n 调用）：对达到电话阈值的目标国家，用阿里云语音（dyvmsapi SingleCallByTts）
   * 逐个拨打其联系人，播报内容用 TtsParam 的 name/system 参数（模板可配置，支持 {{label}}/{{code}}/{{n}}）。
   * body: { countries: [{code, label, contacts}], checkedAt }
   */
  async function callMcPhone(body = {}) {
    // 测试拨号模式：给指定号码打测试电话，验证阿里云语音凭据/模板/ttsCode 可用
    if (body && body.mode === "test") {
      return callMcPhoneTest(body, { loadMcNotify, loadMcVoice, callAliyunVoice });
    }
    const targets = Array.isArray(body.countries) ? body.countries : [];
    const [notify, voice] = await Promise.all([loadMcNotify(), loadMcVoice()]);
    const resolved = targets
      .map((t) => {
        const code = String(t.code || "").toLowerCase();
        const cfg = notify.countries[code] || {};
        return {
          code,
          label: t.label || code,
          contacts: Array.isArray(t.contacts) && t.contacts.length > 0 ? t.contacts : cfg.contacts,
          threshold: cfg.strikeThreshold || 6,
        };
      })
      .filter((t) => MC_COUNTRIES.includes(t.code));
    console.log(`[mc-phone] ${new Date().toISOString()} 电话通知请求:`, JSON.stringify(resolved));
    if (resolved.length === 0) {
      return { ok: true, mode: "ali-voice", calls: [], targets: resolved };
    }
    if (!voice.enabled) {
      return { ok: true, mode: "ali-voice", calls: [], targets: resolved, note: "电话语音已停用（mc-voice.enabled=false）" };
    }
    const calls = [];
    let failed = 0;
    for (const t of resolved) {
      const n = Math.max(1, Number.isInteger(Number(t.n)) ? Number(t.n) : 1);
      const vars = {
        label: t.label,
        code: t.code,
        country: t.label,
        n,
        threshold: t.threshold,
        items: Array.isArray(t.items) ? t.items.join("、") : `${n} 项`,
      };
      const name = fillTemplate(voice.nameTemplate, vars);
      const system = fillTemplate(voice.systemTemplate, vars);
      for (const phone of t.contacts) {
        const clean = String(phone || "").replace(/[^\d+]/g, "").trim();
        if (!/^1\d{10}$/.test(clean) && !/^\d{6,}$/.test(clean)) {
          calls.push({ code: t.code, phone, ok: false, error: "号码格式不合法" });
          failed++;
          continue;
        }
        try {
          const resp = await callAliyunVoice(voice, clean, { name, system });
          const ok = resp && (resp.Code === "OK" || resp.Code === "200");
          calls.push({ code: t.code, phone: clean, ok, callId: resp && resp.CallId, error: ok ? null : (resp && resp.Message) });
          if (!ok) failed++;
        } catch (e) {
          calls.push({ code: t.code, phone: clean, ok: false, error: String(e && e.message ? e.message : e).slice(0, 120) });
          failed++;
        }
      }
    }
    console.log(`[mc-phone] 拨打完成 成功=${calls.length - failed}/${calls.length}`);
    return { ok: failed === 0, mode: "ali-voice", calls, targets: resolved };
  }

  /**
   * 通用条目电话入口：mc_* 走多国电话（按国家联系人）；普通条目按自身 notify.contacts 逐个拨打。
   * body: { mode:"test", testNumber?, n?, items?, country? } 或 { targets? }
   */
  async function callEntryPhone(id, body = {}) {
    if (isMcEntry(id)) {
      return callMcPhone(body || {});
    }
    // 测试拨号
    if (body && body.mode === "test") {
      return callMcPhoneTest(body, { loadMcVoice, callAliyunVoice });
    }
    const entry = await get(id);
    if (!entry) {
      throw Object.assign(new Error(`告警条目不存在：${id}`), { statusCode: 404 });
    }
    const [notify, voice] = await Promise.all([getEntryNotify(id), getEntryVoice(id)]);
    const contacts = Array.isArray(body.contacts) && body.contacts.length > 0
      ? body.contacts
      : notify.contacts;
    if (!Array.isArray(contacts) || contacts.length === 0) {
      return { ok: true, mode: "ali-voice", calls: [], targets: [], note: "该条目未配置电话联系人，不拨打" };
    }
    if (!voice.enabled) {
      return { ok: true, mode: "ali-voice", calls: [], targets: [], note: "电话语音已停用，不拨打" };
    }
    const n = Math.max(1, Number(body.n) || 1);
    const vars = {
      label: entry.name || id,
      code: String(entry.country || "").toLowerCase() || id,
      country: entry.name || id,
      n,
      threshold: notify.strikeThreshold || 6,
      items: Array.isArray(body.items) ? body.items.join("、") : `${n} 项`,
    };
    const name = fillTemplate(voice.nameTemplate, vars);
    const system = fillTemplate(voice.systemTemplate, vars);
    const calls = [];
    let failed = 0;
    for (const phone of contacts) {
      const clean = String(phone || "").replace(/[^\d+]/g, "").trim();
      if (!/^1\d{10}$/.test(clean) && !/^\d{6,}$/.test(clean)) {
        calls.push({ phone, ok: false, error: "号码格式不合法" });
        failed++;
        continue;
      }
      try {
        const resp = await callAliyunVoice(voice, clean, { name, system });
        const ok = resp && (resp.Code === "OK" || resp.Code === "200");
        calls.push({ phone: clean, ok, callId: resp && resp.CallId, error: ok ? null : (resp && resp.Message) });
        if (!ok) failed++;
      } catch (e) {
        calls.push({ phone: clean, ok: false, error: String(e && e.message ? e.message : e).slice(0, 120) });
        failed++;
      }
    }
    return { ok: failed === 0, mode: "ali-voice", calls, targets: [{ id, contacts }], entryId: id };
  }

  async function voicePath() {
    await loadEnvFile(path.join(rootDir, ".env"));
    return resolve(MC_VOICE_FILE);
  }

  /** 读取电话语音配置（阿里云语音凭据 + 播报模板）。 */
  async function loadMcVoice() {
    const file = await voicePath();
    const raw = await readJsonFile(file, {});
    const d = JSON.parse(JSON.stringify(DEFAULT_MC_VOICE));
    if (!raw || typeof raw !== "object" || Object.keys(raw).length === 0) {
      // 无配置文件 → 用默认值，但需要解析 ${ALIBABA_VOICE_*} 环境变量占位符
      return {
        enabled: d.enabled,
        accessKeyId: resolveEnv(d.accessKeyId),
        accessKeySecret: resolveEnv(d.accessKeySecret),
        calledShowNumber: d.calledShowNumber,
        ttsCode: d.ttsCode,
        nameTemplate: d.nameTemplate,
        systemTemplate: d.systemTemplate,
      };
    }
    return {
      enabled: raw.enabled !== false,
      accessKeyId: resolveEnv(String(raw.accessKeyId || d.accessKeyId)),
      accessKeySecret: resolveEnv(String(raw.accessKeySecret || d.accessKeySecret)),
      calledShowNumber: String(raw.calledShowNumber || d.calledShowNumber),
      ttsCode: String(raw.ttsCode || d.ttsCode),
      nameTemplate: String(raw.nameTemplate || d.nameTemplate),
      systemTemplate: String(raw.systemTemplate || d.systemTemplate),
    };
  }

  /** 读取电话语音配置（页面展示用，隐藏密钥中间部分）。 */
  async function getMcVoice() {
    const v = await loadMcVoice();
    return {
      enabled: v.enabled,
      accessKeyId: v.accessKeyId,
      accessKeyIdMasked: maskSecret(v.accessKeyId),
      accessKeySecretMasked: maskSecret(v.accessKeySecret),
      calledShowNumber: v.calledShowNumber,
      ttsCode: v.ttsCode,
      nameTemplate: v.nameTemplate,
      systemTemplate: v.systemTemplate,
    };
  }

  /** 保存电话语音配置（页面上传凭据/模板；不填的字段保持原值）。 */
  async function setMcVoice(cfg = {}) {
    const current = await loadMcVoice();
    const next = {
      enabled: cfg.enabled !== undefined ? cfg.enabled !== false : current.enabled,
      accessKeyId: nonEmpty(cfg.accessKeyId) || current.accessKeyId,
      accessKeySecret: nonEmpty(cfg.accessKeySecret) || current.accessKeySecret,
      calledShowNumber: nonEmpty(cfg.calledShowNumber) || current.calledShowNumber,
      ttsCode: nonEmpty(cfg.ttsCode) || current.ttsCode,
      nameTemplate: nonEmpty(cfg.nameTemplate) || current.nameTemplate,
      systemTemplate: nonEmpty(cfg.systemTemplate) || current.systemTemplate,
    };
    if (!next.ttsCode) throw Object.assign(new Error("电话语音模板 TtsCode 不能为空"), { statusCode: 400 });
    if (!next.calledShowNumber) throw Object.assign(new Error("电话显号不能为空"), { statusCode: 400 });
    await writeJsonFileAtomic(await voicePath(), next);
    return { ok: true, ...(await getMcVoice()) };
  }

  // ---- 多国校验定时（页面可调整，写入 n8n 工作流 ScheduleTrigger） ----

  async function schedulePath() {
    await loadEnvFile(path.join(rootDir, ".env"));
    return resolve(MC_SCHEDULE_FILE);
  }

  async function loadSchedule() {
    const file = await schedulePath();
    const data = await readJsonFile(file, DEFAULT_MC_SCHEDULE);
    const minute = Number(data.minute);
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
      return DEFAULT_MC_SCHEDULE;
    }
    return { minute };
  }

  /** 读取当前多国校验定时（分钟）。 */
  async function getMcSchedule() {
    return loadSchedule();
  }

  /** 把 cron 写入 n8n 工作流的 ScheduleTrigger 节点（typeVersion 1.2, rule.interval[0].expression）。 */
  async function applyMcScheduleToN8n(minute) {
    const base = process.env.N8N_BASE_URL || "";
    const apiKey = process.env.N8N_API_KEY || "";
    if (!base || !apiKey) {
      return { ok: false, error: "生产平台未配置 N8N_BASE_URL / N8N_API_KEY，无法更新 n8n 定时" };
    }
    const cron = `${minute} * * * *`;
    try {
      // 1) 读取当前工作流
      const getResp = await fetchCompatible(`${base}/api/v1/workflows/${MC_WORKFLOW_ID}`, {
        headers: { "X-N8N-API-KEY": apiKey },
      });
      if (!getResp.ok) {
        return { ok: false, error: `读取 n8n 工作流失败（HTTP ${getResp.status}）` };
      }
      const wf = await getResp.json();
      let found = false;
      for (const n of wf.nodes || []) {
        if (n.name === MC_SCHEDULE_TRIGGER_NODE && n.type === "n8n-nodes-base.scheduleTrigger") {
          if (!n.parameters.rule || !Array.isArray(n.parameters.rule.interval)) {
            n.parameters.rule = { interval: [{ field: "cronExpression", expression: cron }] };
          } else {
            n.parameters.rule.interval[0] = { field: "cronExpression", expression: cron };
          }
          found = true;
          break;
        }
      }
      if (!found) {
        return { ok: false, error: `n8n 工作流中未找到定时触发节点「${MC_SCHEDULE_TRIGGER_NODE}」` };
      }
      // 2) PUT 工作流（n8n PUT 不接受 active 字段；settings 只保留 n8n 接受的字段，
      //    不能全量合并 GET 返回的 settings —— 其中 binaryMode 等字段会让 n8n 返回 HTTP 400）
      const srcSettings = wf.settings || {};
      const putSettings = {
        executionOrder: srcSettings.executionOrder === "v2" ? "v2" : "v1",
        callerPolicy: srcSettings.callerPolicy || "workflowsFromSameOwner",
        availableInMCP: Boolean(srcSettings.availableInMCP),
      };
      const putPayload = {
        name: wf.name,
        nodes: wf.nodes,
        connections: wf.connections,
        settings: putSettings,
      };
      const putResp = await fetchCompatible(`${base}/api/v1/workflows/${MC_WORKFLOW_ID}`, {
        method: "PUT",
        headers: { "X-N8N-API-KEY": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(putPayload),
      });
      if (!putResp.ok) {
        return { ok: false, error: `更新 n8n 工作流失败（HTTP ${putResp.status}）` };
      }
      // 3) 保持激活
      const active = Boolean(wf.active);
      if (active) {
        await fetchCompatible(`${base}/api/v1/workflows/${MC_WORKFLOW_ID}/activate`, {
          method: "POST",
          headers: { "X-N8N-API-KEY": apiKey },
        });
      }
      return { ok: true, minute, cron, active };
    } catch (error) {
      return { ok: false, error: String(error && error.message || error) };
    }
  }

  /** 设置多国校验定时（分钟），保存配置并同步到 n8n。minute: 0-59。 */
  async function setMcSchedule({ minute } = {}) {
    const m = Number(minute);
    if (!Number.isInteger(m) || m < 0 || m > 59) {
      throw Object.assign(new Error("定时分钟必须是 0-59 的整数"), { statusCode: 400 });
    }
    await writeJsonFileAtomic(await schedulePath(), { minute: m });
    const sync = await applyMcScheduleToN8n(m);
    return { ok: sync.ok, minute: m, sync };
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
    getMcSchedule,
    setMcSchedule,
    getMcNotify,
    setMcNotify,
    getMcStrikes,
    getMcEnabledCountries,
    getMcGroup,
    setMcGroup,
    getMcVoice,
    setMcVoice,
    callMcPhone,
    // 通用条目能力
    getEntryNotify,
    setEntryNotify,
    getEntryVoice,
    setEntryVoice,
    getEntrySchedule,
    setEntrySchedule,
    getEntryHistory,
    appendEntryHistory,
    listAllHistory,
    getEntryDescription,
    setEntryDescription,
    callEntryPhone,
    isMcEntry,
  };
}
