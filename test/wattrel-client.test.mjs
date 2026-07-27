import assert from "node:assert/strict";
import test from "node:test";
import { queryWattrelAlerts } from "../src/wattrel-client.mjs";

test("Wattrel default query only includes unrepaired quality results", async () => {
  let capturedConfig;

  await queryWattrelAlerts({
    queryFn: async (config) => {
      capturedConfig = config;
      return [];
    },
  });

  assert.match(capturedConfig.query.sql, /result\s*=\s*1\s+AND\s+(?:r\.)?is_repaired\s*=\s*0/i);
});
