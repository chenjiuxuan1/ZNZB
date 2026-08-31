#!/usr/bin/env node

import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPlatformApi } from "./platform-api.mjs";
import { createAlertCenter } from "./alert-center.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const webDir = path.join(rootDir, "web");
const api = createPlatformApi({ rootDir });
const alertCenter = createAlertCenter({ rootDir });
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

server.listen(port, host, () => {
  console.log(`Duty platform running at http://${host}:${port}`);
});

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
  if (method === "GET" && url.pathname === "/api/rules") {
    return sendJson(response, 200, await api.getRulesConfig());
  }
  if (method === "PUT" && url.pathname === "/api/rules") {
    return sendJson(response, 200, await api.saveRulesConfig(await readBody(request)));
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

  // ---- 告警中心 / 综合监控 (n8n + 夜莺) ----
  if (method === "GET" && url.pathname === "/api/alerts/overview") {
    return sendJson(response, 200, await alertCenter.getMonitorOverview());
  }
  if (method === "GET" && url.pathname === "/api/alerts/active") {
    const params = Object.fromEntries(url.searchParams.entries());
    return sendJson(response, 200, await alertCenter.getActiveAlerts({
      busiGroup: params.busiGroup || undefined,
      severity: params.severity !== undefined ? params.severity : undefined,
      limit: params.limit || 200,
    }));
  }
  if (method === "GET" && url.pathname === "/api/alerts/history") {
    const params = Object.fromEntries(url.searchParams.entries());
    return sendJson(response, 200, await alertCenter.getHistoryAlerts({
      stime: params.stime ? Number(params.stime) : undefined,
      etime: params.etime ? Number(params.etime) : undefined,
      limit: params.limit || 200,
      page: params.page || 1,
      ruleName: params.ruleName || undefined,
    }));
  }
  if (method === "GET" && url.pathname === "/api/alerts/busi-groups") {
    return sendJson(response, 200, await alertCenter.getBusiGroups());
  }
  if (method === "GET" && url.pathname === "/api/alerts/rules") {
    const params = Object.fromEntries(url.searchParams.entries());
    return sendJson(response, 200, await alertCenter.getAlertRules(params.busiGroup));
  }
  if (method === "GET" && url.pathname === "/api/alerts/datasources") {
    return sendJson(response, 200, await alertCenter.getDatasources());
  }
  if (method === "GET" && url.pathname === "/api/alerts/notify-rules") {
    return sendJson(response, 200, await alertCenter.getNotifyRules());
  }
  if (method === "GET" && url.pathname === "/api/alerts/n8n/workflows") {
    const params = Object.fromEntries(url.searchParams.entries());
    return sendJson(response, 200, await alertCenter.getN8nWorkflows({
      active: params.active !== undefined ? params.active === "true" : undefined,
      limit: params.limit || 100,
    }));
  }
  if (method === "GET" && url.pathname === "/api/alerts/n8n/executions") {
    const params = Object.fromEntries(url.searchParams.entries());
    return sendJson(response, 200, await alertCenter.getN8nExecutions({
      status: params.status || undefined,
      limit: params.limit || 50,
    }));
  }
  if (method === "GET" && url.pathname === "/api/alerts/config") {
    return sendJson(response, 200, await alertCenter.getConfig());
  }
  if (method === "GET" && url.pathname === "/api/alerts/health") {
    return sendJson(response, 200, await alertCenter.getHealth());
  }
  return sendJson(response, 404, { error: `Not found: ${method} ${url.pathname}` });
}

async function readBody(request, fallback = null) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) {
    return fallback;
  }
  return JSON.parse(text);
}

async function serveStatic(response, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(webDir, safePath));
  if (!filePath.startsWith(webDir)) {
    return sendText(response, 403, "Forbidden");
  }
  try {
    const data = await fs.readFile(filePath);
    response.writeHead(200, { "Content-Type": contentType(filePath) });
    response.end(data);
  } catch {
    const data = await fs.readFile(path.join(webDir, "index.html"));
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
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
