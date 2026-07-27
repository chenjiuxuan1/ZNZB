# DS Metadata Query Playbook

Use this reference when the task is locating DS projects, workflows, tasks, schedules, latest runs, or log paths from StarRocks `ds_catalog`.

## Country Router

| Business country | SR country | DS action country | Metadata DB | Naming style |
|---|---|---|---|---|
| `cn` | `cn` | `cn` | `cn_dolphin` | `workflow_*` |
| `th` | `th` | `th` | `dolphin_scheduler` | `workflow_*` |
| `mx` | `mx` | `mx` | `mex_dolphin` | `process_*` |
| `ph` | `ph` | `ph` | `phl_dolphin` | `process_*` |
| `pk` | `pk` | `pk` | `pak_dolphin` | `workflow_*` |
| `id` | `id` | `ine` | `dolphin_scheduler` | `workflow_*` |

For China, the full metadata namespace is `ds_catalog.cn_dolphin`, for example `ds_catalog.cn_dolphin.t_ds_workflow_definition`.

`workflow_*` and `process_*` differ only in table and relation names. Keep output labels normalized as workflow/task/schedule so the user does not need to care about legacy DS table names.

| Abstract object | `workflow_*` table/field | `process_*` table/field |
|---|---|---|
| Definition | `t_ds_workflow_definition` | `t_ds_process_definition` |
| Definition log | `t_ds_workflow_definition_log` | `t_ds_process_definition_log` |
| Relation | `t_ds_workflow_task_relation` | `t_ds_process_task_relation` |
| Instance | `t_ds_workflow_instance` | `t_ds_process_instance` |
| Schedule code field | `workflow_definition_code` | `process_definition_code` |
| Task-instance parent field | `workflow_instance_id` | `process_instance_id` |

## Core Tables

| Purpose | Table | Key fields |
|---|---|---|
| Project | `t_ds_project` | `code`, `name`, `user_id`, `flag` |
| User/owner | `t_ds_user` | `id`, `user_name`, `email`, `state` |
| Workflow definition | `t_ds_workflow_definition` / `t_ds_process_definition` | `code`, `name`, `version`, `project_code`, `release_state`, `global_params` |
| Task definition | `t_ds_task_definition` | `code`, `name`, `version`, `project_code`, `task_type`, `task_params`, `flag` |
| DAG relation | `t_ds_workflow_task_relation` / `t_ds_process_task_relation` | definition code/version, `pre_task_code`, `post_task_code` |
| Schedule | `t_ds_schedules` | `id`, definition code, `crontab`, `release_state`, time window |
| Workflow instance | `t_ds_workflow_instance` / `t_ds_process_instance` | `id`, definition code, `state`, `start_time`, `end_time` |
| Task instance | `t_ds_task_instance` | `id`, `task_code`, parent instance id, `state`, `log_path`, `task_params` |

## Status Values

`release_state`: `0=OFFLINE`, `1=ONLINE`.

Common workflow instance states: `1=RUNNING_EXECUTION`, `5=STOP`, `6=FAILURE`, `7=SUCCESS`, `14=SERIAL_WAIT`, `18=FAILOVER`.

Common task instance states: `1=RUNNING_EXECUTION`, `6=FAILURE`, `7=SUCCESS`, `8=NEED_FAULT_TOLERANCE`, `9=KILL`, `13=FORCED_SUCCESS`, `17=DISPATCH`.

Task `flag`: `1=enabled`, `0=disabled`.

## Query Patterns

Generate the exact SQL with:

```bash
python3 skills/ds-schedule-manager/scripts/ds_schedule_query_builder.py --country cn --query summary
python3 skills/ds-schedule-manager/scripts/ds_schedule_query_builder.py --country cn --query table-to-task --table-name dwd_fox_asset_withhold_detail
python3 skills/ds-schedule-manager/scripts/ds_schedule_query_builder.py --country cn --query workflow-schedule --workflow-code 159389263102976
python3 skills/ds-schedule-manager/scripts/ds_schedule_query_builder.py --country cn --query recent-task-runs --task-code 159389263102980
python3 skills/ds-schedule-manager/scripts/ds_schedule_query_builder.py --country cn --query daily-table-case --table-name dwd_fox_asset_withhold_detail
```

Run generated SQL through `$sr-box` production only:

```bash
python3 /Users/admin/.codex/skills/sr_box/scripts/sr_gateway_client.py execute \
  --country cn \
  --sql "<rendered read-only SQL>"
```

This DS management skill is tied to the production SR Box SSO gateway at `https://data-map-dev.kuainiu.io`. Do not substitute another local or legacy SQL executor for DS metadata queries. If a project-level instruction describes a different default for daily SR queries, treat that as lower priority than this DS-specific executor split.

### table_to_task_query

Use when the user gives a business table such as `dwd_fox_asset_withhold_detail`.

Expected output fields:

- `project_name`, `project_code`
- `workflow_name`, `workflow_code`, `workflow_release_state`
- `task_name`, `task_code`, `task_type`, `task_flag`
- `schedule_id`, `schedule_release_state`, `crontab`
- `owner_name`

### workflow_schedule_status

Use when the user gives workflow name/code or when `table_to_task_query` returns a candidate workflow.

Expected output fields:

- workflow state from definition
- schedule state from `t_ds_schedules`
- schedule time window, tenant, worker group, environment

### recent_daily_instances

Use for daily schedule questions. Query at least 14 days so a missing day is visible. Report missing runs separately from failed runs.

### log_locator

Use task instance SQL to locate `task_instance_id`, `host`, and `log_path`. The log path is not the log body. Use `$ds-scheduler get_task_log` for body text.

## Not Found Diagnosis

If a full table name has no hit:

1. Search short tokens from the table name.
2. Search historical task definition logs.
3. Search task instance params/name for the last 30 days.
4. Check `SUB_WORKFLOW` parent relationships.
5. Search repository SQL/SHELL only after DS metadata is exhausted.
6. Ask for workflow/task name if the table is dynamically built in scripts.
