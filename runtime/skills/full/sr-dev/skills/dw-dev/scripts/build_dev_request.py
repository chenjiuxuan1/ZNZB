#!/usr/bin/env python3
"""Build a lean DW Dev request from flags and local materials."""

import argparse
import json
from pathlib import Path
import sys

import yaml


def _read_text(path):
    return Path(path).read_text(encoding="utf-8").strip()


def _read_table_mappings(path):
    if not path:
        return []
    payload = yaml.safe_load(_read_text(path))
    if isinstance(payload, dict):
        payload = payload.get("table_mappings", [])
    if not isinstance(payload, list):
        raise ValueError("table mapping file must contain a table_mappings list")
    return payload


def _material(path):
    path = Path(path)
    return {
        "path": str(path),
        "name": path.name,
        "exists": path.exists(),
        "kind": path.suffix.lstrip(".").lower() or "file",
    }


def _first_existing(*paths):
    for path in paths:
        path = Path(path)
        if path.is_file():
            return path
    return None


def _sql_package(package_dir):
    if not package_dir:
        return {}
    package_dir = Path(package_dir)
    prod_release = package_dir / "release" / "01-prod-online.sql"
    testdb_release = package_dir / "release" / "02-testdb-runnable.sql"
    execution_request = (
        package_dir / "06-execution" / "01_testdb_execution_request.json"
    )
    return {
        "root": str(package_dir),
        "prod_release": str(prod_release) if prod_release.is_file() else "",
        "testdb_release": str(testdb_release) if testdb_release.is_file() else "",
        "execution_request": str(execution_request) if execution_request.is_file() else "",
    }


def _sql_from_package(package_dir):
    if not package_dir:
        return ""
    package_dir = Path(package_dir)
    sql_path = _first_existing(
        package_dir / "release" / "02-testdb-runnable.sql",
        package_dir / "05-sql" / "04_testdb_dml.sql",
        package_dir / "05-sql" / "02_testdb_ddl.sql",
    )
    return _read_text(sql_path) if sql_path else ""


def _modeling_artifacts(args):
    artifacts = list(args.modeling_artifact)
    if args.sql_package_dir:
        package_dir = Path(args.sql_package_dir)
        for path in (
            package_dir / "04-modeling.md",
            package_dir / "05-sql" / "01_prod_ddl.sql",
            package_dir / "05-sql" / "04_testdb_dml.sql",
            package_dir / "release" / "01-prod-online.sql",
            package_dir / "release" / "02-testdb-runnable.sql",
        ):
            if path.is_file():
                artifacts.append(str(path))
    return artifacts


def _key_value_pairs(items):
    result = {}
    for item in items:
        key, sep, value = str(item).partition("=")
        key = key.strip()
        if not sep or not key:
            raise ValueError(f"invalid key=value pair: {item}")
        result[key] = value.strip()
    return result


def _release_sql_from_args(args):
    if args.ds_sql_file:
        return _read_text(args.ds_sql_file), "file"
    if args.ds_sql:
        return args.ds_sql, "inline"
    package = _sql_package(args.sql_package_dir)
    prod_release = package.get("prod_release")
    if prod_release:
        return _read_text(prod_release), "sql_package.prod_release"
    return "", ""


def _task_type(args):
    value = (args.ds_task_type or "").strip().upper()
    aliases = {"SCRIPT": "SHELL", "COMMAND": "SHELL"}
    if value:
        return aliases.get(value, value)
    if args.ds_script or args.ds_script_file:
        return "SHELL"
    if args.ds_sql or args.ds_sql_file:
        return "SQL"
    return ""


def _table_name_from_sql_path(args):
    if not args.ds_sql_file:
        return ""
    return Path(args.ds_sql_file).stem


def _release_script_from_args(args):
    if args.ds_script_file:
        return _read_text(args.ds_script_file), "file"
    if args.ds_script:
        return args.ds_script, "inline"
    if _task_type(args) == "SHELL" and args.ds_sql_file:
        table_name = args.ds_task_name or _table_name_from_sql_path(args)
        if table_name:
            return (
                f'python3 /data/web/wattrel/console.py etl --table={table_name} --args="v_start_dt=${{dt}}"',
                "workflow_sql_file",
            )
    return "", ""


