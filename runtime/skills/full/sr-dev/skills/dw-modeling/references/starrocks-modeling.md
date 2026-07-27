# StarRocks Modeling Reference

This reference is intentionally extensible. Add proven patterns here as future modeling work expands.

## Core Design Questions

- What country or datasource is the model for?
- What business domain owns the model?
- Which warehouse layer is the target: ODS, DWD, DIM, DWB/DWT, DWS, or ADS?
- What is the grain?
- What keys identify one row?
- Which partition keeps maintenance and backfill controllable?
- Which bucket key matches high-frequency filters or joins?
- Which sort key or prefix index matches query predicates?
- Does the model need a materialized view or a pre-aggregation layer?
- What artifact should receive the output: reuse decision, SQL-builder request, dw-dev request, DS handoff, or user clarification?
- Which facts are still missing and should block SQL implementation?

## Colocate Join Example

The current Colocate Join reference from the loan-afterloan domain is one example, not a universal rule.

Observed pattern:

- Multiple high-frequency afterloan tables join on `debtor_id`.
- Tables use a shared hash distribution key such as `DISTRIBUTED BY HASH(debtor_id)`.
- Related tables may share a colocate group such as `"colocate_with" = "col_fox"`.
- This can keep rows with the same hash value on the same BE node and reduce shuffle for local joins.

Before recommending Colocate Join, check:

- the join key is stable and appears in every colocated table,
- key type is consistent across tables,
- table bucket count and replication settings can be aligned,
- no severe data skew exists on the bucket key,
- the query workload repeatedly joins the same table group,
- the write/backfill cost is acceptable,
- fallback behavior is documented if colocate group health is degraded.

Recommended artifact text:

```sql
DISTRIBUTED BY HASH(debtor_id) BUCKETS 16
PROPERTIES (
  "colocate_with" = "col_fox"
)
```

Always adapt bucket count, colocate group name, replication, storage medium, and key columns to the target country/domain evidence.

## Layer Notes

- DWD should preserve stable reusable business facts at clear grain.
- DIM should hold reusable dimensions with stable keys and validity rules.
- DWB/DWT can widen facts for repeated analytical access, but should avoid hiding unclear business logic.
- DWS should expose reusable summaries.
- ADS should serve a specific application or report and should not become the canonical upstream for public models.
- DWB/DWS/ADS should prefer DWD/DIM/DWB upstreams. If only ODS exists, record the gap and propose the needed DWD construction.
- ODS->DWD construction should scan existing country metadata for field unification, especially `asset_item_no`, `asset_item_number`, `debtor_id`, `dt`, `etl_create_time`, and `etl_update_time`.
- If a primary key changes during ODS->DWD or DWD rebuild, compare row counts and key counts before and after. Any unexplained reduction must be called out or blocked.

## Common Field Rules

- New StarRocks warehouse models must include `etl_create_time datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT "创建时间"` and `etl_update_time datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT "更新时间"`.
- Chinese comments are the default. For Indonesia (`id`), use English comments unless the user asks otherwise.
- Partition by `date_trunc('month', dt)` or `date_trunc('day', dt)` according to data volume and backfill granularity.
- Use hash distribution on stable high-cardinality join/filter keys. For afterloan/fox models, `debtor_id` is a common candidate but must be checked against country metadata.
- Colocate is recommended only when tables share stable join keys, compatible bucket counts, compatible replication, and repeated local join workload evidence.
- Avoid CTAS as the main production table creation pattern when precise keys, partitioning, distribution, comments, and properties are required.

## Handoff to Implementation

Modeling output should include the modeling decision, knowledge gaps, duplicate-asset judgment, metadata query-plan needs, and a clear route to `$dw-sql-builder` or `$dw-dev`. Final SQL packages belong to `$dw-sql-builder`; execution evidence belongs to `$sr-box` or the approved execution chain after review and human confirmation.
