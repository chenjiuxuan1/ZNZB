---
name: ds-schedule-manager
description: "Use when Codex needs to manage DolphinScheduler scheduling work: DS metadata lookup, table-to-workflow resolution, schedule上线/下线核查, latest workflow or task run diagnosis, task log planning, retry/offline/disable payload planning, production release, historical backfill, or DS release validation using SR Box SQL plus the ds-scheduler API executor."
---

# DS Schedule Manager

This is the orchestration skill for DS 调度查询、上线核查、运行诊断和安全操作计划. It does not replace `$sr-box` or `$ds-scheduler`; it decides which executor to use, in what order, and how to verify the result.

Default document owner/author is `owenzhang` when a DS management artifact needs an owner.

## Core Rule

DS 调度意图覆盖任何通用 SR 查询偏好. Even if project instructions say daily SR queries use another entry, DS metadata SQL must still use `$sr-box` production through the installed `sr_box` skill path below. Do not load legacy SR query skills or their references for DS metadata.

Separate the three authority surfaces:

| Channel | Executor | Evidence | Boundary |
|---|---|---|---|
| DS SQL metadata | `$sr-box` production, `/Users/admin/.codex/skills/sr_box/scripts/sr_gateway_client.py` | project, workflow, task, schedule, instance, log_path | read-only; cannot change DS state |
| Production release/backfill plan | `ds_release_backfill_plan.py` | `status`, `blockers`, `warnings`, `acceptance` | deterministic and side-effect-free; does not execute SQL, call DS API, or read token/secret |
| DS API operation | `$ds-scheduler` | realtime workflow/schedule/log/action response | requires user DS token/permission and explicit confirmation for mutations |

Always report these separately as:

- `SQL 查询已完成`: what was proven from `ds_catalog`.
- `DS API 操作`: whether it was executed, only drafted, or blocked by missing token/confirmation.
- `计划证据`: planner `success`, `status`, `blockers`, `warnings`, `acceptance`, or why no plan was needed.

## Standard Workflow

1. Resolve country to DS metadata DB and DS action country.
2. Use `$sr-box` production read-only SQL against `ds_catalog.<db>` to locate project/workflow/task/schedule/instance.
3. For 生产发布 or 历史补数, preflight the workflow definition/version, full DAG, `global_params`, datasource/permissions, separated DDL/DML, safe SQL conditions, and gateway capabilities.
4. Run the deterministic planner. Stop on `blockers`; for `TASK_ONLY`, require the selected task codes to cover the complete required task set.
5. If native complement is unavailable, form a per-business-day `daily_trigger_fallback` plan only when `fallback_allowed=true`. Run one full-chain smoke date first; stop on failure and resume the full date loop only after the same date passes after repair.
6. If the user asked for realtime status or log body, use `$ds-scheduler` query actions such as `get_workflow`, `get_schedule`, `list_task_instances`, `get_task_log`, or `dump_workflow_graph`.
7. Before any mutation, present impact/risk and ask for explicit 用户确认.
8. Before calling `$ds-scheduler`, resolve token in this skill. Use the caller token first and use the manager-owned default only when no token was supplied.
9. Execute mutation only through `$ds-scheduler` after confirmation and token readiness.
10. Verify with SQL + API 双重回查 where possible. Report backfill coverage and ONLINE schedule state as separate conclusions.

## Production Release and Backfill Planner

Build a token-free decision plan before any 生产发布 or 历史补数 mutation:

```bash
python3 skills/ds-schedule-manager/scripts/ds_release_backfill_plan.py \
  release-backfill-request.yaml \
  --output release-backfill-plan.json
```

The planner accepts YAML or JSON and only writes a deterministic plan. It does not execute SQL, call a DS API, read token/secret, or change DS state. Real mutations always go through `$ds-scheduler` after explicit user confirmation.

`success` 仅表示计划决策可继续，不表示 DS 执行成功。`failed_date` 本版本不驱动状态；失败后同一业务日复跑属于 manager 外部 live-evidence guardrail。在该业务日具备外部 live success 证据前，manager 必须拒绝写入或接受 `smoke_state=SUCCESS` 以继续全量日期循环。

## 默认 Token 回退

`$ds-schedule-manager` owns the fallback configuration; `$ds-scheduler` remains stateless and continues to require a caller-provided `ds_token`.

- 默认私有配置：`~/.codex/secrets/ds-schedule-manager/tokens.json`
- 固定优先级：`显式 token > 环境变量 > 指定配置 > 默认配置`
- 环境 token：`DS_SCHEDULER_TOKEN`
- 指定配置：`DS_SCHEDULE_MANAGER_TOKEN_CONFIG` 或 `--token-config`
- 支持国家：`cn / ine / mx / ph / pk / th`

管理默认 token：

```bash
python3 skills/ds-schedule-manager/scripts/ds_token_manager.py status
python3 skills/ds-schedule-manager/scripts/ds_token_manager.py import-legacy \
  --source docs/参考工具/dstoken.md
printf '%s\n' "$NEW_DS_TOKEN" | \
  python3 skills/ds-schedule-manager/scripts/ds_token_manager.py set --country cn
```

