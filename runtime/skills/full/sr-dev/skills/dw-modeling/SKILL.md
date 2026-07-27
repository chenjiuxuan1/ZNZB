---
name: dw-modeling
description: |
  数仓建模 Skill（$dw-modeling）。用于需求拆解、主题域/分层/粒度/主键/更新频率/复用判断、知识缺口和阻断项确认、输出路由设计，以及给 $dw-sql-builder 或 $dw-dev 的建模交接。用户说“数仓建模”“模型设计”“DWD/DWB/DWS/ADS 建设”“小时更新建模”“是否重复建表”“缺哪些知识”时使用。本 Skill 不写最终 SQL package、不执行 SQL。
---

# Warehouse Modeling

Use this skill to decide what should be modeled before anyone writes runnable SQL. It turns a warehouse requirement into a modeling decision, a knowledge-gap list, a duplicate-asset check, and a handoff route.

## Core Role

`$dw-modeling` owns the modeling decision, not SQL implementation.

It must answer:

- 需求拆解：业务目标、国家或 datasource、主题域、目标层级、指标或明细对象。
- 建模方式：事实/维度/宽表/汇总表、表粒度、主键、增量口径、时效和回刷策略。
- 知识缺口：缺业务口径、源表、字段含义、更新频率、SLA、历史回刷或安全规则时，列为阻断项。
- 重复资产：先判断是否已有表、ETL、workflow、文档或口径可复用，避免重复建设。
- 输出路由：决定后续是复用已有资产、交给 `$dw-sql-builder` 写 SQL、交给 `$dw-dev` 做开发闭环，还是形成 DS/脚本/DDL handoff。

## Required Companion Skills

- Use `$dw-knowledge` when business definitions,指标口径, semantic context, query spec, or clarification material is missing.
- Use `$dw-code-knowledge` when existing ETL SQL, workflow scripts, table build logic, or duplicate asset evidence is needed.
- Use `$dw-standards` for layer, naming, grain, table-design, partition, bucket, security, and release-readiness rules.
- Use `$dw-sql-builder` only after the modeling decision is clear enough to write DDL/DML/ETL SQL.
- Use `$dw-dev` when the requirement needs a full development workspace, `testdb` validation, `$sr-box` execution evidence, release draft, or rollback draft.

## Workflow

1. **Decompose the requirement**
   - Identify business goal, country or datasource, owner, output consumer, target freshness, target layer, and expected artifact.
   - Classify the demand: new model, existing model extension, hourly update, performance optimization, duplicate/reuse check, one-off script, or release handoff.

2. **Collect evidence before deciding**
   - Ask `$dw-knowledge` for business口径, domain notes, semantic context, and known clarification questions.
   - Ask `$dw-code-knowledge` for existing table DDL, ETL SQL, workflow scripts, and related model names.
   - Use `metadata_collector.py` only to generate read-only metadata query plans when live table/catalog evidence is needed. The skill itself still does not execute SQL.

3. **Make the modeling decision**
   - Decide layer, domain, grain, fact/dimension/summary shape, update cadence, incremental key, partition idea, and reuse strategy.
   - Record whether existing assets satisfy the need, partially satisfy it, or conflict with the proposed model.

4. **Block when knowledge is missing**
   - If source truth, grain, SLA, owner, route, field meaning, security level, or duplicate-asset result is unclear, stop with a Chinese `知识缺口与阻断项`.
   - Do not invent source tables, fields, metrics, schedules, or freshness guarantees.

5. **Route the output**
   - `复用已有资产`: output reuse decision and remaining validation questions.
   - `$dw-sql-builder`: output a structured SQL-build request after modeling is clear.
   - `$dw-dev`: output a development handoff when testdb validation, `$sr-box` evidence, release SQL, or rollback planning is needed.
   - `调度上线`: output a scheduling handoff only when DS release or timing is explicitly in scope.

## Hourly Update Checklist

For 小时更新 or near-real-time modeling, explicitly cover:

- business event time vs ingestion time vs snapshot time,
- upstream update frequency and late-arrival behavior,
- whether an existing daily table can be extended or a new hourly table is required,
- `dt` plus `hour` partition strategy or timestamp-range strategy,
- incremental key, idempotence, backfill window, and rerun boundary,
- DS schedule dependency and upstream readiness,
- duplicate hourly assets or reusable DWD/DWB/DWS tables,
- user-confirmed SLA and owner.

Missing any of these facts is a blocker, not a place to guess.

## Output Contract

Prefer Chinese artifact names when writing local handoff material:

- `开发计划/01-建模决策.md`
- `开发计划/02-知识缺口与阻断项.md`
- `开发计划/03-重复资产与复用判定.md`
- `协作请求/dw-sql-builder-请求.yaml`
- `协作请求/dw-dev-请求.yaml`

## Metadata Query-Plan Helper

Use this helper only to prepare read-only metadata inspection requests:

```bash
python3 skills/dw-modeling/scripts/metadata_collector.py \
  --countries cn,th,mx,ph,pk,id \
  --domain fox \
  --output-dir tickets/DATA-3001
```

The generated files are plans for `$sr-box`; they are not execution evidence.

## Handoff To SQL Builder

When handing off to `$dw-sql-builder`, provide:

```yaml
modeling_decision:
  status: draft
  owner: owenzhang
  country: cn
  target_layer: dwd
  business_domain: fox
  output_route: dw-sql-builder
  grain: one row per asset_item_no per withhold_time
  freshness: hourly
  sources:
    confirmed:
      - ods.ods_fox_asset_withhold_detail
    missing: []
  duplicate_asset_decision:
    status: no_reusable_asset_found
    evidence:
      - dw-code-knowledge search result path or summary
  blockers: []
  sql_builder_request:
    expected_outputs:
      - ddl_draft
      - testdb_sql
      - production_sql_draft
      - quality_checks
```

## Boundaries

- Do not execute SQL.
- Do not write final DDL/DML/ETL SQL packages; route that to `$dw-sql-builder`.
- Do not claim a model is verified without real `$sr-box` evidence.
- Do not approve production DDL/DML, DS changes, Jira writes, or backfills without explicit human confirmation.
- Do not bypass `$dw-standards` for production table/model design.
- Do not skip duplicate-asset checks when `$dw-knowledge` or `$dw-code-knowledge` is available.
- Use `owner: owenzhang` when an owner must be defaulted.
