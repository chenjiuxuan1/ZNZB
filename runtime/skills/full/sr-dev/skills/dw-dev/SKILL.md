---
name: dw-dev
description: |
  数仓开发 Skill（$dw-dev）。用于轻量编排数仓开发需求：接收直接提问、文档、Jira 或组合材料，按优先级整理上下文和参考资料，生成交给 $dw-modeling、$dw-sql-builder、$sr-box、$ds-scheduler 的协作请求，并组织系统验证 SQL、用户验收 SQL以及生产表与 testdb 表映射。复杂分析和跨 skill 协调由 Codex 或 Claude Code 等原生智能体完成。本 skill 不修改被调用组件，遇到阻断先停下来询问。默认作者使用 owenzhang。
---

# 数仓开发

将 `$dw-dev` 作为轻量数仓开发编排器使用。它负责需求归一化、上下文组织、工作区包装和下游协作请求，不替代建模、SQL 编写、执行、调度、审查或 Jira 写回能力。

## 核心职责

- 接收直接输入、文档、Jira、本地文件、SQL package 或混合材料。
- 使用中文工作区收纳全部补充资料，包括截图、SQL、链接和不可读来源。
- 按“用户输入 > 索引查询 > `$dw-knowledge` 文档 > `$dw-knowledge` 召回 > 可选 `$dw-code-knowledge` 代码证据”组织上下文。
- 维护参考资料附录、需求 QA 记录和最新交付清单。
- 按阶段生成 `$dw-modeling`、`$dw-sql-builder`、`$sr-box` 和 `$ds-scheduler` 协作请求。
- 在业务范围、映射事实、执行前提或安全条件不完整时停止并用中文说明阻断项。

不得修改被调用的 skill。如果 `$sr-box`、`$dw-knowledge`、`$dw-code-knowledge`、`$dw-modeling`、`$dw-sql-builder` 或 `$ds-scheduler` 缺失或不可用，用中文说明并停在安全交接边界。

## 协作关系

默认开发顺序：

1. `$dw-knowledge`：构建文档知识和语义上下文，不读取代码。
2. `$dw-code-knowledge`：仅在需要 ETL SQL、workflow 脚本或代码来源时使用。
3. `$dw-modeling`：完成需求拆解、粒度、分层、主键、更新频率和资产复用判断。
4. `$dw-sql-builder`：生成或调整 DDL、DML、ETL、生产 SQL 草稿和 `testdb` SQL。
5. `$sr-box`：在可执行 SQL 齐全后执行真实只读检查或 `testdb.*` 验证并返回 trace 与结果。
6. `$ds-scheduler`：仅在用户明确要求 DS 查询或操作时生成交接。

Reviewer、交付发布、Jira 写回、文档发布和上线汇报不属于默认运行链。用户提出这些需求时，只生成简洁交接，由原生智能体选择对应工具。

## 上下文优先级

证据冲突时按以下顺序判断：

1. 用户当前明确提供的输入。
2. 已验证的索引查询或任务内检索结果。
3. `$dw-knowledge` Git-backed 文档。
4. `$dw-knowledge` 召回结果。
5. 仅用于代码事实的 `$dw-code-knowledge` 证据。

低优先级材料只能补缺，不能静默覆盖高优先级输入。不可读来源只记录为阻断或待验证，不得当作事实。

## 工作区契约

只要 `$dw-dev` 创建或更新工作区，至少保留：

- `原始资料/00-原始提问.md`：用户原始问题或当前需求。
- `原始资料/01-资料收纳清单.md`：截图、本地文件、SQL、链接、聊天片段及验证状态。
- `上下文`：已知事实、假设、阻断和待确认问题。
- `QA/00-需求QA记录.md`：补问、回答、需求调整和验收反馈。
- `交付文档/00-交付清单.md`：当前最新交付、验收或待交付状态。

按需创建：`需求文档`、`参考资料`、`开发计划`、`协作请求`、`test闭环sql`、`验收结果`、`调度上线`。不要为了目录完整生成空文件；`上线SQL` 和 `回滚方案` 属于 SQL-builder 结果或显式发布计划。

## SQL 验收契约

进入执行阶段前必须同时具备三份产物：

