import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const workflowPath = new URL("../n8n-warehouse-lineage-gateway.template.json", import.meta.url);
const partitionEvidenceWorkflowPath = new URL("../n8n-warehouse-partition-evidence-gateway.template.json", import.meta.url);
const dsRuntimeEvidenceWorkflowPath = new URL("../n8n-ds-runtime-evidence-gateway.template.json", import.meta.url);
const dynamicEvidenceWorkflowPath = new URL("../n8n-metabase-anomaly-dynamic-evidence-agent.template.json", import.meta.url);
const metabaseAnomalyAgentDocPath = new URL("../docs/metabase-anomaly-agent.md", import.meta.url);

function dynamicNode(name) {
  const workflow = JSON.parse(readFileSync(dynamicEvidenceWorkflowPath, "utf8"));
  return workflow.nodes.find((node) => node.name === name);
}

function normalizeDynamicJob(body, authorization = "Bearer REPLACE_WITH_METABASE_ANOMALY_AGENT_WEBHOOK_TOKEN") {
  const node = dynamicNode("Normalize Async Job And Safe Dates");
  return new Function("$json", node.parameters.jsCode)({ body, headers: { authorization } })[0].json;
}

function parseDynamicDecision(base, raw) {
  const node = dynamicNode("Parse Trailing Dify JSON");
  return new Function("$json", node.parameters.jsCode)({ ...base, text: raw })[0].json;
}

function appendDynamicEvidence(prior, result) {
  const node = dynamicNode("Append Bounded Gateway Evidence");
  return new Function("$json", "structuredClone", "$", node.parameters.jsCode)(result, structuredClone, () => ({ first: () => ({ json: prior }) }))[0].json;
}

function validateDynamicAction(state, difyText) {
  const node = dynamicNode("Validate Dify Action And Budget");
  const run = new Function("$json", "$", node.parameters.jsCode);
  return run({ state, difyText }, () => ({ first: () => ({ json: { state, difyText } }) }))[0].json;
}

function buildCompletionCallback(input) {
  const node = dynamicNode("Build Conservative Completion Callback");
  return new Function("$json", node.parameters.jsCode)(input)[0].json;
}

function buildDsRequest(input) {
  const node = dynamicNode("Build DS Runtime Evidence Request");
  return new Function("$json", "structuredClone", "$", node.parameters.jsCode)(input, structuredClone, () => ({ first: () => ({ json: input }) }))[0].json;
}

function seedVerifiedCardTables(base, cardResponse) {
  const node = dynamicNode("Seed Only Verified Card Tables");
  return new Function("$json", "$", node.parameters.jsCode)(cardResponse, () => ({ first: () => ({ json: base }) }))[0].json;
}

function validateLineageRequest(body, authorization = "Bearer REPLACE_WITH_EVIDENCE_GATEWAY_TOKEN") {
  const workflow = JSON.parse(readFileSync(workflowPath, "utf8"));
  const node = workflow.nodes.find((item) => item.name === "严格校验只读血缘请求");
  return new Function("$json", "Buffer", node.parameters.jsCode)({ body, headers: { authorization } }, Buffer)[0].json;
}

test("dynamic evidence parser selects the last balanced action object despite prior JSON, braces, and escapes", () => {
  const parsed = parseDynamicDecision({}, 'Earlier context {"action":"finish"}; note "{not JSON}". Final: {"action":"trace_lineage","table":"ads.daily_orders","reason":"escaped quote: \\"ok\\""}');
  assert.deepEqual(parsed.decision, { action: "trace_lineage", table: "ads.daily_orders", reason: 'escaped quote: "ok"' });
});

test("dynamic evidence parser falls back conservatively for malformed trailing JSON", () => {
  const parsed = parseDynamicDecision({}, 'Earlier {"action":"finish"}; final {"action":"trace_lineage"');
  assert.deepEqual(parsed.decision, { action: "finish", reason: "Dify response has no trailing JSON" });
});

