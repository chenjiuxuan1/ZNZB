# DS runtime evidence gateway

`n8n-ds-runtime-evidence-gateway.template.json` exposes a narrow public webhook:

```text
POST /webhook/ds-runtime-evidence
```

Every request must include `Authorization: Bearer <shared-evidence-gateway-token>`. Before publishing, replace `REPLACE_WITH_EVIDENCE_GATEWAY_TOKEN` in the template with one shared random value. Missing or incorrect tokens are rejected before any DS reference is resolved. This shared token is not a Dify API Key, platform callback token, or Card SQL token; “public” means reusable by authorized workflows only.

It supplies read-only candidate evidence for investigating a data anomaly. It never starts, retries, reruns, restarts, or otherwise changes a DolphinScheduler task, and it sends no notification or MySQL write.

## Request contract

The request object may contain exactly these fields:

```json
{
  "countryCode": "mx",
  "table": "dws.daily_orders",
  "producerFiles": ["jobs/daily_orders.sql"],
  "sourceSql": "INSERT OVERWRITE dws.daily_orders SELECT * FROM ods.orders",
  "anomalyDate": "2026-07-29"
}
```

`countryCode`, `table`, and `anomalyDate` are required. At least one of `producerFiles` (maximum 20 safe relative paths, each at most 500 characters) or `sourceSql` (at most 20,000 characters) is required. `table` is a lowercase `schema.table` identifier and `anomalyDate` is a real `YYYY-MM-DD` date. Valid country aliases are `cn`, `ine`/`id`, `ph`, `th`, `pk`, and `mx`.

Every other field is rejected with HTTP 400. This includes retry controls, tokens, commands, arbitrary URLs/endpoints, credentials, and start-instance or execution fields. The gateway neither constructs shell commands nor accepts caller-provided workflow references.

## DS runtime prerequisite and blocker

There is no verified live DS router, endpoint, or credential configuration in this repository. Consequently the imported template deliberately defaults to:

```json
{
  "status": "unavailable",
  "reason": "no_verified_ds_reference",
  "candidates": []
}
```

To activate read-only evidence, an n8n administrator must edit the deployment-controlled `Resolve Prebound DS Runtime Reference` node after separately verifying a fixed internal workflow reference:

- Set `workflowId` from `REPLACE_WITH_DS_TASK_MATCH_CANDIDATE_QUERY_WORKFLOW_ID` to the n8n ID for `DS任务匹配候选查询_execute_workflow`.
- Set `verified` to `true` only when that exact workflow is confirmed to be read-only, bounded to candidate lookup, and unable to run/retry/restart tasks, perform writes, or notify.
- Configure any required DS credential/router solely inside that reviewed internal workflow, with a read-only service account. Do not add a URL, token, credential ID, or workflow ID to this gateway request schema.

The template calls that fixed reference with n8n's Execute Workflow node only after the deployment-held verification flag is enabled. It must not be pointed at an auto-rerun, recovery, execution, or notification workflow.

## Candidate response

The gateway returns only high-confidence candidates—either `confidence: "high"` or finite numeric confidence of at least `0.90`. It returns a minimized response shape (`workflowName`, optional `projectName`, `confidence`, and bounded `matchReasons`); it does not expose an execution handle.

```json
{
  "status": "ok",
  "countryCode": "mx",
  "table": "dws.daily_orders",
  "anomalyDate": "2026-07-29",
  "candidates": [
    {
      "workflowName": "daily_orders",
      "projectName": "warehouse",
      "confidence": 0.94,
      "matchReasons": ["output table match"]
    }
  ]
}
```

No candidate is an instruction to execute anything. Treat an empty candidate list or the unavailable response as incomplete evidence and preserve the original anomaly for human investigation.