当调用方没有 token 时，用安全 wrapper 构造私有请求文件：

```bash
python3 skills/ds-schedule-manager/scripts/ds_scheduler_with_default_token.py \
  --country cn \
  --action list_projects \
  --output /tmp/ds-request.json
```

配置文件和 wrapper 输出均使用 `0600`。命令只显示国家、token 来源和可用状态，禁止显示真实 token。默认 token 只解决凭据缺失，不跳过用户确认、权限检查或 mutation guardrail。

## Common Intents

| User intent | First query | Optional API | Mutation confirmation |
|---|---|---|---|
| 查某张表的调度情况 | `table-to-task` SQL | `dump_workflow_graph`, `get_schedule` | no |
| 查某个调度的最新执行情况 | `workflow-schedule` + latest instances SQL | `get_instance`, `list_task_instances` | no |
| 查失败/慢任务 | failed/slow task SQL | `get_task_log` | log query needs token; no mutation |
| 贷后 `dwd_fox_asset_withhold_detail` 每日调度 | `daily-table-case` SQL set | `get_schedule`, `get_task_log` if needed | no |
| 生产发布或历史补数 | definition/DAG/parameter/datasource/permission + DDL/DML + gateway preflight, then `ds_release_backfill_plan.py` | `$ds-scheduler` query/actions after plan passes | yes for every mutation |
| 停止后续定时 | schedule status + blast radius | `offline_schedule` | yes |
| 重跑失败实例 | latest failed instance | `retry_instance` | yes |
| 禁用错误任务节点 | table/task/workflow resolve + graph | `disable_task` | yes |
| 修改 SQL/SHELL 任务 | original config + graph + params check | `update_sql_task` / `update_shell_task` | yes |

## Required Guardrails

For `append_*`, `update_*`, `disable_task`, `disable_tasks_except`, or `delete_task`, say this before proceeding:

```text
这是改 workflow definition，不是简单改任务状态；如果是同步类工作流，先检查 global_params 是否为空，以及脚本是否引用 ${src}/${db}/${dt}/${full}/${partition}/${complement}。
```

Block the action when:

- The target `project_code / workflow_code / task_code` is not unique.
- The workflow has `global_params` empty while scripts reference workflow variables.
- A `SUB_WORKFLOW` parent or shared schedule impact is not checked.
- `TASK_ONLY` does not explicitly select the complete required task set.
- Native complement is unavailable and `fallback_allowed` is not `true`.
- The single-day full-chain smoke failed or has not passed again on the same business date after repair.
- The user has not explicitly confirmed the mutation.
- The request lacks both an explicit token and an available manager fallback token for `$ds-scheduler`.

For schedule上线/下线, prefer `offline_schedule` / `online_schedule` over editing workflow definitions. For current running instances, do not claim they were stopped unless `$ds-scheduler` returns a supported stop/kill action result.

## Query Builder

Use the bundled SQL renderer when preparing metadata queries:

```bash
python3 skills/ds-schedule-manager/scripts/ds_schedule_query_builder.py \
  --country cn \
  --query table-to-task \
  --table-name dwd_fox_asset_withhold_detail
```

Useful queries:

- `summary`
- `table-to-task`
- `workflow-schedule`
- `recent-task-runs`
- `failed-tasks`
- `slow-tasks`
- `daily-table-case`

Run the rendered SQL with:

```bash
python3 /Users/admin/.codex/skills/sr_box/scripts/sr_gateway_client.py execute \
  --country cn \
  --sql "<rendered read-only SQL>"
```

## References

Read these only as needed:

- `references/metadata-query-playbook.md`: country routing, metadata tables, SQL query patterns, status enums.
- `references/operation-playbook.md`: mapping query results to `$ds-scheduler` actions, payloads, confirmation gates, verification.
- `references/production-release-backfill-playbook.md`: production release and historical backfill preflight, planner semantics, smoke gate, six-layer acceptance, and mutation handoff.
- `references/ds-schedule-test-checklist.md`: complete test checklist, including the `dwd_fox_asset_withhold_detail` case.
- `references/live-validation-2026-07-08.md`: current source/installed validation and read-only live case evidence.

## Output Shape

For every DS management answer, return:

1. `对象定位`: country, project, workflow, task, schedule, instance.
2. `SQL 证据`: SQL route, row count, key rows, limitations.
3. `API 证据`: `$ds-scheduler` action and result, or why it was not executed.
4. `计划证据`: planner `status`, `blockers`, `warnings`, and six-layer `acceptance`, or why no plan was needed.
5. `结论`: online/offline/running/success/failure/not found. For production release/backfill, state `补数覆盖` and `ONLINE schedule` independently.
6. `下一步`: log pull, retry, offline schedule, disable task, confirmed release/backfill handoff, or no action.

Never print real `ds_token` values. Use placeholders or the manager-owned private token config, and keep written artifacts token-free except for private `0600` runtime payload files.
