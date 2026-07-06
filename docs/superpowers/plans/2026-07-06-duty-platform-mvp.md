# Duty Platform MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a lightweight Web console inside the current project for reading duty-bot JSON config, editing monitor rules, running offline rule evaluation, and previewing notification messages.

**Architecture:** Add a small Node HTTP server that serves static frontend files and exposes local-only JSON APIs. Reuse the existing rule evaluator and notification formatter instead of rewriting monitoring logic. Keep Metabase as a direct platform concept; the MVP reads existing Metabase inventory JSON and does not rely on Grafana as a Metabase jump page.

**Tech Stack:** Node.js ESM, built-in `http`, plain browser JavaScript, HTML, CSS, existing project modules.

---

## File Structure

- Create `src/platform-validation.mjs`: local validation helpers for countries, rules, safe write targets, and API request bodies.
- Create `src/platform-api.mjs`: API handlers for summary, countries, inventory, rules, sandbox evaluation, and notification preview.
- Create `src/server.mjs`: static file server plus `/api/*` router.
- Create `web/index.html`: single page shell for the platform.
- Create `web/src/styles.css`: work-focused UI styling.
- Create `web/src/api.js`: browser API client.
- Create `web/src/state.js`: browser-side state and derived indexes.
- Create `web/src/app.js`: route handling and layout orchestration.
- Create `web/src/views/dashboard.js`: overview page.
- Create `web/src/views/countries.js`: country config page.
- Create `web/src/views/inventory.js`: Metabase dashboard/card inventory page.
- Create `web/src/views/rules.js`: monitor rule editor page.
- Create `web/src/views/sandbox.js`: offline rule test page.
- Create `web/src/views/notify-preview.js`: TV message preview page.
- Modify `package.json`: add `platform` script.
- Create `test/platform-validation.test.mjs`: validation unit tests.
- Create `test/platform-api.test.mjs`: API handler tests with temporary fixtures.

## Task 1: Validation Module

**Files:**
- Create: `src/platform-validation.mjs`
- Test: `test/platform-validation.test.mjs`

- [ ] **Step 1: Write validation tests**

Create `test/platform-validation.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSafeConfigPath,
  normalizeRuleMessages,
  validateCountriesConfig,
  validateRulesConfig,
  validateSandboxRequest,
} from "../src/platform-validation.mjs";

test("validateCountriesConfig accepts valid countries config", () => {
  const result = validateCountriesConfig({
    countries: [
      {
        code: "ID",
        name: "印尼",
        timezone: "Asia/Jakarta",
        grafanaDashboardUrl: "https://example.com/d/abc",
        dataQualityDashboardUrl: "https://example.com/d/quality",
        monitorConfigFile: "./config/monitor.id.json",
        status: "ready",
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("validateCountriesConfig rejects missing code and invalid urls", () => {
  const result = validateCountriesConfig({
    countries: [
      {
        code: "",
        name: "坏配置",
        timezone: "",
        grafanaDashboardUrl: "not-a-url",
        dataQualityDashboardUrl: "also-not-url",
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /countries\[0\]\.code/);
  assert.match(result.errors.join("\n"), /countries\[0\]\.timezone/);
  assert.match(result.errors.join("\n"), /grafanaDashboardUrl/);
});

test("validateRulesConfig accepts rule arrays and alert metadata", () => {
  const result = validateRulesConfig({
    builtInChecks: { queryError: false, noData: false },
    alerts: { channel: "tv", webhookUrl: "${TV_ALERT_WEBHOOK_URL}" },
    rules: [
      {
        type: "requiredDatePresent",
        dashboardTitle: "OKR",
        cardTitles: ["规模"],
        dateColumn: "统计日期",
        requiredLagDays: 0,
      },
    ],
  });

  assert.equal(result.ok, true);
});

test("validateRulesConfig rejects malformed rules", () => {
  const result = validateRulesConfig({
    rules: [
      { dashboardTitle: "OKR" },
      { type: "requiredDatePresent", parameters: {} },
    ],
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /rules\[0\]\.type/);
  assert.match(result.errors.join("\n"), /rules\[1\]\.parameters/);
});

test("validateSandboxRequest requires rows array and rule object", () => {
  const result = validateSandboxRequest({
    dashboard: {},
    card: {},
    rule: { type: "requiredDatePresent" },
    rows: [],
  });

  assert.equal(result.ok, true);

  const bad = validateSandboxRequest({ rule: null, rows: {} });
  assert.equal(bad.ok, false);
});

test("normalizeRuleMessages maps strings and arrays consistently", () => {
  assert.deepEqual(normalizeRuleMessages(null), []);
  assert.deepEqual(normalizeRuleMessages("bad"), ["bad"]);
  assert.deepEqual(normalizeRuleMessages(["a", "b"]), ["a", "b"]);
});

test("assertSafeConfigPath only allows known config files", () => {
  assert.equal(assertSafeConfigPath("countries"), "config/countries.config.json");
  assert.throws(() => assertSafeConfigPath("../package.json"), /Unsupported config target/);
});
```

