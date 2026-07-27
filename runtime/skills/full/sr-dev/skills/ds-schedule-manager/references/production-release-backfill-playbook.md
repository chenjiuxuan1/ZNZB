# DS 生产发布与历史补数 Playbook

> 作者：owenzhang
> 模块 ID：`ds-schedule-manager`

## 目录

1. [范围与边界](#1-范围与边界)
2. [Definition、DAG、参数、数据源与权限预检](#2-definitiondag参数数据源与权限预检)
3. [DDL 与 DML 分离](#3-ddl-与-dml-分离)
4. [TASK_ONLY 与 TASK_POST 语义](#4-task_only-与-task_post-语义)
5. [原生 complement 与 daily fallback](#5-原生-complement-与-daily-fallback)
6. [单日冒烟、失败即停与同日恢复](#6-单日冒烟失败即停与同日恢复)
7. [安全 SQL 与数据质量前置](#7-安全-sql-与数据质量前置)
8. [六层验收](#8-六层验收)
9. [补数覆盖与 ONLINE schedule 独立结论](#9-补数覆盖与-online-schedule-独立结论)
10. [Token-free 请求样例与确认移交](#10-token-free-请求样例与确认移交)

## 1. 范围与边界

本 playbook 用于规划 DolphinScheduler 生产发布与历史补数。先用 `$sr-box` production 读取 `ds_catalog` 元数据，再用 `ds_release_backfill_plan.py` 形成确定性计划。

计划器只读取 YAML/JSON 并输出 `success`、`status`、`blockers`、`warnings`、`acceptance`。其中 `success` 仅表示计划决策可继续，不表示 DS 执行成功。计划器不执行 SQL、不调用 DS API、不读取 token/secret，也不修改 DS 状态。真实上线、触发、补数或 schedule mutation 始终移交 `$ds-scheduler`，并等待用户明确确认。

## 2. Definition、DAG、参数、数据源与权限预检

形成计划前逐项确认：

1. project、workflow、definition version 唯一，definition 为预期版本和 `ONLINE` 状态。
2. 读取完整 DAG，确认 required task 集合、依赖关系、`SUB_WORKFLOW` 父子影响和 shared schedule 影响。
3. 检查 `global_params` 及脚本引用的 workflow 变量，禁止把空参数误判为可发布。
4. 核对每个 task 的 datasource、SQL 类型、worker group、tenant 与环境路由。
5. 分开验证元数据只读权限、目标库表 DDL/DML 权限和 `$ds-scheduler` API 权限。
6. 预检 gateway 对 trigger mode、complement、task depend type、轮询与终态查询的实际支持。

datasource、DDL/DML 权限和轮询终态 capability 属于 manager 的计划器外部预检：datasource 用 `$sr-box` 元数据证据核对，DDL/DML 权限由批准的执行通道核对，轮询终态 capability 用 `$ds-scheduler` 查询/API 证据核对。它们不会自动成为 `ds_release_backfill_plan.py` 的 blocker；manager 必须自行记录外部阻断并停止 mutation 移交。

在 SQL/gateway 安全项中，计划器只接收五项 SQL 安全布尔：`ddl_ready`、`strict_mode_checked`、`non_null_key_checked`、`half_open_window_checked`、`idempotent_cleanup_checked`，并通过 native complement 与 `fallback_allowed` 字段判断执行模式。不得把外部 datasource、权限或 capability 检查描述成计划器自动完成的预检。

## 3. DDL 与 DML 分离

DDL 只做计划与移交：先审阅 DDL、影响范围、回滚和验收方案，再发布只包含业务 DML 的 workflow task。不要把建表、改表和补数写入混在同一 task 或同一补数循环中。

获得用户明确确认后，DDL 才能由具备目标环境权限的授权且已确认的执行通道执行；不要把 `$ds-scheduler` 描述成 SQL/DDL executor。DDL 验收至少确认对象存在、字段类型、非空约束、主键/分区/分桶设计和执行权限。DML 只有在 DDL 已就绪且回滚/清理方案明确后才能进入单日冒烟。

## 4. TASK_ONLY 与 TASK_POST 语义

- `TASK_ONLY`：只触发显式选中的节点，不假设自动补齐上游或下游。`selected_task_codes` 必须覆盖完整 `required_task_codes`；只选择 ADS 末层应以 `INCOMPLETE_DAG_SELECTION` 阻断。
- `TASK_POST`：用于已确认需要从指定节点继续执行后继节点的场景。先核对 gateway 支持和实际 DAG，再确认它覆盖的后继集合；不得用名称推断完整链路。

两种模式都必须基于完整 DAG 做选择，并在移交前保留 token-free 的 task 清单和影响范围。

## 5. 原生 complement 与 daily fallback

gateway 支持原生 complement 时，计划器可选择 `native_complement`。原生 complement 不可用时，只有请求显式设置 `fallback_allowed=true`，才能形成 `daily_trigger_fallback`。

`daily_trigger_fallback` 按业务日串行触发，每次固定一个业务日期并等待该日终态，再进入下一日期。`fallback_allowed` 不是 `true` 时，返回 `COMPLEMENT_CAPABILITY_UNAVAILABLE`，不得自行循环触发。

## 6. 单日冒烟、失败即停与同日恢复

先选一个业务日期做完整 DAG 单日冒烟，并保持 `failure_stop=true`：

1. 触发被 API 接受只表示请求已受理；accepted/running 绝不等于执行成功。
2. 轮询 workflow instance 与全部 required task instances 到明确终态。
3. 任一层失败立即停止，不生成后续日期的执行移交。
4. 修复后仍在同一个业务日期重新执行完整链路。
5. 只有同日 workflow、task、数据与业务验收通过，才能进入全量日期循环；连续调度仍独立验收。

`failed_date` 本版本不驱动状态，它是保留字段。失败后同一业务日复跑是 manager 外部 live-evidence guardrail：在该业务日具备外部 live success 证据前，manager 必须拒绝写入或接受 `smoke_state=SUCCESS`，也不得继续全量日期循环。

## 7. 安全 SQL 与数据质量前置

进入冒烟前完成以下检查：

- 空串：对关键字段明确空串与 `NULL` 的归一化规则，避免空串穿透为合法业务值。
- 非法类型：对数字、日期、布尔和枚举做安全转换或显式拒绝，禁止静默截断。
- 非空主键：主键字段经过清洗后仍必须非空；不满足时阻断写入并记录样本原因。
- 严格模式：确认执行引擎严格模式和错误阈值，异常数据不得被无提示丢弃。
- 半开区间：日期/时间过滤使用 `[start, end)`，避免跨日边界重复或遗漏。
- 幂等清理：为每个业务日期定义可重复执行的删除、覆盖或唯一键策略，清理范围必须和当日写入范围一致。

## 8. 六层验收

计划与执行结果固定分六层汇报：

| 层级 | `acceptance` 字段 | 验收证据 |
|---|---|---|
| 1 | `definition` | definition 为 `ONLINE` 且 global params 已检查 |
| 2 | `workflow_instance` | 单日/逐日 workflow instance 到成功终态；accepted/running 不算通过 |
| 3 | `task_instances` | 完整 required task 集合全部成功，无遗漏节点 |
| 4 | `data_coverage` | 预期业务日期集合均完成，skip dates 有明确依据 |
| 5 | `business_result` | 通用业务校验通过，异常样本和口径差异已解释 |
| 6 | `continuous_schedule` | schedule 存在且 release state 为 `ONLINE` |

`workflow_instance` 和 `task_instances` 只由请求提供的 `smoke_state` 映射，计划器不会自动查询 live 实例。manager 必须先用外部 live 证据佐证终态，才能提供 `smoke_state=SUCCESS`；任一层没有 live 证据时不得提前写成 `passed`。

`definition.version` 由 manager 的外部 preflight blocker 核对；计划器的 `acceptance.definition` 只映射 definition 是否为 `ONLINE` 以及 `global_params_checked`，不校验 version。

`business_result` 保持 `pending`，必须由计划器外部业务校验补证。`ready_for_backfill` 不等于业务验收通过，也不表示任何 DS task 已执行成功。

## 9. 补数覆盖与 ONLINE schedule 独立结论

历史日期全部完成只证明 `data_coverage=passed`，不能证明连续调度已建立。最终必须并列给出：

- `补数覆盖`：完整、部分、失败或待验证。
- `ONLINE schedule`：passed、offline、missing 或待验证。

允许出现“补数完成但 schedule 缺失或下线”的状态。总状态 `backfill_completed_schedule_missing` 覆盖 schedule 缺失或非 `ONLINE`；`continuous_schedule` 区分 `missing` 与 `offline`。两者都应单独规划 schedule 创建/上线及后续回查。

## 10. Token-free 请求样例与确认移交

以下 YAML 只含通用 project/workflow/task/date，不含 token、secret 或真实生产标识：

```yaml
country: cn
project_code: project-code
workflow_code: workflow-code
definition:
  version: 1
  release_state: ONLINE
  global_params_checked: true
dag:
  required_task_codes: [dwb-task, dws-task, ads-task]
  selected_task_codes: [dwb-task, dws-task, ads-task]
gateway:
  native_complement: false
  task_depend_type: TASK_ONLY
backfill:
  start_date: "2099-01-01"
  end_date: "2099-01-03"
  smoke_date: "2099-01-01"
  fallback_allowed: true
  failure_stop: true
  poll_seconds: 10
  timeout_seconds: 1800
  skip_dates: []
preflight:
  ddl_ready: true
  strict_mode_checked: true
  non_null_key_checked: true
  half_open_window_checked: true
  idempotent_cleanup_checked: true
runtime_evidence:
  trigger_accepted: false
  smoke_state: PENDING
  completed_dates: []
  failed_date: null
schedule:
  exists: false
  release_state: null
```

运行纯计划器：

```bash
python3 skills/ds-schedule-manager/scripts/ds_release_backfill_plan.py \
  release-backfill-request.yaml \
  --output release-backfill-plan.json
```

只有 `blockers` 为空且用户看过影响范围、执行日期、task 集合、回滚/清理方式和验收方案后，才询问明确确认。确认后把 token-free 计划交给 `$ds-scheduler`，再按 manager 的“显式 token > 环境变量 > 指定配置 > 默认配置”解析凭据；任何输出都不得回显真实 token。
