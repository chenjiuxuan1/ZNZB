import path from "node:path";
import { fetchCompatible } from "./fetch-compatible.mjs";
import { readJsonFile } from "./utils.mjs";
import { notifyText } from "./notifier.mjs";

const DS_FETCH_TIMEOUT_MS = 45_000;

function fetchWithTimeout(url, options = {}, timeoutMs = DS_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetchCompatible(url, { ...options, signal: controller.signal })
    .catch((error) => {
      if (error.name === "AbortError") {
        throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}秒），n8n 网关未响应，可能 DS 服务器连接缓慢或不可达`);
      }
      throw error;
    })
    .finally(() => clearTimeout(timer));
}

const DEFAULT_CONFIG_PATH = "config/ds-scheduler.config.json";

const DEFAULT_DS_SCHEDULER_WEBHOOK_URL = "http://127.0.0.1:5678/webhook/ds-scheduler";

function resolveEnvString(value) {
  return String(value ?? "").replace(/\$\{([^}]+)\}/g, (_match, key) => process.env[key] || "").trim();
}

export function resolveDsWebhookUrl(value) {
  return resolveEnvString(value)
    || resolveEnvString(process.env.DS_SCHEDULER_WEBHOOK_URL)
    || DEFAULT_DS_SCHEDULER_WEBHOOK_URL;
}

export function parseProjectNames(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[\n,，;；]+/);
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
}

function normalizeProjects(config, code) {
  const detailed = Array.isArray(config.projects?.[code]) ? config.projects[code] : [];
  if (detailed.length > 0) {
    return detailed
      .map((item) => ({ name: String(item.name || "").trim(), code: String(item.code || "").trim(), error: String(item.error || "") }))
      .filter((item) => item.name || item.code);
  }
  const names = parseProjectNames(config.projectNames?.[code]);
  const legacyCode = String(config.projectCodes?.[code] || "").trim();
  return names.map((name, index) => ({ name, code: index === 0 ? legacyCode : "", error: "" }));
}

export async function loadDsSchedulerConfig(rootDir) {
  const configPath = path.resolve(typeof rootDir === "string" ? rootDir : process.cwd(), DEFAULT_CONFIG_PATH);
  let config = null;
  try {
    config = await readJsonFile(configPath, null);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!config) {
    return { n8nWebhookUrl: resolveDsWebhookUrl(), countries: {}, alerts: {} };
  }
  return {
    n8nWebhookUrl: resolveDsWebhookUrl(config.n8nWebhookUrl),
    countries: config.countries || {},
    projectCodes: config.projectCodes || {},
    projectNames: config.projectNames || {},
    projects: config.projects || {},
    alerts: config.alerts || {},
  };
}

export async function getDsSchedulerScope(rootDir) {
  const config = await loadDsSchedulerConfig(rootDir);
  const countries = config.countries || {};
  const result = {};
  for (const [code, c] of Object.entries(countries)) {
    result[code] = {
      name: c.name || code,
      configured: Boolean(c.token && c.token.length > 0),
    };
  }
  return result;
}

function gatewayErrorMessage(status, body) {
  if (status === 403 || body.includes("403") || body.includes("Forbidden")) {
    return "n8n 网关拒绝访问，请确认服务器 IP 已加入公司网络白名单";
  }
  return `n8n 网关返回异常: ${body.slice(0, 200)}`;
}

function describeGatewayError(parsed) {
  const err = parsed?.error;
  if (!err) return "unknown error";
  const msg = err.message;
  if (typeof msg === "string" && msg.trim()) return msg;
  if (msg && typeof msg === "object") {
    const status = msg.status;
    const url = String(msg.url || "").split("?")[0];
    if (status === 401) return `DS Token 无效或未授权 (HTTP 401)${url ? `：${url}` : ""}`;
    if (status) return `DS API 返回 HTTP ${status}${url ? `：${url}` : ""}`;
    return JSON.stringify(msg).slice(0, 200);
  }
  return err.code || "unknown error";
}

/**
 * Resolve a project name to a project code by calling the n8n gateway.
 */
export async function resolveProjectName(webhookUrl, countryCode, token, projectName) {
  if (!projectName || !projectName.trim()) {
    return { success: false, error: "project name is empty" };
  }
  try {
    const response = await fetchWithTimeout(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        country: countryCode,
        action: "resolve_project",
        ds_token: token,
        payload: {
          project_name: projectName.trim(),
        },
      }),
    });
    const body = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      console.error(`[ds-scheduler] resolve_project ${countryCode} -> ${webhookUrl} HTTP ${response.status}: ${body.slice(0, 200)}`);
      return { success: false, error: gatewayErrorMessage(response.status, body) };
    }
    if (!parsed.success) {
      return { success: false, error: describeGatewayError(parsed) };
    }
    const projectCode = parsed.data?.project_code || parsed.data?.projectCode || "";
    if (!projectCode) {
      return { success: false, error: `未找到项目"${projectName}"，请确认项目名称是否正确` };
    }
    return { success: true, projectCode };
  } catch (error) {
    console.error(`[ds-scheduler] resolve_project ${countryCode} -> ${webhookUrl} request failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

export async function saveDsSchedulerConfig(rootDir, config) {
  const fs = await import("node:fs/promises");
  const filePath = path.resolve(typeof rootDir === "string" ? rootDir : process.cwd(), DEFAULT_CONFIG_PATH);
  const previous = await readJsonFile(filePath, {});

  // Resolve project names to codes
  const webhookUrl = resolveDsWebhookUrl(config.n8nWebhookUrl);
  const countries = config.countries || {};
  const projectNames = config.projectNames || {};
  const requestedProjectCodes = config.projectCodes || {};
  const previousProjectCodes = previous.projectCodes || {};
  const previousProjectNames = previous.projectNames || {};
  const requestedProjects = config.projects || {};
  const previousProjects = previous.projects || {};
  const projectCodes = {};
  const projects = {};
  const resolveResults = [];

  for (const [code, c] of Object.entries(countries)) {
    const token = String(c.token || "").trim();
    const names = parseProjectNames(projectNames[code]);
    projectNames[code] = names.join("，");
    const requestedProjectCode = String(requestedProjectCodes[code] || "").trim();
    const unchangedProjectCode = previousProjectNames[code] === projectNames[code]
      ? String(previousProjectCodes[code] || "").trim()
      : "";
    const supplied = Array.isArray(requestedProjects[code]) ? requestedProjects[code] : [];
    const prior = Array.isArray(previousProjects[code]) ? previousProjects[code] : [];
    projects[code] = [];
    for (const [index, name] of names.entries()) {
      const suppliedMatch = supplied.find((item) => String(item.name || "").trim() === name);
      const priorMatch = prior.find((item) => String(item.name || "").trim() === name);
      let projectCode = String(suppliedMatch?.code || priorMatch?.code || (index === 0 ? requestedProjectCode || unchangedProjectCode : "")).trim();
      let error = "";
      if (!projectCode && token && webhookUrl) {
        const result = await resolveProjectName(webhookUrl, code, token, name);
        if (result.success && result.projectCode) {
          projectCode = result.projectCode;
          resolveResults.push({ country: code, name, code: projectCode, ok: true });
        } else {
          error = result.error;
          resolveResults.push({ country: code, name, code: "", error, ok: false });
        }
      }
      projects[code].push({ name, code: projectCode, error });
    }
    projectCodes[code] = projects[code].find((item) => item.code)?.code || "";
  }

  const fullConfig = {
    n8nWebhookUrl: String(config.n8nWebhookUrl || "").trim(),
    projectNames,
    projectCodes,
    projects,
    countries,
    alerts: config.alerts || {},
  };

  await fs.writeFile(filePath, JSON.stringify(fullConfig, null, 2), "utf8");
  return { ...fullConfig, resolved: resolveResults.filter((r) => r.ok).length, resolveErrors: resolveResults.filter((r) => !r.ok) };
}

export async function checkAllCountries(rootDir, config) {
  const webhookUrl = config.n8nWebhookUrl || "";
  if (!webhookUrl) {
    throw new Error("n8n webhook URL not configured");
  }

  const countries = Object.entries(config.countries || {});
  const results = [];

  for (const [countryCode, countryConfig] of countries) {
    const token = String(countryConfig.token || "").trim();
    if (!token) {
      results.push({
        country: countryCode,
        countryName: countryConfig.name || countryCode,
        success: false,
        error: "token not configured",
        stuckCount: 0,
        checkedWorkflows: 0,
        stuckWorkflows: [],
      });
      continue;
    }

    const configuredProjects = normalizeProjects(config, countryCode).filter((item) => item.code);
    const projectTargets = configuredProjects.length > 0
      ? configuredProjects
      : [{ name: "", code: String(config.projectCodes?.[countryCode] || "") }];
    const projectResults = [];
    for (const project of projectTargets) try {
      const response = await fetchWithTimeout(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          country: countryCode,
          action: "check_failed_instances",
          ds_token: token,
          payload: {
            consecutive_failures: 3,
            page_size: 20,
            project_code: project.code,
          },
        }),
      });

      const body = await response.text();
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        console.error(`[ds-scheduler] check_failed_instances ${countryCode} project=${project.code || project.name || "-"} -> ${webhookUrl} HTTP ${response.status}: ${body.slice(0, 200)}`);
        const errorMsg = gatewayErrorMessage(response.status, body);
        projectResults.push({
          projectName: project.name,
          projectCode: project.code,
          success: false,
          error: errorMsg,
          stuckCount: 0,
          checkedWorkflows: 0,
          stuckWorkflows: [],
        });
        continue;
      }

      if (!parsed.success) {
        projectResults.push({
          projectName: project.name,
          projectCode: project.code,
          success: false,
          error: describeGatewayError(parsed),
          stuckCount: 0,
          checkedWorkflows: 0,
          stuckWorkflows: [],
        });
        continue;
      }

      const data = parsed.data || {};
      // Only monitor ONLINE schedules; OFFLINE schedules are completely ignored.
      // stale_workflows from n8n includes both OFFLINE ("schedule_offline")
      // and ONLINE-but-no-recent-run schedules. Filter to keep only ONLINE ones.
      const staleWorkflows = (data.stale_workflows || [])
        .filter((wf) => wf.schedule_status !== "OFFLINE" && wf.stale_reason !== "schedule_offline")
        .map((wf) => ({
          projectName: project.name,
          projectCode: project.code,
          workflowCode: wf.workflow_code,
          workflowName: wf.workflow_name,
          scheduleId: wf.schedule_id,
          scheduleStatus: wf.schedule_status,
          staleReason: wf.stale_reason,
          staleMessage: wf.stale_message,
          totalInstancesChecked: wf.total_instances_checked,
        }));
      projectResults.push({
        projectName: project.name,
        projectCode: project.code,
        success: true,
        error: null,
        stuckCount: data.stuck_count || 0,
        staleCount: staleWorkflows.length,
        checkedWorkflows: data.total_checked || 0,
        stuckWorkflows: (data.stuck_workflows || []).map((wf) => ({
          projectName: project.name,
          projectCode: project.code,
          workflowCode: wf.workflow_code,
          workflowName: wf.workflow_name,
          scheduleId: wf.schedule_id,
          scheduleStatus: wf.schedule_status,
          consecutiveFailures: wf.consecutive_failures,
          totalChecked: wf.total_checked,
          recentFailures: (wf.recent_failures || []).slice(0, 5),
        })),
        staleWorkflows,
      });
    } catch (error) {
      console.error(`[ds-scheduler] check_failed_instances ${countryCode} project=${project.code || project.name || "-"} -> ${webhookUrl} request failed: ${error.message}`);
      projectResults.push({
        projectName: project.name,
        projectCode: project.code,
        success: false,
        error: error.message,
        stuckCount: 0,
        checkedWorkflows: 0,
        stuckWorkflows: [],
      });
    }
    results.push({
      country: countryCode,
      countryName: countryConfig.name || countryCode,
      success: projectResults.some((item) => item.success),
      partialFailure: projectResults.some((item) => !item.success),
      error: projectResults.filter((item) => !item.success).map((item) => `${item.projectName || item.projectCode}: ${item.error}`).join("；") || null,
      stuckCount: projectResults.reduce((sum, item) => sum + (item.stuckCount || 0), 0),
      staleCount: projectResults.reduce((sum, item) => sum + (item.staleWorkflows?.length || 0), 0),
      checkedWorkflows: projectResults.reduce((sum, item) => sum + (item.checkedWorkflows || 0), 0),
      stuckWorkflows: projectResults.flatMap((item) => item.stuckWorkflows || []),
      staleWorkflows: projectResults.flatMap((item) => item.staleWorkflows || []),
      projects: projectResults,
    });
  }

  const totalStuck = results.reduce((sum, r) => sum + r.stuckCount, 0);
  const totalStale = results.reduce((sum, r) => sum + (r.staleCount || 0), 0);
  const totalChecked = results.reduce((sum, r) => sum + r.checkedWorkflows, 0);
  const failedCountries = results.filter((r) => !r.success).length;

  return {
    checkedAt: new Date().toISOString(),
    totalStuck,
    totalStale,
    totalChecked,
    totalCountries: countries.length,
    failedCountries,
    countries: results,
  };
}