def _ds_scheduler(args, route):
    if not args.ds_release:
        return {}
    sql_content, sql_source = _release_sql_from_args(args)
    script_content, script_source = _release_script_from_args(args)
    country = args.ds_country or route.get("country") or ""
    task_type = _task_type(args)
    task_name = args.ds_task_name or (
        _table_name_from_sql_path(args) if task_type == "SHELL" else ""
    )
    return {
        "enabled": True,
        "country": country,
        "project_space": {
            "name": args.ds_project_name or "",
            "code": args.ds_project_code or "",
        },
        "workflow": {
            "change_mode": args.ds_workflow_change_mode or "",
            "name": args.ds_workflow_name or "",
            "code": args.ds_workflow_code or "",
        },
        "task": {
            "type": task_type,
            "name": task_name,
            "description": args.ds_task_description or "",
            "template_task_name": args.ds_template_task_name or "",
            "upstream_task_name": args.ds_upstream_task_name or "",
            "upstream_task_code": args.ds_upstream_task_code or "",
            "existing_task_name": args.ds_existing_task_name or "",
            "existing_task_code": args.ds_existing_task_code or "",
        },
        "sql": {
            "source": sql_source,
            "content": sql_content,
            "sql_type": args.ds_sql_type or "",
            "sql_type_source": "explicit" if args.ds_sql_type else "warehouse_dev_default",
            "datasource": args.ds_datasource or "",
            "datasource_source": "explicit"
            if args.ds_datasource
            else (
                "template_task"
                if task_type == "SQL" and args.ds_template_task_name
                else ""
            ),
        },
        "script": {
            "source": script_source,
            "content": script_content,
        },
        "operation": {
            "mode": args.ds_operation_mode or "regular",
            "backfill": {
                "start": args.ds_backfill_start or "",
                "end": args.ds_backfill_end or "",
                "partition_param": args.ds_backfill_param or "",
                "reason": args.ds_backfill_reason or "",
            },
            "validation_checks": args.ds_validation_check,
        },
        "schedule": {
            "action": args.ds_schedule_action or "",
            "cron": args.ds_schedule_cron or "",
            "timezone": args.ds_schedule_timezone or "Asia/Shanghai",
            "start_time": args.ds_schedule_start_time or "",
            "end_time": args.ds_schedule_end_time or "",
        },
        "runtime_params": {
            "custom_params": _key_value_pairs(args.ds_custom_param),
            "schedule_time": args.ds_schedule_time or "",
            "start_node_list": args.ds_start_node_list or "",
        },
        "release_controls": {
            "online_workflow": bool(args.ds_online_workflow),
            "trigger_workflow": bool(args.ds_trigger_workflow),
            "restore_original_state": bool(args.ds_restore_original_state),
            "auto_offline": bool(args.ds_auto_offline),
        },
        "preflight": {
            "ds_scheduler_skill_path": args.ds_skill_path or "",
            "token_config_path": args.ds_token_config or "",
            "webhook_url": args.ds_webhook_url or "",
        },
    }


def _parse_jira_reference(value):
    key, sep, source = str(value).partition("=")
    key = key.strip()
    source = source.strip()
    if not sep or not key:
        raise ValueError(f"invalid jira reference, expected KEY=url: {value}")
    return {
        "id": key,
        "kind": "jira",
        "source": source,
        "summary": f"{key} Jira reference",
    }


def _parse_reference(value):
    parts = [part.strip() for part in str(value).split("|", 3)]
    if len(parts) != 4 or not parts[0]:
        raise ValueError("invalid reference, expected id|kind|source|summary")
    return {
        "id": parts[0],
        "kind": parts[1] or "source",
        "source": parts[2],
        "summary": parts[3],
    }


def _context_status(args, missing_questions, system_validation_sql, modeling_artifacts, sql_package):
    if missing_questions:
        return "needs_clarification"
    if args.context_status:
        return args.context_status
    if system_validation_sql:
        return "ready_for_sr_box_execution"
    if modeling_artifacts or sql_package:
        return "ready_for_sql_builder"
    return "ready_for_modeling"


