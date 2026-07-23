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

export async function saveDsSchedulerConfig(rootDir, config) {
  const fs = await import("node:fs/promises");
  const filePath = path.resolve(typeof rootDir === "string" ? rootDir : process.cwd(), DEFAULT_CONFIG_PATH);
  await fs.writeFile(filePath, JSON.stringify(config, null, 2), "utf8");
  return config;
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
        results.push({
          country: countryCode,
          countryName: countryConfig.name || countryCode,
          success: false,
          error: `invalid JSON response: ${body.slice(0, 200)}`,
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
