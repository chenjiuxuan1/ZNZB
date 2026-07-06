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
        code: "INE",
        name: "印尼",
        timezone: "Asia/Jakarta",
        grafanaDashboardUrl: "https://example.com/d/abc",
        dataQualityDashboardUrl: "https://example.com/d/quality",
        monitorConfigFile: "./config/monitor.ine.json",
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
