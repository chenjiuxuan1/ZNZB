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
