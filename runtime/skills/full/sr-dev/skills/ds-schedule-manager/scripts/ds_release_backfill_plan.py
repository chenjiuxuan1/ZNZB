#!/usr/bin/env python3
"""Build deterministic DS production release and backfill plans."""

import argparse
from collections.abc import Mapping
from datetime import date, timedelta
import json
from pathlib import Path
import sys

import yaml


__all__ = ["load_request", "build_plan", "main"]

COUNTRY_ALIASES = {"id": "ine"}
SUPPORTED_COUNTRIES = {"cn", "ine", "mx", "ph", "pk", "th"}
PREFLIGHT_KEYS = (
    "ddl_ready",
    "strict_mode_checked",
    "non_null_key_checked",
    "half_open_window_checked",
    "idempotent_cleanup_checked",
)
SMOKE_STATES = {"PENDING", "RUNNING", "FAILURE", "SUCCESS"}


def load_request(path: Path) -> dict:
    """Load one JSON or YAML mapping."""
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() == ".json":
        payload = json.loads(text)
    else:
        payload = yaml.safe_load(text)
    if not isinstance(payload, Mapping):
        raise ValueError("request must be a mapping")
    return dict(payload)


def _mapping(value):
    return value if isinstance(value, Mapping) else {}


def _text(value):
    if value is None:
        return ""
    return str(value).strip()


def _missing(value):
    return value is None or _text(value) == ""


def _node_codes(value):
    if not isinstance(value, list):
        return []
    return [text for text in (_text(item) for item in value) if text]


def _parse_date(value):
    if not isinstance(value, str):
        return None
    try:
        return date.fromisoformat(value.strip())
    except ValueError:
        return None


def _date_set(value):
    if not isinstance(value, list):
        return set()
    return {
        parsed
        for parsed in (_parse_date(item) for item in value)
        if parsed is not None
    }


def _positive_integer(value):
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and value > 0
    )


def _blocker(code, message):
    return {"code": code, "message": message}


