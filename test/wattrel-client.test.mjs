import assert from "node:assert/strict";
import test from "node:test";
import { mapWattrelRowsToAnomalies, queryWattrelAlerts } from "../src/wattrel-client.mjs";

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

test("Wattrel row mapping preserves nested and case-insensitive gateway fields", () => {
  const [anomaly] = mapWattrelRowsToAnomalies([{
    json: {
      NAME: "放款金额校验",
      SRC_TBL: "ods_grant",
      DEST_TBL: "dwd_grant",
      SRC_VALUE: 100,
      DEST_VALUE: 80,
      DIFF: 20,
    },
  }]);

  assert.equal(anomaly.name, "放款金额校验");
  assert.equal(anomaly.srcTbl, "ods_grant");
  assert.equal(anomaly.destTbl, "dwd_grant");
  assert.equal(anomaly.expectedValue, 100);
  assert.equal(anomaly.actualValue, 80);
  assert.equal(anomaly.diff, 20);
});
