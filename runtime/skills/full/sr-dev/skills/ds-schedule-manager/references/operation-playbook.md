# DS Operation Playbook

Use this reference when SQL metadata must become a DS API query, payload, mutation, or validation result.

## Executor Split

| Step | Executor | Allowed without confirmation |
|---|---|---|
| Metadata SQL | `$sr-box` | yes, read-only |
| API read: workflow/schedule/instance/task/log | `$ds-scheduler` | yes if token is ready; log body still needs DS token |
| Mutation: trigger/retry/offline/online/disable/update/delete | `$ds-scheduler` | no; require explicit user confirmation |

Always say whether `DS API 操作` is executed, drafted, or blocked.

## Query to Action Map

| Situation | Action | Required fields | Verification |
|---|---|---|---|
| Need realtime workflow view | `get_workflow` | `project_code`, `workflow_code` or `workflow_name` | SQL definition + API response |
| Need realtime schedule view | `get_schedule` / `list_schedules` | `project_code`, `schedule_id` or `workflow_code` | SQL `t_ds_schedules` + API response |
| Need task log body | `get_task_log` | `project_code`, `task_instance_id` | Log body returned; keep `log_path` as locator |
| Retry failed workflow instance | `retry_instance` | `project_code`, `instance_id` | `get_instance` and recent SQL instance state |
| Stop future daily triggers | `offline_schedule` | `project_code`, `schedule_id` or `workflow_code` | `get_schedule` shows OFFLINE |
| Bring schedule back | `online_schedule` | `project_code`, `schedule_id` or `workflow_code` | `get_schedule` shows ONLINE |
| Disable a bad task node | `disable_task` | `project_code`, `workflow_code`, `task_code` or `task_name` | API workflow graph + SQL task `flag` |
| Modify SQL task | `update_sql_task` | `project_code`, `workflow_code`, task id/name, SQL | API graph + SQL/API dry run |

## Mutation Gate

Before any mutation, present this compact gate:

```text
目标: <action>
对象: country/project/workflow/task/schedule/instance
影响面: schedule、父子 workflow、上下游任务、是否共享节点
风险: 是否整包更新 workflow definition、global_params 是否完整
验证: SQL + API 双重回查
需要确认: 请明确回复同意执行 <action>
```

For `disable_task`, `delete_task`, `append_*`, or `update_*`, include the guardrail text about `global_params` and `${src}/${db}/${dt}/${full}/${partition}/${complement}` from `SKILL.md`.

## Payload Patterns

Token-free draft for log body:

```json
{
  "country": "cn",
  "action": "get_task_log",
  "payload": {
    "project_code": "158515173456896",
    "task_instance_id": "8206311"
  }
}
```

Token-free draft for `offline_schedule`:

```json
{
  "country": "cn",
  "action": "offline_schedule",
  "payload": {
    "project_code": "158515173456896",
    "schedule_id": "1234567890"
  }
}
```

Token-free draft for `retry_instance`:

```json
{
  "country": "cn",
  "action": "retry_instance",
  "payload": {
    "project_code": "158515173456896",
    "instance_id": "1351007"
  }
}
```

Token-free draft for `disable_task`:

```json
{
  "country": "cn",
  "action": "disable_task",
  "payload": {
    "project_code": "158515173456896",
    "workflow_code": "159389263102976",
    "task_code": "159389263102980",
    "restore_original_state": true,
    "auto_offline": true
  }
}
```

Use the caller's explicit token first. If it is absent, use `scripts/ds_scheduler_with_default_token.py`; it resolves `DS_SCHEDULER_TOKEN`, `DS_SCHEDULE_MANAGER_TOKEN_CONFIG`, then `~/.codex/secrets/ds-schedule-manager/tokens.json`, and passes the resolved token explicitly to the unchanged `$ds-scheduler` builder. The private payload file must remain `0600`. Never write real token values into docs, test logs, or final answers.

## Verification

After an API mutation:

1. Run the matching `$ds-scheduler` read action (`get_schedule`, `get_workflow`, `get_instance`, or `dump_workflow_graph`).
2. Run SQL against `ds_catalog` to verify persisted metadata.
3. Report both as `SQL + API 双重回查`.
4. If the API response and SQL disagree, treat the API result as realtime but mark SQL convergence pending.

## Release/上线 Report Shape

For DS 上线 or 下线 reports, include:

- release object and owner (`owenzhang` when defaulted)
- preflight evidence
- exact token-free payload
- confirmation record
- execution response summary
- SQL/API verification
- rollback payload or restore action

Do not describe generated payloads as executed上线 evidence.
