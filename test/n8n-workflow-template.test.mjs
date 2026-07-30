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

function buildDsMatchRequest(input) {
  const node = dynamicNode("Build DS Match Request");
  return new Function("$json", "structuredClone", "$", node.parameters.jsCode)(input, structuredClone, () => ({ first: () => ({ json: input }) }))[0].json;
}

function collectDsMatchCandidates(rows) {
  const node = dynamicNode("Collect DS Match Candidates");
  const run = new Function("$input", node.parameters.jsCode);
  return run({ all: () => rows.map((json) => ({ json })) })[0].json;
}

function buildDsStatusRequest(input) {
  const node = dynamicNode("Build DS Status Request");
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
    card: {
      id: 42,
      name: "Daily Orders",
      dataset_query: { native: { query: "SELECT * FROM dws.daily_orders JOIN dim.product ON 1=1" } },
    },
  });
  assert.deepEqual(seeded.state.discoveredTables.sort(), ["dim.product", "dws.daily_orders"]);
  assert.equal(seeded.state.evidence[0].kind, "card_sql");
  assert.equal(seeded.state.evidence[0].status, "available");
});

test("dynamic evidence workflow validates all five evidence actions with budget tracking", () => {
  const state = {
    discoveredTables: ["ads.daily_orders"], verifiedTables: ["ads.daily_orders"],
    lineage: [{ table: "ads.daily_orders", upstreamTables: ["dws.daily_orders"], producerSql: true }],
    budget: { maxDepth: 3, maxCalls: 12, maxWattrel: 3, maxDs: 3, maxDsStatus: 3, depth: 1, calls: 4, wattrel: 0, ds: 0, dsStatus: 0 },
  };
  assert.equal(validateDynamicAction(state, '{"action":"trace_lineage","table":"ads.daily_orders"}').action, "trace_lineage");
  assert.equal(validateDynamicAction(state, '{"action":"check_wattrel","table":"ads.daily_orders"}').action, "check_wattrel");
  assert.equal(validateDynamicAction(state, '{"action":"check_ds_workflow","table":"ads.daily_orders"}').action, "check_ds_workflow");
  assert.equal(validateDynamicAction(state, '{"action":"check_ds_status","table":"ads.daily_orders"}').action, "check_ds_status");
  assert.equal(validateDynamicAction(state, '{"action":"finish"}').action, "finish");
  const partitionResult = validateDynamicAction(state, '{"action":"check_partition","table":"ads.daily_orders"}');
  assert.equal(partitionResult.valid, false);
  assert.equal(partitionResult.action, "finish");
});

