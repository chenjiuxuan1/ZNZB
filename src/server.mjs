#!/usr/bin/env node

import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";

const gzip = promisify(zlib.gzip);
import { fileURLToPath } from "node:url";
import { createPlatformApi } from "./platform-api.mjs";
import { loadEnvFile } from "./utils.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const webDir = path.join(rootDir, "web");
await loadEnvFile(path.join(rootDir, ".env"));
const api = createPlatformApi({ rootDir });
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "127.0.0.1";

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }
    await serveStatic(request, response, url.pathname);
  } catch (error) {
    sendJson(response, error.statusCode || 500, {
      error: error.message,
      errors: error.errors || undefined,
    });
  }
});

const staticFileCache = new Map();
const JSON_CACHE_TTL_MS = Number(process.env.JSON_CACHE_TTL_MS || 30_000);
const jsonResponseCache = new Map();

function cacheJsonResponse(cacheKey, statusCode, payload) {
  if (JSON_CACHE_TTL_MS <= 0) {
    return;
  }
  jsonResponseCache.set(cacheKey, {
    statusCode,
    payload,
    cachedAt: Date.now(),
  });
}

function getCachedJsonResponse(cacheKey) {
  const entry = jsonResponseCache.get(cacheKey);
  if (!entry) {
    return null;
  }
  if (Date.now() - entry.cachedAt > JSON_CACHE_TTL_MS) {
    jsonResponseCache.delete(cacheKey);
    return null;
  }
  return entry;
}

function invalidateJsonCachePrefix(prefix) {
  for (const key of jsonResponseCache.keys()) {
    if (key.startsWith(prefix)) {
      jsonResponseCache.delete(key);
    }
  }
}

server.listen(port, host, () => {
  console.log(`Duty platform running at http://${host}:${port}`);
});
startBatchScheduler();
startDsScheduler();

