#!/usr/bin/env node

import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPlatformApi } from "./platform-api.mjs";
import { createDsAutoRetryManager } from "./ds-auto-retry-manager.mjs";
import { cleanupLegacyDashboardUrls } from "./history-dashboard-url-cleanup.mjs";
import { loadEnvFile, readJsonRequestBody } from "./utils.mjs";
import { assertWarehouseLineageToolAuthorized, proxyWarehouseLineageRequest } from "./warehouse-lineage-proxy.mjs";
import { assertMetabaseAgentCallbackAuthorized } from "./metabase-agent-callback-auth.mjs";
import { proxyWattrelQuery, proxyDsSchedulerRequest, proxySrQuery } from "./evidence-tool-proxy.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const webDir = path.join(rootDir, "web");
await loadEnvFile(path.join(rootDir, ".env"));
try {
  const cleanup = await cleanupLegacyDashboardUrls({ rootDir });
  if (cleanup.changedFileCount > 0) {
    console.log(`[history-url-cleanup] removed ${cleanup.removedFieldCount} legacy dashboardUrl fields from ${cleanup.changedFileCount} files; backups saved under config/history-url-backups`);
  }
} catch (error) {
  console.error("[history-url-cleanup] failed:", error);
}
const dsAutoRetryManager = createDsAutoRetryManager({ rootDir });
const api = createPlatformApi({ rootDir, dsAutoRetryManager });
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "127.0.0.1";

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }
    await serveStatic(response, url.pathname);
  } catch (error) {
    sendJson(response, error.statusCode || 500, {
      error: error.message,
      errors: error.errors || undefined,
    });
  }
});

server.requestTimeout = 600_000;
server.listen(port, host, () => {
  console.log(`Duty platform running at http://${host}:${port}`);
});
startBatchScheduler();
startDsScheduler();
startHiveScheduler();
dsAutoRetryManager.start();