- [ ] **Step 2: Run validation tests and verify they fail**

Run:

```bash
node --test test/platform-validation.test.mjs
```

Expected: fail because `src/platform-validation.mjs` does not exist.

- [ ] **Step 3: Implement validation helpers**

Create `src/platform-validation.mjs`:

```js
const SAFE_CONFIG_TARGETS = {
  countries: "config/countries.config.json",
  rules: "config/public-monitor.config.json",
};

const RULE_MATCH_FIELDS = [
  "countryCode",
  "countryName",
  "dashboardTitle",
  "dashboardTitles",
  "dashboardTitlePattern",
  "cardTitle",
  "cardTitles",
  "cardTitlePattern",
];

export function assertSafeConfigPath(target) {
  const filePath = SAFE_CONFIG_TARGETS[target];
  if (!filePath) {
    throw new Error(`Unsupported config target: ${target}`);
  }
  return filePath;
}

export function validateCountriesConfig(config) {
  const errors = [];
  if (!config || typeof config !== "object" || !Array.isArray(config.countries)) {
    return { ok: false, errors: ["countries must be an array"] };
  }

  config.countries.forEach((country, index) => {
    if (!country || typeof country !== "object") {
      errors.push(`countries[${index}] must be an object`);
      return;
    }
    requireString(errors, country.code, `countries[${index}].code`);
    requireString(errors, country.name, `countries[${index}].name`);
    requireString(errors, country.timezone, `countries[${index}].timezone`);
    optionalUrl(errors, country.grafanaDashboardUrl, `countries[${index}].grafanaDashboardUrl`);
    optionalUrl(errors, country.dataQualityDashboardUrl, `countries[${index}].dataQualityDashboardUrl`);
    if (country.monitorConfigFile !== undefined && typeof country.monitorConfigFile !== "string") {
      errors.push(`countries[${index}].monitorConfigFile must be a string`);
    }
    if (country.status !== undefined && typeof country.status !== "string") {
      errors.push(`countries[${index}].status must be a string`);
    }
  });

  return { ok: errors.length === 0, errors };
}

export function validateRulesConfig(config) {
  const errors = [];
  if (!config || typeof config !== "object") {
    return { ok: false, errors: ["rules config must be an object"] };
  }
  if (!Array.isArray(config.rules)) {
    return { ok: false, errors: ["rules must be an array"] };
  }

  config.rules.forEach((rule, index) => {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
      errors.push(`rules[${index}] must be an object`);
      return;
    }
    requireString(errors, rule.type, `rules[${index}].type`);
    const hasMatcher = RULE_MATCH_FIELDS.some((field) => rule[field] !== undefined);
    if (!hasMatcher) {
      errors.push(`rules[${index}] must include a dashboard/card/country matcher`);
    }
    for (const field of ["parameters", "exclude", "correlatedChangeSuppressions"]) {
      if (rule[field] !== undefined && !Array.isArray(rule[field])) {
        errors.push(`rules[${index}].${field} must be an array`);
      }
    }
  });

  return { ok: errors.length === 0, errors };
}

export function validateSandboxRequest(body) {
  const errors = [];
  if (!body || typeof body !== "object") {
    return { ok: false, errors: ["request body must be an object"] };
  }
  if (!body.rule || typeof body.rule !== "object" || Array.isArray(body.rule)) {
    errors.push("rule must be an object");
  }
  if (!Array.isArray(body.rows)) {
    errors.push("rows must be an array");
  }
  if (body.dashboard !== undefined && (!body.dashboard || typeof body.dashboard !== "object")) {
    errors.push("dashboard must be an object when provided");
  }
  if (body.card !== undefined && (!body.card || typeof body.card !== "object")) {
    errors.push("card must be an object when provided");
  }
  return { ok: errors.length === 0, errors };
}

export function normalizeRuleMessages(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.filter(Boolean).map(String);
  }
  return [String(value)];
}

function requireString(errors, value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${path} must be a non-empty string`);
  }
}

