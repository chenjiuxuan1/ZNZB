#!/usr/bin/env python3
"""Build dry-run DS release bundles for DW Dev."""

import json
import os
from pathlib import Path

import yaml


SUPPORTED_COUNTRIES = {"cn", "ine", "mx", "ph", "pk", "th"}
APPEND_MODE = "append_to_existing_workflow"
ADJUST_MODE = "adjust_existing_workflow"
CREATE_MODE = "create_new_workflow"
SUPPORTED_MODES = {APPEND_MODE, ADJUST_MODE, CREATE_MODE}
REGULAR_OPERATION = "regular"
BACKFILL_OPERATION = "backfill"
REPAIR_OPERATION = "repair"
SUPPORTED_OPERATION_MODES = {REGULAR_OPERATION, BACKFILL_OPERATION, REPAIR_OPERATION}
TOKEN_PLACEHOLDER = "__DS_TOKEN_FROM_LOCAL_CONFIG__"
TOKEN_CONFIG_DEFAULT = Path.home() / ".codex" / "secrets" / "ds-scheduler" / "tokens.json"
DS_SCHEDULER_DEFAULT = Path.home() / ".codex" / "skills" / "ds-scheduler"


def build_ds_release_bundle(request, output_dir, ticket_id):
    ds_release = _mapping(request.get("ds_release"))
    if not _truthy(ds_release.get("enabled")):
        return None

    output_dir = Path(output_dir)
    release_dir = output_dir / "release" / "ds"
    release_dir.mkdir(parents=True, exist_ok=True)

    normalized = _normalize_release(request, ds_release, ticket_id)
    preflight = _evaluate_preflight(normalized)
    blockers = _release_blockers(normalized, preflight)

    _write_yaml(release_dir / "00-release-request.yaml", normalized)
    _write_text(
        release_dir / "01-preflight.md",
        _render_preflight(normalized, preflight, blockers),
    )
    _write_operation_docs(release_dir, normalized)
    _write_preflight_payloads(release_dir, normalized)

    if not blockers:
        _write_action_payloads(release_dir, normalized)
        _write_rollback_payloads(release_dir, normalized)

    _write_text(
        release_dir / "07-production-validation.md",
        _render_production_validation(normalized, blockers),
    )
    _write_text(release_dir / "08-execution-log.md", _render_execution_log(normalized, blockers))

    return {
        "enabled": True,
        "status": "blocked" if blockers else "dry_run_ready",
        "blockers": blockers,
        "release_dir": str(release_dir),
    }


