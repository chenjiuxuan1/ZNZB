import test from "node:test";
import assert from "node:assert/strict";

globalThis.window = { location: { hash: "" } };
const { buildBatchScheduleCountryConfig } = await import("../web/src/views/batch-check.js");

test("buildBatchScheduleCountryConfig keeps KN Chat personal recipients and group chat together", () => {
  const fields = {
    ".schedule-country-notify-channel": { value: "knBot" },
    ".schedule-country-enabled": { checked: true },
    ".schedule-country-dashboard-uuid": { value: "dashboard-ph" },
    ".schedule-country-chat-id": { value: "-100239001" },
    ".schedule-country-recipient-emails": { value: "owner@kn.group" },
  };
  const row = {
    dataset: { countryCode: "PH" },
    querySelector(selector) {
      return fields[selector] || null;
    },
  };

  const config = buildBatchScheduleCountryConfig(row, {
    webhookUrl: "https://tv.example/alert",
    botId: "tv-bot",
  });

  assert.equal(config.countryCode, "PH");
  assert.equal(config.chatId, "-100239001");
  assert.equal(config.recipientEmails, "owner@kn.group");
  assert.equal(config.botToken, "${KN_BOT_TOKEN}");
});
