# DS Schedule Manager Live Validation - 2026-07-08

Scope: validate `$ds-schedule-manager` source and installed copy, then run read-only DS metadata cases through `$sr-box`. No production DS mutation was executed.

## Local Validation

| Check | Result |
|---|---|
| Source skill validation | pass: `quick_validate.py skills/ds-schedule-manager` |
| Source unit test | pass: `python3 -m unittest skills/ds-schedule-manager/scripts/test_ds_schedule_manager.py` |
| Source py_compile | pass |
| Installed path | `/Users/admin/.codex/skills/ds-schedule-manager` |
| Installed skill validation | pass |
| Installed unit test | pass |
| Source vs installed diff | pass: `diff -qr` returned no differences |

## SR Box Readiness

| Check | Result |
|---|---|
| Gateway health | `status=UP` |
| SSO user | `owenzhang@kn.group`, SR user `'owenzhang'@'%'` |
| Route | `cn`, datasource `sr_cn_local`, connect mode `managed-ssh-tunnel` |

## China DS Summary

Query: `ds_schedule_query_builder.py --country cn --query summary`

| Metric | State | Count |
|---|---:|---:|
| workflow_release_state | 0 | 247 |
| workflow_release_state | 1 | 737 |
| schedule_release_state | 0 | 363 |
| schedule_release_state | 1 | 191 |
| recent_workflow_instance_state | 5 | 2 |
| recent_workflow_instance_state | 6 | 4240 |
| recent_workflow_instance_state | 7 | 51640 |
| recent_task_instance_state | 6 | 4561 |
| recent_task_instance_state | 7 | 308102 |
| recent_task_instance_state | 8 | 6 |
| recent_task_instance_state | 9 | 3 |

## Required Case: `dwd_fox_asset_withhold_detail`

Country: `cn`

| Step | Result |
|---|---|
| `table-to-task` against current task definitions | 0 rows |
| Recent 14-day task instances by task params/name | 0 rows |
| Conclusion | No direct DS metadata hit for this table name in current China DS definitions or recent instances. Use not-found diagnosis: short tokens, historical definitions, repository SQL/SHELL, or known workflow/task name. |

## Known Positive Case: `dwb_fox_asset_period_info`

Country: `cn`

| Step | Result |
|---|---|
| `table-to-task` | 49 candidate rows |
| Matched afterloan workflow | project `贷后域建设` / `158515173456896`, workflow `DWB(1H)` / `159389263102976`, task `dwb_fox_asset_period_info` / `159389263102980` |
| Workflow release state | `1=ONLINE` |
| Schedule | no direct `t_ds_schedules` row for this workflow |
| Latest workflow instances | latest 10 rows all `state=7=SUCCESS` |
| Latest observed instance | `1406036`, `2026-07-08 15:41:02` to `15:42:52`, host `10.20.48.14:5678` |
| Interpretation | Workflow is online and running successfully, but no direct schedule record exists; it may be manually triggered, externally triggered, or triggered by a parent workflow. Check `SUB_WORKFLOW` parent relationships before claiming schedule status. |

## `$ds-scheduler` Dry Run

Because the user did not provide a real `ds_token`, only payload construction was validated.

Dry-run action:

```text
country=cn
action=get_schedule
project_code=158515173456896
workflow_code=159389263102976
token=FAKE_DS_TOKEN_FOR_DRY_RUN
```

Result: payload and curl were generated successfully. This is not DS API execution evidence.

## Mutation Boundary

No `online_schedule`, `offline_schedule`, `retry_instance`, `disable_task`, `update_*`, or `append_*` action was executed. Future mutation tests must require user confirmation, real DS token readiness, and SQL + API dual verification.