/**
 * Send notification for DS scheduler check results.
 */
export async function notifyDsSchedulerCheck(config, checkResult) {
  const alertConfig = config.alerts || {};
  if (!alertConfig.channel && !alertConfig.webhookUrl) {
    return { sent: false, reason: "alert not configured" };
  }

  const totalStuck = checkResult.totalStuck || 0;
  const totalStale = checkResult.totalStale || 0;
  const hasAnomalies = totalStuck > 0 || totalStale > 0;

  if (!hasAnomalies && alertConfig.sendWhenHealthy === false) {
    return { sent: false, reason: "healthy notification disabled" };
  }

  const messages = buildDsSchedulerMessages(checkResult, alertConfig);
  const results = [];

  for (const message of messages) {
    results.push(
      await notifyText(config, message.body, {
        title: message.title,
        severity: hasAnomalies ? "warning" : "info",
      }),
    );
  }

  return {
    sent: results.some((resultItem) => resultItem.sent),
    sentMessages: messages.length,
    results,
  };
}

/**
 * Build notification messages for DS scheduler check results.
 */
function buildDsSchedulerMessages(checkResult, alertConfig = {}) {
  const messages = [];
  const totalStuck = checkResult.totalStuck || 0;
  const totalStale = checkResult.totalStale || 0;
  const hasAnomalies = totalStuck > 0 || totalStale > 0;

  // Build overview message
  let body = `## DS 调度监控巡检报告\n\n`;
  body += `**检查时间**: ${new Date(checkResult.checkedAt).toLocaleString("zh-CN")}\n\n`;
  body += `### 概览\n`;
  body += `- 监控国家: ${checkResult.totalCountries}\n`;
  body += `- 检查工作流: ${checkResult.totalChecked}\n`;
  body += `- 卡死工作流: ${totalStuck}\n`;
  body += `- 离线/旷工任务: ${totalStale}\n`;
  body += `- 检查失败国家: ${checkResult.failedCountries}\n\n`;

  if (hasAnomalies) {
    body += `### 异常详情\n\n`;

    // Add stuck workflows
    if (totalStuck > 0) {
      body += `#### ⛔ 卡死工作流 (${totalStuck})\n\n`;
      for (const countryResult of checkResult.countries || []) {
        if (countryResult.stuckWorkflows && countryResult.stuckWorkflows.length > 0) {
          body += `**${countryResult.countryName} (${countryResult.country})**\n`;
          for (const wf of countryResult.stuckWorkflows) {
            body += `- \`${wf.workflowName}\` (${wf.workflowCode})\n`;
            body += `  - 连续失败: ${wf.consecutiveFailures} 次\n`;
            body += `  - 调度状态: ${wf.scheduleStatus || "未知"}\n`;
          }
          body += `\n`;
        }
      }
    }

    // Add stale workflows
    if (totalStale > 0) {
      body += `#### ⚠️ 离线/旷工任务 (${totalStale})\n\n`;
      for (const countryResult of checkResult.countries || []) {
        if (countryResult.staleWorkflows && countryResult.staleWorkflows.length > 0) {
          body += `**${countryResult.countryName} (${countryResult.country})**\n`;
          for (const wf of countryResult.staleWorkflows) {
            body += `- \`${wf.workflowName}\` (${wf.workflowCode})\n`;
            body += `  - 状态: ${wf.staleMessage || wf.staleReason || "离线"}\n`;
            body += `  - 调度状态: ${wf.scheduleStatus || "未知"}\n`;
          }
          body += `\n`;
        }
      }
    }

    // Add failed countries
    if (checkResult.failedCountries > 0) {
      body += `#### ❌ 检查失败国家 (${checkResult.failedCountries})\n\n`;
      for (const countryResult of checkResult.countries || []) {
        if (!countryResult.success) {
          body += `- **${countryResult.countryName} (${countryResult.country})**: ${countryResult.error || "未知错误"}\n`;
        }
      }
      body += `\n`;
    }
  } else {
    body += `### ✅ 一切正常\n\n`;
    body += `所有检查通过，没有发现异常。\n`;
  }

  messages.push({
    title: hasAnomalies ? "⚠️ DS 调度监控异常告警" : "✅ DS 调度监控健康报告",
    body,
  });

  return messages;
}