def _normalize_release(request, ds_release, ticket_id):
    route = _mapping(request.get("route"))
    project = _mapping(ds_release.get("project_space"))
    workflow = _mapping(ds_release.get("workflow"))
    task = _mapping(ds_release.get("task"))
    sql = _mapping(ds_release.get("sql"))
    script = _mapping(ds_release.get("script"))
    operation = _mapping(ds_release.get("operation"))
    backfill = _mapping(operation.get("backfill"))
    schedule = _mapping(ds_release.get("schedule"))
    runtime_params = _mapping(ds_release.get("runtime_params"))
    controls = _mapping(ds_release.get("release_controls"))
    preflight = _mapping(ds_release.get("preflight"))
    country = _text(ds_release.get("country"), _text(route.get("country")))
    mode = _normalize_mode(workflow.get("change_mode"))
    task_type = _normalize_task_type(task.get("type"))
    return {
        "ticket_id": ticket_id,
        "country": country,
        "project_space": {
            "name": _text(project.get("name")),
            "code": _text(project.get("code")),
        },
        "workflow": {
            "change_mode": mode,
            "name": _text(workflow.get("name")),
            "code": _text(workflow.get("code")),
        },
        "task": {
            "type": task_type,
            "name": _text(task.get("name")),
            "description": _text(task.get("description")),
            "template_task_name": _text(task.get("template_task_name")),
            "upstream_task_name": _text(task.get("upstream_task_name")),
            "upstream_task_code": _text(task.get("upstream_task_code")),
            "existing_task_name": _text(task.get("existing_task_name")),
            "existing_task_code": _text(task.get("existing_task_code")),
        },
        "sql": {
            "source": _text(sql.get("source")),
            "content": _text(sql.get("content")),
            "sql_type": _text(sql.get("sql_type"), "execute"),
            "sql_type_source": _text(sql.get("sql_type_source"), "warehouse_dev_default"),
            "datasource": _text(sql.get("datasource")),
            "datasource_source": _text(sql.get("datasource_source")),
        },
        "script": {
            "source": _text(script.get("source")),
            "content": _text(script.get("content")),
        },
        "operation": {
            "mode": _normalize_operation_mode(operation.get("mode")),
            "backfill": {
                "start": _text(backfill.get("start")),
                "end": _text(backfill.get("end")),
                "partition_param": _text(backfill.get("partition_param")),
                "reason": _text(backfill.get("reason")),
            },
            "validation_checks": _text_list(operation.get("validation_checks")),
        },
        "schedule": {
            "action": _text(schedule.get("action")),
            "cron": _text(schedule.get("cron")),
            "timezone": _text(schedule.get("timezone"), "Asia/Shanghai"),
            "start_time": _text(schedule.get("start_time")),
            "end_time": _text(schedule.get("end_time")),
        },
        "runtime_params": {
            "custom_params": _mapping(runtime_params.get("custom_params")),
            "schedule_time": _text(runtime_params.get("schedule_time")),
            "start_node_list": _text(runtime_params.get("start_node_list")),
        },
        "release_controls": {
            "online_workflow": _truthy(controls.get("online_workflow")),
            "trigger_workflow": _truthy(controls.get("trigger_workflow")),
            "restore_original_state": _truthy(controls.get("restore_original_state")),
            "auto_offline": _truthy(controls.get("auto_offline")),
        },
        "preflight": {
            "ds_scheduler_skill_path": _text(
                preflight.get("ds_scheduler_skill_path"), str(DS_SCHEDULER_DEFAULT)
            ),
            "token_config_path": _text(
                preflight.get("token_config_path"),
                os.environ.get("DS_SCHEDULER_TOKEN_CONFIG", str(TOKEN_CONFIG_DEFAULT)),
            ),
            "token_available": preflight.get("token_available"),
            "connectivity_checked": preflight.get("connectivity_checked"),
            "connectivity_result": _mapping(preflight.get("connectivity_result")),
            "webhook_url": _text(preflight.get("webhook_url")),
        },
    }


def _evaluate_preflight(release):
    skill_path = Path(release["preflight"]["ds_scheduler_skill_path"]).expanduser()
    script_path = skill_path / "scripts" / "build_ds_webhook_payload.py"
    token_status = _token_status(
        release["country"],
        release["preflight"]["token_config_path"],
        release["preflight"]["token_available"],
    )
    connectivity = _connectivity_status(release["preflight"])
    return {
        "skill_path": str(skill_path),
        "skill_exists": skill_path.is_dir(),
        "script_exists": script_path.is_file(),
        "token": token_status,
        "connectivity": connectivity,
        "webhook_url_present": bool(release["preflight"]["webhook_url"]),
    }


def _token_status(country, token_config_path, token_available):
    if token_available is True:
        return {"status": "pass", "source": "request.preflight.token_available"}
    path = Path(token_config_path).expanduser()
    result = {
        "status": "missing",
        "path": str(path),
        "config_exists": path.is_file(),
        "country_key_exists": False,
    }
    if not path.is_file():
        return result
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        result["status"] = "invalid"
        result["error"] = type(exc).__name__
        return result
    raw_tokens = data.get("tokens", data) if isinstance(data, dict) else {}
    if not isinstance(raw_tokens, dict):
        result["status"] = "invalid"
        result["error"] = "tokens must be a mapping"
        return result
    countries = {str(key).strip().lower() for key in raw_tokens if str(key).strip()}
    result["country_key_exists"] = country in countries
    result["status"] = "pass" if country in countries else "missing_country_key"
    return result


def _connectivity_status(preflight):
    connectivity_result = _mapping(preflight.get("connectivity_result"))
    if connectivity_result:
        return {
            "status": "pass" if connectivity_result.get("success") is True else "fail",
            "source": "request.preflight.connectivity_result",
        }
    if preflight.get("connectivity_checked") is True:
        return {"status": "pass", "source": "request.preflight.connectivity_checked"}
    return {"status": "pending", "source": "dry_run_only"}