async function handleApi(request, response, url) {
  const method = request.method || "GET";
  if (method === "GET" && url.pathname === "/api/summary") {
    return sendJson(response, 200, await api.getSummary());
  }
  if (method === "GET" && url.pathname === "/api/countries") {
    return sendJson(response, 200, await api.getCountries());
  }
  if (method === "PUT" && url.pathname === "/api/countries") {
    return sendJson(response, 200, await api.saveCountriesConfig(await readBody(request)));
  }
  if (method === "GET" && url.pathname === "/api/inventory") {
    return sendJson(response, 200, await api.getInventory(Object.fromEntries(url.searchParams.entries())));
  }
  if (method === "POST" && url.pathname === "/api/inventory/manual") {
    return sendJson(response, 200, await api.addManualDashboard(await readBody(request, {})));
  }
  if (method === "DELETE" && url.pathname === "/api/inventory/dashboard") {
    return sendJson(response, 200, await api.deleteDashboard(await readBody(request, {})));
  }
  if (method === "POST" && url.pathname === "/api/inventory/discover-one") {
    return sendJson(response, 200, await api.discoverManualDashboard(await readBody(request, {})));
  }
  if (method === "POST" && url.pathname === "/api/inventory/discover") {
    const body = await readBody(request, {});
    return sendJson(response, 200, await api.discoverCountryDashboards(body.countryCode));
  }
  if (method === "POST" && url.pathname === "/api/inventory/discover-all/start") {
    const started = api.startDiscoverAllCountryDashboards();
    return sendJson(response, 202, { started: started.started, progress: started.progress });
  }
  if (method === "GET" && url.pathname === "/api/inventory/discover-all/progress") {
    return sendJson(response, 200, api.getDiscoverAllCountryDashboardsProgress());
  }
  if (method === "POST" && url.pathname === "/api/inventory/discover-all") {
    return sendJson(response, 200, await api.discoverAllCountryDashboards());
  }
  if (method === "GET" && url.pathname === "/api/rules") {
    return sendJson(response, 200, await api.getRulesConfig());
  }
  if (method === "PUT" && url.pathname === "/api/rules") {
    return sendJson(response, 200, await api.saveRulesConfig(await readBody(request)));
  }
  if (method === "GET" && url.pathname === "/api/batch-schedule") {
    return sendJson(response, 200, await api.getBatchSchedule());
  }
  if (method === "GET" && url.pathname === "/api/batch-schedule/progress") {
    return sendJson(response, 200, await api.getBatchScheduleRunProgress());
  }
  if (method === "GET" && url.pathname === "/api/batch-history") {
    return sendJson(response, 200, await api.getBatchHistory(Object.fromEntries(url.searchParams.entries())));
  }
  if (method === "POST" && url.pathname === "/api/fluctuation-visual/series") {
    return sendJson(response, 200, await api.getFluctuationVisualSeries(await readBody(request, {})));
  }
  if (method === "POST" && url.pathname === "/api/fluctuation-metric-tags/lookup") {
    return sendJson(response, 200, await api.getFluctuationMetricTags(await readBody(request, {})));
  }
  if (method === "PUT" && url.pathname === "/api/fluctuation-metric-tags") {
    return sendJson(response, 200, await api.updateFluctuationMetricTag(await readBody(request, {})));
  }
  if (method === "POST" && url.pathname === "/api/metabase-anomaly-analysis") {
    return sendJson(response, 200, await api.analyzeMetabaseAnomaly(await readBody(request, {})));
  }
  if (method === "GET" && url.pathname === "/api/metabase-anomaly-analysis/display-index") {
    return sendJson(response, 200, await api.getMetabaseAnomalyAnalysisDisplayIndex(Object.fromEntries(url.searchParams.entries())));
  }
 if (method === "GET" && url.pathname === "/api/metabase-anomaly-analyses") {
   return sendJson(response, 200, await api.getMetabaseAnomalyAnalysesForRun(Object.fromEntries(url.searchParams.entries())));
 }
  if (method === "GET" && url.pathname === "/api/metabase-anomaly-analysis/diagnostic") {
    return sendJson(response, 200, await api.diagnoseMetabaseAnomalyAgent());
  }
  if (method === "POST" && url.pathname === "/api/metabase-anomaly-analysis/rerun") {
    const body = await readBody(request, {});
    return sendJson(response, 202, await api.startRerunMetabaseAnomalyAnalysis(body));
  }
 if (method === "GET" && url.pathname === "/api/metabase-anomaly-analysis") {
    return sendJson(response, 200, await api.getMetabaseAnomalyAnalysis(Object.fromEntries(url.searchParams.entries())));
  }
  if (method === "POST" && url.pathname === "/api/metabase-anomaly-analysis/card-sql") {
    const body = await readBody(request, {});
    assertMetabaseAgentCallbackAuthorized(request, body);
    return sendJson(response, 200, await api.getMetabaseAnomalyCardSql(body));
  }
  if (method === "POST" && url.pathname === "/api/metabase-anomaly-analysis/callback") {
    const body = await readBody(request, {});
    assertMetabaseAgentCallbackAuthorized(request, body);
    return sendJson(response, 200, await api.completeMetabaseAnomalyAnalysis(body));
  }
 if (method === "POST" && url.pathname === "/api/metabase-anomaly-analysis/batch-callback") {
   const body = await readBody(request, {});
   console.error(`[server] batch-callback: auth=${request.headers.authorization ? "present" : "missing"} keys=${Object.keys(body).join(",")} results=${Array.isArray(body.results) ? body.results.length : 0}`);
   assertMetabaseAgentCallbackAuthorized(request, body);
   return sendJson(response, 200, await api.completeMetabaseAnomalyBatch(body));
 }
 if (method === "POST" && url.pathname === "/api/metabase-anomaly-analysis/evidence-snapshot") {
    const body = await readBody(request, {});
    assertMetabaseAgentCallbackAuthorized(request, body);
    return sendJson(response, 200, await api.saveMetabaseAnomalyEvidenceSnapshot(body));
  }
  if (method === "POST" && url.pathname === "/api/tools/warehouse-lineage") {
    const body = await readBody(request, {});
    return sendJson(response, 200, await proxyWarehouseLineageRequest(body));
  }
  if (method === "POST" && url.pathname === "/api/tools/metabase-card-sql") {
    const body = await readBody(request, {});
    return sendJson(response, 200, await api.getMetabaseAnomalyCardSql(body));
  }
  if (method === "POST" && url.pathname === "/api/tools/wattrel-query") {
    const body = await readBody(request, {});
    return sendJson(response, 200, await proxyWattrelQuery(body));
  }
  if (method === "POST" && url.pathname === "/api/tools/ds-scheduler") {
    const body = await readBody(request, {});
    return sendJson(response, 200, await proxyDsSchedulerRequest(body));
  }
  if (method === "POST" && url.pathname === "/api/tools/query-table-data") {
    const body = await readBody(request, {});
    return sendJson(response, 200, await proxySrQuery(body));
  }
  if (method === "POST" && url.pathname === "/api/tools/current-anomaly-evidence") {
    return sendJson(response, 200, await api.getMetabaseAnomalyEvidenceSnapshot(await readBody(request, {})));
  }
  if (method === "POST" && url.pathname === "/api/external-alert-runs") {
    return sendJson(response, 200, await api.ingestExternalAlertRun(await readBody(request, {})));
  }
  if (method === "POST" && url.pathname === "/api/wattrel/query") {
    return sendJson(response, 200, await api.queryWattrelAlerts(await readBody(request, {})));
  }
  if (method === "POST" && url.pathname === "/api/wattrel/current") {
    return sendJson(response, 200, await api.getCurrentWattrelAlerts(await readBody(request, {})));
  }
  if (method === "POST" && url.pathname === "/api/quality-rule-generation/sheet") {
    return sendJson(response, 200, await api.getQualityRuleGenerationSheet(await readBody(request, {})));
  }
  if (method === "POST" && url.pathname === "/api/quality-rule-generation/submit") {
    return sendJson(response, 200, await api.submitQualityRuleGenerationRow(await readBody(request, {})));
  }
  if (method === "PUT" && url.pathname === "/api/batch-schedule") {
    return sendJson(response, 200, await api.saveBatchSchedule(await readBody(request, {})));
  }
  if (method === "POST" && url.pathname === "/api/batch-schedule/run-now") {
    if (api.isBatchScheduleRunning()) {
      return sendJson(response, 409, { error: "巡检正在运行中，请等待完成后再试。" });
    }
    api.runBatchScheduleNow().catch((error) => console.error("[batch-schedule] run-now background error:", error.message));
    return sendJson(response, 200, { started: true });
  }
  if (method === "POST" && url.pathname === "/api/batch-schedule/stop") {
    return sendJson(response, 200, api.stopBatchScheduleRun());
  }
  if (method === "POST" && url.pathname === "/api/sandbox/evaluate") {
    return sendJson(response, 200, await api.evaluateSandbox(await readBody(request)));
  }
  if (method === "POST" && url.pathname === "/api/sandbox/evaluate-live") {
    return sendJson(response, 200, await api.evaluateLiveSandbox(await readBody(request)));
  }
  if (method === "POST" && url.pathname === "/api/batch-check") {
    return sendJson(response, 200, await api.runBatchCheck(await readBody(request, {})));
  }
  if (method === "POST" && url.pathname === "/api/batch-check-and-notify") {
    return sendJson(response, 200, await api.runBatchCheckAndNotify(await readBody(request, {})));
  }
  if (method === "POST" && url.pathname === "/api/notify-preview") {
    const body = await readBody(request, {});
    return sendJson(response, 200, await api.getNotifyPreview(body?.result || null, body?.options || {}));
  }
  if (method === "POST" && url.pathname === "/api/notify-test") {
    return sendJson(response, 200, await api.sendNotifyTest(await readBody(request, {})));
  }
  if (method === "GET" && url.pathname === "/api/hive-scheduler/config") {
    return sendJson(response, 200, await api.getHiveSchedulerConfig());
  }
  if (method === "PUT" && url.pathname === "/api/hive-scheduler/config") {
    return sendJson(response, 200, await api.saveHiveSchedulerConfig(await readBody(request, {})));
  }
  if (method === "POST" && url.pathname === "/api/hive-scheduler/check") {
    return sendJson(response, 200, await api.checkAllHiveCountries());
  }
  if (method === "GET" && url.pathname === "/api/hive-scheduler/schedule") {
    return sendJson(response, 200, await api.getHiveSchedule());
  }
  if (method === "PUT" && url.pathname === "/api/hive-scheduler/schedule") {
    return sendJson(response, 200, await api.saveHiveSchedule(await readBody(request, {})));
  }
  if (method === "POST" && url.pathname === "/api/hive-scheduler/schedule/run-now") {
    return sendJson(response, 200, await api.runHiveScheduleNow());
  }
  if (method === "GET" && url.pathname === "/api/hive-scheduler/history") {
    return sendJson(response, 200, await api.getHiveHistory(Object.fromEntries(url.searchParams.entries())));
  }
  if (method === "GET" && url.pathname === "/api/ds-scheduler/config") {
    return sendJson(response, 200, await api.getDsSchedulerConfig());
  }
  if (method === "PUT" && url.pathname === "/api/ds-scheduler/config") {
    return sendJson(response, 200, await api.saveDsSchedulerConfig(await readBody(request)));
  }
  if (method === "POST" && url.pathname === "/api/ds-scheduler/check") {
    return sendJson(response, 200, await api.checkAllDsCountries());
  }
  if (method === "GET" && url.pathname === "/api/ds-failure-logs") {
    return sendJson(response, 200, await api.getDsFailureLogs(Object.fromEntries(url.searchParams.entries())));
  }
  if (method === "GET" && url.pathname === "/api/ds-failure-retry/control") {
    return sendJson(response, 200, api.getDsFailureRetryControl());
  }
  if (method === "POST" && url.pathname === "/api/ds-failure-retry/start") {
    return sendJson(response, 200, api.startDsFailureRetry(await readBody(request, {})));
  }
  if (method === "POST" && url.pathname === "/api/ds-failure-retry/config") {
    return sendJson(response, 200, api.configureDsFailureRetry(await readBody(request, {})));
  }
  if (method === "POST" && url.pathname === "/api/ds-failure-retry/run-now") {
    return sendJson(response, 200, api.runDsFailureRetryNow(await readBody(request, {})));
  }
  if (method === "POST" && url.pathname === "/api/ds-failure-retry/stop") {
    return sendJson(response, 200, api.stopDsFailureRetry());
  }
  if (method === "GET" && url.pathname === "/api/ds-failure-retry/logs") {
    return sendJson(response, 200, api.getDsFailureRetryLogs(Object.fromEntries(url.searchParams.entries())));
  }
  if (method === "GET" && url.pathname === "/api/ds-scheduler/notification") {
    return sendJson(response, 200, await api.getDsNotificationConfig());
  }
  if (method === "PUT" && url.pathname === "/api/ds-scheduler/notification") {
    return sendJson(response, 200, await api.saveDsNotificationConfig(await readBody(request, {})));
  }
  if (method === "POST" && url.pathname === "/api/ds-scheduler/notification/preview") {
    return sendJson(response, 200, await api.previewDsNotification(await readBody(request, {})));
  }
  if (method === "POST" && url.pathname === "/api/ds-scheduler/notification/test") {
    return sendJson(response, 200, await api.sendDsNotificationTest(await readBody(request, {})));
  }
  if (method === "GET" && url.pathname === "/api/ds-scheduler/schedule") {
    return sendJson(response, 200, await api.getDsSchedule());
  }
  if (method === "PUT" && url.pathname === "/api/ds-scheduler/schedule") {
    return sendJson(response, 200, await api.saveDsSchedule(await readBody(request, {})));
  }
  if (method === "POST" && url.pathname === "/api/ds-scheduler/schedule/run-now") {
    return sendJson(response, 200, await api.runDsScheduleNow());
  }
  if (method === "GET" && url.pathname === "/api/ds-scheduler/history") {
    return sendJson(response, 200, await api.getDsHistory(Object.fromEntries(url.searchParams.entries())));
  }
  if (method === "GET" && url.pathname === "/api/ds-scheduler/usage") {
    return sendJson(response, 200, await api.getDsSchedulerUsage(Object.fromEntries(url.searchParams.entries())));
  }
  if (method === "POST" && url.pathname === "/api/ds-scheduler/usage/refresh") {
    return sendJson(response, 200, await api.refreshDsSchedulerUsage(await readBody(request, {})));
  }
  return sendJson(response, 404, { error: `Not found: ${method} ${url.pathname}` });
}