def build_request(args):
    route = {}
    if args.country:
        route["country"] = args.country
    if args.datasource:
        route["datasource"] = args.datasource

    source_materials = [_material(path) for path in args.material]
    if args.sql_package_dir:
        source_materials.append(_material(args.sql_package_dir))

    system_validation_sql = args.system_validation_sql or args.validation_sql or ""
    if args.system_validation_sql_file:
        system_validation_sql = _read_text(args.system_validation_sql_file)
    elif args.validation_sql_file:
        system_validation_sql = _read_text(args.validation_sql_file)
    if not system_validation_sql:
        system_validation_sql = _sql_from_package(args.sql_package_dir)
    user_validation_sql = args.user_validation_sql or ""
    if args.user_validation_sql_file:
        user_validation_sql = _read_text(args.user_validation_sql_file)
    table_mappings = _read_table_mappings(args.table_mapping_file)

    missing_questions = []
    if not route:
        missing_questions.append("请补充 route.country 或 route.datasource。")

    sql_package = _sql_package(args.sql_package_dir)
    modeling_artifacts = _modeling_artifacts(args)
    context_status = _context_status(
        args,
        missing_questions,
        system_validation_sql,
        modeling_artifacts,
        sql_package,
    )

    jira_entries = [_parse_jira_reference(item) for item in args.jira_reference]
    other_entries = [_parse_reference(item) for item in args.reference]
    reference_appendix = jira_entries + other_entries

    source_references = [item["path"] for item in source_materials]
    source_references.extend(entry["source"] for entry in reference_appendix)
    source_references.extend(args.dw_knowledge_doc)
    source_references.extend(args.dw_knowledge_recall)

    request = {
        "ticket_id": args.ticket_id,
        "summary": args.summary or args.title or "Warehouse development request from local materials.",
        "title": args.title or args.summary or args.ticket_id,
        "route": route,
        "risk_level": args.risk_level,
        "owner": args.owner,
        "context": {
            "status": context_status,
            "confidence": "medium" if not missing_questions else "low",
            "source_references": source_references,
            "user_inputs": args.user_input,
            "indexed_queries": args.indexed_query,
            "dw_knowledge_documents": args.dw_knowledge_doc,
            "dw_knowledge_recalls": args.dw_knowledge_recall,
            "dw_code_evidence": args.dw_code_evidence,
            "facts": args.known_fact,
            "open_questions": args.open_question,
            "clarification_questions": missing_questions,
        },
        "query_spec": {
            "country": args.country or "",
            "datasource": args.datasource or "",
            "business_domain": args.business_domain,
            "canonical_table": args.canonical_table or "",
            "target": args.target or "",
            "grain": args.grain or "",
            "freshness": args.freshness or "",
            "default_filters": args.default_filter,
        },
        "development": {
            "change_summary": args.change_summary or args.summary or "",
            "affected_assets": args.affected_asset,
            "lineage": args.lineage,
            "impact_scope": args.impact_scope,
            "source_materials": source_materials,
            "modeling_artifacts": modeling_artifacts,
        },
        "reference_appendix": reference_appendix,
    }
    if sql_package:
        request["development"]["sql_package"] = sql_package
    ds_scheduler = _ds_scheduler(args, route)
    if ds_scheduler:
        request["ds_scheduler"] = ds_scheduler

    if system_validation_sql:
        request["sql"] = {
            "validation": system_validation_sql,
            "system_validation": system_validation_sql,
            "user_validation": user_validation_sql,
            "table_mappings": table_mappings,
        }
    if missing_questions:
        request["missing_questions"] = missing_questions
    return request


