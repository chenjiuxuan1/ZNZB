# Warehouse partition evidence gateway

`n8n-warehouse-partition-evidence-gateway.template.json` exposes the public n8n production webhook:

```text
POST /webhook/warehouse-partition-evidence
```

Every request must include `Authorization: Bearer <shared-evidence-gateway-token>`. Replace `REPLACE_WITH_EVIDENCE_GATEWAY_TOKEN` in the imported template with one shared random value before publishing. Missing or incorrect tokens are rejected before query construction. This shared gateway token is distinct from Dify, duty-platform callback, and Card SQL tokens; “public” means reusable by authorized workflows, never anonymous.

It is a deliberately narrow read-only evidence gateway. It does not accept caller-supplied SQL, database addresses, shell commands, credential references, users, passwords, tokens, or arbitrary extra fields.

## Request

```json
{
  "countryCode": "mx",
  "table": "dws.daily_orders",
  "anomalyDate": "2026-07-29",
  "baselineDate": "2026-07-01",
  "metricHint": "gmv"
}
```

Required fields are `countryCode`, `table`, `anomalyDate`, and `baselineDate`. `metricHint` is optional contextual text only; it never becomes SQL.

- Countries: `cn`, `ine` (also `id`), `ph`, `th`, `pk`, and `mx`.
- Table: lowercase `schema.table` identifiers only.
- Dates: real `YYYY-MM-DD` dates; baseline must not be after anomaly and the interval must be at most 31 days.
- The input object must contain only the documented fields. For example, `sql`, `host`, `command`, `credential`, `password`, and `token` are rejected with HTTP 400.

## What it queries

After validation, the workflow creates exactly two fixed StarRocks SQL probes against a safely quoted validated table:

```sql
SELECT 'anomaly' AS evidence_type, '2026-07-29' AS requested_partition_date,
       COUNT(*) AS observed_row_count, MAX(dt) AS observed_partition_date
FROM `dws`.`daily_orders`
WHERE dt = '2026-07-29'
UNION ALL
SELECT 'baseline' AS evidence_type, '2026-07-01' AS requested_partition_date,
       COUNT(*) AS observed_row_count, MAX(dt) AS observed_partition_date
FROM `dws`.`daily_orders`
WHERE dt = '2026-07-01';
```

The template intentionally supports the established `dt` date-partition convention only. A table using another partition column must receive a separately reviewed template change; do not add a caller-controlled partition column or query field.

## Credentials and deployment blocker

No actual StarRocks connector configuration exists in this repository. In particular, the existing country SSH/Wattrel MySQL workflow is not a StarRocks connection source and must not be copied into this gateway.

Before activating the workflow, an n8n administrator must create or select six country-specific MySQL-protocol StarRocks Credentials and bind each placeholder node:

| Country | Node | Required credential name |
| --- | --- | --- |
| China | `Read-only StarRocks cn` | `StarRocks CN Read-only` |
| Indonesia | `Read-only StarRocks ine` | `StarRocks INE Read-only` |
| Philippines | `Read-only StarRocks ph` | `StarRocks PH Read-only` |
| Thailand | `Read-only StarRocks th` | `StarRocks TH Read-only` |
| Pakistan | `Read-only StarRocks pk` | `StarRocks PK Read-only` |
| Mexico | `Read-only StarRocks mx` | `StarRocks MX Read-only` |

Each Credential must use a service account restricted to `SELECT` on the approved warehouse schemas. The template contains identifiers such as `REPLACE_WITH_STARROCKS_READONLY_MX_CREDENTIAL`, not hosts, usernames, passwords, or secrets. Bind them in n8n after import and verify the account cannot run mutations.

## Responses

Successful evidence is returned as:

```json
{
  "status": "ok",
  "countryCode": "mx",
  "table": "dws.daily_orders",
  "evidence": [
    { "evidenceType": "anomaly", "requestedPartitionDate": "2026-07-29", "availability": "available", "rowCount": 1250, "observedPartitionDate": "2026-07-29" },
    { "evidenceType": "baseline", "requestedPartitionDate": "2026-07-01", "availability": "available", "rowCount": 1192, "observedPartitionDate": "2026-07-01" }
  ]
}
```

Credential/query failures return `status: "unavailable"` with `reason: "connector_unavailable"`. If either requested date has no observed `dt` partition, the response is also `unavailable` with `reason: "date_partition_unavailable"`; its unavailable row uses `rowCount: null`, never a misleading zero. Consumers should preserve the original anomaly and treat this as incomplete evidence, not a clean data result.