function optionalUrl(errors, value, path) {
  if (value === undefined || value === null || value === "") {
    return;
  }
  if (typeof value !== "string") {
    errors.push(`${path} must be a URL string`);
    return;
  }
  try {
    new URL(value);
  } catch {
    errors.push(`${path} must be a valid URL`);
  }
}
```

- [ ] **Step 4: Run validation tests and verify they pass**

Run:

```bash
node --test test/platform-validation.test.mjs
```

Expected: PASS.

## Task 2: Platform API Module

**Files:**
- Create: `src/platform-api.mjs`
- Test: `test/platform-api.test.mjs`

- [ ] **Step 1: Write API tests**

Create `test/platform-api.test.mjs`:

```js
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createPlatformApi,
  flattenInventory,
} from "../src/platform-api.mjs";

async function makeFixture() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "duty-platform-"));
  await fs.mkdir(path.join(rootDir, "config"), { recursive: true });
  await fs.writeFile(
    path.join(rootDir, "config/countries.config.json"),
    JSON.stringify({ countries: [{ code: "ID", name: "印尼", timezone: "Asia/Jakarta", status: "ready" }] }),
  );
  await fs.writeFile(
    path.join(rootDir, "config/public-monitor.config.json"),
    JSON.stringify({
      alerts: { channel: "tv", webhookUrl: "${TV_ALERT_WEBHOOK_URL}" },
      rules: [{ type: "requiredDatePresent", dashboardTitle: "OKR", cardTitles: ["规模"], dateColumn: "统计日期" }],
    }),
  );
  await fs.writeFile(
    path.join(rootDir, "config/discovered-public-dashboards.ready.json"),
    JSON.stringify({
      dashboardCount: 1,
      dashboards: [
        {
          countryCode: "ID",
          countryName: "印尼",
          title: "OKR",
          uuid: "dash-1",
          url: "https://data.example/public/dashboard/dash-1",
          cards: [
            {
              title: "规模",
              cardId: 1,
              dashcardId: 2,
              columns: ["统计日期", "注册数"],
              sampleRows: [{ "统计日期": "2026-07-06", "注册数": 10 }],
              queryStatus: "ok",
            },
          ],
        },
      ],
    }),
  );
  await fs.writeFile(
    path.join(rootDir, "config/public-check-result.ready.json"),
    JSON.stringify({ checkedAt: "2026-07-06T00:00:00.000Z", anomalyCount: 0, checkedCardCount: 1, anomalies: [] }),
  );
  return rootDir;
}

test("flattenInventory returns dashboard and card counts", () => {
  const flat = flattenInventory({
    dashboards: [
      { title: "A", cards: [{ title: "C1" }, { title: "C2" }] },
      { title: "B", cards: [] },
    ],
  });

  assert.equal(flat.dashboardCount, 2);
  assert.equal(flat.cardCount, 2);
});

