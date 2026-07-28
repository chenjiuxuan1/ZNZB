import assert from "node:assert/strict";
import test from "node:test";
import { mapWattrelRowsToAnomalies, queryWattrelAlerts } from "../src/wattrel-client.mjs";

test("Wattrel default query only includes the latest unrepaired result per quality rule", async () => {
  let capturedConfig;

  await queryWattrelAlerts({
    queryFn: async (config) => {
      capturedConfig = config;
      return [];
    },
  });

  assert.match(capturedConfig.query.sql, /result\s*=\s*1\s+AND\s+(?:r\.)?is_repaired\s*=\s*0/i);
  assert.match(capturedConfig.query.sql, /MAX\(id\)\s+AS\s+latest_id/i);
  assert.doesNotMatch(capturedConfig.query.sql, /DATE_SUB\(NOW\(\), INTERVAL 3 DAY\)/i);
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
  assert.equal(anomaly.tableName, "dwd_grant");
  assert.equal(anomaly.expectedValue, 100);
  assert.equal(anomaly.actualValue, 80);
  assert.equal(anomaly.diff, 20);
});

test("Wattrel row mapping uses the rule name when the source omits dest_tbl", () => {
  const [anomaly] = mapWattrelRowsToAnomalies([{
    name: "dwb_asset_period_info_repaid_delay_cnt",
    dest_tbl: "",
  }]);

  assert.equal(anomaly.destTbl, "");
  assert.equal(anomaly.tableName, "dwb_asset_period_info_repaid_delay_cnt");
});

test("Wattrel row mapping reports a headerless n8n result instead of showing empty table fields", () => {
  const [anomaly] = mapWattrelRowsToAnomalies([{
    0: 0,
    49: 49,
    495956: 495957,
    ods_qsa_erp: "ods_qsa_erp",
  }]);

  assert.equal(anomaly.cardTitle, "Wattrel 字段解析失败");
  assert.match(anomaly.message, /n8n 未返回 Wattrel 查询列名/);
});

test("Wattrel row mapping keeps only the newest row for a repeated quality rule", () => {
  const anomalies = mapWattrelRowsToAnomalies([
    { quality_id: 7, name: "放款金额校验", dest_tbl: "dwd_grant", dest_value: 80 },
    { quality_id: 7, name: "放款金额校验", dest_tbl: "dwd_grant", dest_value: 60 },
  ]);

  assert.equal(anomalies.length, 1);
  assert.equal(anomalies[0].actualValue, 80);
});
