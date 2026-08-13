import path from "node:path";
import { fetchCompatible } from "./fetch-compatible.mjs";
import { notifyText } from "./notifier.mjs";
import { readJsonFile, writeJsonFileAtomic } from "./utils.mjs";

const CONFIG_PATH = "config/hive-scheduler.config.json";
const DEFAULT_WEBHOOK_URL = "http://127.0.0.1:5678/webhook/ds-scheduler";
const REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_HIVE_PROJECT_NAMES = {
  ine: "ods，dwb，tdm，dm_feature，temp，market，dwd，rpt，dws，privacy，dim",
  th: "ods，dwb，tdm，dm_feature，temp，market，dwd，rpt，dws，privacy，dim，dwt",
  cn: "ods，dwb，tdm，dm_feature，temp，market，dwd，rpt，dws，privacy，dim，dm_n，ext，dwt",
};

export const DEFAULT_HIVE_ALERT_ROUTING = {
  channel: "tv",
  webhookUrl: "https://tv-service-alert.kuainiu.chat/alert/v2/array",
  botId: "494903d0-6203-4d4c-a8d7-6bd7d3c92680",
  countryMentions: {
    cn: ["rockyzong@kn.group"],
    ine: ["gretchenhe@kn.group"],
    ph: ["jiangchuanchen@kn.group"],
    th: ["qilonghuang@kn.group"],
    pk: ["gretchenhe@kn.group"],
    mx: ["kuiwu@kn.group"],
  },
};

function resolveEnv(value) {
  return String(value || "").replace(/\$\{([^}]+)\}/g, (_match, key) => process.env[key] || "").trim();
}

export function parseHiveProjectNames(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[\n,，;；]+/);
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
}

function normalizeMentions(value) {
  const items = Array.isArray(value) ? value : String(value || "").split(/[\n,，;；]+/);
  return [...new Set(items.map((item) => String(item).trim()).filter(Boolean))];
}

function normalizeRouting(value = {}) {
  const countryMentions = {};
  for (const code of ["cn", "ine", "ph", "th", "pk", "mx"]) {
    countryMentions[code] = normalizeMentions(value.countryMentions?.[code] ?? DEFAULT_HIVE_ALERT_ROUTING.countryMentions[code]);
  }
  return {
    channel: "tv",
    webhookUrl: String(value.webhookUrl || DEFAULT_HIVE_ALERT_ROUTING.webhookUrl).trim(),
    botId: String(value.botId || DEFAULT_HIVE_ALERT_ROUTING.botId).trim(),
    countryMentions,
  };
}

function withDefaultProjectNames(value = {}) {
  const result = { ...value };
  for (const [code, names] of Object.entries(DEFAULT_HIVE_PROJECT_NAMES)) {
    if (!String(result[code] || "").trim()) result[code] = names;
  }
  return result;
}

export async function loadHiveSchedulerConfig(rootDir) {
  const filePath = path.resolve(rootDir || process.cwd(), CONFIG_PATH);
  const stored = await readJsonFile(filePath, {});
  return {
    n8nWebhookUrl: resolveEnv(stored.n8nWebhookUrl) || resolveEnv(process.env.HIVE_SCHEDULER_WEBHOOK_URL) || DEFAULT_WEBHOOK_URL,
    countries: stored.countries || {},
    projectNames: withDefaultProjectNames(stored.projectNames || {}),
    projects: stored.projects || {},
    alertRouting: normalizeRouting(stored.alertRouting),
  };
}