def _release_blockers(release, preflight):
    blockers = []
    country = release["country"]
    mode = release["workflow"]["change_mode"]
    task_type = release["task"]["type"]
    operation_mode = release["operation"]["mode"]
    if country not in SUPPORTED_COUNTRIES:
        blockers.append(f"country `{country or 'missing'}` is not supported")
    if mode not in SUPPORTED_MODES:
        blockers.append(f"workflow.change_mode `{mode or 'missing'}` is not supported")
    if mode == CREATE_MODE:
        blockers.append("create_new_workflow: unsupported by current ds-scheduler gateway")
    if operation_mode not in SUPPORTED_OPERATION_MODES:
        blockers.append(f"operation.mode `{operation_mode or 'missing'}` is not supported")
    if operation_mode in {BACKFILL_OPERATION, REPAIR_OPERATION}:
        backfill = release["operation"]["backfill"]
        if not (backfill["start"] and backfill["end"]):
            blockers.append("operation.backfill.start and end are required for backfill/repair")
    if _schedule_requested(release):
        blockers.append("schedule action is unsupported by current ds-scheduler gateway")
    if not release["project_space"]["code"]:
        blockers.append("project_space.code is required")
    if mode in {APPEND_MODE, ADJUST_MODE} and not release["workflow"]["code"]:
        blockers.append("workflow.code is required for existing workflow changes")
    if not release["task"]["name"]:
        blockers.append("task.name is required")
    if task_type not in {"SQL", "SHELL"}:
        blockers.append("task.type must be SQL or SHELL")
    if not release["task"]["template_task_name"]:
        blockers.append("task.template_task_name is required")
    if task_type == "SQL" and not release["sql"]["content"]:
        blockers.append("sql.content is required for SQL release")
    if task_type == "SHELL" and not release["script"]["content"]:
        blockers.append("script.content is required for SHELL release")
    if mode == ADJUST_MODE and not (
        release["task"]["existing_task_name"] or release["task"]["existing_task_code"]
    ):
        blockers.append("task.existing_task_name or existing_task_code is required for adjust mode")
    if not preflight["skill_exists"] or not preflight["script_exists"]:
        blockers.append("ds-scheduler skill or payload builder script is missing")
    if preflight["token"]["status"] != "pass":
        blockers.append("DS token preflight did not pass")
    if preflight["connectivity"]["status"] == "fail":
        blockers.append("live DS connectivity check failed")
    return blockers


def _write_preflight_payloads(release_dir, release):
    preflight_dir = release_dir / "preflight"
    _write_json(
        preflight_dir / "01-list-projects.payload.json",
        _payload(release, "list_projects", {}),
    )
    workflow_payload = {}
    if release["workflow"]["code"]:
        workflow_payload["workflow_code"] = release["workflow"]["code"]
    if release["workflow"]["name"]:
        workflow_payload["workflow_name"] = release["workflow"]["name"]
    if workflow_payload:
        _write_json(
            preflight_dir / "02-get-workflow.payload.json",
            _payload(release, "get_workflow", workflow_payload),
        )
    if release["workflow"]["code"]:
        _write_json(
            preflight_dir / "03-dump-workflow-graph.payload.json",
            _payload(
                release,
                "dump_workflow_graph",
                {"workflow_code": release["workflow"]["code"]},
            ),
        )


def _write_operation_docs(release_dir, release):
    _write_text(release_dir / "02-operation-plan.md", _render_operation_plan(release))
    if _schedule_requested(release):
        _write_yaml(
            release_dir / "schedule" / "01-schedule-request.yaml",
            {
                "ticket_id": release["ticket_id"],
                "country": release["country"],
                "project_code": release["project_space"]["code"],
                "workflow_code": release["workflow"]["code"],
                "schedule": release["schedule"],
                "status": "blocked",
                "blocker": "current ds-scheduler gateway does not expose schedule create/update actions",
            },
        )