def write_request(request, output):
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.suffix.lower() == ".json":
        output.write_text(
            json.dumps(request, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    else:
        output.write_text(
            yaml.safe_dump(request, allow_unicode=True, sort_keys=False),
            encoding="utf-8",
        )
    return output


def main(argv=None):
    parser = argparse.ArgumentParser(description="Build a lean DW Dev request.")
    parser.add_argument("--ticket-id", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--country")
    parser.add_argument("--datasource")
    parser.add_argument("--title")
    parser.add_argument("--summary")
    parser.add_argument("--business-domain", default="unknown")
    parser.add_argument("--target")
    parser.add_argument("--grain")
    parser.add_argument("--canonical-table")
    parser.add_argument("--freshness")
    parser.add_argument("--risk-level", default="medium")
    parser.add_argument("--owner", default="owenzhang")
    parser.add_argument("--context-status")
    parser.add_argument("--material", action="append", default=[])
    parser.add_argument("--user-input", action="append", default=[])
    parser.add_argument("--indexed-query", action="append", default=[])
    parser.add_argument("--jira-reference", action="append", default=[])
    parser.add_argument("--dw-knowledge-doc", action="append", default=[])
    parser.add_argument("--dw-knowledge-recall", action="append", default=[])
    parser.add_argument("--dw-code-evidence", action="append", default=[])
    parser.add_argument("--known-fact", action="append", default=[])
    parser.add_argument("--open-question", action="append", default=[])
    parser.add_argument("--reference", action="append", default=[])
    parser.add_argument("--validation-sql")
    parser.add_argument("--validation-sql-file")
    parser.add_argument("--system-validation-sql")
    parser.add_argument("--system-validation-sql-file")
    parser.add_argument("--user-validation-sql")
    parser.add_argument("--user-validation-sql-file")
    parser.add_argument("--table-mapping-file")
    parser.add_argument("--sql-package-dir")
    parser.add_argument("--change-summary")
    parser.add_argument("--affected-asset", action="append", default=[])
    parser.add_argument("--lineage", action="append", default=[])
    parser.add_argument("--impact-scope", action="append", default=[])
    parser.add_argument("--default-filter", action="append", default=[])
    parser.add_argument("--modeling-artifact", action="append", default=[])
    parser.add_argument("--ds-release", action="store_true")
    parser.add_argument("--ds-country")
    parser.add_argument("--ds-project-code")
    parser.add_argument("--ds-project-name")
    parser.add_argument("--ds-workflow-code")
    parser.add_argument("--ds-workflow-name")
    parser.add_argument("--ds-workflow-change-mode")
    parser.add_argument("--ds-task-type")
    parser.add_argument("--ds-task-name")
    parser.add_argument("--ds-task-description")
    parser.add_argument("--ds-template-task-name")
    parser.add_argument("--ds-upstream-task-name")
    parser.add_argument("--ds-upstream-task-code")
    parser.add_argument("--ds-existing-task-name")
    parser.add_argument("--ds-existing-task-code")
    parser.add_argument("--ds-sql")
    parser.add_argument("--ds-sql-file")
    parser.add_argument("--ds-sql-type")
    parser.add_argument("--ds-datasource")
    parser.add_argument("--ds-script")
    parser.add_argument("--ds-script-file")
    parser.add_argument("--ds-operation-mode")
    parser.add_argument("--ds-backfill-start")
    parser.add_argument("--ds-backfill-end")
    parser.add_argument("--ds-backfill-param")
    parser.add_argument("--ds-backfill-reason")
    parser.add_argument("--ds-validation-check", action="append", default=[])
    parser.add_argument("--ds-schedule-action")
    parser.add_argument("--ds-schedule-cron")
    parser.add_argument("--ds-schedule-timezone")
    parser.add_argument("--ds-schedule-start-time")
    parser.add_argument("--ds-schedule-end-time")
    parser.add_argument("--ds-custom-param", action="append", default=[])
    parser.add_argument("--ds-schedule-time")
    parser.add_argument("--ds-start-node-list")
    parser.add_argument("--ds-online-workflow", action="store_true")
    parser.add_argument("--ds-trigger-workflow", action="store_true")
    parser.add_argument("--ds-restore-original-state", action="store_true")
    parser.add_argument("--ds-auto-offline", action="store_true")
    parser.add_argument("--ds-skill-path")
    parser.add_argument("--ds-token-config")
    parser.add_argument("--ds-webhook-url")
    args = parser.parse_args(argv)

    request = build_request(args)
    output = write_request(request, args.output)
    print(
        json.dumps(
            {
                "success": True,
                "output": str(output),
                "status": request["context"]["status"],
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