test("platform api returns summary and inventory", async () => {
  const rootDir = await makeFixture();
  const api = createPlatformApi({ rootDir });

  const summary = await api.getSummary();
  assert.equal(summary.countryCount, 1);
  assert.equal(summary.dashboardCount, 1);
  assert.equal(summary.cardCount, 1);
  assert.equal(summary.ruleCount, 1);

  const inventory = await api.getInventory({ countryCode: "ID", q: "规模" });
  assert.equal(inventory.dashboards.length, 1);
  assert.equal(inventory.dashboards[0].cards.length, 1);
});

test("platform api evaluates sandbox rules", async () => {
  const rootDir = await makeFixture();
  const api = createPlatformApi({ rootDir });

  const result = await api.evaluateSandbox({
    dashboard: { title: "OKR" },
    card: { title: "规模" },
    rule: { type: "requiredDatePresent", dateColumn: "统计日期", requiredDate: "2026-07-06" },
    rows: [{ "统计日期": "2026-07-06" }],
  });

  assert.equal(result.ok, true);
  assert.equal(result.matched, false);
  assert.deepEqual(result.messages, []);
});

test("platform api validates and saves rules", async () => {
  const rootDir = await makeFixture();
  const api = createPlatformApi({ rootDir });

  const next = await api.saveRulesConfig({
    rules: [{ type: "notEmpty", dashboardTitle: "OKR", cardTitles: ["规模"] }],
  });

  assert.equal(next.rules.length, 1);
  const saved = JSON.parse(await fs.readFile(path.join(rootDir, "config/public-monitor.config.json"), "utf8"));
  assert.equal(saved.rules[0].type, "notEmpty");
});

test("platform api generates notify preview", async () => {
  const rootDir = await makeFixture();
  const api = createPlatformApi({ rootDir });

  const preview = await api.getNotifyPreview();
  assert.ok(preview.messages.length >= 1);
  assert.ok(preview.messages[0].body.includes("公共报表巡检"));
});
```

- [ ] **Step 2: Run API tests and verify they fail**

Run:

```bash
node --test test/platform-api.test.mjs
```

Expected: fail because `src/platform-api.mjs` does not exist.

- [ ] **Step 3: Implement platform API**

Create `src/platform-api.mjs` with these exports:

```js
import fs from "node:fs/promises";
import path from "node:path";
import { evaluateRowsAgainstRule } from "./metabase-public-monitor.mjs";
import { buildPublicCheckMessages } from "./notifier.mjs";
import { readJsonFile } from "./utils.mjs";
import {
  normalizeRuleMessages,
  validateCountriesConfig,
  validateRulesConfig,
  validateSandboxRequest,
} from "./platform-validation.mjs";

const FILES = {
  countries: "config/countries.config.json",
  rules: "config/public-monitor.config.json",
  inventory: "config/discovered-public-dashboards.ready.json",
  result: "config/public-check-result.ready.json",
};

