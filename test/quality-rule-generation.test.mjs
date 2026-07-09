import assert from "node:assert/strict";
import test from "node:test";
import { readQualityRuleGenerationSheet } from "../src/quality-rule-generation.mjs";

test("quality rule generation reads private sheet through webhook rows", async () => {
  const snapshot = await readQualityRuleGenerationSheet({
    config: {
      enabled: true,
      sheetUrl: "https://docs.google.com/spreadsheets/d/example/edit?gid=160372088",
      gid: "160372088",
      readWebhookUrl: "https://n8n.example/webhook/read-quality-rules",
    },
    readWebhookFn: async (url, payload) => {
      assert.equal(url, "https://n8n.example/webhook/read-quality-rules");
      assert.equal(payload.action, "read_quality_rule_generation_rows");
      return {
        rows: [
          {
            "国家": "中国",
            "数据库": "dwd_sec",
            "表名": "dwd_cst_pay_cost_detail",
            "是否自动生成": "1",
            "是否上线": "是",
            "src_sql": "SELECT 1 AS cnt",
            "dest_sql": "SELECT 1 AS cnt",
          },
        ],
      };
    },
  });

  assert.equal(snapshot.source, "read_webhook");
  assert.equal(snapshot.rowCount, 1);
  assert.equal(snapshot.countries[0].country, "CN");
  assert.equal(snapshot.summary.autoGenerateCount, 1);
  assert.equal(snapshot.rows[0].autoGenerate, "1");
  assert.equal(snapshot.rows[0].database, "dwd_sec");
  assert.equal(snapshot.rows[0].srcSql, "SELECT 1 AS cnt");
});
