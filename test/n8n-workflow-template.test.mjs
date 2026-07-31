import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const workflowPath = new URL("../n8n-warehouse-lineage-gateway.template.json", import.meta.url);
const dynamicEvidenceWorkflowPath = new URL("../n8n-metabase-anomaly-dynamic-evidence-agent.template.json", import.meta.url);
const metabaseAnomalyAgentDocPath = new URL("../docs/metabase-anomaly-agent.md", import.meta.url);

function dynamicNode(name) {
  const workflow = JSON.parse(readFileSync(dynamicEvidenceWorkflowPath, "utf8"));
  return workflow.nodes.find((node) => node.name === name);
}

const INGRESS_TOKEN = "REPLACE_WITH_METABASE_ANOMALY_AGENT_WEBHOOK_TOKEN";

function normalizeDynamicJob(body, authorization = `Bearer ${INGRESS_TOKEN}`) {
  const node = dynamicNode("Normalize Job");
  return new Function("$json", node.parameters.jsCode)({ body, headers: { authorization } })[0].json;
}

function parseDifyResponse(data) {
  const node = dynamicNode("Parse Dify Response");
  return new Function("$json", node.parameters.jsCode)({ data })[0].json;
}

function seedCardSql(normData, cardResponse) {
  const node = dynamicNode("Seed Card SQL");
  return new Function("$json", "$", node.parameters.jsCode)(
    cardResponse,
    () => ({ first: () => ({ json: normData }) }),
  )[0].json;
}

function buildCallback(normData, parsedData) {
  const node = dynamicNode("Build Callback");
  return new Function("$json", "$", node.parameters.jsCode)(
    {},
    (nodeName) => ({
      first: () => ({
        json: nodeName === "Normalize Job" ? normData : nodeName === "Parse Dify Response" ? parsedData : {},
      }),
    }),
  )[0].json;
}

function validateLineageRequest(body, authorization = "Bearer REPLACE_WITH_EVIDENCE_GATEWAY_TOKEN") {
  const workflow = JSON.parse(readFileSync(workflowPath, "utf8"));
  const node = workflow.nodes.find((item) => item.name === "严格校验只读血缘请求");
  return new Function("$json", "Buffer", node.parameters.jsCode)({ body, headers: { authorization } }, Buffer)[0].json;
}

/* ── Normalize Job ── */

test("Normalize Job extracts anomalyDate as the FIRST date (problem date) from production-format messages", () => {
  const body = {
    protocolVersion: 2,
    jobId: "job-1234",
    anomaly: { message: "指标「通过~放款」从 0.40664557 降为 0（统计日期 2026-07-31 对比 2026-07-30）" },
    context: { runId: "run-1", countryCode: "ine", anomalyIndex: 0 },
    callback: { token: "callback-token" },
  };
  const normalized = normalizeDynamicJob(body);
  assert.equal(normalized.state.anomalyDate, "2026-07-31");
  assert.equal(normalized.state.baselineDate, "2026-07-30");
});

test("Normalize Job normalizes slash-separated dates and validates impossible dates", () => {
  const body = {
    protocolVersion: 2,
    jobId: "job-1234",
    anomaly: { message: "统计日期 2026/07/15 对比 2026/07/14" },
    context: { runId: "run-1", countryCode: "mx", anomalyIndex: 0 },
    callback: { token: "callback-token" },
  };
  const normalized = normalizeDynamicJob(body);
  assert.equal(normalized.state.anomalyDate, "2026-07-15");
  assert.equal(normalized.state.baselineDate, "2026-07-14");
  assert.throws(() => normalizeDynamicJob({ ...body, anomaly: { message: "bad 2026-02-30" } }), /invalid anomaly date/i);
});

