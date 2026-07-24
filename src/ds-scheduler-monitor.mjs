import path from "node:path";
import { fetchCompatible } from "./fetch-compatible.mjs";
import { readJsonFile } from "./utils.mjs";
import { notifyText } from "./notifier.mjs";

const DEFAULT_CONFIG_PATH = "config/ds-scheduler.config.json";

export async function loadDsSchedulerConfig(rootDir) {
  const configPath = path.resolve(typeof rootDir === "string" ? rootDir : process.cwd(), DEFAULT_CONFIG_PATH);
  const config = await readJsonFile(configPath, null);
  if (!config) {
    return { n8nWebhookUrl: "", countries: {}, alerts: {} };
  }
  return {
    n8nWebhookUrl: config.n8nWebhookUrl || "",
    countries: config.countries || {},
    projectCodes: config.projectCodes || {},
    projectNames: config.projectNames || {},
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

/**
 * Resolve a project name to a project code by calling the n8n gateway.
 */
export async function resolveProjectName(webhookUrl, countryCode, token, projectName) {
  if (!projectName || !projectName.trim()) {
    return { success: false, error: "project name is empty" };
  }
  try {
    const response = await fetchCompatible(webhookUrl, {
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
      return { success: false, error: `resolve_project returned invalid JSON: ${body.slice(0, 200)}` };
    }
    if (!parsed.success) {
      return { success: false, error: parsed.error?.message || parsed.error?.code || "resolve_project failed" };
    }
    const projectCode = parsed.data?.project_code || parsed.data?.projectCode || "";
    if (!projectCode) {
      return { success: false, error: `未找到项目"${projectName}"，请确认项目名称是否正确` };
    }
    return { success: true, projectCode };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function saveDsSchedulerConfig(rootDir, config) {
  const fs = await import("node:fs/promises");
  const filePath = path.resolve(typeof rootDir === "string" ? rootDir : process.cwd(), DEFAULT_CONFIG_PATH);
  const previous = await readJsonFile(filePath, {});

  // Resolve project names to codes
  const webhookUrl = config.n8nWebhookUrl || "";
  const countries = config.countries || {};
  const projectNames = config.projectNames || {};
  const requestedProjectCodes = config.projectCodes || {};
  const previousProjectCodes = previous.projectCodes || {};
  const previousProjectNames = previous.projectNames || {};
  const projectCodes = {};
  const resolveResults = [];

  for (const [code, c] of Object.entries(countries)) {
    const token = String(c.token || "").trim();
    const projectName = projectNames[code] || "";
    const requestedProjectCode = String(requestedProjectCodes[code] || "").trim();
    const unchangedProjectCode = previousProjectNames[code] === projectName
      ? String(previousProjectCodes[code] || "").trim()
      : "";
    projectCodes[code] = requestedProjectCode || unchangedProjectCode;

    if (!requestedProjectCode && token && projectName && webhookUrl) {
      const result = await resolveProjectName(webhookUrl, code, token, projectName);
      if (result.success && result.projectCode) {
        projectCodes[code] = result.projectCode;
        resolveResults.push({ country: code, name: projectName, code: result.projectCode, ok: true });
      } else {
        resolveResults.push({
          country: code,
          name: projectName,
          code: projectCodes[code],
          error: result.error,
          ok: false,
        });
      }
    }
  }

  const fullConfig = {
    n8nWebhookUrl: webhookUrl,
    projectNames,
    projectCodes,
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

    try {
      const response = await fetchCompatible(webhookUrl, {
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
            project_code: config.projectCodes?.[countryCode] || "",
          },
        }),
      });

      const body = await response.text();
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        const errorMsg = body.includes("403")
          ? "n8n 网关拒绝访问，请确认服务器 IP 已加入公司网络白名单"
          : `n8n 网关返回异常: ${body.slice(0, 200)}`;
        results.push({
          country: countryCode,
          countryName: countryConfig.name || countryCode,
          success: false,
          error: errorMsg,
          stuckCount: 0,
          checkedWorkflows: 0,
          stuckWorkflows: [],
        });
        continue;
      }

      if (!parsed.success) {
        results.push({
          country: countryCode,
          countryName: countryConfig.name || countryCode,
          success: false,
          error: parsed.error?.message || parsed.error?.code || "unknown error",
          stuckCount: 0,
          checkedWorkflows: 0,
          stuckWorkflows: [],
        });
        continue;
      }

      const data = parsed.data || {};
      results.push({
        country: countryCode,
        countryName: countryConfig.name || countryCode,
        success: true,
        error: null,
        stuckCount: data.stuck_count || 0,
        staleCount: data.stale_count || 0,
        checkedWorkflows: data.total_checked || 0,
        stuckWorkflows: (data.stuck_workflows || []).map((wf) => ({
          workflowCode: wf.workflow_code,
          workflowName: wf.workflow_name,
          scheduleId: wf.schedule_id,
          scheduleStatus: wf.schedule_status,
          consecutiveFailures: wf.consecutive_failures,
          totalChecked: wf.total_checked,
          recentFailures: (wf.recent_failures || []).slice(0, 5),
        })),
        staleWorkflows: (data.stale_workflows || []).map((wf) => ({
          workflowCode: wf.workflow_code,
          workflowName: wf.workflow_name,
          scheduleId: wf.schedule_id,
          scheduleStatus: wf.schedule_status,
          staleReason: wf.stale_reason,
          staleMessage: wf.stale_message,
          totalInstancesChecked: wf.total_instances_checked,
        })),
      });
    } catch (error) {
      results.push({
        country: countryCode,
        countryName: countryConfig.name || countryCode,
        success: false,
        error: error.message,
        stuckCount: 0,
        checkedWorkflows: 0,
        stuckWorkflows: [],
      });
    }
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
