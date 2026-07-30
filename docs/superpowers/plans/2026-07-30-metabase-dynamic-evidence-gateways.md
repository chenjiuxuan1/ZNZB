# Metabase Dynamic Evidence Gateways Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide public, read-only n8n partition and DolphinScheduler runtime evidence gateways and extend the Metabase evidence Agent decision loop to use them.

**Architecture:** Restore the deleted, tracked import templates first. Keep static lineage as one public webhook, add two independently usable public webhooks for partition and DS runtime evidence, and let the main Agent call them only after Dify selects a whitelisted action. Every gateway accepts only country/table/date identifiers; callers never submit SQL, credentials, commands, or retry requests.

**Tech Stack:** n8n webhook, Code, HTTP Request, Execute Workflow and SSH nodes; existing six-country SSH Credentials; ZNZB callback API; Node.js test harnesses for exported workflow Code nodes.

---

### Task 1: Restore and harden the tracked lineage template

**Files:**
- Restore: `n8n-warehouse-lineage-gateway.template.json`
- Restore: `n8n-metabase-anomaly-evidence-agent.template.json`
- Restore: `dify-metabase-data-evidence-agent.yml`
- Restore: `dify-warehouse-lineage.openapi.yml`
- Test: `test/n8n-workflow-template.test.mjs`

- [ ] Restore only the four deleted tracked templates from `HEAD`; preserve all unrelated modified/untracked files.
- [ ] Add a regression fixture containing ``FROM `dws`.`dws_asset_gmv_income_mv` JOIN `dim`.`dim_product_split` ``.
- [ ] Assert that the lineage Code-node parser returns normalized `dws.dws_asset_gmv_income_mv` and `dim.dim_product_split`, not an empty source list.
- [ ] Update the parser to accept backtick-quoted one- and two-part identifiers, strip backticks during normalization, and keep the existing table-name whitelist.
- [ ] Run: `node --test test/n8n-workflow-template.test.mjs`; expected: all parser tests pass.

### Task 2: Create the public partition evidence gateway

**Files:**
- Create: `n8n-warehouse-partition-evidence-gateway.template.json`
- Create: `docs/warehouse-partition-evidence-gateway.md`
- Test: `test/n8n-workflow-template.test.mjs`

- [ ] Add `POST /webhook/warehouse-partition-evidence` with `countryCode`, `table`, `anomalyDate`, `baselineDate`, and optional `metricHint` input.
- [ ] Validate six-country aliases, two-part table identifiers, ISO dates, distinct dates, and a 31-day maximum comparison span. Reject every input containing SQL, host, credential, shell or operation fields.
- [ ] Route each validated request to a preconfigured read-only StarRocks Credential. Generate only fixed `SHOW PARTITIONS`/`SELECT COUNT(*)` evidence queries from validated identifiers and dates; do not interpolate user SQL.
- [ ] Return `{ success, table, dates, partitionEvidence, rowCounts, status }`; represent unavailable configuration/query metadata as `status: "unavailable"`, never as zero rows.
- [ ] Document credential setup using n8n Credentials only, with no password/token in the template.
- [ ] Add validation tests for valid INE input, invalid table, invalid date range, and rejection of a `sql` payload field.
- [ ] Run: `node --test test/n8n-workflow-template.test.mjs`; expected: all gateway validation tests pass.

### Task 3: Create the public DS runtime evidence gateway

**Files:**
- Create: `n8n-ds-runtime-evidence-gateway.template.json`
- Create: `docs/ds-runtime-evidence-gateway.md`
- Test: `test/n8n-workflow-template.test.mjs`

- [ ] Add `POST /webhook/ds-runtime-evidence` with `countryCode`, `table`, `producerFiles`, `sourceSql`, and `anomalyDate` input.
- [ ] Validate country/table/date and bound producer file and SQL evidence sizes. Reject all retry, command, token, instance-start and arbitrary URL fields.
- [ ] Invoke `DS任务匹配候选查询_execute_workflow` as an internal Execute Workflow dependency; retain only verified/high-confidence candidates.
- [ ] Query only runtime status for candidates through the existing DS read router/Credential. Do not call `各国-DS失败自动重跑统一入口` or any retry endpoint.
- [ ] Return `{ success, candidateStatus, candidates, runtimeEvidence, status }` with `no_verified_ds_reference` when no eligible task exists.
- [ ] Add tests for request validation and for filtering low-confidence candidates before runtime lookup.
- [ ] Run: `node --test test/n8n-workflow-template.test.mjs`; expected: all DS gateway tests pass.

### Task 4: Extend the main evidence Agent state machine

**Files:**
- Modify: `n8n-metabase-anomaly-evidence-agent.template.json`
- Modify: `docs/n8n-dify-decision-loop.md`
- Test: `test/n8n-workflow-template.test.mjs`

- [ ] Extend Dify action validation to allow `trace_lineage`, `check_partition`, `check_ds_workflow`, and `finish`.
- [ ] Permit only tables supplied by card SQL or verified producer SQL lineage; limit partition checks to three tables and DS checks to three high-confidence candidates.
- [ ] Add HTTP nodes to both public evidence gateways and append bounded results into the existing `evidence` state before looping to Dify.
- [ ] Preserve the existing `jobId` passthrough, callback URL conversion and parsed-action recovery logic.
- [ ] Update the Dify prompt contract so it chooses partition/DS actions before `finish` when actionable evidence exists, and only states causes supported by returned evidence.
- [ ] Add a state-machine test covering card SQL → lineage → partition → DS runtime → finish.
- [ ] Run: `node --test test/n8n-workflow-template.test.mjs`; expected: full loop fixture reaches `finish` with all evidence types retained.

### Task 5: Import and smoke-test public webhooks

**Files:**
- Modify: `docs/n8n-dify-decision-loop.md`

- [ ] Import the three public gateway templates, bind their named read-only Credentials, and activate one production webhook per path.
- [ ] Use a valid INE table/date request to confirm partition evidence returns a structured result or `unavailable` without falsely returning zero.
- [ ] Use the known `ads_3005_gmv_dashboard_sumary_d` producer SQL to confirm DS candidate matching is read-only and emits no retry request.
- [ ] Trigger a forced Metabase analysis and inspect the n8n execution to verify repeated Dify decisions and a callback containing only bounded evidence.
- [ ] Do not stage or commit unrelated user changes; report imported workflow IDs, configured Credential names, and any unavailable integration separately.
