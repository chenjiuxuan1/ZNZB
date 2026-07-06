import fs from "node:fs/promises";
import path from "node:path";
import { MetabasePublicClient } from "./metabase-public-client.mjs";
import {
  buildDefaultCardParameters,
  checkPublicDashboards,
  evaluateRowsAgainstRule,
  mergeParameters,
} from "./metabase-public-monitor.mjs";
import { buildPublicCheckMessages, notifyText } from "./notifier.mjs";
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
  baselineCache: "config/public-check-baseline-cache.json",
};
const DEFAULT_TV_WEBHOOK_URL = "https://tv-service-alert.kuainiu.chat/alert/v2/array";

export function createPlatformApi({
  rootDir = process.cwd(),
  metabaseClientFactory = (dashboard) => new MetabasePublicClient({
    baseUrl: new URL(dashboard.url).origin,
    requestTimeoutSeconds: 30,
  }),
  notifyTextFn = notifyText,
} = {}) {
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
        alerts: preserveHiddenSecrets(config.alerts ?? previous.alerts, previous.alerts, ["webhookUrl", "botId"]),
        gateway: preserveHiddenSecrets(config.gateway ?? previous.gateway, previous.gateway, ["token"]),
      };
      await writeJsonAtomic(resolve("rules"), next);
      return redactRuleConfig(next);
    },

    async evaluateSandbox(body) {
      const validation = validateSandboxRequest(body);
      if (!validation.ok) {
        throw badRequest("Invalid sandbox request", validation.errors);
      }
      const rule = applyDashboardRuleDefaults(body.rule, body.dashboard);
      const raw = evaluateRowsAgainstRule(body.rows, rule);
      const messages = normalizeRuleMessages(raw);
      return {
        ok: true,
        matched: messages.length > 0,
        messages,
        rowCount: body.rows.length,
        dashboard: body.dashboard || null,
        card: body.card || null,
        rule,
      };
    },

    async evaluateLiveSandbox(body) {
      validateLiveSandboxRequest(body);
      const dashboard = body.dashboard;
      const card = body.card;
      const rule = applyDashboardRuleDefaults(body.rule, dashboard);
      const client = metabaseClientFactory(dashboard);
      const parameters = mergeParameters(buildDefaultCardParameters(dashboard, card), rule.parameters || []);
      const rows = await client.queryDashcardJson({
        cardId: card.cardId,
        dashboardUuid: dashboard.uuid,
        dashcardId: card.dashcardId,
        parameters,
      });
      const safeRows = Array.isArray(rows) ? rows : [];
      const raw = evaluateRowsAgainstRule(safeRows, rule);
      const messages = normalizeRuleMessages(raw);
      return {
        ok: true,
        source: "metabase",
        matched: messages.length > 0,
        messages,
        rowCount: safeRows.length,
        rows: safeRows,
        request: {
          baseUrl: new URL(dashboard.url).origin,
          dashboardUuid: dashboard.uuid,
          cardId: card.cardId,
          dashcardId: card.dashcardId,
          parameterCount: parameters.length,
        },
        dashboard,
        card,
        rule,
      };
    },

    async runBatchCheck(body = {}) {
      const inventory = await readJsonFile(resolve("inventory"), { dashboards: [] });
      const ruleConfig = await readJsonFile(resolve("rules"), {
        builtInChecks: { queryError: true, noData: true },
        rules: [],
      });
      const countryCode = String(body.countryCode || "").trim();
      const dashboardUuid = String(body.dashboardUuid || "").trim();
      const maxCards = body.maxCards === undefined || body.maxCards === null || body.maxCards === ""
        ? null
        : clampPositiveInteger(body.maxCards, 20, 1, Number.MAX_SAFE_INTEGER);
      const filteredInventory = filterBatchInventory(inventory, { countryCode, dashboardUuid, maxCards });
      const queryCardFn = async (_client, dashboard, card, parameters = []) => {
        const client = metabaseClientFactory(dashboard);
        try {
          const rows = await client.queryDashcardJson({
            cardId: card.cardId,
            dashboardUuid: dashboard.uuid,
            dashcardId: card.dashcardId,
            parameters,
          });
          return {
            ok: true,
            rows: Array.isArray(rows) ? rows : [],
            error: null,
          };
        } catch (error) {
          return {
            ok: false,
            rows: [],
            error: error.message,
          };
        }
      };
      return checkPublicDashboards({
        inventory: filteredInventory,
        ruleConfig: {
          ...ruleConfig,
          dataQuality: { ...(ruleConfig.dataQuality || {}), enabled: false },
        },
        baselineCacheFile: resolve("baselineCache"),
        queryCardFn,
      });
    },

    async runBatchCheckAndNotify(body = {}) {
      const result = await this.runBatchCheck(body);
      const anomalyCount = Number(result.anomalyCount || 0) + Number(result.dataQualityAnomalyCount || 0);
      if (anomalyCount <= 0) {
        return {
          ...result,
          notification: {
            sent: false,
            skipped: true,
            reason: "no anomalies",
            sentMessages: 0,
            results: [],
            botId: String(body.botId || "").trim(),
            mentions: normalizeMentions(body.mentions),
            sentAt: null,
          },
        };
      }
      const rules = await readJsonFile(resolve("rules"), { alerts: {} });
      const botId = String(body.botId || "").trim();
      if (!botId) {
        throw badRequest("TV bot_id is required", ["请填写 TV bot_id。"]);
      }
      const alerts = {
        ...(rules.alerts || {}),
        channel: "tv",
        webhookUrl: resolveWebhookUrl(body.webhookUrl, rules.alerts?.webhookUrl),
        botId,
        mentions: normalizeMentions(body.mentions),
      };
      if (!alerts.webhookUrl) {
        throw badRequest("TV webhook is required", ["请填写 TV webhook 地址。"]);
      }
      const messages = buildPublicCheckMessages(result, alerts);
      const results = [];
      for (const message of messages) {
        results.push(
          await notifyTextFn({ ...rules, alerts }, message.body, {
            title: message.title,
            severity: anomalyCount > 0 ? "warning" : "info",
            timestamp: result.checkedAt,
            anomalyCount: message.anomalyCount ?? result.anomalyCount,
            checkedCardCount: result.checkedCardCount,
          }),
        );
      }
      return {
        ...result,
        notification: {
          sent: results.some((item) => item.sent),
          sentMessages: messages.length,
          results,
          botId,
          mentions: alerts.mentions,
          webhookUrl: alerts.webhookUrl,
          sentAt: new Date().toISOString(),
        },
      };
    },

    async getNotifyPreview(resultOverride = null, optionOverride = {}) {
      const rules = await readJsonFile(resolve("rules"), { alerts: {} });
      const result = resultOverride || await readJsonFile(resolve("result"), {
        checkedAt: new Date().toISOString(),
        checkedCardCount: 0,
        anomalyCount: 0,
        anomalies: [],
      });
      return {
        messages: buildPublicCheckMessages(result, { ...(rules.alerts || {}), ...optionOverride }),
      };
    },

    async sendNotifyTest(body = {}) {
      const rules = await readJsonFile(resolve("rules"), { alerts: {} });
      const botId = String(body.botId || "").trim();
      const message = String(body.message || "").trim();
      if (!botId) {
        throw badRequest("TV bot_id is required", ["请填写 TV bot_id。"]);
      }
      if (!message) {
        throw badRequest("Message is required", ["请先生成或填写要测试发送的 TV 文案。"]);
      }
      const alerts = {
        ...(rules.alerts || {}),
        channel: "tv",
        webhookUrl: resolveWebhookUrl(body.webhookUrl, rules.alerts?.webhookUrl),
        botId,
        mentions: normalizeMentions(body.mentions),
      };
      const result = await notifyTextFn({ ...rules, alerts }, message, {
        title: body.title || "值班平台 TV 测试",
        severity: "info",
        timestamp: new Date().toISOString(),
      });
      return {
        ...result,
        botId,
        sentAt: new Date().toISOString(),
      };
    },
  };
}