async function postGateway(webhookUrl, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchCompatible(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`n8n 网关返回异常（HTTP ${response.status}）：${text.slice(0, 200)}`);
    }
    if (!response.ok || parsed.success === false) {
      const message = parsed?.error?.message || parsed?.error || text;
      throw new Error(typeof message === "string" ? message : JSON.stringify(message));
    }
    return parsed.data && typeof parsed.data === "object" ? parsed.data : {};
  } catch (error) {
    if (error.name === "AbortError") throw new Error("HIVE 巡检请求超时（60 秒）");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveProject(webhookUrl, country, token, name) {
  const data = await postGateway(webhookUrl, {
    country,
    action: "resolve_project",
    ds_token: token,
    payload: { project_name: name },
  });
  const code = String(data.project_code || data.projectCode || "").trim();
  if (!code) throw new Error(`未找到项目“${name}”`);
  return code;
}

export async function saveHiveSchedulerConfig(rootDir, input = {}) {
  const filePath = path.resolve(rootDir || process.cwd(), CONFIG_PATH);
  const previous = await readJsonFile(filePath, {});
  const webhookUrl = String(input.n8nWebhookUrl || previous.n8nWebhookUrl || DEFAULT_WEBHOOK_URL).trim();
  const countries = {};
  const projectNames = {};
  const projects = {};
  const resolveErrors = [];

  for (const code of ["cn", "ine", "ph", "th", "pk", "mx"]) {
    const source = input.countries?.[code] || {};
    const oldCountry = previous.countries?.[code] || {};
    const token = String(source.token || oldCountry.token || "").trim();
    countries[code] = { name: String(source.name || oldCountry.name || code), enabled: Boolean(source.enabled), token };
    const names = parseHiveProjectNames(input.projectNames?.[code]);
    projectNames[code] = names.join("，");
    projects[code] = [];
    for (const name of names) {
      const old = (previous.projects?.[code] || []).find((item) => item.name === name);
      let projectCode = String(old?.code || "").trim();
      let error = "";
      if (!projectCode && token) {
        try {
          projectCode = await resolveProject(webhookUrl, code, token, name);
        } catch (cause) {
          error = cause.message;
          resolveErrors.push({ country: code, name, error });
        }
      }
      projects[code].push({ name, code: projectCode, error });
    }
  }

  const config = {
    n8nWebhookUrl: webhookUrl,
    countries,
    projectNames,
    projects,
    alertRouting: normalizeRouting(input.alertRouting || previous.alertRouting),
  };
  await writeJsonFileAtomic(filePath, config);
  return { ...config, resolved: Object.values(projects).flat().filter((item) => item.code).length, resolveErrors };
}

function normalizeWorkflow(item = {}) {
  return {
    projectName: item.projectName || "",
    projectCode: item.projectCode || "",
    workflowCode: String(item.workflow_code || item.workflowCode || item.code || ""),
    workflowName: String(item.workflow_name || item.workflowName || item.name || ""),
    scheduleStatus: String(item.schedule_status || item.scheduleStatus || ""),
    instanceState: String(item.instance_state || item.instanceState || item.state || ""),
    message: String(item.not_run_message || item.abnormal_message || item.failure_message || item.message || ""),
  };
}

function projectTargets(config, country) {
  return (config.projects?.[country] || []).filter((item) => item.code);
}

export async function checkAllHiveCountries(rootDir, config) {
  const checkedAt = new Date().toISOString();
  const results = [];
  for (const [country, countryConfig] of Object.entries(config.countries || {})) {
    if (!countryConfig.enabled) continue;
    const token = String(countryConfig.token || "").trim();
    const targets = projectTargets(config, country);
    if (!token || targets.length === 0) {
      results.push({ country, countryName: countryConfig.name || country, success: false, error: !token ? "Token 未配置" : "没有已匹配的监控项目", checkedWorkflows: 0, notRunCount: 0, abnormalCount: 0, projects: [] });
      continue;
    }
    const projectResults = [];
    for (const project of targets) {
      try {
        const data = await postGateway(config.n8nWebhookUrl, {
          country,
          action: "check_failed_instances",
          ds_token: token,
          payload: {
            project_code: project.code,
            monitor_policy: "scheduled_today_once",
            schedule_scope: "today_due",
            run_scope: "today",
            success_state: "SUCCESS",
            include_checked_workflows: true,
            include_not_run_workflows: true,
            include_abnormal_workflows: true,
          },
        });
        const decorate = (item) => normalizeWorkflow({ ...item, projectName: project.name, projectCode: project.code });
        const checked = (data.checked_workflows || data.workflows || []).map(decorate);
        const notRun = (data.not_run_workflows || []).map(decorate);
        const abnormal = (data.abnormal_workflows || []).map(decorate);
        projectResults.push({ projectName: project.name, projectCode: project.code, success: true, checkedWorkflows: checked.length || Number(data.total_should_run || 0), checkedWorkflowDetails: checked, notRunWorkflows: notRun, abnormalWorkflows: abnormal });
      } catch (error) {
        projectResults.push({ projectName: project.name, projectCode: project.code, success: false, error: error.message, checkedWorkflows: 0, notRunWorkflows: [], abnormalWorkflows: [] });
      }
    }
    const notRunWorkflows = projectResults.flatMap((item) => item.notRunWorkflows || []);
    const abnormalWorkflows = projectResults.flatMap((item) => item.abnormalWorkflows || []);
    results.push({
      country,
      countryName: countryConfig.name || country,
      success: projectResults.every((item) => item.success),
      checkedWorkflows: projectResults.reduce((sum, item) => sum + Number(item.checkedWorkflows || 0), 0),
      notRunCount: notRunWorkflows.length,
      abnormalCount: abnormalWorkflows.length,
      notRunWorkflows,
      abnormalWorkflows,
      projects: projectResults,
      error: projectResults.filter((item) => !item.success).map((item) => `${item.projectName}：${item.error}`).join("；") || null,
    });
  }
  return {
    checkedAt,
    totalChecked: results.reduce((sum, item) => sum + item.checkedWorkflows, 0),
    totalNotRun: results.reduce((sum, item) => sum + item.notRunCount, 0),
    totalAbnormal: results.reduce((sum, item) => sum + item.abnormalCount, 0),
    failedCountries: results.filter((item) => !item.success).length,
    countries: results,
  };
}

function countryMessage(country) {
  const lines = [
    `## HIVE 调度监控异常 · ${country.countryName || country.country}`,
    "",
    `检查工作流：${country.checkedWorkflows || 0}`,
    `应运行未运行：${country.notRunCount || 0}`,
    `运行状态异常：${country.abnormalCount || 0}`,
  ];
  if (country.error) lines.push(`巡检失败：${country.error}`);
  for (const item of country.notRunWorkflows || []) lines.push(`- 未运行｜${item.projectName}｜${item.workflowName || item.workflowCode}`);
  for (const item of country.abnormalWorkflows || []) lines.push(`- 异常｜${item.projectName}｜${item.workflowName || item.workflowCode}｜${item.instanceState || item.message}`);
  return lines.join("\n");
}

export async function notifyHiveSchedulerCheck(config, result) {
  const routing = normalizeRouting(config.alertRouting);
  const sends = [];
  for (const country of result.countries || []) {
    const hasIssue = !country.success || country.notRunCount > 0 || country.abnormalCount > 0;
    if (!hasIssue) continue;
    const alerts = {
      channel: "tv",
      webhookUrl: routing.webhookUrl,
      botId: routing.botId,
      mentions: normalizeMentions(routing.countryMentions[country.country]),
    };
    sends.push(await notifyText({ alerts }, countryMessage(country), {
      title: `HIVE 调度监控异常 · ${country.countryName || country.country}`,
      severity: "warning",
      timestamp: result.checkedAt,
    }));
  }
  return { sent: sends.some((item) => item.sent), sentMessages: sends.filter((item) => item.sent).length, results: sends };
}
