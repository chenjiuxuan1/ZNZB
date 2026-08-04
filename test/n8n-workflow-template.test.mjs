import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const workflowFile = new URL("../n8n-metabase-anomaly-dynamic-evidence-agent.template.json", import.meta.url);

async function workflow() {
  return JSON.parse(await fs.readFile(workflowFile, "utf8"));
}

test("two-stage evidence workflow accepts protocol v4 dashboard and metric jobs", async () => {
  const data = await workflow();
  const normalize = data.nodes.find((node) => node.name === "Normalize Batch");
  assert.ok(normalize);
  assert.match(normalize.parameters.jsCode, /protocolVersion !== 4/);
  assert.match(normalize.parameters.jsCode, /dashboard_screening/);
  assert.match(normalize.parameters.jsCode, /metric_deep_analysis/);
  assert.match(normalize.parameters.jsCode, /512 \* 1024/);
  assert.match(normalize.parameters.jsCode, /unique non-negative anomalyIndex/);
});

test("batched workflow sends one Dify request and one callback for the whole batch", async () => {
  const data = await workflow();
  assert.equal(data.nodes.length, 7);
  const dify = data.nodes.find((node) => node.name === "Call Dify Batch Agent");
  const build = data.nodes.find((node) => node.name === "Build Batch Callback");
  const callback = data.nodes.find((node) => node.name === "Callback Batch Platform");
  assert.match(dify.parameters.jsonBody, /batch_id/);
  assert.match(dify.parameters.jsonBody, /snapshot_id/);
  assert.match(dify.parameters.jsonBody, /cases_json/);
  assert.match(dify.parameters.jsonBody, /analysis_stage/);
  assert.match(build.parameters.jsCode, /screening-callback/);
  assert.match(build.parameters.jsCode, /batch-callback/);
  assert.match(callback.parameters.url, /callbackUrl/);
  assert.match(callback.parameters.jsonBody, /\$json/);
});

test("batched workflow tolerates incomplete Dify results with conservative defaults", async () => {
  const data = await workflow();
  const build = data.nodes.find((node) => node.name === "Build Batch Callback");
  assert.match(build.parameters.jsCode, /verdictByIndex/);
  assert.match(build.parameters.jsCode, /needs_deep_analysis/);
  assert.match(build.parameters.jsCode, /insufficient_evidence/);
  assert.match(build.parameters.jsCode, /Dify 未返回该指标/);
});

test("workflow stays token-placeholder-only and no longer repeats card SQL reads", async () => {
  const raw = await fs.readFile(workflowFile, "utf8");
  assert.match(raw, /REPLACE_WITH_METABASE_ANOMALY_AGENT_WEBHOOK_TOKEN/);
  assert.match(raw, /REPLACE_WITH_METABASE_AGENT_CALLBACK_TOKEN/);
  assert.match(raw, /REPLACE_WITH_DIFY_API_KEY/);
  assert.doesNotMatch(raw, /fuxi_backend_query_all/);
  assert.doesNotMatch(raw, /Get Card SQL|Seed Card SQL/);
});