1. `test闭环sql/00-生产-testdb表映射.yaml`
   - 每张生产输出表必须与唯一的 `testdb.*` 表一一对应。
   - 记录 `production_table`、`testdb_table`、`build_strategy`、生产/测试表模型和 `schema_aligned`。
   - 优先使用 `create_table_like`；使用 `explicit_ddl` 时也必须保证表模型、字段、主键、分区和分桶与生产一致。
2. `test闭环sql/01-系统验证.sql`
   - 包含供 `$sr-box` 执行的建表、装载和系统质量检查。
   - 所有写目标必须位于 `testdb.*`，并能在映射文件中找到。
3. `test闭环sql/02-用户验收.sql`
   - 只允许 `SELECT/WITH/SHOW/DESC/EXPLAIN`。
   - 每段 SQL 必须写明“结果列”和“通过条件”，让使用者可直接执行并判断结果。

旧字段 `validation_sql` 继续作为系统验证 SQL 读取，但缺少用户验收 SQL或表映射时状态必须为 `blocked_validation_contract`，不得宣称验证闭环完成。生成 SQL 不等于执行证据。

## 工作流程

1. 收纳需求和资料，默认作者/owner 为 `owenzhang`。
2. 验证新增截图、本地文件、SQL 和链接，并先登记到资料收纳清单。
3. 按上下文优先级整理事实、假设和待确认问题。
4. 生成 `协作请求/dw-modeling-协作请求.yaml`。
5. 建模结果或状态达到 `ready_for_sql_builder` 后生成 `协作请求/dw-sql-builder-协作请求.yaml`。
6. 三份 SQL 验收产物齐全且安全检查通过后，生成 `协作请求/sr-box-执行请求.json`。
7. 将 `$sr-box` 真实结果写入 `验收结果`；没有 trace 和返回结果时不得写“验收通过”。
8. 仅在用户明确要求调度时生成 `调度上线/01-ds-scheduler-协作请求.yaml`，本 skill 不直接改 DS。
9. 每次补问、口径确认、需求变更和验收反馈都更新 QA 与交付清单，最新用户确认状态优先。

## DATA-2232 示例边界

- DATA-2232 是当前需求。
- DATA-2111 是已完成的一期业务和计算上下文，包含 M1/M2 漏斗、CDC 快照和 30 天转化窗口。
- DATA-2262 是已完成的邀请表更新；`dwb.dwb_c_user_invite.user_invite_channel` 可作为继承事实。
- `data.kuainiu.io/collection/2452-mexicash-mgm` 只有可读时才能作为看板来源；403 必须记录为阻断。
- trace 映射、来源表或转化身份规则缺失时，先补问，不生成执行 SQL。

## 命令示例

生成建模优先请求：

```bash
python3 skills/dw-dev/scripts/build_dev_request.py \
  --ticket-id DATA-2232 \
  --country mx \
  --business-domain mgm \
  --user-input "基于 DATA-2111 和 DATA-2262 已完成内容开发二期" \
  --jira-reference DATA-2232=https://kylith.atlassian.net/browse/DATA-2232 \
  --dw-knowledge-doc "MexiCash-MGM 数据明细表" \
  --output tickets/DATA-2232/dev-request.yaml
```

生成完整 SQL 验收请求：

```bash
python3 skills/dw-dev/scripts/build_dev_request.py \
  --ticket-id DATA-2232 \
  --country mx \
  --system-validation-sql-file sql/01-system.sql \
  --user-validation-sql-file sql/02-user.sql \
  --table-mapping-file sql/00-table-mapping.yaml \
  --output tickets/DATA-2232/dev-request.yaml
```

生成工作区：

```bash
python3 skills/dw-dev/scripts/dev_orchestrator.py \
  tickets/DATA-2232/dev-request.yaml \
  --output-dir tickets/DATA-2232
```

## 完成标准

最终回答必须分别说明：需求与上下文、原始资料、QA、建模交接、SQL-builder 交接、三份 SQL 验收产物、`$sr-box` 真实执行证据、DS 交接、交付文档以及尚未解决的阻断。没有真实执行时明确写“未执行”，不能用草稿替代结果。
