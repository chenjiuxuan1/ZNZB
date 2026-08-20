import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

async function workflow() {
  return JSON.parse(await fs.readFile(new URL("../n8n-ds-usage-report.json", import.meta.url), "utf8"));
}

test("usage-report workflow exposes a POST webhook on ds-usage-report", async () => {
  const data = await workflow();
  const webhook = data.nodes.find((node) => node.type === "n8n-nodes-base.webhook");
  assert.ok(webhook);
  assert.equal(webhook.parameters.httpMethod, "POST");
  assert.equal(webhook.parameters.path, "ds-usage-report");
});

test("usage-report workflow queries the audit table with column names and reads password from variables", async () => {
  const data = await workflow();
  const parse = data.nodes.find((node) => node.name === "解析请求生成审计查询命令");
  assert.ok(parse);
  assert.match(parse.parameters.jsCode, /ds_operation_audit_log/);
  assert.match(parse.parameters.jsCode, /10\.20\.47\.19/);
  assert.match(parse.parameters.jsCode, /--column-names/);
  assert.match(parse.parameters.jsCode, /auditPassword/);
  assert.doesNotMatch(parse.parameters.jsCode, /6JA8j2uGvZi3FrAcxM06/);
});

test("usage-report workflow chains webhook -> ssh -> respond", async () => {
  const data = await workflow();
  const respond = data.nodes.find((node) => node.type === "n8n-nodes-base.respondToWebhook");
  const ssh = data.nodes.find((node) => node.type === "n8n-nodes-base.ssh");
  const ifNode = data.nodes.find((node) => node.type === "n8n-nodes-base.if");
  assert.ok(respond && ssh && ifNode);
  assert.equal(data.connections["中国跳板机查询审计表"].main[0][0].node, "解析查询结果");
  assert.equal(data.connections["解析查询结果"].main[0][0].node, "返回使用统计结果");
  assert.equal(data.connections[ifNode.name].main[0][0].node, "中国跳板机查询审计表");
});