def build_plan(request: dict) -> dict:
    """Return one deterministic decision plan."""
    if not isinstance(request, Mapping):
        raise ValueError("request must be a mapping")

    definition = _mapping(request.get("definition"))
    dag = _mapping(request.get("dag"))
    gateway = _mapping(request.get("gateway"))
    backfill = _mapping(request.get("backfill"))
    preflight = _mapping(request.get("preflight"))
    runtime_evidence = _mapping(request.get("runtime_evidence"))
    schedule = _mapping(request.get("schedule"))

    country = _text(request.get("country"))
    country = COUNTRY_ALIASES.get(country, country)
    required_task_codes = _node_codes(dag.get("required_task_codes"))
    selected_task_codes = _node_codes(dag.get("selected_task_codes"))
    release_state = _text(definition.get("release_state"))
    smoke_state = _text(runtime_evidence.get("smoke_state"))
    smoke_date_text = _text(backfill.get("smoke_date"))

    blockers = []
    if country not in SUPPORTED_COUNTRIES:
        blockers.append(
            _blocker(
                "INVALID_COUNTRY",
                "country 必须是 cn、ine、mx、ph、pk 或 th。",
            )
        )
    if _missing(request.get("project_code")):
        blockers.append(
            _blocker("MISSING_PROJECT_CODE", "project_code 必填。")
        )
    if _missing(request.get("workflow_code")):
        blockers.append(
            _blocker("MISSING_WORKFLOW_CODE", "workflow_code 必填。")
        )
    if _missing(definition.get("version")):
        blockers.append(
            _blocker(
                "MISSING_DEFINITION_VERSION",
                "definition.version 必填。",
            )
        )
    if release_state != "ONLINE":
        blockers.append(
            _blocker(
                "DEFINITION_NOT_ONLINE",
                "workflow definition 必须处于 ONLINE 状态。",
            )
        )
    if definition.get("global_params_checked") is not True:
        blockers.append(
            _blocker(
                "GLOBAL_PARAMS_NOT_CHECKED",
                "必须确认 workflow global params。",
            )
        )

    if not required_task_codes:
        blockers.append(
            _blocker(
                "EMPTY_REQUIRED_TASK_CODES",
                "required_task_codes 不能为空。",
            )
        )
    if not selected_task_codes:
        blockers.append(
            _blocker(
                "EMPTY_SELECTED_TASK_CODES",
                "selected_task_codes 不能为空。",
            )
        )
    if len(required_task_codes) != len(set(required_task_codes)):
        blockers.append(
            _blocker(
                "DUPLICATE_REQUIRED_TASK_CODES",
                "required_task_codes 不能包含重复节点。",
            )
        )
    if len(selected_task_codes) != len(set(selected_task_codes)):
        blockers.append(
            _blocker(
                "DUPLICATE_SELECTED_TASK_CODES",
                "selected_task_codes 不能包含重复节点。",
            )
        )
    if not set(required_task_codes).issubset(set(selected_task_codes)):
        blockers.append(
            _blocker(
                "INCOMPLETE_DAG_SELECTION",
                "selected_task_codes 必须覆盖完整必选 DAG 节点集合。",
            )
        )

    start_date = _parse_date(backfill.get("start_date"))
    end_date = _parse_date(backfill.get("end_date"))
    smoke_date = _parse_date(backfill.get("smoke_date"))
    dates_valid = (
        start_date is not None
        and end_date is not None
        and smoke_date is not None
        and start_date <= smoke_date <= end_date
    )
    if not dates_valid:
        blockers.append(
            _blocker(
                "INVALID_BACKFILL_DATES",
                "必须提供合法日期并满足 start_date <= smoke_date <= end_date。",
            )
        )
    if backfill.get("failure_stop") is not True:
        blockers.append(
            _blocker(
                "FAILURE_STOP_REQUIRED",
                "历史补数必须启用 failure_stop。",
            )
        )
    if not _positive_integer(backfill.get("poll_seconds")):
        blockers.append(
            _blocker(
                "INVALID_POLL_SECONDS",
                "poll_seconds 必须为正整数。",
            )
        )
    if not _positive_integer(backfill.get("timeout_seconds")):
        blockers.append(
            _blocker(
                "INVALID_TIMEOUT_SECONDS",
                "timeout_seconds 必须为正整数。",
            )
        )
    if any(preflight.get(key) is not True for key in PREFLIGHT_KEYS):
        blockers.append(
            _blocker(
                "PREFLIGHT_CHECK_FAILED",
                "五项发布与补数安全预检必须全部通过。",
            )
        )
    if smoke_state not in SMOKE_STATES:
        blockers.append(
            _blocker(
                "INVALID_SMOKE_STATE",
                "smoke_state 必须是 PENDING、RUNNING、FAILURE 或 SUCCESS。",
            )
        )

    if gateway.get("native_complement") is True:
        execution_mode = "native_complement"
    elif backfill.get("fallback_allowed") is True:
        execution_mode = "daily_trigger_fallback"
    else:
        execution_mode = "unavailable"
        blockers.append(
            _blocker(
                "COMPLEMENT_CAPABILITY_UNAVAILABLE",
                "原生 complement 不可用，且未允许逐业务日触发回退。",
            )
        )

    warnings = []
    if _text(gateway.get("task_depend_type")).upper() == "TASK_ONLY":
        warnings.append(
            {
                "code": "TASK_ONLY_REQUIRES_EXPLICIT_FULL_NODE_SET",
                "message": (
                    "TASK_ONLY 不会自动执行下游，"
                    "必须显式选择完整节点集合。"
                ),
            }
        )

    expected_dates = set()
    if dates_valid:
        current_date = start_date
        while current_date <= end_date:
            expected_dates.add(current_date)
            if current_date == end_date:
                break
            current_date += timedelta(days=1)
        expected_dates -= _date_set(backfill.get("skip_dates"))
    completed_dates = _date_set(runtime_evidence.get("completed_dates"))
    all_dates_completed = (
        dates_valid and expected_dates.issubset(completed_dates)
    )

    schedule_exists = schedule.get("exists") is True
    schedule_online = (
        schedule_exists
        and _text(schedule.get("release_state")) == "ONLINE"
    )
    trigger_accepted = runtime_evidence.get("trigger_accepted") is True

    preflight_blockers = list(blockers)
    if preflight_blockers:
        status = "blocked_preflight"
        success = False
    elif smoke_state == "FAILURE":
        status = "blocked_smoke_failed"
        success = False
    elif smoke_state == "RUNNING" or (
        trigger_accepted and smoke_state == "PENDING"
    ):
        status = "waiting_for_smoke_terminal"
        success = True
    elif smoke_state == "SUCCESS" and all_dates_completed:
        status = (
            "backfill_completed_schedule_online"
            if schedule_online
            else "backfill_completed_schedule_missing"
        )
        success = True
    elif smoke_state == "SUCCESS":
        status = "ready_for_backfill"
        success = True
    else:
        status = "ready_for_single_day_smoke"
        success = True

    output_blockers = list(preflight_blockers)
    if smoke_state == "FAILURE":
        output_blockers.append(
            _blocker(
                "SMOKE_FAILED",
                "单日完整链路冒烟失败，必须停止全量补数。",
            )
        )

    evidence_acceptance = {
        "SUCCESS": "passed",
        "RUNNING": "running",
        "FAILURE": "failed",
    }.get(smoke_state, "pending")
    if schedule_online:
        continuous_schedule = "passed"
    elif schedule_exists:
        continuous_schedule = "offline"
    else:
        continuous_schedule = "missing"

    acceptance = {
        "definition": (
            "passed"
            if release_state == "ONLINE"
            and definition.get("global_params_checked") is True
            else "pending"
        ),
        "workflow_instance": evidence_acceptance,
        "task_instances": evidence_acceptance,
        "data_coverage": "passed" if all_dates_completed else "pending",
        "business_result": "pending",
        "continuous_schedule": continuous_schedule,
    }

    return {
        "success": success,
        "status": status,
        "country": country,
        "execution_mode": execution_mode,
        "blockers": output_blockers,
        "warnings": warnings,
        "required_task_codes": required_task_codes,
        "selected_task_codes": selected_task_codes,
        "smoke_date": smoke_date_text,
        "mutation_confirmation_required": True,
        "acceptance": acceptance,
    }


def main(argv=None) -> int:
    """Run the side-effect-free planning CLI."""
    parser = argparse.ArgumentParser(
        description="Build a deterministic DS release and backfill plan."
    )
    parser.add_argument("request", type=Path)
    parser.add_argument("--output", type=Path)
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return int(exc.code)

    try:
        request = load_request(args.request)
        plan = build_plan(request)
        rendered = json.dumps(plan, ensure_ascii=False, indent=2) + "\n"
        if args.output:
            args.output.write_text(rendered, encoding="utf-8")
        else:
            sys.stdout.write(rendered)
    except (OSError, TypeError, ValueError, yaml.YAMLError):
        print("请求解析或计划输出失败。", file=sys.stderr)
        return 2

    return 0 if plan["success"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