test("dynamic evidence completion preserves bounded validated Dify finish fields", () => {
  const callback = buildCompletionCallback({
    jobId: "job-1234",
    context: { runId: "run-1", countryCode: "MX", anomalyIndex: 1 },
    valid: true,
    action: "finish",
    decision: {
      action: "finish", summary: "已完成只读取证", evidence: ["card SQL", "lineage"],
      possibleCauses: ["上游未产出"], verificationSteps: ["已查血缘"], recommendedActions: ["人工确认"],
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
  assert.deepEqual(callback.evidence.evidenceChain, [{ kind: "trace_lineage" }]);
  assert.deepEqual(callback.evidence.wattrelAlerts, []);
  assert.deepEqual(callback.evidence.dsCandidates, []);
  assert.deepEqual(callback.evidence.dsStatus, []);
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

test("dynamic evidence DS match request builds executeWorkflow inputs from verified producer SQL", () => {
  const request = buildDsMatchRequest({
    jobId: "job-42",
    context: { countryCode: "INE" }, table: "dwd.dwd_app_dtb", state: {
      anomalyDate: "2026-07-30",
      lineage: [{ table: "dwd.dwd_app_dtb", producerSql: true, producerFiles: ["dwd/dwd_app_dtb/dwd_app_dtb.sql"], sourceSql: "INSERT OVERWRITE dwd.dwd_app_dtb SELECT * FROM ods.app" }],
    },
  });
  assert.equal(request.dsEvidenceAvailable, true);
  assert.equal(request.dsInputs.country, "INE");
  assert.equal(request.dsInputs.request_id, "job-42");
  assert.equal(request.dsInputs.alertTime, "2026-07-30");
  assert.match(request.dsInputs.sqlText, /^INSERT OVERWRITE/);
});

test("dynamic evidence DS match request returns unavailable without verified producer SQL", () => {
  const request = buildDsMatchRequest({
    jobId: "job-42",
    context: { countryCode: "MX" }, table: "dws.orders", state: {
      anomalyDate: "2026-07-30",
      lineage: [{ table: "dws.orders", producerSql: false, producerFiles: [], sourceSql: "" }],
    },
  });
  assert.equal(request.dsEvidenceAvailable, false);
  assert.equal(request.status, "unavailable");
  assert.equal(request.reason, "no_verified_producer_lineage_for_ds");
});

test("dynamic evidence appends wattrel quality alerts matching the target table", () => {
  const prior = {
    action: "check_wattrel", table: "dws.daily_orders",
    state: { discoveredTables: ["dws.daily_orders"], verifiedTables: ["dws.daily_orders"], evidence: [], lineage: [], wattrelAlerts: [], budget: { wattrel: 0 } },
  };
  const result = {
    data: [
      { quality_id: 1, name: "订单量波动", src_tbl: "dws.daily_orders", dest_tbl: "ads.daily_report", result: 1, status: "open", created_at: "2026-07-29 10:00:00" },
      { quality_id: 2, name: "其他表告警", src_tbl: "ods.other_table", dest_tbl: "dws.other", result: 1, status: "open", created_at: "2026-07-29 11:00:00" },
    ],
  };
  const next = appendDynamicEvidence(prior, result);
  assert.equal(next.state.wattrelAlerts.length, 1);
  assert.equal(next.state.wattrelAlerts[0].name, "订单量波动");
  assert.equal(next.state.wattrelAlerts[0].table, "dws.daily_orders");
  assert.equal(next.state.budget.wattrel, 1);
});

test("dynamic evidence collects DS match candidates from executeWorkflow rows", () => {
  const rows = [
    { success: true, data: [{ workflow_name: "daily_orders_v2", workflow_code: "wf_001", project_name: "warehouse", confidence: "high", match_info: "sql-text-match" }] },
    { success: true, data: [{ workflow_name: "daily_orders_v3", workflow_code: "wf_002", project_name: "warehouse", confidence: "medium" }] },
  ];
  const result = collectDsMatchCandidates(rows);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0].workflowName, "daily_orders_v2");
  assert.equal(result.candidates[0].confidence, "high");
  assert.equal(result.success, true);
});

test("dynamic evidence collects DS match candidates handles empty and failed rows", () => {
  const result = collectDsMatchCandidates([{ success: false, data: [], error: { code: "NO_MATCH" } }]);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.success, false);
});

test("dynamic evidence builds DS status request from verified DS candidates", () => {
  const request = buildDsStatusRequest({
    jobId: "job-42",
    context: { countryCode: "MX" },
    table: "dws.daily_orders",
    state: {
      anomalyDate: "2026-07-29",
      dsCandidates: [{ table: "dws.daily_orders", workflowName: "daily_orders_v2", confidence: "high" }],
    },
  });
  assert.equal(request.dsStatusAvailable, true);
  assert.equal(request.dsStatusRequest.country, "MX");
  assert.equal(request.dsStatusRequest.action, "check_failed_instances");
  assert.equal(request.dsStatusRequest.ds_token, "REPLACE_WITH_DS_API_TOKEN_MX");
  assert.equal(request.dsStatusRequest.payload.search_val, "daily_orders_v2");
  assert.match(request.dsStatusRequest.payload.start_time, /^\d{4}-\d{2}-\d{2} 00:00:00$/);
  assert.match(request.dsStatusRequest.payload.end_time, /2026-07-29 23:59:59/);
});

test("dynamic evidence DS status request maps DS API token by country", () => {
  const cnRequest = buildDsStatusRequest({
    jobId: "job-42",
    context: { countryCode: "CN" },
    table: "dws.orders",
    state: { anomalyDate: "2026-07-29", dsCandidates: [{ table: "dws.orders", workflowName: "cn_orders", confidence: "high" }] },
  });
  assert.equal(cnRequest.dsStatusRequest.ds_token, "REPLACE_WITH_DS_API_TOKEN_CN");

  const ineRequest = buildDsStatusRequest({
    jobId: "job-42",
    context: { countryCode: "INE" },
    table: "dws.orders",
    state: { anomalyDate: "2026-07-29", dsCandidates: [{ table: "dws.orders", workflowName: "ine_orders", confidence: "high" }] },
  });
  assert.equal(ineRequest.dsStatusRequest.ds_token, "REPLACE_WITH_DS_API_TOKEN_INE");
});

test("dynamic evidence DS status request returns unavailable without DS candidates", () => {
  const request = buildDsStatusRequest({
    jobId: "job-42",
    context: { countryCode: "MX" },
    table: "dws.daily_orders",
    state: { anomalyDate: "2026-07-29", dsCandidates: [] },
  });
  assert.equal(request.dsStatusAvailable, false);
  assert.equal(request.status, "unavailable");
  assert.equal(request.reason, "no_ds_candidates_for_status_check");
});

test("dynamic evidence appends DS status evidence", () => {
  const prior = {
    action: "check_ds_status", table: "dws.daily_orders",
    state: { discoveredTables: ["dws.daily_orders"], verifiedTables: ["dws.daily_orders"], evidence: [], lineage: [], dsStatus: [], budget: { dsStatus: 0 } },
  };
  const result = { success: true, action: "check_failed_instances", data: [{ id: 1, state: "FAILURE", name: "daily_orders_v2" }] };
  const next = appendDynamicEvidence(prior, result);
  assert.equal(next.state.dsStatus.length, 1);
  assert.equal(next.state.dsStatus[0].success, true);
  assert.equal(next.state.budget.dsStatus, 1);
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

test("warehouse lineage gateway requires the shared bearer token", () => {
  const lineage = { operation: "trace_table", countryCode: "mx", table: "dws.daily_orders", maxFiles: 10 };
  assert.equal(validateLineageRequest(lineage, "").valid, false);
  assert.equal(validateLineageRequest(lineage, "Bearer wrong-token").valid, false);
  assert.equal(validateLineageRequest(lineage, "Bearer REPLACE_WITH_EVIDENCE_GATEWAY_TOKEN").valid, true);
});

test("dynamic evidence workflow is async, uses fixed gateways and executeWorkflow, and has no embedded secrets", () => {
  const workflow = JSON.parse(readFileSync(dynamicEvidenceWorkflowPath, "utf8"));
  assert.equal(workflow.nodes.find((node) => node.name === "Receive Dynamic Evidence Job").parameters.responseMode, "responseNode");
  assert.match(JSON.stringify(workflow), /\/webhook\/warehouse-lineage/);
  assert.match(JSON.stringify(workflow), /\/webhook\/wattrel-query/);
  assert.match(JSON.stringify(workflow), /\/webhook\/ds-scheduler/);
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
  assert.ok(workflow.nodes.find((node) => node.name === "Build DS Match Request"));
  assert.equal(workflow.nodes.find((node) => node.name === "Invoke DS Task Candidate Query").type, "n8n-nodes-base.executeWorkflow");
  assert.match(JSON.stringify(workflow.nodes.find((node) => node.name === "Invoke DS Task Candidate Query")), /REPLACE_WITH_DS_TASK_MATCH_WORKFLOW_ID/);
  assert.match(JSON.stringify(workflow.nodes.find((node) => node.name === "Check DS Scheduler Status")), /ds-scheduler/);
  assert.equal(workflow.nodes.some((node) => /partition/i.test(node.name)), false);
  assert.doesNotMatch(JSON.stringify(workflow), /warehouse-partition-evidence|ds-runtime-evidence/);
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

test("warehouse lineage gateway uses SSH-based country routing for six countries", () => {
  const workflow = JSON.parse(readFileSync(workflowPath, "utf8"));
  const sshNodes = workflow.nodes.filter((node) => node.type === "n8n-nodes-base.ssh");
  assert.ok(sshNodes.length >= 6);
  const switchNode = workflow.nodes.find((node) => node.name === "按国家分流到跳板机");
  assert.ok(switchNode);
  assert.doesNotMatch(JSON.stringify(workflow), /passwordEnv|sshHost/i);
});
