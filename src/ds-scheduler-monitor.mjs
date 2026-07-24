import path from "node:path";
import { fetchCompatible } from "./fetch-compatible.mjs";
import { readJsonFile } from "./utils.mjs";

const DEFAULT_CONFIG_PATH = "config/ds-scheduler.config.json";

export async function loadDsSchedulerConfig(rootDir) {
  const configPath = path.resolve(typeof rootDir === "string" ? rootDir : process.cwd(), DEFAULT_CONFIG_PATH);
  const config = await readJsonFile(configPath, null);
  if (!config) {
    return { n8nWebhookUrl: "", countries: {} };
  }
  return {
    n8nWebhookUrl: config.n8nWebhookUrl || "",
    countries: config.countries || {},
    projectCodes: config.projectCodes || {},
    projectNames: config.projectNames || {},
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

  // Resolve project names to codes
  const webhookUrl = config.n8nWebhookUrl || "";
  const countries = config.countries || {};
  const projectNames = config.projectNames || {};
  const projectCodes = {};
  const resolveResults = [];

  for (const [code, c] of Object.entries(countries)) {
    const token = String(c.token || "").trim();
    const projectName = projectNames[code] || "";
    projectCodes[code] = "";

    if (token && projectName && webhookUrl) {
      const result = await resolveProjectName(webhookUrl, code, token, projectName);
      if (result.success && result.projectCode) {
        projectCodes[code] = result.projectCode;
        resolveResults.push({ country: code, name: projectName, code: result.projectCode, ok: true });
      } else {
        resolveResults.push({ country: code, name: projectName, error: result.error, ok: false });
      }
    }
  }

  const fullConfig = {
    n8nWebhookUrl: webhookUrl,
    projectNames,
    projectCodes,
    countries,
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

const DS_COUNTRY_NAMES = {
  cn: "中国",
  ine: "印尼",
  ph: "菲律宾",
  th: "泰国",
  pk: "巴基斯坦",
  mx: "墨西哥",
};

function dsCountryName(code) {
  const key = String(code || "").toLowerCase();
  return DS_COUNTRY_NAMES[key] || code || "未知";
}

function formatDsCompactDateTime(isoString) {
  if (!isoString) {
    return "-";
  }
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return String(isoString);
  }
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function buildDsSummaryMessage(result, options = {}) {
  const lines = [];
  const detailUrl = options.detailUrl || "";
  const totalCountries = result.totalCountries || 0;
  const totalChecked = result.totalChecked || 0;
  const totalStuck = result.totalStuck || 0;
  const totalStale = result.totalStale || 0;
  const failedCountries = result.failedCountries || 0;
  const hasIssue = totalStuck > 0 || totalStale > 0 || failedCountries > 0;

  lines.push(hasIssue ? "⚠️【DS 调度监控异常】" : "✅【DS 调度监控正常】");
  lines.push("");
  lines.push(`🕒 检查时间：${formatDsCompactDateTime(result.checkedAt)}（北京时间）`);
  lines.push("");
  lines.push("📊 异常概览");
  lines.push(`• 检查范围：${totalCountries} 个国家 / ${totalChecked} 个工作流`);
  lines.push(`• 卡死工作流：${totalStuck} 个`);
  lines.push(`• 离线/旷工任务：${totalStale} 个`);
  if (failedCountries > 0) {
    lines.push(`• 检查失败国家：${failedCountries} 个`);
  }

  const countries = result.countries || [];
  const issueCountries = countries.filter((c) => (c.stuckCount || 0) > 0 || (c.staleCount || 0) > 0);
  const failedCountryList = countries.filter((c) => !c.success);

  if (issueCountries.length > 0) {
    lines.push("");
    lines.push("🌍 异常国家明细");
    for (const country of issueCountries.slice(0, 10)) {
      const parts = [];
      if ((country.stuckCount || 0) > 0) {
        parts.push(`卡死 ${country.stuckCount} 个`);
      }
      if ((country.staleCount || 0) > 0) {
        parts.push(`离线 ${country.staleCount} 个`);
      }
      lines.push(`• ${dsCountryName(country.country)}：${parts.join("，")}`);

      const stuckTop = (country.stuckWorkflows || []).slice(0, 3);
      for (const wf of stuckTop) {
        lines.push(`  ⛔ ${wf.workflowName || wf.workflowCode}（连续失败 ${wf.consecutiveFailures || 0} 次）`);
      }
      const staleTop = (country.staleWorkflows || []).slice(0, 2);
      for (const wf of staleTop) {
        lines.push(`  ⚠️ ${wf.workflowName || wf.workflowCode}（${wf.staleReason || wf.staleMessage || "异常下线"}）`);
      }
    }
    if (issueCountries.length > 10) {
      lines.push(`  另有 ${issueCountries.length - 10} 个国家的异常未展开`);
    }
  }

  if (failedCountryList.length > 0) {
    lines.push("");
    lines.push("❌ 检查失败国家");
    for (const country of failedCountryList) {
      lines.push(`• ${dsCountryName(country.country)}：${country.error || "未知错误"}`);
    }
  }

  if (!hasIssue) {
    lines.push("");
    lines.push("✅ 本次检查未发现异常。");
  }

  if (detailUrl) {
    lines.push("");
    lines.push(`详情：${detailUrl}`);
  }

  return lines.join("\n");
}

export function buildDsCountryMessage(countryResult, options = {}) {
  const lines = [];
  const detailUrl = options.detailUrl || "";
  const name = dsCountryName(countryResult.country);
  const stuckCount = countryResult.stuckCount || 0;
  const staleCount = countryResult.staleCount || 0;
  const hasIssue = stuckCount > 0 || staleCount > 0 || !countryResult.success;

  lines.push(hasIssue ? `⚠️【DS 调度 · ${name}异常】` : `✅【DS 调度 · ${name}正常】`);
  lines.push("");
  lines.push(`🕒 检查时间：${formatDsCompactDateTime(countryResult.checkedAt || new Date().toISOString())}`);
  lines.push(`📋 检查工作流：${countryResult.checkedWorkflows || 0} 个`);
  lines.push(`⛔ 卡死：${stuckCount} 个`);
  lines.push(`⚠️ 离线：${staleCount} 个`);

  if (!countryResult.success) {
    lines.push("");
    lines.push(`❌ 检查失败：${countryResult.error || "未知错误"}`);
  }

  const stuckWorkflows = countryResult.stuckWorkflows || [];
  if (stuckWorkflows.length > 0) {
    lines.push("");
    lines.push("⛔ 卡死工作流");
    for (const wf of stuckWorkflows.slice(0, 8)) {
      const reason = wf.consecutiveFailures ? `连续失败 ${wf.consecutiveFailures} 次` : "运行超时";
      lines.push(`• ${wf.workflowName || wf.workflowCode}：${reason}`);
    }
    if (stuckWorkflows.length > 8) {
      lines.push(`• 另有 ${stuckWorkflows.length - 8} 个未展开`);
    }
  }

  const staleWorkflows = countryResult.staleWorkflows || [];
  if (staleWorkflows.length > 0) {
    lines.push("");
    lines.push("⚠️ 离线/旷工任务");
    for (const wf of staleWorkflows.slice(0, 5)) {
      lines.push(`• ${wf.workflowName || wf.workflowCode}：${wf.staleReason || wf.staleMessage || "异常下线"}`);
    }
    if (staleWorkflows.length > 5) {
      lines.push(`• 另有 ${staleWorkflows.length - 5} 个未展开`);
    }
  }

  if (!hasIssue) {
    lines.push("");
    lines.push("✅ 全部正常。");
  }

  if (detailUrl) {
    lines.push("");
    lines.push(`详情：${detailUrl}`);
  }

  return lines.join("\n");
}

export function buildDsNotifyMessages(result, options = {}) {
  const messages = [];
  const totalIssues = (result.totalStuck || 0) + (result.totalStale || 0) + (result.failedCountries || 0);

  messages.push({
    title: totalIssues > 0 ? `DS 调度监控异常 ${totalIssues} 项` : "DS 调度监控正常",
    body: buildDsSummaryMessage(result, options),
    issueCount: totalIssues,
    scope: "summary",
  });

  if (options.includeCountryDetailMessages !== true) {
    return messages;
  }

  const countries = result.countries || [];
  for (const country of countries) {
    const countryIssues = (country.stuckCount || 0) + (country.staleCount || 0) + (country.success ? 0 : 1);
    if (countryIssues === 0 && options.sendWhenHealthy !== true) {
      continue;
    }
    messages.push({
      title: `${dsCountryName(country.country)} DS 调度 ${countryIssues > 0 ? `异常 ${countryIssues} 项` : "正常"}`,
      body: buildDsCountryMessage(country, options),
      issueCount: countryIssues,
      scope: "country",
      countryCode: country.country,
      countryName: dsCountryName(country.country),
    });
  }

  return messages;
}
