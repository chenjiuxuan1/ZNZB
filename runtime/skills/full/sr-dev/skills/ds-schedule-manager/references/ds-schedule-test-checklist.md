# DS Schedule Test Checklist

> 作者：owenzhang

Use this checklist before calling the skill complete or before trusting it for DS 调度管理.

## Non-Mutating Tests

| ID | Case | Steps | Pass condition |
|---|---|---|---|
| DSM-TC-001 | SR route health | `$sr-box` health + `SELECT 1` for target country | route is ready and metadata datasource is visible |
| DSM-TC-002 | Country mapping | Render `summary` for `cn`, `mx`, `ph`, `pk`, `th`, `id` | correct metadata DB and `workflow_*`/`process_*` naming |
| DSM-TC-003 | Current上线统计 | Run `summary` SQL | workflow and schedule `release_state` counts return |
| DSM-TC-004 | Table-to-task lookup | Render/run `table-to-task` for a known table | project/workflow/task/schedule candidates return or not-found path is documented |
| DSM-TC-005 | Daily afterloan case | Render/run `daily-table-case` for `dwd_fox_asset_withhold_detail` | daily workflow/schedule/latest instances are resolved or not-found diagnosis is explicit |
| DSM-TC-006 | Workflow latest execution | Render/run `workflow-schedule` and latest instance query for one workflow | latest workflow instance state is reported |
| DSM-TC-007 | Task latest execution | Render/run `recent-task-runs` for one `task_code` | latest task instance, state, `task_instance_id`, `log_path` are reported |
| DSM-TC-008 | Failed task log planning | Locate a failed task instance and draft `get_task_log` payload | token-free payload has `project_code` and `task_instance_id` |
| DSM-TC-009 | DS API read smoke | Use `$ds-scheduler get_workflow` or `get_schedule` on a resolved object | API response agrees with SQL or discrepancy is explained |
| DSM-TC-010 | Not-found path | Query a fake or absent table | skill tries full name, token search, history, instances, SUB_WORKFLOW, then reports no direct hit |

## Mutating Dry-Run Tests

These tests produce payloads and risk reports only; they do not上线生产对象 and do not下线生产对象. In short: 不上线生产对象, 不下线生产对象.

| ID | Case | Required evidence |
|---|---|---|
| DSM-TC-011 | `offline_schedule` dry run | schedule status, blast radius, token-free payload, user confirmation gate |
| DSM-TC-012 | `retry_instance` dry run | failed instance, retry payload, downstream risk note |
| DSM-TC-013 | `disable_task` dry run | unique task, graph, `global_params`, variable reference check |
| DSM-TC-014 | `update_sql_task` dry run | original SQL/runtime config, datasource, rollback payload |
| DSM-TC-015 | Verification pairing | every mutation draft names SQL + API 双重回查 commands |

## Production Release and Backfill Planner Tests

以下用例与 `test_ds_schedule_manager.py` 的 `DSM-BF` 单测一一对应，均只运行无副作用计划器。

| ID | Unit test | Case | Pass condition |
|---|---|---|---|
| DSM-BF-001 | `test_dsm_bf_001_blocks_incomplete_dag_selection` | `TASK_ONLY` 只选择末层 task | 返回 `blocked_preflight` 和 `INCOMPLETE_DAG_SELECTION` |
| DSM-BF-002 | `test_dsm_bf_002_uses_daily_fallback_without_native_complement` | gateway 无原生 complement 且 `fallback_allowed=true` | 执行模式为 `daily_trigger_fallback` |
| DSM-BF-003 | `test_dsm_bf_003_warns_for_task_only_complete_selection` | `TASK_ONLY` 已显式选择完整 required task 集合 | 返回 `TASK_ONLY_REQUIRES_EXPLICIT_FULL_NODE_SET` 提醒 |
| DSM-BF-004 | `test_dsm_bf_004_stops_after_smoke_failure` | 单日完整链路冒烟失败 | 返回 `blocked_smoke_failed`，不得进入全量日期循环 |
| DSM-BF-005 | `test_dsm_bf_005_separates_backfill_from_schedule` | 补数日期覆盖完成但 schedule 缺失 | 数据覆盖为 `passed`，连续调度为 `missing` |
| DSM-BF-006 | `test_dsm_bf_006_does_not_treat_accepted_trigger_as_success` | DS 仅接受触发且冒烟仍在运行 | 返回 `waiting_for_smoke_terminal`，workflow instance 不得标记 `passed` |

## Required Real Case: 贷后 Daily Table

Case target:

```text
country: cn
table_name: dwd_fox_asset_withhold_detail
domain: 贷后
expected question: 每日调度情况、上线情况、最近执行情况
```

Minimum evidence:

1. `table-to-task` SQL generated and, when credentials allow, executed.
2. Candidate workflow/schedule state or explicit not-found diagnosis.
3. Latest 14-day instance view or explanation why no task/workflow candidate exists.
4. If a `task_instance_id` is found, token-free `get_task_log` payload.
5. No production mutation without explicit confirmation.

## Completion Gate

The skill can be considered tested only when:

- Local unit tests pass.
- Skill validation passes for source and installed copy.
- At least one SR read-only case has live evidence.
- At least one `$ds-scheduler` query or payload-builder smoke succeeds.
- All mutation cases remain dry-run unless the user explicitly approves a live DS change.
