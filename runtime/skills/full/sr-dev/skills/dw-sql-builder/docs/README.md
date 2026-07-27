# Warehouse SQL Builder 使用说明

> 作者：owenzhang
> 模块 ID：`dw-sql-builder`
> 展示名称：`SQL 构建能力`

## 定位

`$dw-sql-builder` 用于在建模方案明确后，编写、调整和优化数仓 SQL，并生成正式上线版与 `testdb` 可执行版 SQL package。

它负责：

- DDL 草稿。
- DML/ETL SQL 草稿。
- 正式上线版 SQL。
- `testdb` 验证 SQL。
- 质量检查 SQL。
- `$sr-box` 或 `$dw-dev` 的执行请求草稿。

它不负责从零做需求建模，也不执行 SQL。

## SQL Package

```bash
python3 skills/dw-sql-builder/scripts/modeling_sql_package.py \
  modeling-request.yaml \
  --output-dir tickets/DATA-3001
```

输出：

- `04-modeling.md`
- `05-sql/01_prod_ddl.sql`
- `05-sql/02_testdb_ddl.sql`
- `05-sql/03_prod_dml.sql`
- `05-sql/04_testdb_dml.sql`
- `05-sql/05_quality_checks.sql`
- `06-execution/01_testdb_execution_request.json`
- `release/01-prod-online.sql`
- `release/02-testdb-runnable.sql`

关键约束：

- `release/01-prod-online.sql` 是正式上线版草稿，不自动执行。
- `release/02-testdb-runnable.sql` 是 `testdb` 可执行打通版本。
- 验证写入目标必须是 `testdb.*`。
- 读取源表默认保留真实 DWD/DWB/DIM/ODS；只有显式提供 `test_source_mapping` 时才改写到 `testdb` seed 表。

## 协作边界

```text
dw-modeling       # 需求拆解、建模、阻断项和输出路由
  -> dw-sql-builder  # SQL 编写、优化、SQL package
  -> dw-dev          # testdb 验证、sr-box evidence、上线/回滚草稿
```

缺少表粒度、源表、字段口径、SLA 或复用判断时，返回 `$dw-modeling` 补齐，不直接猜 SQL。

## 验收口径

- SQL package 生成成功不等于已执行。
- `$dw-standards` 未通过时，不声明生产可上线。
- `$sr-box` 未真实执行时，不声明 `testdb` 验证通过。
- 生产 SQL 只能作为草稿，必须等用户明确确认后才能进入上线链路。