export function createPlatformApi({ rootDir = process.cwd() } = {}) {
  const resolve = (name) => path.join(rootDir, FILES[name]);

  return {
    async getSummary() {
      const [countries, rules, inventory, result] = await Promise.all([
        readJsonFile(resolve("countries"), { countries: [] }),
        readJsonFile(resolve("rules"), { rules: [] }),
        readJsonFile(resolve("inventory"), { dashboards: [] }),
        readJsonFile(resolve("result"), null),
      ]);
      const flat = flattenInventory(inventory);
      return {
        countryCount: countries.countries?.length || 0,
        dashboardCount: flat.dashboardCount,
        cardCount: flat.cardCount,
        ruleCount: rules.rules?.length || 0,
        lastResult: result
          ? {
              checkedAt: result.checkedAt || null,
              checkedCardCount: result.checkedCardCount || 0,
              anomalyCount: result.anomalyCount || 0,
              dataQualityAnomalyCount: result.dataQualityAnomalyCount || 0,
            }
          : null,
        countries: countries.countries || [],
        countrySummaries: summarizeCountries(countries.countries || [], inventory, result),
      };
    },

    async getCountries() {
      return readJsonFile(resolve("countries"), { countries: [] });
    },

    async saveCountriesConfig(config) {
      const validation = validateCountriesConfig(config);
      if (!validation.ok) {
        throw badRequest("Invalid countries config", validation.errors);
      }
      await writeJsonAtomic(resolve("countries"), config);
      return config;
    },

    async getInventory(filters = {}) {
      const inventory = await readJsonFile(resolve("inventory"), { dashboards: [] });
      return filterInventory(inventory, filters);
    },

    async getRulesConfig() {
      const config = await readJsonFile(resolve("rules"), { rules: [] });
      return redactRuleConfig(config);
    },

    async saveRulesConfig(config) {
      const validation = validateRulesConfig(config);
      if (!validation.ok) {
        throw badRequest("Invalid rules config", validation.errors);
      }
      const previous = await readJsonFile(resolve("rules"), {});
      const next = {
        ...previous,
        ...config,
        alerts: sanitizeAlerts(config.alerts ?? previous.alerts),
        gateway: sanitizeGateway(config.gateway ?? previous.gateway),
      };
      await writeJsonAtomic(resolve("rules"), next);
      return redactRuleConfig(next);
    },

    async evaluateSandbox(body) {
      const validation = validateSandboxRequest(body);
      if (!validation.ok) {
        throw badRequest("Invalid sandbox request", validation.errors);
      }
      const raw = evaluateRowsAgainstRule(body.rows, body.rule);
      const messages = normalizeRuleMessages(raw);
      return {
        ok: true,
        matched: messages.length > 0,
        messages,
        rowCount: body.rows.length,
        dashboard: body.dashboard || null,
        card: body.card || null,
        rule: body.rule,
      };
    },

    async getNotifyPreview(resultOverride = null) {
      const rules = await readJsonFile(resolve("rules"), { alerts: {} });
      const result = resultOverride || await readJsonFile(resolve("result"), {
        checkedAt: new Date().toISOString(),
        checkedCardCount: 0,
        anomalyCount: 0,
        anomalies: [],
      });
      return {
        messages: buildPublicCheckMessages(result, rules.alerts || {}),
      };
    },
  };
}

export function flattenInventory(inventory) {
  const dashboards = inventory?.dashboards || [];
  return {
    dashboardCount: dashboards.length,
    cardCount: dashboards.reduce((sum, dashboard) => sum + (dashboard.cards?.length || 0), 0),
  };
}

export async function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(tempPath, filePath);
}

function filterInventory(inventory, filters = {}) {
  const q = String(filters.q || "").trim().toLowerCase();
  const countryCode = String(filters.countryCode || "").trim();
  const dashboardTitle = String(filters.dashboardTitle || "").trim();
  const dashboards = (inventory.dashboards || [])
    .filter((dashboard) => !countryCode || dashboard.countryCode === countryCode || dashboard.country?.code === countryCode)
    .filter((dashboard) => !dashboardTitle || dashboard.title === dashboardTitle || dashboard.sourcePanelTitle === dashboardTitle)
    .map((dashboard) => ({
      ...dashboard,
      cards: (dashboard.cards || []).filter((card) => {
        if (!q) return true;
        return [dashboard.title, dashboard.sourcePanelTitle, card.title, card.cardId, card.dashcardId]
          .filter((value) => value !== undefined && value !== null)
          .some((value) => String(value).toLowerCase().includes(q));
      }),
    }))
    .filter((dashboard) => !q || dashboard.cards.length > 0);

  return {
    ...inventory,
    dashboards,
    dashboardCount: dashboards.length,
    totalCardCount: dashboards.reduce((sum, dashboard) => sum + (dashboard.cards?.length || 0), 0),
  };
}