def _write_action_payloads(release_dir, release):
    action_dir = release_dir / "action"
    if release["workflow"]["change_mode"] == ADJUST_MODE:
        _write_json(
            action_dir / "01-delete-existing-task.payload.json",
            _payload(
                release,
                "delete_task",
                {
                    "project_code": release["project_space"]["code"],
                    "workflow_code": release["workflow"]["code"],
                    "task_name": release["task"]["existing_task_name"],
                    "task_code": release["task"]["existing_task_code"],
                    "restore_original_state": release["release_controls"][
                        "restore_original_state"
                    ],
                    "auto_offline": release["release_controls"]["auto_offline"],
                },
            ),
        )

    append_action = "append_sql_task" if release["task"]["type"] == "SQL" else "append_shell_task"
    _write_json(
        action_dir / "02-append-task.payload.json",
        _payload(release, append_action, _append_payload(release)),
    )
    if release["release_controls"]["online_workflow"]:
        _write_json(
            action_dir / "03-online-workflow.payload.json",
            _payload(
                release,
                "online_workflow",
                {"workflow_code": release["workflow"]["code"]},
            ),
        )
    if release["release_controls"]["trigger_workflow"]:
        _write_json(
            action_dir / "04-trigger-workflow.payload.json",
            _payload(
                release,
                "trigger_workflow",
                {
                    "workflow_code": release["workflow"]["code"],
                    "start_node_list": release["runtime_params"]["start_node_list"],
                    "schedule_time": release["runtime_params"]["schedule_time"],
                    "custom_params": release["runtime_params"]["custom_params"],
                },
            ),
        )


def _append_payload(release):
    payload = {
        "project_code": release["project_space"]["code"],
        "workflow_code": release["workflow"]["code"],
        "task_type": release["task"]["type"],
        "task_name": release["task"]["name"],
        "task_description": release["task"]["description"],
        "template_task_name": release["task"]["template_task_name"],
        "upstream_task_name": release["task"]["upstream_task_name"],
        "upstream_task_code": release["task"]["upstream_task_code"],
    }
    if release["task"]["type"] == "SQL":
        payload.update(
            {
                "sql": release["sql"]["content"],
                "sql_type": release["sql"]["sql_type"],
            }
        )
        if release["sql"]["datasource"]:
            payload["datasource"] = release["sql"]["datasource"]
    else:
        payload["script"] = release["script"]["content"]
    return payload


def _write_rollback_payloads(release_dir, release):
    _write_json(
        release_dir / "rollback" / "01-delete-new-task.payload.json",
        _payload(
            release,
            "delete_task",
            {
                "project_code": release["project_space"]["code"],
                "workflow_code": release["workflow"]["code"],
                "task_name": release["task"]["name"],
                "restore_original_state": release["release_controls"][
                    "restore_original_state"
                ],
                "auto_offline": release["release_controls"]["auto_offline"],
            },
        ),
    )


def _payload(release, action, payload):
    base_payload = {
        "project_code": "",
        "workflow_code": "",
        "workflow_name": "",
        "instance_id": "",
        "start_node_list": "",
        "schedule_time": "",
        "state_type": "",
        "search_val": "",
        "page_no": 1,
        "page_size": 20,
        "custom_params": {},
    }
    base_payload.update(payload)
    return {
        "source": "dw-dev",
        "country": release["country"],
        "action": action,
        "ds_token": TOKEN_PLACEHOLDER,
        "request_id": f"{release['ticket_id']}-{action}",
        "payload": base_payload,
    }


def _render_preflight(release, preflight, blockers):
    token_status = preflight["token"]
    connectivity = preflight["connectivity"]
    mode = release["workflow"]["change_mode"]
    lines = [
        "# DS 发布前置检查",
        "",
        f"- ticket_id: `{release['ticket_id']}`",
        f"- country: `{release['country'] or 'missing'}`",
        f"- project_space.name: `{release['project_space']['name'] or 'unknown'}`",
        f"- project_space.code: `{release['project_space']['code'] or 'missing'}`",
        f"- workflow.change_mode: `{mode or 'missing'}`",
        f"- workflow.name: `{release['workflow']['name'] or 'unknown'}`",
        f"- workflow.code: `{release['workflow']['code'] or 'missing'}`",
        f"- task.type: `{release['task']['type'] or 'missing'}`",
        f"- task.name: `{release['task']['name'] or 'missing'}`",
        f"- operation.mode: `{release['operation']['mode'] or 'missing'}`",
        f"- schedule.action: `{release['schedule']['action'] or 'none'}`",
        "",
        "## Checks",
        "",
        f"- ds-scheduler skill: {_pass_fail(preflight['skill_exists'] and preflight['script_exists'])}",
        f"- token config exists: {_pass_fail(token_status.get('config_exists', True))}",
        f"- token country key: {_pass_fail(token_status['status'] == 'pass')}",
        f"- live connectivity: {connectivity['status']}",
        f"- webhook url configured: {_pass_fail(preflight['webhook_url_present'])}",
        "",
        "## Workflow Boundary",
        "",
    ]
    if mode == CREATE_MODE:
        lines.append("- create_new_workflow: unsupported by current ds-scheduler gateway.")
    elif mode == ADJUST_MODE:
        lines.append("- adjust_existing_workflow: supported as delete existing task + append new task dry-run payloads.")
    else:
        lines.append("- append_to_existing_workflow: supported as append SQL/SHELL task dry-run payload.")
    if _schedule_requested(release):
        lines.append("- schedule: documented only; current gateway has no schedule create/update action.")
    lines.extend(
        [
            "",
            "## Blockers",
            "",
            _bullet_list(blockers),
            "",
            "## Boundary",
            "",
            "- 本目录只生成 DS dry-run payload 和发布检查材料，不直接调用 n8n 或 DS。",
            "- 真实执行需要用户显式确认，并使用调用人自己的 DS token。",
            "- token 明文不会写入产物；payload 使用占位符。",
            "- `testdb` 验证成功不等于生产 DS 已上线。",
            "- 定时配置当前只写入 `schedule/01-schedule-request.yaml`，不会生成可执行 action payload。",
            "",
        ]
    )
    return "\n".join(lines)