test("Normalize Job falls back to today when no date is present", () => {
  const body = {
    protocolVersion: 2,
    jobId: "job-1234",
    anomaly: { message: "no date supplied" },
    context: { runId: "run-1", countryCode: "mx", anomalyIndex: 0 },
    callback: { token: "callback-token" },
  };
  const fallback = normalizeDynamicJob(body);
  assert.match(fallback.state.anomalyDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(fallback.state.baselineDate, /^\d{4}-\d{2}-\d{2}$/);
});

test("Normalize Job uses single date as anomalyDate and derives baselineDate as previous day", () => {
  const body = {
    protocolVersion: 2,
    jobId: "job-1234",
    anomaly: { message: "anomaly on 2026-07-29" },
    context: { runId: "run-1", countryCode: "mx", anomalyIndex: 0 },
    callback: { token: "callback-token" },
  };
  const normalized = normalizeDynamicJob(body);
  assert.equal(normalized.state.anomalyDate, "2026-07-29");
  assert.equal(normalized.state.baselineDate, "2026-07-28");
});

test("Normalize Job truncates oversized fields", () => {
  const body = {
    protocolVersion: 2,
    jobId: "job-1234",
    anomaly: { message: "x".repeat(13000), dashboardTitle: "d".repeat(300), cardTitle: "c".repeat(300), dashboardUrl: "u".repeat(2100) },
    context: { runId: "run-1", countryCode: "mx", anomalyIndex: 0 },
    callback: { token: "callback-token" },
  };
  const oversized = normalizeDynamicJob(body);
  assert.equal(oversized.anomaly.message.length, 12000);
  assert.equal(oversized.anomaly.dashboardTitle.length, 256);
  assert.equal(oversized.anomaly.cardTitle.length, 256);
  assert.equal(oversized.anomaly.dashboardUrl.length, 2048);
});

test("Normalize Job hardcodes internal callback URL and ignores external URLs", () => {
  const base = {
    protocolVersion: 2,
    jobId: "job-1234",
    anomaly: { message: "2026-07-29" },
    context: { runId: "run-1", countryCode: "mx", anomalyIndex: 0 },
    callback: { token: "callback-token" },
  };
  for (const url of ["https://evil.example/callback", "http://169.254.169.254/latest/meta-data", "http://redirector.example/to-internal"]) {
    const normalized = normalizeDynamicJob({ ...base, callback: { ...base.callback, url } });
    assert.equal(normalized.callback.url, "http://172.19.0.1:28787/api/metabase-anomaly-analysis/callback");
  }
});

/* ── Auth ── */

test("Normalize Job rejects missing or incorrect ingress authorization and invalid callback credentials", () => {
  const body = { protocolVersion: 2, jobId: "job-1234", anomaly: { message: "2026-07-29" }, context: { runId: "run-1", countryCode: "mx", anomalyIndex: 0 }, callback: { token: "callback-token" } };
  const expected = `Bearer ${INGRESS_TOKEN}`;
  assert.equal(normalizeDynamicJob(body, expected).jobId, "job-1234");
  assert.throws(() => normalizeDynamicJob(body, ""), /Unauthorized dynamic evidence webhook/);
  assert.throws(() => normalizeDynamicJob(body, "Bearer wrong-token"), /Unauthorized dynamic evidence webhook/);
  assert.throws(() => normalizeDynamicJob(body, `${expected.slice(0, -1)}X`), /Unauthorized dynamic evidence webhook/);
  assert.throws(() => normalizeDynamicJob({ ...body, jobId: "" }), /valid jobId and callback.token/i);
  assert.throws(() => normalizeDynamicJob({ ...body, callback: {} }), /valid jobId and callback.token/i);
});

test("Normalize Job implements constant-time-style token comparison", () => {
  const node = dynamicNode("Normalize Job");
  assert.match(node.parameters.jsCode, /const tokenEquals = \(left, right\).*Math\.max\(actual\.length, configured\.length\).*diff \|= /s);
  assert.doesNotMatch(node.parameters.jsCode, /header !== expected|header === expected/);
});

/* ── Seed Card SQL ── */

test("Seed Card SQL extracts tables from nested Metabase card SQL response", () => {
  const norm = normalizeDynamicJob({
    protocolVersion: 2,
    jobId: "job-1234",
    anomaly: { message: "2026-07-29" },
    context: { runId: "run-1", countryCode: "ine", anomalyIndex: 6 },
    callback: { token: "callback-token" },
  });
  const seeded = seedCardSql(norm, {
    card: {
      id: 42,
      name: "Daily Orders",
      dataset_query: { native: { query: "SELECT * FROM dws.daily_orders JOIN dim.product ON 1=1" } },
    },
  });
  assert.deepEqual(seeded.state.discoveredTables.sort(), ["dim.product", "dws.daily_orders"]);
  assert.deepEqual(seeded.state.verifiedTables.sort(), ["dim.product", "dws.daily_orders"]);
  assert.ok(seeded.state.cardSql.length > 0);
});

/* ── Parse Dify Response ── */

test("Parse Dify Response extracts the last balanced JSON object from Dify output text", () => {
  const parsed = parseDifyResponse({
    outputs: {
      text: 'Earlier context {"action":"finish"}; note "{not JSON}". Final: {"action":"trace_lineage","table":"ads.daily_orders","reason":"escaped quote: \\"ok\\""}',
    },
  });
  assert.deepEqual(parsed.decision, { action: "trace_lineage", table: "ads.daily_orders", reason: 'escaped quote: "ok"' });
});

test("Parse Dify Response falls back conservatively for malformed trailing JSON", () => {
  const parsed = parseDifyResponse({
    outputs: { text: 'Earlier {"action":"finish"}; final {"action":"trace_lineage"' },
  });
  assert.deepEqual(parsed.decision, { action: "finish", reason: "Dify response has no trailing JSON" });
});

test("Parse Dify Response handles analysis_json output field", () => {
  const parsed = parseDifyResponse({
    outputs: { analysis_json: '{"action":"finish","summary":"done","dataSideVerdict":"business_change"}' },
  });
  assert.equal(parsed.decision.action, "finish");
  assert.equal(parsed.decision.summary, "done");
  assert.equal(parsed.decision.dataSideVerdict, "business_change");
});

/* ── Build Callback ── */

test("Build Callback maps validated Dify finish fields to analysis object", () => {
  const norm = normalizeDynamicJob({
    protocolVersion: 2,
    jobId: "job-1234",
    anomaly: { message: "2026-07-29" },
    context: { runId: "run-1", countryCode: "MX", anomalyIndex: 1 },
    callback: { token: "callback-token" },
  });
  const parsed = {
    decision: {
      action: "finish",
      summary: "已完成只读取证",
      evidence: ["card SQL", "lineage"],
      possibleCauses: ["上游未产出"],
      verificationSteps: ["已查血缘"],
      recommendedActions: ["人工确认"],
      confidence: "medium",
      limitations: "DS 未绑定",
      dataSideVerdict: "data_issue",
      notificationAction: "send",
    },
  };
  const callback = buildCallback(norm, parsed);
  assert.equal(callback.jobId, "job-1234");
  assert.equal(callback.runId, "run-1");
  assert.equal(callback.countryCode, "mx");
  assert.equal(callback.anomalyIndex, 1);
  assert.equal(callback.analysis.summary, "已完成只读取证");
  assert.deepEqual(callback.analysis.evidence, ["card SQL", "lineage"]);
  assert.equal(callback.analysis.confidence, "medium");
  assert.equal(callback.analysis.dataSideVerdict, "data_issue");
  assert.equal(callback.analysis.notificationAction, "send");
  assert.deepEqual(callback.evidence.evidenceChain, []);
});

test("Build Callback falls back to safe defaults when Dify fields are invalid", () => {
  const norm = normalizeDynamicJob({
    protocolVersion: 2,
    jobId: "job-1234",
    anomaly: { message: "2026-07-29" },
    context: { runId: "run-1", countryCode: "MX", anomalyIndex: 1 },
    callback: { token: "callback-token" },
  });
  const parsed = {
    decision: { action: "finish", summary: { unsafe: true }, confidence: "certain", dataSideVerdict: "write_data" },
    difyText: "some partial response",
  };
  const callback = buildCallback(norm, parsed);
  assert.equal(callback.analysis.confidence, "low");
  assert.equal(callback.analysis.dataSideVerdict, "insufficient_evidence");
  assert.equal(callback.analysis.notificationAction, "enrich_only");
  assert.match(callback.analysis.limitations, /some partial response/);
});

/* ── Workflow structure & security ── */

test("dynamic evidence workflow is a 9-node linear flow with no embedded secrets", () => {
  const workflow = JSON.parse(readFileSync(dynamicEvidenceWorkflowPath, "utf8"));
  assert.equal(workflow.nodes.length, 9);

  const nodeNames = workflow.nodes.map((n) => n.name);
  assert.ok(nodeNames.includes("Receive Evidence Job"));
  assert.ok(nodeNames.includes("Normalize Job"));
  assert.ok(nodeNames.includes("Respond Accepted"));
  assert.ok(nodeNames.includes("Get Card SQL"));
  assert.ok(nodeNames.includes("Seed Card SQL"));
  assert.ok(nodeNames.includes("Call Dify Agent"));
  assert.ok(nodeNames.includes("Parse Dify Response"));
  assert.ok(nodeNames.includes("Build Callback"));
  assert.ok(nodeNames.includes("Callback Platform"));

  const webhook = workflow.nodes.find((n) => n.name === "Receive Evidence Job");
  assert.equal(webhook.type, "n8n-nodes-base.webhook");

  const difyCall = workflow.nodes.find((n) => n.name === "Call Dify Agent");
  assert.equal(difyCall.parameters.options.timeout, 300000);

  assert.match(JSON.stringify(workflow), /REPLACE_WITH_DIFY_API_KEY/);
  assert.match(JSON.stringify(workflow), /REPLACE_WITH_METABASE_ANOMALY_AGENT_WEBHOOK_TOKEN/);
  assert.match(JSON.stringify(workflow), /REPLACE_WITH_METABASE_AGENT_CALLBACK_TOKEN/);
  assert.doesNotMatch(JSON.stringify(workflow), /\$env\b|\$vars\b|sk-[a-z0-9]{12,}/i);

  const hexTokens = JSON.stringify(workflow).match(/[0-9a-f]{32,}/g);
  assert.equal(hexTokens, null);
});

test("Metabase anomaly Agent guide references the dynamic Dify template", () => {
  const guide = readFileSync(metabaseAnomalyAgentDocPath, "utf8");
  const workflow = JSON.parse(readFileSync(dynamicEvidenceWorkflowPath, "utf8"));
  const webhook = workflow.nodes.find((node) => node.name === "Receive Evidence Job");

  assert.match(guide, /n8n-metabase-anomaly-dynamic-evidence-agent\.template\.json/);
  assert.match(guide, new RegExp(webhook.parameters.path));
  assert.match(guide, /Dify 决策/);
  assert.match(guide, /METABASE_ANOMALY_AGENT_N8N_TOKEN/);
  assert.match(guide, /METABASE_ANOMALY_AGENT_CALLBACK_TOKEN/);
});

/* ── Warehouse lineage gateway (unchanged) ── */

function getStaticParser() {
  const workflow = JSON.parse(readFileSync(workflowPath, "utf8"));
  const codeNode = workflow.nodes.find((node) => node.name === "校验并构造只读检索命令");
  const createCommand = new Function("$json", "Buffer", codeNode.parameters.jsCode);
  const [{ json }] = createCommand({ body: { countryCode: "mx", table: "dws.dws_asset_gmv_income_mv" } }, Buffer);
  const encoded = json.command.match(/[A-Za-z0-9+/]{100,}={0,2}/)[0];
  return Buffer.from(encoded, "base64").toString("utf8");
}

test("warehouse lineage workflow parser accepts backtick-quoted qualified SQL identifiers", () => {
  const root = mkdtempSync(join(tmpdir(), "warehouse-lineage-"));
  try {
    writeFileSync(join(root, "lineage.sql"), [
      "insert overwrite table `dws`.`dws_asset_gmv_income_mv`",
      "select * from `dim`.`dim_product_split`",
    ].join("\n"));

    const result = JSON.parse(execFileSync("python3", ["-c", getStaticParser(), root, "dws.dws_asset_gmv_income_mv", "10"], { encoding: "utf8" }));

    assert.deepEqual(result.upstreamTables, ["dim.dim_product_split"]);
    assert.equal(result.matchedFiles[0].outputTables[0], "dws.dws_asset_gmv_income_mv");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("warehouse lineage gateway uses SSH-based country routing for six countries", () => {
  const workflow = JSON.parse(readFileSync(workflowPath, "utf8"));
  const sshNodes = workflow.nodes.filter((node) => node.type === "n8n-nodes-base.ssh");
  assert.ok(sshNodes.length >= 6);
  const switchNode = workflow.nodes.find((node) => node.name === "按国家分流到跳板机");
  assert.ok(switchNode);
  assert.doesNotMatch(JSON.stringify(workflow), /passwordEnv|sshHost/i);
});