function summarizeCountries(countries, inventory, result) {
  return countries.map((country) => {
    const dashboards = (inventory.dashboards || []).filter((dashboard) => {
      return dashboard.countryCode === country.code || dashboard.country?.code === country.code;
    });
    const anomalies = (result?.anomalies || []).filter((anomaly) => anomaly.countryCode === country.code);
    return {
      code: country.code,
      name: country.name,
      timezone: country.timezone,
      status: country.status || "unknown",
      dashboardCount: dashboards.length,
      cardCount: dashboards.reduce((sum, dashboard) => sum + (dashboard.cards?.length || 0), 0),
      anomalyCount: anomalies.length,
    };
  });
}

function redactRuleConfig(config) {
  return {
    ...config,
    alerts: sanitizeAlerts(config.alerts),
    gateway: sanitizeGateway(config.gateway),
  };
}

function sanitizeAlerts(alerts = {}) {
  return {
    ...alerts,
    webhookUrl: alerts.webhookUrl ? maskSecretReference(alerts.webhookUrl) : alerts.webhookUrl,
    botId: alerts.botId ? maskSecretReference(alerts.botId) : alerts.botId,
  };
}

function sanitizeGateway(gateway = {}) {
  return {
    ...gateway,
    token: gateway.token ? maskSecretReference(gateway.token) : gateway.token,
  };
}

function maskSecretReference(value) {
  const text = String(value);
  if (/^\$\{[^}]+\}$/.test(text)) {
    return text;
  }
  return "<hidden>";
}

function badRequest(message, errors) {
  const error = new Error(message);
  error.statusCode = 400;
  error.errors = errors;
  return error;
}
```

- [ ] **Step 4: Run API tests and verify they pass**

Run:

```bash
node --test test/platform-api.test.mjs
```

Expected: PASS.

## Task 3: HTTP Server and Static Files

**Files:**
- Create: `src/server.mjs`
- Modify: `package.json`

- [ ] **Step 1: Add platform script**

Modify `package.json` scripts:

```json
"platform": "node ./src/server.mjs"
```

- [ ] **Step 2: Implement server**

Create `src/server.mjs` with:

```js
#!/usr/bin/env node

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPlatformApi } from "./platform-api.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const webDir = path.join(rootDir, "web");
const api = createPlatformApi({ rootDir });
const port = Number(process.env.PORT || 8787);

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