function normalizeMentions(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (!value) {
    return [];
  }
  return String(value)
    .split(/[\n,，;；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function filterBatchInventory(inventory, { countryCode, dashboardUuid, maxCards }) {
  let remainingCards = maxCards ?? Number.MAX_SAFE_INTEGER;
  const dashboards = [];
  for (const dashboard of inventory.dashboards || []) {
    const code = dashboard.countryCode || dashboard.country?.code || "";
    if (countryCode && code !== countryCode) {
      continue;
    }
    if (dashboardUuid && dashboard.uuid !== dashboardUuid) {
      continue;
    }
    if (remainingCards <= 0) {
      break;
    }
    const cards = (dashboard.cards || []).slice(0, remainingCards);
    remainingCards -= cards.length;
    if (cards.length) {
      dashboards.push({ ...dashboard, cards });
    }
  }
  return {
    ...inventory,
    dashboards,
    dashboardCount: dashboards.length,
    totalCardCount: dashboards.reduce((sum, dashboard) => sum + (dashboard.cards?.length || 0), 0),
  };
}

function clampPositiveInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function resolveWebhookUrl(frontendWebhookUrl, configuredWebhookUrl) {
  const frontend = String(frontendWebhookUrl || "").trim();
  if (frontend) {
    return frontend;
  }
  const env = String(process.env.TV_ALERT_WEBHOOK_URL || "").trim();
  if (env) {
    return env;
  }
  const configured = String(configuredWebhookUrl || "").trim();
  if (configured && !/^\$\{[^}]+\}$/.test(configured)) {
    return configured;
  }
  return DEFAULT_TV_WEBHOOK_URL;
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
        if (!q) {
          return true;
        }
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

function preserveHiddenSecrets(next = {}, previous = {}, fields = []) {
  const merged = { ...next };
  for (const field of fields) {
    if (merged[field] === "<hidden>") {
      merged[field] = previous?.[field];
    }
  }
  return merged;
}

function applyDashboardRuleDefaults(rule = {}, dashboard = {}) {
  const timezone = rule.timezone === "dashboard" || !rule.timezone
    ? dashboard?.timezone || dashboard?.country?.timezone || "Asia/Jakarta"
    : rule.timezone;

  return {
    ...rule,
    timezone,
  };
}

function validateLiveSandboxRequest(body) {
  if (!body || typeof body !== "object") {
    throw badRequest("Invalid live sandbox request", ["请求体不能为空。"]);
  }
  if (!body.dashboard?.url || !body.dashboard?.uuid) {
    throw badRequest("Invalid live sandbox request", ["请选择带 Metabase URL 和 uuid 的看板。"]);
  }
  if (!body.card?.cardId || !body.card?.dashcardId) {
    throw badRequest("Invalid live sandbox request", ["请选择带 cardId 和 dashcardId 的卡片。"]);
  }
  if (!body.rule || typeof body.rule !== "object" || !body.rule.type) {
    throw badRequest("Invalid live sandbox request", ["请选择要试跑的规则。"]);
  }
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