test("dynamic evidence turns a continued Dify HTTP failure into a conservative finish callback", () => {
  const parse = dynamicNode("Parse Trailing Dify JSON");
  const parsed = new Function("$json", parse.parameters.jsCode)({
    jobId: "job-1234",
    context: { runId: "run-1", countryCode: "MX", anomalyIndex: 1 },
    state: { evidence: [], budget: {} },
    error: { message: "Dify HTTP 503" },
  })[0].json;
  assert.equal(parsed.decision.action, "finish");
  const validated = validateDynamicAction(parsed.state, JSON.stringify(parsed.decision));
  const callback = buildCompletionCallback({ ...parsed, ...validated });
  assert.equal(callback.analysis.dataSideVerdict, "insufficient_evidence");
  assert.equal(callback.analysis.notificationAction, "enrich_only");
  assert.equal(callback.jobId, "job-1234");
});

test("dynamic evidence normalizes valid dates, truncates display input, and uses only the fixed callback destination", () => {
  const body = { protocolVersion: 2, jobId: "job-1234", anomaly: { message: "baseline 2026/07/01 and anomaly 2026-07-29" }, context: { runId: "run-1", countryCode: "mx", anomalyIndex: 0 }, callback: { url: "https://platform.example/callback", token: "callback-token" } };
  const normalized = normalizeDynamicJob(body);
  assert.equal(normalized.jobId, "job-1234");
  assert.deepEqual(normalized.callback, { url: "REPLACE_WITH_DUTY_PLATFORM_INTERNAL_CALLBACK_URL", token: "callback-token" });
  assert.equal(normalized.state.anomalyDate, "2026-07-29");
  assert.equal(normalized.state.baselineDate, "2026-07-01");
  assert.throws(() => normalizeDynamicJob({ ...body, anomaly: { message: "bad 2026-02-30" } }), /invalid anomaly date/i);
  const fallback = normalizeDynamicJob({ ...body, anomaly: { message: "no date supplied" } });
  assert.match(fallback.state.anomalyDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(fallback.state.baselineDate, /^\d{4}-\d{2}-\d{2}$/);
  const oversized = normalizeDynamicJob({ ...body, anomaly: { message: "x".repeat(13000), dashboardTitle: "d".repeat(300), cardTitle: "c".repeat(300), dashboardUrl: "u".repeat(2100) } });
  assert.equal(oversized.anomaly.message.length, 12000);
  assert.equal(oversized.anomaly.dashboardTitle.length, 256);
  assert.equal(oversized.anomaly.cardTitle.length, 256);
  assert.equal(oversized.anomaly.dashboardUrl.length, 2048);
});

test("dynamic evidence webhook rejects missing or incorrect ingress authorization and invalid callback credentials", () => {
  const body = { protocolVersion: 2, jobId: "job-1234", anomaly: { message: "2026-07-29" }, context: { runId: "run-1", countryCode: "mx", anomalyIndex: 0 }, callback: { token: "callback-token" } };
  const expected = "Bearer REPLACE_WITH_METABASE_ANOMALY_AGENT_WEBHOOK_TOKEN";
  assert.equal(normalizeDynamicJob(body, expected).jobId, "job-1234");
  assert.throws(() => normalizeDynamicJob(body, ""), /Unauthorized dynamic evidence webhook/);
  assert.throws(() => normalizeDynamicJob(body, "Bearer wrong-token"), /Unauthorized dynamic evidence webhook/);
  assert.throws(() => normalizeDynamicJob(body, `${expected.slice(0, -1)}X`), /Unauthorized dynamic evidence webhook/);
  assert.throws(() => normalizeDynamicJob({ ...body, jobId: "" }), /valid jobId and callback.token/i);
  assert.throws(() => normalizeDynamicJob({ ...body, callback: {} }), /valid jobId and callback.token/i);
});

test("dynamic evidence webhook implements a bounded constant-time-style ingress comparison", () => {
  const node = dynamicNode("Normalize Async Job And Safe Dates");
  assert.match(node.parameters.jsCode, /const tokenEquals = \(left, right\).*Math\.max\(actual\.length, configured\.length\).*diff \|=/s);
  assert.doesNotMatch(node.parameters.jsCode, /header !== expected|header === expected/);
});

test("dynamic evidence ignores external, metadata, and redirect callback URLs", () => {
  const base = { protocolVersion: 2, jobId: "job-1234", anomaly: { message: "2026-07-29" }, context: { runId: "run-1", countryCode: "mx", anomalyIndex: 0 }, callback: { token: "callback-token" } };
  for (const url of ["https://evil.example/callback", "http://169.254.169.254/latest/meta-data", "http://redirector.example/to-internal"]) {
    const normalized = normalizeDynamicJob({ ...base, callback: { ...base.callback, url } });
    assert.equal(normalized.callback.url, "REPLACE_WITH_DUTY_PLATFORM_INTERNAL_CALLBACK_URL");
  }
});

test("dynamic evidence bounds stored evidence and expands only verified producer tables", () => {
  const prior = { action: "trace_lineage", table: "ads.daily_orders", state: { discoveredTables: ["ads.daily_orders"], verifiedTables: ["ads.daily_orders"], evidence: Array.from({ length: 20 }, (_, i) => ({ i })), lineage: [], budget: { depth: 0 } } };
  const next = appendDynamicEvidence(prior, { evidence: { quality: "producer_sql" }, upstreamTables: ["dws.daily_orders", "invalid;table"] });
  assert.equal(next.state.evidence.length, 20);
  assert.deepEqual(next.state.discoveredTables, ["ads.daily_orders", "dws.daily_orders"]);
  assert.deepEqual(next.state.verifiedTables, ["ads.daily_orders", "dws.daily_orders"]);
  assert.equal(next.state.budget.depth, 1);
});

test("dynamic evidence seeds lineage only from the nested Card SQL response returned by ZNZB", () => {
  const base = normalizeDynamicJob({
    protocolVersion: 2,
    jobId: "job-1234",
    anomaly: { message: "2026-07-29" },
    context: { runId: "run-1", countryCode: "ine", anomalyIndex: 6 },
    callback: { token: "callback-token" },
  });
  const seeded = seedVerifiedCardTables(base, {
    success: true,
    card: {
      id: 469,
      dataset_query: {
        native: {
          query: "SELECT * FROM `ads`.`ads_3005_gmv_dashboard_sumary_d` JOIN dws.daily_orders ON 1 = 1",
        },
      },
    },
  });
  assert.deepEqual(seeded.state.discoveredTables, ["ads.ads_3005_gmv_dashboard_sumary_d", "dws.daily_orders"]);
  assert.equal(seeded.state.evidence[0].cardId, 469);
  assert.equal(validateDynamicAction(seeded.state, '{"action":"trace_lineage","table":"ads.ads_3005_gmv_dashboard_sumary_d"}').valid, true);
});

test("dynamic evidence keeps card-SQL HTTP failures as bounded unavailable evidence", () => {
  const base = normalizeDynamicJob({
    protocolVersion: 2,
    jobId: "job-1234",
    anomaly: { message: "2026-07-29" },
    context: { runId: "run-1", countryCode: "ine", anomalyIndex: 6 },
    callback: { token: "callback-token" },
  });
  const seeded = seedVerifiedCardTables(base, { error: { message: "request timed out after 30s" } });
  assert.deepEqual(seeded.state.evidence, [{ kind: "card_sql", status: "unavailable", error: "request timed out after 30s" }]);
  assert.deepEqual(seeded.state.discoveredTables, []);
});

test("all five external evidence requests continue regular output and every action branch reaches callback", () => {
  const workflow = JSON.parse(readFileSync(dynamicEvidenceWorkflowPath, "utf8"));
  const external = [
    "Get Verified Card SQL",
    "Ask Dify For Next Action",
    "Trace Lineage Via Public Gateway",
    "Check Partition Via Public Gateway",
    "Check DS Runtime Via Public Gateway",
  ];
  for (const name of external) {
    assert.equal(dynamicNode(name).onError, "continueRegularOutput", `${name} must not strand an accepted job on HTTP failure`);
  }
  const reachable = (from, target, seen = new Set()) => {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (workflow.connections[from]?.main || []).flat().some((edge) => reachable(edge.node, target, seen));
  };
  for (const name of ["Get Verified Card SQL", "Ask Dify For Next Action", "Trace Lineage Via Public Gateway", "Check Partition Via Public Gateway", "Check DS Runtime Via Public Gateway"]) {
    assert.equal(reachable(name, "Callback Duty Platform"), true, `${name} failure continuation must be able to reach callback`);
  }
});

test("dynamic evidence keeps backward-compatible top-level Card SQL fields", () => {
  const seeded = seedVerifiedCardTables({ state: {} }, { sql: "SELECT * FROM dws.daily_orders" });
  assert.deepEqual(seeded.state.discoveredTables, ["dws.daily_orders"]);
});

test("dynamic evidence workflow only accepts actions against discovered tables within fixed budgets", () => {
  const state = {
    discoveredTables: ["ads.daily_orders"], verifiedTables: ["ads.daily_orders"],
    budget: { maxDepth: 3, maxCalls: 10, maxPartitions: 3, maxDs: 3, depth: 0, calls: 1, partitions: 0, ds: 0 },
  };
  const accepted = validateDynamicAction(state, 'Decision: {"action":"trace_lineage","table":"ads.daily_orders"}');
  assert.equal(accepted.valid, true);
  assert.equal(accepted.action, "trace_lineage");
  assert.equal(accepted.table, "ads.daily_orders");

  for (const decision of [
    '{"action":"check_partition","table":"dws.invented"}',
    '{"action":"trace_lineage","table":"ads.daily_orders","depth":4}',
    '{"action":"check_partition","table":"ads.daily_orders"}',
  ]) {
    const result = validateDynamicAction(
      decision.includes("check_partition") ? { ...state, budget: { ...state.budget, partitions: 3 } } : state,
      decision,
    );
    assert.equal(result.valid, false);
  }
});

test("dynamic evidence workflow drives card to lineage to partition to DS then finish", () => {
  const state = {
    discoveredTables: ["ads.daily_orders"], verifiedTables: ["ads.daily_orders"],
    lineage: [{ table: "ads.daily_orders", upstreamTables: ["dws.daily_orders"], producerSql: true }],
    budget: { maxDepth: 3, maxCalls: 10, maxPartitions: 3, maxDs: 3, depth: 1, calls: 4, partitions: 1, ds: 0 },
  };
  assert.equal(validateDynamicAction(state, '{"action":"trace_lineage","table":"ads.daily_orders"}').action, "trace_lineage");
  assert.equal(validateDynamicAction(state, '{"action":"check_partition","table":"ads.daily_orders"}').action, "check_partition");
  assert.equal(validateDynamicAction(state, '{"action":"check_ds_workflow","table":"ads.daily_orders"}').action, "check_ds_workflow");
  assert.equal(validateDynamicAction(state, '{"action":"finish"}').action, "finish");
});

test("dynamic evidence completion preserves bounded validated Dify finish fields", () => {
  const callback = buildCompletionCallback({
    jobId: "job-1234",
    context: { runId: "run-1", countryCode: "MX", anomalyIndex: 1 },
    valid: true,
    action: "finish",
    decision: {
      action: "finish", summary: "已完成只读取证", evidence: ["card SQL", "lineage"],
      possibleCauses: ["上游未产出"], verificationSteps: ["已查分区"], recommendedActions: ["人工确认"],
      confidence: "medium", limitations: "DS 未绑定", dataSideVerdict: "data_issue", notificationAction: "send",
    },
    state: { evidence: [{ kind: "trace_lineage" }] },
  });
  assert.equal(callback.analysis.summary, "已完成只读取证");
  assert.deepEqual(callback.analysis.evidence, ["card SQL", "lineage"]);
  assert.equal(callback.analysis.confidence, "medium");
  assert.equal(callback.analysis.dataSideVerdict, "data_issue");
  assert.equal(callback.analysis.notificationAction, "send");
  assert.deepEqual(callback.analysis.evidenceChain, [{ kind: "trace_lineage", table: null, result: null }]);
  // Top-level evidence preserves the sanitized gateway record.  Missing fields
  // stay absent instead of being materialized as nulls, so no invented table or
  // result can be displayed by the platform.
  assert.deepEqual(callback.evidence, { evidenceChain: [{ kind: "trace_lineage" }] });
});

test("dynamic evidence completion falls back when Dify finish fields are invalid", () => {
  const callback = buildCompletionCallback({
    jobId: "job-1234", context: { runId: "run-1", countryCode: "MX", anomalyIndex: 1 },
    valid: false, action: "finish", decision: { action: "finish", summary: { unsafe: true }, confidence: "certain", dataSideVerdict: "write_data" }, state: {}, error: "unsupported_action",
  });
  assert.equal(callback.analysis.confidence, "low");
  assert.equal(callback.analysis.dataSideVerdict, "insufficient_evidence");
  assert.equal(callback.analysis.notificationAction, "enrich_only");
  assert.match(callback.analysis.limitations, /unsupported_action/);
});

test("dynamic evidence completion persists a bounded redacted evidence chain at callback top level", () => {
  const callback = buildCompletionCallback({
    jobId: "job-1234", context: { runId: "run-1", countryCode: "MX", anomalyIndex: 1 }, valid: true, action: "finish",
    decision: { action: "finish", summary: "finished" },
    state: { evidence: Array.from({ length: 24 }, (_, index) => ({ kind: "trace_lineage", table: "dws.orders", result: { quality: "producer_sql", sourceSql: "SELECT secret", authorization: "Bearer hidden", detail: "x".repeat(700), index } })) },
  });
  assert.equal(callback.evidence.evidenceChain.length, 20);
  assert.equal(callback.evidence.evidenceChain[0].result.sourceSql, undefined);
  assert.equal(callback.evidence.evidenceChain[0].result.authorization, undefined);
  assert.equal(callback.evidence.evidenceChain[0].result.detail.length, 600);
  assert.equal(JSON.stringify(callback.evidence).includes("Bearer hidden"), false);
});

test("dynamic evidence DS request forwards only verified producer lineage clues", () => {
  const request = buildDsRequest({
    context: { countryCode: "INE" }, table: "dwd.dwd_app_dtb", state: {
      anomalyDate: "2026-07-30",
      lineage: [{ table: "dwd.dwd_app_dtb", producerSql: true, producerFiles: ["dwd/dwd_app_dtb/dwd_app_dtb.sql"], sourceSql: "INSERT OVERWRITE dwd.dwd_app_dtb SELECT * FROM ods.app" }],
    },
  });
  assert.equal(request.dsEvidenceAvailable, true);
  assert.equal(request.dsRequest.countryCode, "INE");
  assert.equal(request.dsRequest.table, "dwd.dwd_app_dtb");
  assert.deepEqual(request.dsRequest.producerFiles, ["dwd/dwd_app_dtb/dwd_app_dtb.sql"]);
  assert.match(request.dsRequest.sourceSql, /^INSERT OVERWRITE/);
});

test("warehouse lineage gateway accepts only strict read-only trace requests", () => {
  const valid = validateLineageRequest({ operation: "trace_table", countryCode: "mx", table: "dws.daily_orders", maxFiles: 10 });
  assert.equal(valid.valid, true);
  assert.equal(valid.table, "dws.daily_orders");
  for (const body of [
    { operation: "trace_table", countryCode: "mx", table: "daily_orders", maxFiles: 10 },
    { operation: "trace_table", countryCode: "mx", table: "dws.daily_orders", maxFiles: 0 },
    { operation: "trace_table", countryCode: "mx", table: "dws.daily_orders", maxFiles: "10" },
    { operation: "trace_table", countryCode: "mx", table: "dws.daily_orders", sql: "select 1" },
    { operation: "trace_table", countryCode: "mx", table: "dws.daily_orders", host: "evil", command: "id", token: "secret" },
  ]) assert.equal(validateLineageRequest(body).valid, false);
});

test("all reusable evidence gateways require the shared bearer token", () => {
  const lineage = { operation: "trace_table", countryCode: "mx", table: "dws.daily_orders", maxFiles: 10 };
  const partition = { countryCode: "mx", table: "dws.daily_orders", anomalyDate: "2026-07-29", baselineDate: "2026-07-01" };
  const ds = { countryCode: "mx", table: "dws.daily_orders", anomalyDate: "2026-07-29", sourceSql: "SELECT 1" };
  for (const [validate, body] of [[validateLineageRequest, lineage], [validatePartitionEvidence, partition], [validateDsRuntimeEvidence, ds]]) {
    assert.equal(validate(body, "").valid, false);
    assert.equal(validate(body, "Bearer wrong-token").valid, false);
    assert.equal(validate(body, "Bearer REPLACE_WITH_EVIDENCE_GATEWAY_TOKEN").valid, true);
  }
});

test("dynamic evidence workflow is async, uses public fixed gateways, and has no embedded secrets", () => {
  const workflow = JSON.parse(readFileSync(dynamicEvidenceWorkflowPath, "utf8"));
  assert.equal(workflow.nodes.find((node) => node.name === "Receive Dynamic Evidence Job").parameters.responseMode, "responseNode");
  assert.match(JSON.stringify(workflow), /\/webhook\/warehouse-lineage/);
  assert.match(JSON.stringify(workflow), /\/webhook\/warehouse-partition-evidence/);
  assert.match(JSON.stringify(workflow), /\/webhook\/ds-runtime-evidence/);
  assert.match(JSON.stringify(workflow), /REPLACE_WITH_DIFY_API_KEY/);
  assert.match(JSON.stringify(workflow), /REPLACE_WITH_DIFY_WORKFLOW_RUN_URL/);
  assert.doesNotMatch(JSON.stringify(workflow), /REPLACE_WITH_DIFY_HOST/);
  assert.match(JSON.stringify(workflow), /REPLACE_WITH_METABASE_ANOMALY_AGENT_WEBHOOK_TOKEN/);
  assert.match(JSON.stringify(workflow), /REPLACE_WITH_EVIDENCE_GATEWAY_TOKEN/);
  assert.match(JSON.stringify(workflow), /REPLACE_WITH_DUTY_PLATFORM_INTERNAL_CALLBACK_URL/);
  const cardSql = workflow.nodes.find((node) => node.name === "Get Verified Card SQL");
  const cardSqlAuthorization = cardSql.parameters.headerParameters.parameters.find((header) => header.name === "Authorization").value;
  assert.equal(cardSqlAuthorization, "=Bearer REPLACE_WITH_METABASE_AGENT_CALLBACK_TOKEN");
  assert.doesNotMatch(JSON.stringify(cardSql), /REPLACE_WITH_PLATFORM_CARD_SQL_TOKEN/);
  assert.doesNotMatch(workflow.nodes.find((node) => node.name === "Callback Duty Platform").parameters.url, /callback\.url/);
  assert.doesNotMatch(JSON.stringify(workflow), /\$env\b|\$vars\b|sk-[a-z0-9]{12,}/i);
  assert.equal(workflow.nodes.find((node) => node.name === "Ask Dify For Next Action").parameters.url, "=REPLACE_WITH_DIFY_WORKFLOW_RUN_URL");
  const difyBody = workflow.nodes.find((node) => node.name === "Ask Dify For Next Action").parameters.jsonBody;
  for (const field of ["run_id", "country_code", "anomaly_index", "anomaly_message", "dashboard_title", "card_title", "dashboard_url", "state_json"]) {
    assert.match(difyBody, new RegExp(`\\b${field}\\s*:`));
  }
  assert.ok(workflow.nodes.find((node) => node.name === "Build DS Runtime Evidence Request"));
  for (const name of ["Trace Lineage Via Public Gateway", "Check Partition Via Public Gateway", "Check DS Runtime Via Public Gateway"]) {
    const authorization = workflow.nodes.find((node) => node.name === name).parameters.headerParameters.parameters.find((header) => header.name === "Authorization").value;
    assert.equal(authorization, "=Bearer REPLACE_WITH_EVIDENCE_GATEWAY_TOKEN");
  }
});

test("Metabase anomaly Agent guide defaults to the dynamic Dify template and its fixed security contract", () => {
  const guide = readFileSync(metabaseAnomalyAgentDocPath, "utf8");
  const workflow = JSON.parse(readFileSync(dynamicEvidenceWorkflowPath, "utf8"));
  const webhook = workflow.nodes.find((node) => node.name === "Receive Dynamic Evidence Job");

  assert.match(guide, /n8n-metabase-anomaly-dynamic-evidence-agent\.template\.json/);
  assert.match(guide, new RegExp(`/webhook/${webhook.parameters.path}`));
  assert.match(guide, /Dify 决策/);
  assert.match(guide, /METABASE_ANOMALY_AGENT_N8N_TOKEN/);
  assert.match(guide, /METABASE_ANOMALY_AGENT_CALLBACK_TOKEN/);
  assert.match(guide, /REPLACE_WITH_METABASE_AGENT_CALLBACK_TOKEN/);
  assert.match(guide, /REPLACE_WITH_DUTY_PLATFORM_INTERNAL_CALLBACK_URL/);
  assert.match(guide, /DIFY_WAREHOUSE_LINEAGE_TOOL_TOKEN[\s\S]{0,100}不得/);
  assert.doesNotMatch(guide, /当前部署的 Agent 是 \*\*n8n 编排 \+ DashScope/);
});

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

function validatePartitionEvidence(body, authorization = "Bearer REPLACE_WITH_EVIDENCE_GATEWAY_TOKEN") {
  const workflow = JSON.parse(readFileSync(partitionEvidenceWorkflowPath, "utf8"));
  const codeNode = workflow.nodes.find((node) => node.name === "Validate And Build Fixed Partition Evidence");
  const validate = new Function("$json", codeNode.parameters.jsCode);
  return validate({ body, headers: { authorization } })[0].json;
}

test("warehouse partition evidence workflow accepts only normalized identifiers and a 31-day date window", () => {
  const result = validatePartitionEvidence({
    countryCode: "ID",
    table: "dws.daily_orders",
    anomalyDate: "2026-07-29",
    baselineDate: "2026-07-01",
    metricHint: "gmv",
  });

  assert.equal(result.valid, true);
  assert.equal(result.countryCode, "ine");
  assert.equal(result.table, "dws.daily_orders");
  assert.match(result.query, /^SELECT 'anomaly' AS evidence_type/);
  assert.match(result.query, /`dws`\.`daily_orders`/);
  assert.doesNotMatch(result.query, /gmv/);
});

test("warehouse partition evidence workflow rejects injected fields and invalid date spans", () => {
  for (const body of [
    { countryCode: "mx", table: "dws.orders; DROP TABLE x", anomalyDate: "2026-07-29", baselineDate: "2026-07-01" },
    { countryCode: "mx", table: "dws.orders", anomalyDate: "2026-07-29", baselineDate: "2026-06-01" },
    { countryCode: "mx", table: "dws.orders", anomalyDate: "2026-02-30", baselineDate: "2026-02-01" },
    { countryCode: "mx", table: "dws.orders", anomalyDate: "2026-07-29", baselineDate: "2026-07-01", partitionColumn: "event_date" },
    { countryCode: "mx", table: "dws.orders", anomalyDate: "2026-07-29", baselineDate: "2026-07-01", sql: "SELECT *", host: "evil.example", command: "id", password: "secret" },
  ]) {
    assert.equal(validatePartitionEvidence(body).valid, false);
  }
});

test("warehouse partition evidence workflow binds only read-only country credential placeholders and has an unavailable response", () => {
  const workflow = JSON.parse(readFileSync(partitionEvidenceWorkflowPath, "utf8"));
  const webhook = workflow.nodes.find((node) => node.type === "n8n-nodes-base.webhook");
  assert.equal(webhook.parameters.path, "warehouse-partition-evidence");
  assert.equal(webhook.parameters.httpMethod, "POST");

  const readers = workflow.nodes.filter((node) => node.name.startsWith("Read-only StarRocks "));
  assert.deepEqual(readers.map((node) => node.name.replace("Read-only StarRocks ", "")).sort(), ["cn", "ine", "mx", "ph", "pk", "th"]);
  for (const node of readers) {
    const country = node.name.replace("Read-only StarRocks ", "").toUpperCase();
    assert.equal(node.credentials.mySql.id, `REPLACE_WITH_STARROCKS_READONLY_${country}_CREDENTIAL`);
    assert.match(node.credentials.mySql.name, /Read-only/);
  }

  const unavailable = workflow.nodes.find((node) => node.name === "Return Connector Unavailable");
  assert.match(unavailable.parameters.jsCode, /unavailable/);
  assert.doesNotMatch(JSON.stringify(workflow), /(?:10\.|192\.168\.|172\.20\.|passwordEnv|sshHost)/i);
});

function validateDsRuntimeEvidence(body, authorization = "Bearer REPLACE_WITH_EVIDENCE_GATEWAY_TOKEN") {
  const workflow = JSON.parse(readFileSync(dsRuntimeEvidenceWorkflowPath, "utf8"));
  const codeNode = workflow.nodes.find((node) => node.name === "Validate DS Runtime Evidence Input");
  const validate = new Function("$json", codeNode.parameters.jsCode);
  return validate({ body, headers: { authorization } })[0].json;
}

test("DS runtime evidence workflow accepts bounded allowlisted evidence inputs", () => {
  const result = validateDsRuntimeEvidence({
    countryCode: "ID",
    table: "dws.daily_orders",
    producerFiles: ["jobs/daily_orders.sql", "jobs/common_dims.sql"],
    sourceSql: "INSERT OVERWRITE dws.daily_orders SELECT * FROM ods.orders",
    anomalyDate: "2026-07-29",
  });

  assert.equal(result.valid, true);
  assert.equal(result.countryCode, "ine");
  assert.equal(result.table, "dws.daily_orders");
  assert.deepEqual(result.producerFiles, ["jobs/daily_orders.sql", "jobs/common_dims.sql"]);
  assert.equal(result.anomalyDate, "2026-07-29");
});

test("DS runtime evidence workflow rejects control fields and unbounded evidence", () => {
  for (const body of [
    { countryCode: "mx", table: "dws.orders", anomalyDate: "2026-07-29", retry: true },
    { countryCode: "mx", table: "dws.orders", anomalyDate: "2026-07-29", token: "secret", command: "id" },
    { countryCode: "mx", table: "dws.orders", anomalyDate: "2026-07-29", url: "https://evil.example", startInstance: 1 },
    { countryCode: "mx", table: "dws.orders; drop table x", anomalyDate: "2026-07-29" },
    { countryCode: "mx", table: "dws.orders", anomalyDate: "2026-07-29", producerFiles: Array.from({ length: 21 }, () => "a.sql") },
    { countryCode: "mx", table: "dws.orders", anomalyDate: "2026-07-29", sourceSql: "x".repeat(20001) },
    { countryCode: ["mx"], table: "dws.orders", anomalyDate: "2026-07-29", sourceSql: "SELECT 1" },
    { countryCode: "mx", table: ["dws.orders"], anomalyDate: "2026-07-29", sourceSql: "SELECT 1" },
    { countryCode: "mx", table: "dws.orders", anomalyDate: ["2026-07-29"], sourceSql: "SELECT 1" },
    { countryCode: "mx", table: "dws.orders", anomalyDate: "2026-07-29", sourceSql: { sql: "SELECT 1" } },
    { countryCode: "mx", table: "dws.orders", anomalyDate: "2026-07-29", producerFiles: ["/etc/passwd"] },
  ]) {
    assert.equal(validateDsRuntimeEvidence(body).valid, false);
  }
});

test("DS runtime evidence workflow is prebound, safely unavailable by default, and filters to high-confidence candidates", () => {
  const workflow = JSON.parse(readFileSync(dsRuntimeEvidenceWorkflowPath, "utf8"));
  const webhook = workflow.nodes.find((node) => node.type === "n8n-nodes-base.webhook");
  assert.equal(webhook.parameters.path, "ds-runtime-evidence");

  const reference = workflow.nodes.find((node) => node.name === "Resolve Prebound DS Runtime Reference");
  assert.match(reference.parameters.jsCode, /no_verified_ds_reference/);
  assert.match(reference.parameters.jsCode, /REPLACE_WITH_DS_TASK_MATCH_CANDIDATE_QUERY_WORKFLOW_ID/);

  const execute = workflow.nodes.find((node) => node.name === "Invoke Prebound DS Task Candidate Query");
  assert.equal(execute.type, "n8n-nodes-base.executeWorkflow");
  assert.doesNotMatch(JSON.stringify(execute), /auto.?rerun|restart|retry|start.?instance/i);

  const filter = workflow.nodes.find((node) => node.name === "Return High-confidence DS Candidates Only");
  const normalize = new Function("$input", "$", filter.parameters.jsCode);
  const [{ json }] = normalize(
    { all: () => [{ json: { candidates: [{ workflowName: "daily_orders", confidence: "high" }, { workflowName: "weak", confidence: "low" }, { workflowName: "scored", confidence: 0.92 }] } }] },
    () => ({ first: () => ({ json: { countryCode: "mx", table: "dws.orders", anomalyDate: "2026-07-29" } }) }),
  );
  assert.deepEqual(json.candidates.map((candidate) => candidate.workflowName), ["daily_orders", "scored"]);
  assert.equal(json.status, "ok");
  assert.equal(workflow.nodes.some((node) => /n8n-nodes-base\.(?:mysql|slack)/i.test(node.type)), false);
  assert.equal(workflow.nodes.some((node) => /auto.?rerun|restart/i.test(node.name)), false);
});