function startBatchScheduler() {
  let running = false;
  const tick = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      const result = await api.runDueBatchSchedule();
      if (result.ran) {
        console.log(`Batch public check schedule ran at ${new Date().toISOString()}`);
      }
    } catch (error) {
      console.error("Batch public check schedule failed:", error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, 60_000);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  setTimeout(tick, 5_000).unref?.();
}

function startDsScheduler() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await api.runDueDsSchedule();
      if (result.ran) console.log(`DS scheduler check ran at ${new Date().toISOString()}`);
    } catch (error) {
      console.error("DS scheduler check failed:", error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, 60_000);
  timer.unref?.();
  setTimeout(tick, 8_000).unref?.();
}

function startHiveScheduler() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await api.runDueHiveSchedule();
      if (result.ran) console.log(`HIVE scheduler check ran at ${new Date().toISOString()}`);
    } catch (error) {
      console.error("HIVE scheduler check failed:", error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, 60_000);
  timer.unref?.();
  setTimeout(tick, 10_000).unref?.();
}

async function readBody(request, fallback = null) {
  return readJsonRequestBody(request, { fallback });
}

async function serveStatic(response, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(webDir, safePath));
  if (!filePath.startsWith(webDir)) {
    return sendText(response, 403, "Forbidden");
  }
  try {
    const data = await fs.readFile(filePath);
    response.writeHead(200, {
      "Content-Type": contentType(filePath),
      "Cache-Control": "no-store",
    });
    response.end(data);
  } catch {
    const data = await fs.readFile(path.join(webDir, "index.html"));
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(data);
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

function sendText(response, statusCode, text) {
  response.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(text);
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}