async function handleApi(request, response, url) {
  const method = request.method || "GET";
  const isGet = method === "GET";
  const cacheKey = isGet ? `${url.pathname}${url.search || ""}` : "";

  if (!isGet) {
    // Every mutation can affect summary, inventory, schedules, or history.
    // Clearing the small in-memory GET cache prevents the UI from showing
    // stale data for up to JSON_CACHE_TTL_MS immediately after a save/run.
    jsonResponseCache.clear();
  }

  if (isGet && cacheKey) {
    const cached = getCachedJsonResponse(cacheKey);
    if (cached) {
      return sendJsonFromCache(request, response, cached.statusCode, cached.payload);
    }
  }

  const sendJsonCached = async (statusCode, payload) => {
    if (isGet && cacheKey && statusCode === 200) {
      cacheJsonResponse(cacheKey, statusCode, payload);
    }
    return sendJsonCompressed(request, response, statusCode, payload);
  };

  if (method === "GET" && url.pathname === "/api/summary") {
    return sendJsonCached(200, await api.getSummary());
  }
  if (method === "GET" && url.pathname === "/api/countries") {
    return sendJsonCached(200, await api.getCountries());
  }
  if (method === "PUT" && url.pathname === "/api/countries") {
    return sendJsonCached(200, await api.saveCountriesConfig(await readBody(request)));
  }
  if (method === "GET" && url.pathname === "/api/inventory") {
    return sendJsonCached(200, await api.getInventory(Object.fromEntries(url.searchParams.entries())));
  }
  if (method === "GET" && url.pathname === "/api/rules") {
    return sendJsonCached(200, await api.getRulesConfig());
  }
  if (method === "PUT" && url.pathname === "/api/rules") {
    return sendJsonCached(200, await api.saveRulesConfig(await readBody(request)));
  }
  if (method === "GET" && url.pathname === "/api/batch-schedule") {
    return sendJsonCached(200, await api.getBatchSchedule());
  }
  if (method === "GET" && url.pathname === "/api/batch-schedule/progress") {
    return sendJsonCached(200, await api.getBatchScheduleRunProgress());
  }
  if (method === "GET" && url.pathname === "/api/batch-history") {
    return sendJsonCached(200, await api.getBatchHistory(Object.fromEntries(url.searchParams.entries())));
  }
  if (method === "POST" && url.pathname === "/api/external-alert-runs") {
    return sendJsonCached(200, await api.ingestExternalAlertRun(await readBody(request, {})));
  }
  if (method === "POST" && url.pathname === "/api/wattrel/query") {
    return sendJsonCached(200, await api.queryWattrelAlerts(await readBody(request, {})));
  }
  if (method === "POST" && url.pathname === "/api/wattrel/current") {
    return sendJsonCached(200, await api.getCurrentWattrelAlerts(await readBody(request, {})));
  }
  if (method === "POST" && url.pathname === "/api/quality-rule-generation/sheet") {
    return sendJsonCached(200, await api.getQualityRuleGenerationSheet(await readBody(request, {})));
  }
  if (method === "POST" && url.pathname === "/api/quality-rule-generation/submit") {
    return sendJsonCached(200, await api.submitQualityRuleGenerationRow(await readBody(request, {})));
  }
  if (method === "PUT" && url.pathname === "/api/batch-schedule") {
    return sendJsonCached(200, await api.saveBatchSchedule(await readBody(request, {})));
  }
  if (method === "POST" && url.pathname === "/api/batch-schedule/run-now") {
    return sendJsonCached(200, await api.runBatchScheduleNow());
  }
  if (method === "POST" && url.pathname === "/api/sandbox/evaluate") {
    return sendJsonCached(200, await api.evaluateSandbox(await readBody(request)));
  }
  if (method === "POST" && url.pathname === "/api/sandbox/evaluate-live") {
    return sendJsonCached(200, await api.evaluateLiveSandbox(await readBody(request)));
  }
  if (method === "POST" && url.pathname === "/api/batch-check") {
    return sendJsonCached(200, await api.runBatchCheck(await readBody(request, {})));
  }
  if (method === "POST" && url.pathname === "/api/batch-check-and-notify") {
    return sendJsonCached(200, await api.runBatchCheckAndNotify(await readBody(request, {})));
  }
  if (method === "POST" && url.pathname === "/api/notify-preview") {
    const body = await readBody(request, {});
    return sendJsonCached(200, await api.getNotifyPreview(body?.result || null, body?.options || {}));
  }
  if (method === "POST" && url.pathname === "/api/notify-test") {
    return sendJsonCached(200, await api.sendNotifyTest(await readBody(request, {})));
  }
  if (method === "GET" && url.pathname === "/api/ds-scheduler/config") {
    return sendJsonCached(200, await api.getDsSchedulerConfig());
  }
  if (method === "PUT" && url.pathname === "/api/ds-scheduler/config") {
    return sendJsonCached(200, await api.saveDsSchedulerConfig(await readBody(request)));
  }
  if (method === "POST" && url.pathname === "/api/ds-scheduler/check") {
    return sendJsonCached(200, await api.checkAllDsCountries());
  }
  if (method === "GET" && url.pathname === "/api/ds-scheduler/schedule") {
    return sendJsonCached(200, await api.getDsSchedule());
  }
  if (method === "GET" && url.pathname === "/api/ds-scheduler/schedule/progress") {
    return sendJsonCached(200, await api.getDsScheduleRunProgress());
  }
  if (method === "GET" && url.pathname === "/api/ds-scheduler/history") {
    return sendJsonCached(200, await api.getDsHistory(Object.fromEntries(url.searchParams.entries())));
  }
  if (method === "PUT" && url.pathname === "/api/ds-scheduler/schedule") {
    return sendJsonCached(200, await api.saveDsSchedule(await readBody(request, {})));
  }
  if (method === "POST" && url.pathname === "/api/ds-scheduler/schedule/run-now") {
    return sendJsonCached(200, await api.runDsScheduleNow());
  }
  if (method === "POST" && url.pathname === "/api/ds-scheduler/check-and-notify") {
    return sendJsonCached(200, await api.runDsCheckAndNotify(await readBody(request, {})));
  }
  if (method === "POST" && url.pathname === "/api/ds-scheduler/notify-test") {
    return sendJsonCached(200, await api.sendDsNotifyTest(await readBody(request, {})));
  }
  if (method === "POST" && url.pathname === "/api/ds-scheduler/notify-preview") {
    return sendJsonCached(200, await api.getDsNotifyPreview(await readBody(request, {})));
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
    if (running) {
      return;
    }
    running = true;
    try {
      const result = await api.runDueDsSchedule?.();
      if (result?.ran) {
        console.log(`DS scheduler ran at ${new Date().toISOString()}`);
      }
    } catch (error) {
      if (error && error.message && !String(error.message).includes("runDueDsSchedule")) {
        console.error("DS scheduler failed:", error);
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, 60_000);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  setTimeout(tick, 10_000).unref?.();
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

async function serveStatic(request, response, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(webDir, safePath));
  if (!filePath.startsWith(webDir)) {
    return sendText(response, 403, "Forbidden");
  }
  let data;
  let contentTypeValue;
  let cacheControl = "no-cache";
  try {
    const cached = staticFileCache.get(filePath);
    let stats = null;
    try {
      stats = await fs.stat(filePath);
    } catch {
      stats = null;
    }
    if (cached && stats && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      data = cached.data;
      contentTypeValue = cached.contentType;
    } else {
      data = await fs.readFile(filePath);
      contentTypeValue = contentType(filePath);
      if (stats && isCacheableAsset(filePath)) {
        staticFileCache.set(filePath, {
          data,
          contentType: contentTypeValue,
          mtimeMs: stats.mtimeMs,
          size: stats.size,
        });
      }
    }
    if (isLongCacheAsset(filePath)) {
      cacheControl = "public, max-age=31536000, immutable";
    } else if (isCacheableAsset(filePath)) {
      cacheControl = "public, max-age=60";
    }
  } catch {
    data = await fs.readFile(path.join(webDir, "index.html"));
    contentTypeValue = "text/html; charset=utf-8";
  }
  await sendCompressedResponse(request, response, 200, data, {
    "Content-Type": contentTypeValue,
    "Cache-Control": cacheControl,
  });
}

function isCacheableAsset(filePath) {
  return /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf)$/i.test(filePath);
}

function isLongCacheAsset(filePath) {
  return /[?&]v=/i.test(filePath) || /\.(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf)$/i.test(filePath);
}

async function sendCompressedResponse(request, response, statusCode, body, headers = {}) {
  const acceptEncoding = (request && request.headers && request.headers["accept-encoding"]) || "";
  const canGzip = /gzip/i.test(acceptEncoding);
  const bodyBuffer = Buffer.isBuffer(body) ? body : Buffer.from(body);

  if (canGzip && bodyBuffer.length > 1024) {
    const compressed = await gzip(bodyBuffer, { level: 6 });
    response.writeHead(statusCode, {
      ...headers,
      "Content-Encoding": "gzip",
      "Content-Length": compressed.length,
    });
    response.end(compressed);
    return;
  }

  response.writeHead(statusCode, {
    ...headers,
    "Content-Length": bodyBuffer.length,
  });
  response.end(bodyBuffer);
}

function sendJson(response, statusCode, payload) {
  const jsonStr = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate",
  });
  response.end(jsonStr);
}

async function sendJsonCompressed(request, response, statusCode, payload) {
  const jsonStr = JSON.stringify(payload);
  await sendCompressedResponse(request, response, statusCode, jsonStr, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate",
  });
}

function sendJsonFromCache(request, response, statusCode, payload) {
  return sendJsonCompressed(request, response, statusCode, payload);
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
