import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const workflowFile = new URL("../n8n-metabase-anomaly-dynamic-evidence-agent.template.json", import.meta.url);

async function workflow() {
  return JSON.parse(await fs.readFile(workflowFile, "utf8"));
}

test("single-stage evidence workflow accepts protocol v5 dashboard analysis jobs", async () => {
  const data = await workflow();
  const normalize = data.nodes.find((node) => node.name === "Normalize Batch");
  assert.ok(normalize);
  assert.match(normalize.parameters.jsCode, /protocolVersion !== 5/);
  assert.match(normalize.parameters.jsCode, /dashboard_analysis/);
  assert.match(normalize.parameters.jsCode, /512 \* 1024/);
  assert.match(normalize.parameters.jsCode, /unique non-negative anomalyIndex/);
});

test("batched workflow sends one Dify request and one callback for the whole batch", async () => {
  const data = await workflow();
  assert.equal(data.nodes.length, 10);
  const dify = data.nodes.find((node) => node.name === "Call Dify Batch Agent");
  const build = data.nodes.find((node) => node.name === "Build Batch Callback");
  const callback = data.nodes.find((node) => node.name === "Callback Batch Platform");
  assert.ok(data.nodes.find((node) => node.name === "Extract Missing Cases"));
  assert.ok(data.nodes.find((node) => node.name === "Call Dify Missing Agent"));
  assert.ok(data.nodes.find((node) => node.name === "Parse Dify Missing Response"));
  assert.match(dify.parameters.jsonBody, /batch_id/);
  assert.match(dify.parameters.jsonBody, /snapshot_id/);
  assert.match(dify.parameters.jsonBody, /cases_json/);
  assert.match(dify.parameters.jsonBody, /analysis_stage/);
  assert.match(build.parameters.jsCode, /batch-callback/);
  assert.doesNotMatch(build.parameters.jsCode, /screening-callback/);
  assert.match(callback.parameters.url, /callbackUrl/);
  assert.match(callback.parameters.jsonBody, /\$json/);
});

test("batched workflow calls the Dify Agent chat API over the internal network", async () => {
  const data = await workflow();
  const dify = data.nodes.find((node) => node.name === "Call Dify Batch Agent");

  assert.equal(dify.parameters.url, "http://172.20.0.234/v1/chat-messages");
  assert.match(dify.parameters.jsonBody, /query:/);
  assert.match(dify.parameters.jsonBody, /payloadJson/);
  assert.match(dify.parameters.jsonBody, /输入 JSON/);
  assert.match(dify.parameters.jsonBody, /conversation_id: ''/);
  assert.match(dify.parameters.jsonBody, /response_mode: 'streaming'/);
  assert.match(dify.parameters.options?.response?.response?.format || JSON.stringify(dify.parameters.options), /text/);
  assert.doesNotMatch(dify.parameters.jsonBody, /\{\{#start\./);
  assert.doesNotMatch(dify.parameters.url, /workflows\/run/);
});

test("streaming Agent responses are parsed from SSE data events", async () => {
  const data = await workflow();
  const parser = data.nodes.find((node) => node.name === "Parse Dify Batch Response");
  assert.match(parser.parameters.jsCode, /text\/event-stream|data:/);
  assert.match(parser.parameters.jsCode, /answer/);
});

test("batched workflow merges a repair pass and tolerates incomplete Dify results", async () => {
  const data = await workflow();
  const build = data.nodes.find((node) => node.name === "Build Batch Callback");
  assert.match(build.parameters.jsCode, /Parse Dify Missing Response/);
  assert.match(build.parameters.jsCode, /matched\.get\(Number\(c\.anomalyIndex\)\)/);
  assert.match(build.parameters.jsCode, /insufficient_evidence/);
  assert.match(build.parameters.jsCode, /Dify 未返回该指标/);
  assert.match(build.parameters.jsCode, /screeningVerdict/);
});

test("workflow stays token-placeholder-only and no longer repeats card SQL reads", async () => {
  const raw = await fs.readFile(workflowFile, "utf8");
  assert.match(raw, /REPLACE_WITH_METABASE_ANOMALY_AGENT_WEBHOOK_TOKEN/);
  assert.match(raw, /REPLACE_WITH_METABASE_AGENT_CALLBACK_TOKEN/);
  assert.match(raw, /REPLACE_WITH_DIFY_API_KEY/);
  assert.doesNotMatch(raw, /fuxi_backend_query_all/);
  assert.doesNotMatch(raw, /Get Card SQL|Seed Card SQL/);
});
