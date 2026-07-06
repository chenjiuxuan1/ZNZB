import path from "node:path";
import { ensureGrafanaCookie } from "./browser-auth.mjs";
import { parseDashboardUrl, resolveTimeRange } from "./config.mjs";
import { buildPanelQueries, flattenPanels, getDashboardTimeRange } from "./dashboard.mjs";
import { buildPanelSnapshot } from "./frame-data.mjs";
import { getGrafanaAccess } from "./runner.mjs";
import { deepMapStrings, readJsonFile } from "./utils.mjs";

const ENV_PATTERN = /\$\{([A-Z0-9_]+)\}/g;

export async function collectDataQualityMetrics(options = {}) {
  const config = options.config || {};
  if (config.enabled === false) {
    return null;
  }

  const countriesFile = path.resolve(config.countriesFile || "./config/countries.config.json");
  const countriesConfig = await readJsonFile(countriesFile, { countries: [] });
  const countries = (countriesConfig.countries || []).filter((country) => {
    return country.status !== "disabled" && country.dataQualityDashboardUrl;
  });

  const results = [];
  for (const country of countries) {
    results.push(await collectCountryDataQuality(country, config));
  }

  return {
    checkedAt: new Date().toISOString(),
    countries: results,
  };
}

async function collectCountryDataQuality(country, options) {
  try {
    const config = await buildCountryGrafanaConfig(country, options);
    await ensureGrafanaCookie(config);
    const { client, dashboardResponse } = await getGrafanaAccess(config);

    try {
      const dashboard = dashboardResponse.dashboard;
      const panels = flattenPanels(dashboard);
      const targetPanels = selectTargetPanels(panels, options.panelTitlePattern);

      if (targetPanels.length === 0) {
        return buildCountryResult(country, {
          status: "noPanel",
          error: `未找到匹配面板：${options.panelTitlePattern || "当前异常数|异常数"}`,
        });
      }

      const timeRange = resolveTimeRange(options.timeRange || getDashboardTimeRange(dashboard));
      const panelValues = [];
      for (const panel of targetPanels) {
        const queries = buildPanelQueries(panel, config.variables);
        if (queries.length === 0) {
          continue;
        }

        const queryResponse = await client.queryData(queries, timeRange);
        const snapshot = buildPanelSnapshot(panel, queryResponse);
        const values = selectLatestNumericValues(snapshot, options.valueFieldNamePattern);
        if (values.length > 0) {
          panelValues.push({
            panelId: panel.id,
            panelTitle: panel.title || `Panel ${panel.id}`,
            values,
          });
        }
      }

      if (panelValues.length === 0) {
        return buildCountryResult(country, {
          status: "noData",
          error: "匹配面板没有返回数值",
        });
      }

      return buildCountryResult(country, {
        status: "ok",
        currentAnomalyCount: aggregatePanelValues(panelValues, options.aggregation || "sum"),
        dashboardUrl: country.dataQualityDashboardUrl,
        panels: panelValues.map((panel) => ({
          panelId: panel.panelId,
          panelTitle: panel.panelTitle,
          valueCount: panel.values.length,
        })),
      });
    } finally {
      await client.close?.();
    }
  } catch (error) {
    return buildCountryResult(country, {
      status: "error",
      error: error.message,
    });
  }
}

async function buildCountryGrafanaConfig(country, options) {
  const monitorConfigFile = path.resolve(country.monitorConfigFile || inferMonitorConfigFile(country.code));
  const rawConfig = deepMapStrings(await readJsonFile(monitorConfigFile), interpolateEnvString);
  const urlMetadata = parseDashboardUrl(country.dataQualityDashboardUrl);

  return {
    stateFile: ".state/monitor-state.json",
    schedule: { intervalMinutes: 10 },
    browserAuth: {
      enabled: true,
      headless: true,
      apiHeadless: true,
      authWarmupUrl: country.grafanaDashboardUrl,
      storageStateFile: ".state/grafana-storage-state.json",
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    },
    alerts: { channel: "console", sendRecovery: true },
    variables: {},
    builtInChecks: { queryError: true, noData: true },
    ...rawConfig,
    silent: true,
    country: {
      code: country.code,
      name: country.name,
      timezone: country.timezone,
    },
    grafana: {
      ...rawConfig.grafana,
      dashboardUrl: country.dataQualityDashboardUrl,
      baseUrl: urlMetadata.baseUrl,
      dashboardUid: urlMetadata.dashboardUid,
      orgId: urlMetadata.orgId,
      requestTimeoutSeconds: options.requestTimeoutSeconds || rawConfig.grafana?.requestTimeoutSeconds || 20,
    },
    timeRange: options.timeRange || urlMetadata.timeRange || rawConfig.timeRange,
  };
}

function inferMonitorConfigFile(countryCode) {
  const normalized = String(countryCode || "").toLowerCase();
  if (normalized === "id") {
    return "./config/monitor.config.json";
  }
  return `./config/monitor.${normalized}.json`;
}

function selectTargetPanels(panels, pattern) {
  const regex = new RegExp(pattern || "当前异常数|异常数|current\\s*anomal", "i");
  return panels.filter((panel) => regex.test(panel.title || ""));
}

function selectLatestNumericValues(snapshot, pattern) {
  const regex = pattern ? new RegExp(pattern, "i") : null;
  return (snapshot.numericSeries || [])
    .filter((series) => !regex || regex.test(series.fieldName || ""))
    .map((series) => Number(series.latestValue))
    .filter(Number.isFinite);
}

function aggregatePanelValues(panelValues, aggregation) {
  const values = panelValues.flatMap((panel) => panel.values);
  if (values.length === 0) {
    return null;
  }

  if (aggregation === "max") {
    return Math.max(...values);
  }

  if (aggregation === "first") {
    return values[0];
  }

  return values.reduce((sum, value) => sum + value, 0);
}

function buildCountryResult(country, payload) {
  return {
    countryCode: country.code,
    countryName: country.name,
    timezone: country.timezone,
    ...payload,
  };
}

function interpolateEnvString(value) {
  return value.replace(ENV_PATTERN, (_, envKey) => process.env[envKey] ?? "");
}
