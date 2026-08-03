import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const workflowFile = new URL("../n8n-metabase-anomaly-dynamic-evidence-agent.template.json", import.meta.url);

async function workflow() {
  return JSON.parse(await fs.readFile(workflowFile, "utf8"));
}

test("batched AI-first evidence workflow accepts only protocol v3 batches of one to three cases", async () => {
  const data = await workflow();
  const normalize = data.nodes.find((node) => node.name === "Normalize Batch");
  assert.ok(normalize);
  assert.match(normalize.parameters.jsCode, /protocolVersion !== 3/);
  assert.match(normalize.parameters.jsCode, /cases\.length<1 \|\| cases\.length>3/);
  assert.match(normalize.parameters.jsCode, /unique non-negative anomalyIndex/);
});

test("batched workflow sends one Dify request and one callback for the whole batch", async () => {
  const data = await workflow();
  assert.equal(data.nodes.length, 7);
  const dify = data.nodes.find((node) => node.name === "Call Dify Batch Agent");
  const callback = data.nodes.find((node) => node.name === "Callback Batch Platform");
  assert.match(dify.parameters.jsonBody, /batch_id/);
  assert.match(dify.parameters.jsonBody, /snapshot_id/);
  assert.match(dify.parameters.jsonBody, /cases_json/);
  assert.match(callback.parameters.url, /batch-callback$/);
  assert.match(callback.parameters.jsonBody, /\$json/);
});

test("batched workflow rejects malformed Dify results instead of silently notifying", async () => {
  const data = await workflow();
  const build = data.nodes.find((node) => node.name === "Build Batch Callback");
  assert.match(build.parameters.jsCode, /exactly one verdict for every case/);
  assert.match(build.parameters.jsCode, /invalid or duplicate anomalyIndex/);
  assert.match(build.parameters.jsCode, /insufficient_evidence/);
});

test("workflow stays token-placeholder-only and no longer repeats card SQL reads", async () => {
  const raw = await fs.readFile(workflowFile, "utf8");
  assert.match(raw, /REPLACE_WITH_METABASE_ANOMALY_AGENT_WEBHOOK_TOKEN/);
  assert.match(raw, /REPLACE_WITH_METABASE_AGENT_CALLBACK_TOKEN/);
  assert.match(raw, /REPLACE_WITH_DIFY_API_KEY/);
  assert.doesNotMatch(raw, /fuxi_backend_query_all/);
  assert.doesNotMatch(raw, /Get Card SQL|Seed Card SQL/);
});