server.listen(port, () => {
  console.log(`Duty platform running at http://localhost:${port}`);
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
  if (method === "POST" && url.pathname === "/api/notify-preview") {
    const body = await readBody(request, {});
    return sendJson(response, 200, await api.getNotifyPreview(body.result || null));
  }
  sendJson(response, 404, { error: `Not found: ${method} ${url.pathname}` });
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
```

## Task 4: Frontend Shell

**Files:**
- Create: `web/index.html`
- Create: `web/src/styles.css`
- Create: `web/src/api.js`
- Create: `web/src/state.js`
- Create: `web/src/app.js`

- [ ] **Step 1: Create HTML shell**

Create `web/index.html` with a left navigation and main root:

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>值班平台</title>
    <link rel="stylesheet" href="/src/styles.css" />
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/app.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Create API client**

Create `web/src/api.js`:

```js
export async function apiGet(path) {
  return request(path, { method: "GET" });
}

export async function apiPut(path, body) {
  return request(path, { method: "PUT", body: JSON.stringify(body) });
}

export async function apiPost(path, body = {}) {
  return request(path, { method: "POST", body: JSON.stringify(body) });
}

async function request(path, options) {
  const response = await fetch(path, {
    ...options,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Request failed: ${response.status}`);
    error.payload = payload;
    throw error;
  }
  return payload;
}
```

- [ ] **Step 3: Create shared state helpers**

Create `web/src/state.js`:

```js
export const state = {
  route: window.location.hash.replace(/^#/, "") || "/dashboard",
  summary: null,
  countries: null,
  inventory: null,
  rulesConfig: null,
  selected: {
    countryCode: "",
    dashboardUuid: "",
    cardId: "",
    ruleIndex: 0,
  },
};

export function setRoute(route) {
  state.route = route;
  window.location.hash = route;
}

export function getDashboards() {
  return state.inventory?.dashboards || [];
}

export function getCards(dashboard) {
  return dashboard?.cards || [];
}

export function findSelectedDashboard() {
  return getDashboards().find((dashboard) => dashboard.uuid === state.selected.dashboardUuid) || getDashboards()[0] || null;
}

export function findSelectedCard() {
  const dashboard = findSelectedDashboard();
  return getCards(dashboard).find((card) => String(card.cardId) === String(state.selected.cardId)) || getCards(dashboard)[0] || null;
}

export function findSelectedRule() {
  return state.rulesConfig?.rules?.[Number(state.selected.ruleIndex || 0)] || state.rulesConfig?.rules?.[0] || null;
}
```

- [ ] **Step 4: Create app router**

Create `web/src/app.js` that imports view renderers, loads all API data, and renders navigation.

- [ ] **Step 5: Create CSS**

Create `web/src/styles.css` with a dense, work-focused layout: fixed sidebar, top toolbar, tables, split panes, form controls, JSON blocks, status badges.

## Task 5: Frontend Views

**Files:**
- Create: `web/src/views/dashboard.js`
- Create: `web/src/views/countries.js`
- Create: `web/src/views/inventory.js`
- Create: `web/src/views/rules.js`
- Create: `web/src/views/sandbox.js`
- Create: `web/src/views/notify-preview.js`

- [ ] **Step 1: Dashboard view**

Render summary cards and country table from `/api/summary`.

- [ ] **Step 2: Countries view**

Render editable country rows and save via `PUT /api/countries`.

- [ ] **Step 3: Inventory view**

Render dashboard/card browser using `/api/inventory`.

- [ ] **Step 4: Rules view**

Render rule list, selected rule form fields, JSON editor, and save via `PUT /api/rules`.

- [ ] **Step 5: Sandbox view**

Render dashboard/card/rule selectors, sample rows, and call `POST /api/sandbox/evaluate`.

- [ ] **Step 6: Notify preview view**

Call `POST /api/notify-preview` and render each message body in copyable text areas.

## Task 6: Verification

**Files:**
- Modify only files created above if failures are found.

- [ ] **Step 1: Run focused tests**

Run:

```bash
node --test test/platform-validation.test.mjs test/platform-api.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run full test suite**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 3: Start platform**

Run:

```bash
npm run platform
```

Expected output:

```text
Duty platform running at http://localhost:8787
```

- [ ] **Step 4: Smoke test API**

Run in another shell:

```bash
curl -s http://localhost:8787/api/summary
```

Expected: JSON containing `countryCount`, `dashboardCount`, `cardCount`, and `ruleCount`.

## Self-Review

Spec coverage:

- Reads existing JSON configs: Task 2, Task 3, Task 5.
- Saves countries/rules JSON: Task 1, Task 2, Task 5.
- Offline sandbox evaluation: Task 1, Task 2, Task 5.
- Notification preview: Task 2, Task 5.
- No online Metabase/Grafana access in MVP: Task 2 only reads local files and evaluates local rows.
- Metabase direct platform concept: Inventory view reads Metabase inventory directly; Grafana is not used as a jump source.
- Existing CLI unchanged: only adds `platform` script.

Placeholder scan:

- No TBD/TODO markers.
- No live secrets.
- No online write API.

Type consistency:

- API functions return JSON objects consumed directly by browser views.
- Sandbox request shape matches `validateSandboxRequest`.
- Rules config shape remains compatible with `public-monitor.config.json`.
