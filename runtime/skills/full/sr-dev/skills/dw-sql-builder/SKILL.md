---
name: dw-sql-builder
description: |
  数仓 SQL 构建 Skill（$dw-sql-builder）。用于在建模方案已确认或已有明确 SQL 需求时编写、调整、优化 StarRocks/Hive 数仓 SQL，生成 DDL/DML/ETL 草稿、正式上线版 SQL、testdb 可执行 SQL、质量检查 SQL 和 SQL package。用户说“写 SQL”“优化 SQL”“生成上线 SQL”“生成 testdb SQL”“根据建模方案落 SQL”时使用。不负责需求建模决策，不执行 SQL。
---

# Warehouse SQL Builder

Use this skill after the model decision is clear enough to write SQL. It owns SQL implementation, SQL optimization, and SQL package generation; it does not decide the business model from scratch and does not execute SQL.

## Core Role

`$dw-sql-builder` turns an approved or sufficiently clear modeling handoff into implementation artifacts:

- DDL drafts for production and `testdb`.
- DML/ETL SQL drafts for production and `testdb` validation.
- SQL optimization notes for StarRocks/Hive-style warehouse work.
- quality check SQL.
- execution request drafts for `$sr-box` or `$dw-dev`.
- formal production SQL draft and executable `testdb` validation SQL.

If the handoff lacks grain, source truth, target layer, owner, route, field meaning, or freshness, stop and route the blocker back to `$dw-modeling`.

## Required Companion Skills

- Use `$dw-modeling` when the request still needs需求拆解, model grain, duplicate-asset judgment, or output routing.
- Use `$dw-standards` before claiming the SQL is ready for production table/model use.
- Use `$dw-dev` when the SQL must enter a full development workspace with `testdb` validation, `$sr-box` evidence, release draft, or rollback draft.
- Use `$sr-box` only outside this skill when real read checks or `testdb` execution is explicitly needed.

## SQL Package Mode

Use SQL package mode when the caller provides a structured modeling request and needs both formal production SQL and directly executable `testdb` SQL.

Command:

```bash
python3 skills/dw-sql-builder/scripts/modeling_sql_package.py \
  modeling-request.yaml \
  --output-dir tickets/DATA-3001
```

Required output:

- `04-modeling.md`
- `05-sql/01_prod_ddl.sql`
- `05-sql/02_testdb_ddl.sql`
- `05-sql/03_prod_dml.sql`
- `05-sql/04_testdb_dml.sql`
- `05-sql/05_quality_checks.sql`
- `06-execution/01_testdb_execution_request.json`
- `release/01-prod-online.sql`
- `release/02-testdb-runnable.sql`

Rules:

- `release/01-prod-online.sql` is the formal production draft only.
- `release/02-testdb-runnable.sql` is the executable validation version.
- In the `testdb` DML version, the write target must be `testdb.xxx`.
- Read sources such as `dwd.xxx`, `dwb.xxx`, or `dim.xxx` stay on real source tables unless `test_source_mapping` explicitly maps them to `testdb` seed tables.
- For DWB/DWS/ADS construction, prefer DWD/DIM/DWB upstreams over ODS. If a required DWD does not exist, block and ask `$dw-modeling` to decide whether DWD construction is needed first.

## SQL Implementation Checklist

Before writing or changing SQL, confirm:

- route: country or datasource,
- target database and table,
- target layer and business domain,
- owner, defaulting to `owenzhang` only when needed,
- source tables and read/write boundaries,
- table grain and keys,
- partition, bucket, sort key, and model type,
- incremental mode, rerun/backfill behavior, and idempotence,
- `testdb` write target for validation,
- production SQL is only a draft until explicit approval,
- `$dw-standards` status before claiming production readiness.

## Optimization Scope

Use this skill for SQL and physical-layout optimization such as:

- reducing repeated scans or unnecessary CTE materialization,
- choosing StarRocks key type, partition, bucket key, bucket count, and sort key from an approved model,
- separating production SQL from `testdb` runnable SQL,
- producing quality checks for uniqueness, row count, nulls, and partition freshness,
- converting an approved model into ETL SQL or a DS SQL/SHELL handoff draft.

Do not use optimization as a reason to change the business grain or target layer without sending the decision back to `$dw-modeling`.

## Handoff To Warehouse Dev

When handing off to `$dw-dev`, provide:

```yaml
sql_builder:
  status: draft
  owner: owenzhang
  source_modeling_artifact: 开发计划/01-建模决策.md
  artifacts:
    production_sql: release/01-prod-online.sql
    testdb_sql: release/02-testdb-runnable.sql
    execution_request: 06-execution/01_testdb_execution_request.json
  standards_status: needs_dw_standards
  execution_boundary: "No SQL executed by dw-sql-builder."
```

## Boundaries

- Do not execute SQL.
- Do not make business-model decisions that belong to `$dw-modeling`.
- Do not write validation SQL to non-`testdb` targets.
- Do not rewrite read sources to `testdb` unless `test_source_mapping` is provided.
- Do not claim `$dw-standards` pass, `$sr-box` execution, DS上线, or production readiness without real evidence.
- Do not auto-approve production DDL/DML, DS changes, backfills, Jira writes, or release operations.