def _render_operation_plan(release):
    operation = release["operation"]
    backfill = operation["backfill"]
    schedule = release["schedule"]
    lines = [
        "# DS 操作计划",
        "",
        f"- ticket_id: `{release['ticket_id']}`",
        f"- operation.mode: `{operation['mode']}`",
        f"- task.type: `{release['task']['type'] or 'missing'}`",
        f"- sql.sql_type: `{release['sql']['sql_type']}`",
        f"- sql.sql_type_source: `{release['sql']['sql_type_source']}`",
        f"- sql.datasource: `{release['sql']['datasource'] or 'template_task'}`",
        f"- sql.datasource_source: `{release['sql']['datasource_source'] or 'unknown'}`",
        "",
        "## 补数/回刷",
        "",
    ]
    if operation["mode"] in {BACKFILL_OPERATION, REPAIR_OPERATION}:
        lines.extend(
            [
                f"- backfill.start: `{backfill['start'] or 'missing'}`",
                f"- backfill.end: `{backfill['end'] or 'missing'}`",
                f"- backfill.partition_param: `{backfill['partition_param'] or '未指定'}`",
                f"- backfill.reason: `{backfill['reason'] or '未指定'}`",
                "",
                "补数执行前必须确认回刷窗口、下游影响、覆盖分区备份和业务通知；执行后至少校验行数、关键金额、主键重复、分区新鲜度和抽样口径。",
            ]
        )
    else:
        lines.append("- 当前为常规上线，不声明补数或历史回刷窗口。")
    lines.extend(
        [
            "",
            "## 验证项",
            "",
            _bullet_list(operation["validation_checks"]),
            "",
            "## 定时诉求",
            "",
        ]
    )
    if _schedule_requested(release):
        lines.extend(
            [
                f"- action: `{schedule['action']}`",
                f"- cron: `{schedule['cron'] or 'missing'}`",
                f"- timezone: `{schedule['timezone']}`",
                f"- start_time: `{schedule['start_time'] or '未指定'}`",
                f"- end_time: `{schedule['end_time'] or '未指定'}`",
                "- status: `blocked`",
                "- reason: 当前 `$ds-scheduler` gateway 尚未暴露定时创建/更新动作，不能生成可执行定时 payload。",
            ]
        )
    else:
        lines.append("- 未声明定时新增或调整；如需定时，必须等待 gateway 暴露 schedule action 后再执行。")
    lines.append("")
    return "\n".join(lines)


