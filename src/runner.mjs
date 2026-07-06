import path from "node:path";
import { ensureGrafanaCookie } from "./browser-auth.mjs";
import { BrowserGrafanaClient } from "./browser-grafana-client.mjs";
import { evaluateAnomalies } from "./checks.mjs";
import { resolveTimeRange } from "./config.mjs";
import {
  buildPanelQueries,
  describePanels,
  flattenPanels,
  getDashboardTimeRange,
} from "./dashboard.mjs";
import { buildPanelSnapshot } from "./frame-data.mjs";
import { GrafanaClient } from "./grafana-client.mjs";
import { notify } from "./notifier.mjs";
import { diffActiveAnomalies, loadState, saveState } from "./state-store.mjs";
import { sleep, writeJsonFile } from "./utils.mjs";

export async function discover(config, outputFile) {
  logStep(config, "开始读取 Grafana dashboard 元信息");
  const { client, dashboardResponse: response } = await getGrafanaAccess(config);
  try {
    const dashboard = response.dashboard;
    const panels = flattenPanels(dashboard);
    logStep(config, `读取成功：${dashboard.title}，共 ${panels.length} 个面板`);

    const summary = {
      country: config.country || null,
      title: dashboard.title,
      uid: dashboard.uid,
      timeRange: dashboard.time || null,
      panels: describePanels(panels),
    };

    if (outputFile) {
      await writeJsonFile(path.resolve(outputFile), summary);
      logStep(config, `面板清单已写入 ${path.resolve(outputFile)}`);
    }

    return summary;
  } finally {
    await client.close?.();
  }
}

export async function runCheck(config) {
  logStep(config, "开始执行报表巡检");
  const { client, dashboardResponse } = await getGrafanaAccess(config);
  try {
    const dashboard = dashboardResponse.dashboard;
    const panels = flattenPanels(dashboard);
    const dashboardTimeRange = getDashboardTimeRange(dashboard);
    const timeRange = resolveTimeRange(config.timeRange || dashboardTimeRange);
    const snapshots = new Map();

    for (const panel of panels) {
      const queries = buildPanelQueries(panel, config.variables);
      if (queries.length === 0) {
        continue;
      }

      const queryResponse = await client.queryData(queries, timeRange);
      snapshots.set(panel.id, buildPanelSnapshot(panel, queryResponse));
    }

    const result = evaluateAnomalies({
      config,
      dashboard,
      panels,
      snapshots,
      nowMs: Date.now(),
    });

    const previousState = await loadState(config.stateFile);
    const { nextState, newAnomalies, recoveries } = diffActiveAnomalies(previousState, result.anomalies);

    if (newAnomalies.length > 0 || (config.alerts?.sendRecovery && recoveries.length > 0)) {
      await notify(config, {
        dashboardTitle: result.dashboardTitle,
        newAnomalies,
        recoveries: config.alerts?.sendRecovery ? recoveries : [],
      });
    }

    await saveState(config.stateFile, nextState);

    return {
      ...result,
      panelCount: panels.length,
      checkedCount: snapshots.size,
      timeRange,
      newAnomalies,
      recoveries,
    };
  } finally {
    await client.close?.();
  }
}

export async function watch(config) {
  const intervalMs = (config.schedule?.intervalMinutes || 10) * 60_000;

  while (true) {
    try {
      const result = await runCheck(config);
      console.log(
        `[watch] checked=${result.checkedCount} active=${result.anomalies.length} new=${result.newAnomalies.length}`,
      );
    } catch (error) {
      console.error(`[watch] ${error.message}`);
    }

    await sleep(intervalMs);
  }
}

export async function getGrafanaAccess(config) {
  const directClient = new GrafanaClient(config);

  try {
    logStep(config, "先尝试直接调用 Grafana API");
    const dashboardResponse = await directClient.getDashboardByUid(config.grafana.dashboardUid);
    logStep(config, "Grafana API 直接访问成功");
    return { client: directClient, dashboardResponse };
  } catch (error) {
    logStep(config, `Grafana API 直接访问失败：${error.message}`);
    const canRetryWithBrowser =
      config.browserAuth?.enabled !== false
      && (config.grafana.username || config.grafana.cookie || config.browserAuth?.userDataDir);
    const looksLikeAuthGatewayIssue =
      error.message.includes("Expected JSON response but got text/html")
      || error.message.includes("401");

    if (!canRetryWithBrowser || !looksLikeAuthGatewayIssue) {
      throw error;
    }

    logStep(config, "改用浏览器登录态重试");
    await ensureGrafanaCookie(config);
    const cookieClient = new GrafanaClient(config);
    try {
      logStep(config, "使用浏览器登录态重新调用 Grafana API");
      const dashboardResponse = await cookieClient.getDashboardByUid(config.grafana.dashboardUid);
      return { client: cookieClient, dashboardResponse };
    } catch (cookieError) {
      logStep(config, `浏览器登录态直连 API 仍失败：${cookieError.message}`);
      logStep(config, "改在 Chrome 页面内请求 Grafana API");
      const browserClient = await BrowserGrafanaClient.create(config);
      try {
        const dashboardResponse = await browserClient.getDashboardByUid(config.grafana.dashboardUid);
        return { client: browserClient, dashboardResponse };
      } catch (browserError) {
        await browserClient.close?.();
        throw browserError;
      }
    }
  }
}

function logStep(config, message) {
  if (config.silent) {
    return;
  }
  console.error(`[discover] ${message}`);
}