def _render_production_validation(release, blockers):
    lines = [
        "# DS 生产验证计划",
        "",
        f"> Ticket：`{release['ticket_id']}`",
        "",
        "## DS 侧验证",
        "",
        "1. 真实执行前先发送 `preflight/01-list-projects.payload.json` 确认 token 权限和项目可见。",
        "2. 发送 `preflight/02-get-workflow.payload.json` 和 `preflight/03-dump-workflow-graph.payload.json` 确认目标工作流、模板任务和依赖边。",
        "3. append 或 adjust 后重新 dump workflow graph，确认新增/调整节点和上游依赖符合预期。",
        "4. online 后触发 workflow，再通过 `list_instances` / `get_instance` 轮询任务状态。",
        "",
        "## SR 只读验证",
        "",
        "1. 使用 `$sr-box` 按国家执行只读校验 SQL。",
        "2. 校验目标分区新鲜度、行数、核心主键重复、关键字段空值和业务口径抽样。",
        "3. 将 DS instance id、trace、SR 查询结果写入 evidence 后再声明上线通过。",
        "",
    ]
    if release["operation"]["mode"] in {BACKFILL_OPERATION, REPAIR_OPERATION}:
        backfill = release["operation"]["backfill"]
        lines.extend(
            [
                "## 补数/回刷专项验证",
                "",
                f"- 回刷窗口：`{backfill['start'] or 'missing'}` 到 `{backfill['end'] or 'missing'}`",
                f"- 分区参数：`{backfill['partition_param'] or '未指定'}`",
                "- 回刷前：确认覆盖分区备份、下游任务暂停/依赖窗口和业务通知。",
                "- 回刷后：按分区比对行数、金额、主键重复、空值、抽样明细和下游 freshness。",
                "",
            ]
        )
    lines.extend(
        [
            "## 当前状态",
            "",
            _bullet_list(blockers) if blockers else "- dry-run payload 已生成，等待人工确认后执行。",
            "",
        ]
    )
    return "\n".join(lines)


def _render_execution_log(release, blockers):
    return "\n".join(
        [
            "# DS 发布执行日志",
            "",
            f"- ticket_id: `{release['ticket_id']}`",
            "- status: `dry_run_only`" if not blockers else "- status: `blocked`",
            "- executed: `false`",
            "",
            "## 下一步",
            "",
            "1. owner/reviewer 确认 DS 边界、上线窗口、回滚方式。",
            "2. 用调用人 DS token 执行 preflight 连通性检查。",
            "3. 连通性通过后，逐步执行 action payload。",
            "4. 触发生产验证并补充 evidence。",
            "",
        ]
    )


def _normalize_mode(value):
    text = _text(value)
    aliases = {
        "append": APPEND_MODE,
        "add": APPEND_MODE,
        "add_task": APPEND_MODE,
        "append_to_workflow": APPEND_MODE,
        "append_to_existing": APPEND_MODE,
        "adjust": ADJUST_MODE,
        "update": ADJUST_MODE,
        "replace": ADJUST_MODE,
        "replace_task": ADJUST_MODE,
        "create": CREATE_MODE,
        "new": CREATE_MODE,
        "create_workflow": CREATE_MODE,
    }
    return aliases.get(text, text)


def _normalize_task_type(value):
    text = _text(value).upper()
    aliases = {"SCRIPT": "SHELL", "COMMAND": "SHELL"}
    return aliases.get(text, text)


def _normalize_operation_mode(value):
    text = _text(value, REGULAR_OPERATION).lower()
    aliases = {
        "normal": REGULAR_OPERATION,
        "online": REGULAR_OPERATION,
        "regular_release": REGULAR_OPERATION,
        "replay": BACKFILL_OPERATION,
        "rerun": BACKFILL_OPERATION,
        "补数": BACKFILL_OPERATION,
        "回刷": BACKFILL_OPERATION,
        "fix": REPAIR_OPERATION,
        "hotfix": REPAIR_OPERATION,
        "repair_data": REPAIR_OPERATION,
        "修复": REPAIR_OPERATION,
    }
    return aliases.get(text, text)


def _schedule_requested(release):
    action = _text(release["schedule"].get("action")).lower()
    return bool(action and action not in {"none", "no", "false", "document_only"})


def _mapping(value):
    return value if isinstance(value, dict) else {}


def _text_list(value):
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def _text(value, default=""):
    if value is None:
        return default
    text = str(value).strip()
    return text if text else default


def _truthy(value):
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    return str(value).strip().lower() in {"1", "true", "yes", "y", "on", "pass"}


def _pass_fail(value):
    return "pass" if value else "fail"


def _bullet_list(items):
    if not items:
        return "- 无"
    return "\n".join(f"- {item}" for item in items)


def _write_text(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _write_json(path, payload):
    _write_text(path, json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n")


def _write_yaml(path, payload):
    _write_text(path, yaml.safe_dump(payload, allow_unicode=True, sort_keys=False))
