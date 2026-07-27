#!/usr/bin/env python3
import argparse
import json
import re
import shutil
import sys
from pathlib import Path

import yaml


CONTEXT_PRIORITY = [
    ("用户输入", "user_inputs"),
    ("索引查询", "indexed_queries"),
    ("$dw-knowledge 文档", "dw_knowledge_documents"),
    ("$dw-knowledge 召回", "dw_knowledge_recalls"),
    ("$dw-code-knowledge", "dw_code_evidence"),
]


class WarehouseDevInputError(ValueError):
    """Raised when a DW Dev request cannot be orchestrated safely."""


def orchestrate_dev(request, output_dir, reviewed_at=None):
    del reviewed_at
    if not isinstance(request, dict):
        raise WarehouseDevInputError("dev request must be a mapping")

    ticket_id = _ticket_id(request)
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    context = _mapping(request.get("context"))
    query_spec = _mapping(request.get("query_spec"))
    route = _mapping(request.get("route"))
    validation_sql = _validation_sql(request)
    user_validation_sql = _user_validation_sql(request)
    table_mappings = _table_mappings(request)

    _write_core_workspace(request, output_dir, query_spec)

    if _needs_clarification(request, context, query_spec, route):
        questions = _clarification_questions(request, context, query_spec, route)
        _write_text(
            output_dir / "需求文档" / "02-补问.md",
            _render_clarification(ticket_id, questions),
        )
        return _summary(ticket_id, "needs_clarification", output_dir)

    _write_text(
        output_dir / "协作请求" / "dw-modeling-协作请求.yaml",
        yaml.safe_dump(
            _modeling_handoff(request, query_spec, route),
            allow_unicode=True,
            sort_keys=False,
        ),
    )

    if _sql_builder_ready(request):
        _write_text(
            output_dir / "协作请求" / "dw-sql-builder-协作请求.yaml",
            yaml.safe_dump(
                _sql_builder_handoff(request, query_spec, route),
                allow_unicode=True,
                sort_keys=False,
            ),
        )

    if not validation_sql:
        status = "ready_for_sql_builder" if _sql_builder_ready(request) else "ready_for_modeling"
        return _summary(ticket_id, status, output_dir)

    _write_text(
        output_dir / "test闭环sql" / "01-系统验证.sql",
        validation_sql.strip() + "\n",
    )

    if table_mappings:
        _write_text(
            output_dir / "test闭环sql" / "00-生产-testdb表映射.yaml",
            yaml.safe_dump(
                {
                    "version": 1,
                    "author": "owenzhang",
                    "table_mappings": table_mappings,
                },
                allow_unicode=True,
                sort_keys=False,
            ),
        )
    if user_validation_sql:
        _write_text(
            output_dir / "test闭环sql" / "02-用户验收.sql",
            user_validation_sql.strip() + "\n",
        )

    blocker = _validation_write_blocker(validation_sql)
    if blocker:
        _write_text(
            output_dir / "协作请求" / "sr-box-阻断说明.md",
            _render_sr_box_blocker(ticket_id, blocker, validation_sql),
        )
        return _summary(ticket_id, "blocked_testdb_guardrail", output_dir)

    contract_blocker = _validation_contract_blocker(
        validation_sql,
        user_validation_sql,
        table_mappings,
    )
    if contract_blocker:
        _write_text(
            output_dir / "协作请求" / "SQL验收契约阻断说明.md",
            _render_validation_contract_blocker(ticket_id, contract_blocker),
        )
        return _summary(ticket_id, "blocked_validation_contract", output_dir)

    _write_text(
        output_dir / "协作请求" / "sr-box-执行请求.json",
        json.dumps(
            _sr_box_request(request, output_dir, route, validation_sql),
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        )
        + "\n",
    )

    if _ds_scheduler_enabled(request):
        _write_text(
            output_dir / "调度上线" / "01-ds-scheduler-协作请求.yaml",
            yaml.safe_dump(
                _ds_scheduler_handoff(request),
                allow_unicode=True,
                sort_keys=False,
            ),
        )

    execution_result = _mapping(request.get("execution_result"))
    if not execution_result:
        return _summary(ticket_id, "ready_for_sr_box_execution", output_dir)

    _write_text(
        output_dir / "验收结果" / "01-sr-box-执行结果.md",
        _render_execution_evidence(validation_sql, execution_result),
    )

    if execution_result.get("success") is not True:
        return _summary(ticket_id, "validation_failed", output_dir)

    return _summary(ticket_id, "accepted_testdb_validation", output_dir)


def load_request(path):
    path = Path(path)
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() == ".json":
        payload = json.loads(text)
    else:
        payload = yaml.safe_load(text)
    if payload is None:
        payload = {}
    if not isinstance(payload, dict):
        raise WarehouseDevInputError("dev request must be a mapping")
    return payload


def print_json(payload, stream=None):
    stream = stream or sys.stdout
    print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True), file=stream)


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Orchestrate a lean DW Dev workspace."
    )
    parser.add_argument("request", type=Path, help="DW Dev request YAML or JSON")
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument(
        "--reviewed-at",
        help="Accepted for compatibility; this skill does not run embedded downstream checks.",
    )
    args = parser.parse_args(argv)

    try:
        result = orchestrate_dev(
            load_request(args.request),
            args.output_dir,
            reviewed_at=args.reviewed_at,
        )
    except (
        WarehouseDevInputError,
        OSError,
        json.JSONDecodeError,
        yaml.YAMLError,
        ValueError,
    ) as exc:
        print_json(
            {
                "success": False,
                "errorType": type(exc).__name__,
                "message": str(exc),
            },
            stream=sys.stderr,
        )
        return 2

    print_json(result)
    return 0 if result["success"] else 1


def _write_core_workspace(request, output_dir, query_spec):
    _write_raw_workspace(request, output_dir)
    _write_qa_workspace(request, output_dir)
    _write_delivery_workspace(request, output_dir)
    _write_text(
        output_dir / "需求文档" / "00-需求摘要.md",
        _render_requirement_summary(request, query_spec),
    )
    _write_text(
        output_dir / "需求文档" / "01-输入来源索引.md",
        _render_source_index(request),
    )
    _write_text(
        output_dir / "上下文" / "01-上下文优先级.md",
        _render_context_priority(request),
    )
    _write_reference_appendix(request, output_dir)
    _write_text(
        output_dir / "开发计划" / "01-开发计划.md",
        _render_task_plan(request, query_spec),
    )


def _write_raw_workspace(request, output_dir):
    _write_text(
        output_dir / "原始资料" / "00-原始提问.md",
        _render_original_question(request),
    )
    material_rows = []
    for entry in _raw_material_entries(request):
        material_rows.append(_verify_and_archive_raw_material(entry, output_dir))
    _write_text(
        output_dir / "原始资料" / "01-资料收纳清单.md",
        _render_raw_material_index(material_rows),
    )


def _write_qa_workspace(request, output_dir):
    _write_text(
        output_dir / "QA" / "00-需求QA记录.md",
        _render_qa_records(request),
    )


def _write_delivery_workspace(request, output_dir):
    _write_text(
        output_dir / "交付文档" / "00-交付清单.md",
        _render_delivery_index(request),
    )


def _ticket_id(request):
    value = request.get("ticket_id")
    if isinstance(value, str) and value.strip():
        return value.strip()
    return "UNKNOWN"


def _mapping(value):
    return value if isinstance(value, dict) else {}


def _text(value, default=""):
    if value is None:
        return default
    text = str(value).strip()
    return text if text else default


def _text_list(value):
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def _validation_sql(request):
    sql = request.get("sql")
    if isinstance(sql, dict):
        return _text(sql.get("system_validation"), _text(sql.get("validation")))
    return _text(request.get("validation_sql"), _text(sql))


def _user_validation_sql(request):
    sql = request.get("sql")
    if isinstance(sql, dict):
        return _text(sql.get("user_validation"))
    return _text(request.get("user_validation_sql"))


def _table_mappings(request):
    sql = request.get("sql")
    mappings = sql.get("table_mappings") if isinstance(sql, dict) else None
    if mappings is None:
        mappings = request.get("table_mappings")
    return mappings if isinstance(mappings, list) else []


def _needs_clarification(request, context, query_spec, route):
    status = _text(context.get("status")).lower()
    if status in {"needs_clarification", "semantic_miss", "blocked", "blocked_needs_input"}:
        return True
    if _text_list(context.get("clarification_questions")):
        return True
    if _text_list(context.get("blockers")):
        return True
    if _text_list(request.get("missing_questions")):
        return True
    if not query_spec:
        return True
    if not route or not (_text(route.get("country")) or _text(route.get("datasource"))):
        return True
    return False


def _clarification_questions(request, context, query_spec, route):
    questions = _text_list(context.get("clarification_questions"))
    if questions:
        return questions
    blockers = _text_list(context.get("blockers"))
    if blockers:
        return blockers
    missing = _text_list(request.get("missing_questions"))
    if missing:
        return missing
    if not query_spec:
        missing.append("请补充 query_spec；当前不能确认业务域、粒度、目标层级或输出路由。")
    if not route or not (_text(route.get("country")) or _text(route.get("datasource"))):
        missing.append("请补充 route.country 或 route.datasource。")
    return missing or ["请补充可进入建模的需求上下文后再继续。"]


def _render_clarification(ticket_id, questions):
    lines = [
        "# DEV 补问",
        "",
        f"> Ticket：`{ticket_id}`",
        "",
        "当前信息不足，`$dw-dev` 会停止在补问阶段，不会生成下游协作请求、不会执行 SQL、不会回写外部系统。",
        "",
        "## 需要补充",
        "",
    ]
    lines.extend(f"{index}. {question}" for index, question in enumerate(questions, 1))
    lines.append("")
    return "\n".join(lines)


def _render_requirement_summary(request, query_spec):
    route = _mapping(request.get("route"))
    context = _mapping(request.get("context"))
    return "\n".join(
        [
            "# 需求摘要",
            "",
            f"- ticket_id: `{_ticket_id(request)}`",
            f"- owner: `{_text(request.get('owner'), 'owenzhang')}`",
            f"- summary: {_text(request.get('summary'), _text(request.get('title'), '待补充'))}",
            f"- route.country: `{_text(route.get('country'), 'unknown')}`",
            f"- route.datasource: `{_text(route.get('datasource'), 'unknown')}`",
            f"- business_domain: `{_text(query_spec.get('business_domain'), 'unknown')}`",
            f"- target: `{_text(query_spec.get('target'), _text(query_spec.get('canonical_table'), 'unknown'))}`",
            f"- grain: `{_text(query_spec.get('grain'), 'unknown')}`",
            f"- context.status: `{_text(context.get('status'), 'unknown')}`",
            f"- confidence: `{_text(context.get('confidence'), 'unknown')}`",
            "",
            "## 已知事实",
            "",
            _bullet_list(_context_items(context, "facts")),
            "",
            "## 待确认",
            "",
            _bullet_list(_context_items(context, "open_questions")),
            "",
        ]
    )


def _render_source_index(request):
    context = _mapping(request.get("context"))
    development = _mapping(request.get("development"))
    materials = development.get("source_materials")
    material_lines = []
    if isinstance(materials, list):
        for item in materials:
            if isinstance(item, dict):
                material_lines.append(
                    f"{_text(item.get('path'), _text(item.get('name'), 'unknown'))} "
                    f"(exists={bool(item.get('exists'))}, kind={_text(item.get('kind'), 'file')})"
                )
    return "\n".join(
        [
            "# 输入来源索引",
            "",
            "## 用户输入",
            "",
            _bullet_list(_context_items(context, "user_inputs")),
            "",
            "## Jira / 文档 / 链接",
            "",
            _bullet_list(_source_references(request)),
            "",
            "## 本地材料",
            "",
            _bullet_list(material_lines),
            "",
            "## 边界",
            "",
            "- 链接、截图或外部看板只有在已读取或用户明确提供内容后才可作为事实。",
            "- 当前 skill 只组织来源与协作请求，不替代 Codex 或 Claude Code 的分析判断。",
            "",
        ]
    )


def _render_original_question(request):
    context = _mapping(request.get("context"))
    user_inputs = _context_items(context, "user_inputs")
    return "\n".join(
        [
            "# 原始提问",
            "",
            f"- ticket_id: `{_ticket_id(request)}`",
            f"- owner: `{_text(request.get('owner'), 'owenzhang')}`",
            f"- summary: {_text(request.get('summary'), _text(request.get('title'), '待补充'))}",
            "",
            "## 用户原始输入",
            "",
            _bullet_list(user_inputs),
            "",
            "## 当前处理原则",
            "",
            "- 后续每一次补充资料、截图、链接、SQL、口径调整或验收反馈都必须进入 `原始资料/01-资料收纳清单.md`。",
            "- 截图或本地文件必须先验证可读或已复制到 `原始资料/files/`，再进入上下文或交付判断。",
            "- 本文件记录最初问题；需求调整记录到 `QA/00-需求QA记录.md` 和 `交付文档/00-交付清单.md`。",
            "",
        ]
    )


def _raw_material_entries(request):
    entries = []
    raw_materials = request.get("raw_materials")
    if isinstance(raw_materials, list):
        entries.extend(item for item in raw_materials if isinstance(item, dict))

    development = _mapping(request.get("development"))
    materials = development.get("source_materials")
    if isinstance(materials, list):
        for index, item in enumerate(materials, 1):
            if not isinstance(item, dict):
                continue
            entry = dict(item)
            entry.setdefault("id", f"material-{index:02d}")
            entry.setdefault("source", _text(item.get("path"), _text(item.get("source"))))
            entry.setdefault("summary", _text(item.get("name"), "本地补充资料"))
            entries.append(entry)
    return entries


def _verify_and_archive_raw_material(entry, output_dir):
    item_id = _text(entry.get("id"), _safe_name(entry.get("summary")) or "material")
    kind = _text(entry.get("kind"), "source")
    source = _text(entry.get("source"), _text(entry.get("path")))
    summary = _text(entry.get("summary"), "待补充")
    captured_at = _text(entry.get("captured_at"), "未记录")
    status = "已记录，待人工补充内容"
    stored_path = ""

    if source and _is_url(source):
        status = "已记录链接，需实际读取后才能作为事实"
    elif source:
        source_path = Path(source).expanduser()
        if source_path.is_file():
            files_dir = Path(output_dir) / "原始资料" / "files"
            files_dir.mkdir(parents=True, exist_ok=True)
            target = files_dir / _safe_filename(source_path.name)
            if source_path.resolve() != target.resolve():
                shutil.copy2(source_path, target)
            stored_path = target.relative_to(output_dir).as_posix()
            status = "已验证并收纳"
        elif source_path.is_dir():
            status = "已验证目录，未复制目录内容"
        else:
            status = "未找到本地文件，作为阻断来源记录"

    explicit_status = _text(entry.get("status"))
    if explicit_status:
        status = explicit_status

    return {
        "id": item_id,
        "kind": kind,
        "source": source,
        "summary": summary,
        "captured_at": captured_at,
        "status": status,
        "stored_path": stored_path,
    }


def _render_raw_material_index(rows):
    lines = [
        "# 资料收纳清单",
        "",
        "所有补充资料先进入这里；未验证或不可读的资料只能作为阻断或待确认来源，不能升级为既定事实。",
        "",
    ]
    if not rows:
        lines.extend(["- 待补充", ""])
        return "\n".join(lines)
    for row in rows:
        lines.extend(
            [
                f"## {row['id']}",
                "",
                f"- kind: `{row['kind']}`",
                f"- source: {row['source'] or '待补充'}",
                f"- summary: {row['summary']}",
                f"- captured_at: `{row['captured_at']}`",
                f"- status: {row['status']}",
                f"- stored_path: `{row['stored_path'] or '未复制'}`",
                "",
            ]
        )
    return "\n".join(lines)


def _render_qa_records(request):
    context = _mapping(request.get("context"))
    records = request.get("qa_records")
    if not isinstance(records, list):
        records = []

    lines = [
        "# 需求 QA 记录",
        "",
        "每次补问、口径确认、需求调整、验收反馈都追加或更新到这里；结论需要写明来源和状态。",
        "",
    ]
    if not records:
        lines.extend(["## 记录", "", "- 待补充", ""])
    for index, record in enumerate(records, 1):
        if not isinstance(record, dict):
            continue
        lines.extend(
            [
                f"## Q{index}",
                "",
                f"- question: {_text(record.get('question'), '待补充')}",
                f"- answer: {_text(record.get('answer'), '待补充')}",
                f"- source: {_text(record.get('source'), '待补充')}",
                f"- status: `{_text(record.get('status'), 'pending')}`",
                f"- recorded_at: `{_text(record.get('recorded_at'), '未记录')}`",
                "",
            ]
        )

    lines.extend(
        [
            "## 当前待确认",
            "",
            _bullet_list(_context_items(context, "open_questions")),
            "",
        ]
    )
    return "\n".join(lines)


def _render_delivery_index(request):
    delivery = _mapping(request.get("delivery"))
    execution_result = _mapping(request.get("execution_result"))
    lines = [
        "# 交付清单",
        "",
        "本目录固定保存对外交付信息。需求调整后，以本文件的最新内容为准，旧交付描述必须被覆盖。",
        "",
        f"- ticket_id: `{_ticket_id(request)}`",
        f"- owner: `{_text(request.get('owner'), 'owenzhang')}`",
        "",
        "## 实际上线交付清单",
        "",
        _bullet_list(_text_list(delivery.get("checklist"))),
        "",
        "## 上线或发布材料",
        "",
        _bullet_list(_text_list(delivery.get("release_items"))),
        "",
        "## 验收结果",
        "",
        _bullet_list(_delivery_acceptance_items(delivery, execution_result)),
        "",
        "## 边界",
        "",
        "- 没有真实执行结果时，本文件只能表示交付准备状态。",
        "- `$sr-box` 执行证据仍以 `验收结果/01-sr-box-执行结果.md` 为准。",
        "- DS 上线、Jira 回写和外部发布仍需用户确认。",
        "",
    ]
    return "\n".join(lines)


def _delivery_acceptance_items(delivery, execution_result):
    items = _text_list(delivery.get("acceptance"))
    if execution_result:
        success = execution_result.get("success")
        trace_id = _text(execution_result.get("trace_id"))
        row_count = _text(execution_result.get("row_count"))
        summary = f"$sr-box execution success={success}"
        if trace_id:
            summary += f", trace_id={trace_id}"
        if row_count:
            summary += f", row_count={row_count}"
        items.append(summary)
    return items


def _render_context_priority(request):
    context = _mapping(request.get("context"))
    lines = [
        "# 上下文优先级",
        "",
        "同一事实冲突时按以下顺序取信；低优先级只能补充，不能覆盖高优先级。",
        "",
    ]
    for index, (label, key) in enumerate(CONTEXT_PRIORITY, 1):
        lines.extend([f"## {index}. {label}", "", _bullet_list(_context_items(context, key)), ""])
    lines.extend(
        [
            "## 既定事实和阻断",
            "",
            _bullet_list(_context_items(context, "facts")),
            "",
            "## 待确认问题",
            "",
            _bullet_list(_context_items(context, "open_questions")),
            "",
        ]
    )
    return "\n".join(lines)


def _render_task_plan(request, query_spec):
    development = _mapping(request.get("development"))
    route = _mapping(request.get("route"))
    time_range = _mapping(query_spec.get("time_range"))
    return "\n".join(
        [
            "# 数仓开发编排计划",
            "",
            f"- ticket_id: `{_ticket_id(request)}`",
            f"- route.country: `{_text(route.get('country'), 'unknown')}`",
            f"- route.datasource: `{_text(route.get('datasource'), 'unknown')}`",
            f"- business_domain: `{_text(query_spec.get('business_domain'), 'unknown')}`",
            f"- target: `{_text(query_spec.get('target'), _text(query_spec.get('canonical_table'), 'unknown'))}`",
            f"- grain: `{_text(query_spec.get('grain'), 'unknown')}`",
            f"- time_window: `{_text(time_range.get('start_date'), 'unknown')}..{_text(time_range.get('end_date'), 'unknown')}`",
            "",
            "## 开发影响范围",
            "",
            _bullet_list(_text_list(development.get("impact_scope"))),
            "",
            "## 血缘与依赖",
            "",
            _bullet_list(_text_list(development.get("lineage"))),
            "",
            "## 受影响资产",
            "",
            _bullet_list(_text_list(development.get("affected_assets"))),
            "",
            "## 协作顺序",
            "",
            "1. 由 Codex 或 Claude Code 读取本工作区，先调用 `$dw-modeling` 完成粒度、分层、复用和缺口判断。",
            "2. 建模结论清楚后调用 `$dw-sql-builder` 编写或调整 SQL package。",
            "3. 只有存在 `testdb.*` 验证 SQL 时，才生成 `$sr-box` 执行请求。",
            "4. 只有用户明确要求调度或执行变更时，才生成 `$ds-scheduler` 协作请求。",
            "",
            "## 风险和确认点",
            "",
            "- `testdb` 验证成功不等于生产上线。",
            "- 未经人工确认不执行生产 DDL/DML、DS 上线、Jira 回写或外部发送。",
            "- 评审、交付、Jira 写入和发布材料只在用户显式要求时由原生智能体协调。",
            "",
        ]
    )


def _write_reference_appendix(request, output_dir):
    entries = _reference_entries(request)
    context = _mapping(request.get("context"))
    index_lines = ["# 参考资料来源索引", ""]
    if not entries:
        index_lines.append("- 待补充")
    for entry in entries:
        item_id = _text(entry.get("id"), "unknown")
        kind = _text(entry.get("kind"), "source")
        source = _text(entry.get("source"), item_id)
        summary = _text(entry.get("summary"), "待补充")
        index_lines.append(f"- `{item_id}` [{kind}] {source}：{summary}")
        filename = f"{_safe_name(kind)}-{_safe_name(item_id)}.md"
        _write_text(
            output_dir / "参考资料" / filename,
            _render_reference_entry(entry),
        )
    index_lines.extend(
        [
            "",
            "## 已知事实",
            "",
            _bullet_list(_context_items(context, "facts")),
            "",
            "## 待确认",
            "",
            _bullet_list(_context_items(context, "open_questions")),
            "",
        ]
    )
    _write_text(output_dir / "参考资料" / "00-来源索引.md", "\n".join(index_lines))


def _render_reference_entry(entry):
    return "\n".join(
        [
            f"# {_text(entry.get('id'), '参考资料')}",
            "",
            f"- kind: `{_text(entry.get('kind'), 'source')}`",
            f"- source: {_text(entry.get('source'), 'unknown')}",
            f"- summary: {_text(entry.get('summary'), '待补充')}",
            "",
            "## 边界",
            "",
            "- 本文件只记录来源和摘要；未读取的外部内容不得被升级为既定事实。",
            "",
        ]
    )


def _modeling_handoff(request, query_spec, route):
    context = _mapping(request.get("context"))
    development = _mapping(request.get("development"))
    return {
        "type": "dw-dev handoff",
        "target_skill": "$dw-modeling",
        "native_agent": "Codex or Claude Code",
        "ticket_id": _ticket_id(request),
        "route": route,
        "query_spec": query_spec,
        "known_facts": _context_items(context, "facts"),
        "open_questions": _context_items(context, "open_questions"),
        "affected_assets": _text_list(development.get("affected_assets")),
        "context_priority": [label for label, _key in CONTEXT_PRIORITY],
        "reference_index": "参考资料/00-来源索引.md",
        "expected_output": [
            "建模粒度、分层、主键、刷新频率和复用判断",
            "知识缺口和阻断项",
            "交给 $dw-sql-builder 的建模交接",
        ],
    }


def _sql_builder_handoff(request, query_spec, route):
    development = _mapping(request.get("development"))
    return {
        "type": "dw-dev handoff",
        "target_skill": "$dw-sql-builder",
        "native_agent": "Codex or Claude Code",
        "ticket_id": _ticket_id(request),
        "route": route,
        "query_spec": query_spec,
        "modeling_artifacts": _text_list(development.get("modeling_artifacts")),
        "sql_package": _mapping(development.get("sql_package")),
        "reference_index": "参考资料/00-来源索引.md",
        "expected_output": [
            "DDL/DML/ETL 草稿",
            "testdb 可执行 SQL",
            "生产 SQL 草稿",
            "SQL package 索引",
        ],
    }


def _sql_builder_ready(request):
    context = _mapping(request.get("context"))
    development = _mapping(request.get("development"))
    status = _text(context.get("status")).lower()
    if status in {"ready_for_sql_builder", "ready_for_execution", "ready_for_sr_box_execution"}:
        return True
    if _text_list(development.get("modeling_artifacts")):
        return True
    if _mapping(development.get("sql_package")):
        return True
    return False


def _source_references(request):
    context = _mapping(request.get("context"))
    entries = list(_text_list(context.get("source_references")))
    for entry in _reference_entries(request):
        source = _text(entry.get("source"))
        if source:
            entries.append(source)
    return _unique(entries)


def _reference_entries(request):
    value = request.get("reference_appendix")
    return [entry for entry in value if isinstance(entry, dict)] if isinstance(value, list) else []


def _context_items(context, key):
    return _text_list(context.get(key))


def _validation_write_blocker(sql):
    statements = [part.strip() for part in sql.split(";") if part.strip()]
    for statement in statements:
        target = _mutation_target(statement)
        if target is None:
            continue
        if not target.lower().startswith("testdb."):
            return {
                "code": "NON_TESTDB_WRITE_BLOCKED",
                "target": target,
                "message": "验证 SQL 的写目标必须显式位于 testdb.*。",
            }
    return {}


def _validation_contract_blocker(system_sql, user_sql, table_mappings):
    if not user_sql:
        return {
            "code": "MISSING_USER_VALIDATION_SQL",
            "message": "缺少用户验收 SQL；必须提供可直接执行并能看到结果的只读查询。",
        }
    if not table_mappings:
        return {
            "code": "MISSING_TABLE_MAPPING",
            "message": "缺少生产表与 testdb 表一一对应关系。",
        }

    for statement in _sql_statements(user_sql):
        keyword = _first_sql_keyword(statement)
        if keyword not in {"select", "with", "show", "desc", "describe", "explain"}:
            return {
                "code": "USER_VALIDATION_NOT_READ_ONLY",
                "message": "用户验收 SQL 必须只读，只允许 SELECT/WITH/SHOW/DESC/EXPLAIN。",
            }
    if "结果列" not in user_sql or "通过条件" not in user_sql:
        return {
            "code": "USER_VALIDATION_EXPECTATION_MISSING",
            "message": "用户验收 SQL 必须说明结果列和通过条件。",
        }

    production_tables = set()
    testdb_tables = set()
    normalized_mappings = []
    for index, raw_mapping in enumerate(table_mappings, 1):
        if not isinstance(raw_mapping, dict):
            return {
                "code": "INVALID_TABLE_MAPPING",
                "message": f"第 {index} 个表映射必须是对象。",
            }
        production_table = _text(raw_mapping.get("production_table")).lower()
        testdb_table = _text(raw_mapping.get("testdb_table")).lower()
        strategy = _text(raw_mapping.get("build_strategy")).lower()
        if not production_table or not testdb_table.startswith("testdb."):
            return {
                "code": "INVALID_TABLE_MAPPING",
                "message": f"第 {index} 个映射必须同时提供生产表和 testdb.* 测试表。",
            }
        if production_table in production_tables or testdb_table in testdb_tables:
            return {
                "code": "TABLE_MAPPING_NOT_ONE_TO_ONE",
                "message": "生产表与 testdb 表必须一一对应，不能重复映射。",
            }
        if strategy not in {"create_table_like", "explicit_ddl"}:
            return {
                "code": "INVALID_BUILD_STRATEGY",
                "message": "build_strategy 只允许 create_table_like 或 explicit_ddl。",
            }
        if raw_mapping.get("schema_aligned") is not True:
            return {
                "code": "SCHEMA_NOT_ALIGNED",
                "message": "testdb 表必须与生产表结构一致；差异未确认时禁止进入执行。",
            }
        if _text(raw_mapping.get("production_model")) != _text(raw_mapping.get("testdb_model")):
            return {
                "code": "TABLE_MODEL_NOT_ALIGNED",
                "message": "testdb 表模型必须与生产表模型一致。",
            }
        production_tables.add(production_table)
        testdb_tables.add(testdb_table)
        normalized_mappings.append((production_table, testdb_table, strategy))

    write_targets = {
        target.lower()
        for statement in _sql_statements(system_sql)
        for target in [_mutation_target(statement)]
        if target
    }
    unmapped_targets = sorted(write_targets - testdb_tables)
    if unmapped_targets:
        return {
            "code": "UNMAPPED_TESTDB_WRITE",
            "message": "系统验证 SQL 的写目标缺少表映射：" + ", ".join(unmapped_targets),
        }

    normalized_sql = re.sub(r"[`\"\s]+", " ", system_sql.lower())
    for production_table, testdb_table, strategy in normalized_mappings:
        if strategy != "create_table_like":
            continue
        pattern = (
            r"create\s+table\s+(?:if\s+not\s+exists\s+)?"
            + re.escape(testdb_table)
            + r"\s+like\s+"
            + re.escape(production_table)
        )
        if not re.search(pattern, normalized_sql):
            return {
                "code": "CREATE_TABLE_LIKE_MISSING",
                "message": f"映射 {production_table} -> {testdb_table} 必须使用 CREATE TABLE LIKE。",
            }
    return {}


def _sql_statements(sql):
    return [part.strip() for part in str(sql or "").split(";") if part.strip()]


def _first_sql_keyword(statement):
    without_comments = re.sub(r"/\*.*?\*/", " ", statement, flags=re.DOTALL)
    without_comments = re.sub(r"--[^\n]*(?:\n|$)", " ", without_comments)
    match = re.search(r"\b([A-Za-z]+)\b", without_comments)
    return match.group(1).lower() if match else ""


def _render_validation_contract_blocker(ticket_id, blocker):
    return "\n".join(
        [
            "# SQL 验收契约阻断说明",
            "",
            f"- ticket_id: `{ticket_id}`",
            f"- code: `{blocker['code']}`",
            f"- message: {blocker['message']}",
            "",
            "补齐 `00-生产-testdb表映射.yaml`、`01-系统验证.sql` 和 `02-用户验收.sql` 后再执行。",
            "",
        ]
    )


def _mutation_target(statement):
    patterns = [
        r"\bcreate\s+(?:temporary\s+)?table\s+(?:if\s+not\s+exists\s+)?([`\"\w.]+)",
        r"\binsert\s+(?:overwrite\s+)?(?:into\s+)?(?:table\s+)?([`\"\w.]+)",
        r"\bupdate\s+([`\"\w.]+)",
        r"\bdelete\s+from\s+([`\"\w.]+)",
        r"\balter\s+table\s+([`\"\w.]+)",
        r"\bdrop\s+table\s+(?:if\s+exists\s+)?([`\"\w.]+)",
        r"\btruncate\s+table\s+([`\"\w.]+)",
        r"\breplace\s+into\s+([`\"\w.]+)",
    ]
    for pattern in patterns:
        match = re.search(pattern, statement, flags=re.IGNORECASE)
        if match:
            return match.group(1).strip("`\"")
    return None


def _render_sr_box_blocker(ticket_id, blocker, sql):
    return "\n".join(
        [
            "# SR Box 阻断说明",
            "",
            f"- ticket_id: `{ticket_id}`",
            f"- code: `{blocker['code']}`",
            f"- target: `{blocker['target']}`",
            f"- message: {blocker['message']}",
            "",
            "## SQL",
            "",
            "```sql",
            sql.strip(),
            "```",
            "",
        ]
    )


def _sr_box_request(request, output_dir, route, validation_sql):
    return {
        "type": "dw-dev handoff",
        "target_skill": "$sr-box",
        "native_agent": "Codex or Claude Code",
        "ticket_id": _ticket_id(request),
        "purpose": "testdb-validation",
        "route": route,
        "sql": validation_sql,
        "sqlMode": request.get("sqlMode", "execute"),
        "writeGuard": "testdb-only",
        "taskName": f"dw-dev-{_ticket_id(request)}",
        "evidencePath": str(output_dir / "验收结果" / "01-sr-box-执行结果.md"),
    }


def _ds_scheduler_enabled(request):
    ds_scheduler = _mapping(request.get("ds_scheduler"))
    if not ds_scheduler:
        ds_scheduler = _mapping(request.get("ds_release"))
    enabled = ds_scheduler.get("enabled")
    if isinstance(enabled, bool):
        return enabled
    if enabled is None:
        return False
    return str(enabled).strip().lower() in {"1", "true", "yes", "y", "on"}


def _ds_scheduler_handoff(request):
    ds_scheduler = _mapping(request.get("ds_scheduler")) or _mapping(request.get("ds_release"))
    return {
        "type": "dw-dev handoff",
        "target_skill": "$ds-scheduler",
        "native_agent": "Codex or Claude Code",
        "ticket_id": _ticket_id(request),
        "status": "pending_user_confirmation",
        "ds_scheduler": ds_scheduler,
        "required_evidence": ["验收结果/01-sr-box-执行结果.md"],
        "boundary": "$dw-dev does not execute DolphinScheduler changes directly.",
    }


def _render_execution_evidence(validation_sql, execution_result):
    return "\n".join(
        [
            "# SR Box 验收结果",
            "",
            "本文件只记录 `$sr-box` 返回的真实执行证据；生成 SQL 或计划不算执行证据。",
            "",
            "## SQL",
            "",
            "```sql",
            validation_sql.strip(),
            "```",
            "",
            "## Result",
            "",
            "```json",
            json.dumps(execution_result, ensure_ascii=False, indent=2, sort_keys=True),
            "```",
            "",
            "## 边界",
            "",
            "- 本次只允许 `testdb` 验证或只读检查。",
            "- 未执行生产上线。",
            "- 外部发送、Jira 回写和 DS 变更仍需人工确认。",
            "",
        ]
    )


def _summary(ticket_id, status, output_dir):
    artifacts = []
    if output_dir.exists():
        artifacts = sorted(
            path.relative_to(output_dir).as_posix()
            for path in output_dir.rglob("*")
            if path.is_file()
        )
    return {
        "success": status
        in {
            "accepted_testdb_validation",
            "needs_clarification",
            "ready_for_modeling",
            "ready_for_sql_builder",
            "ready_for_sr_box_execution",
        },
        "ticket_id": ticket_id,
        "status": status,
        "artifacts": artifacts,
    }


def _bullet_list(items):
    if not items:
        return "- 待补充"
    return "\n".join(f"- {item}" for item in items)


def _unique(items):
    result = []
    seen = set()
    for item in items:
        if item in seen:
            continue
        seen.add(item)
        result.append(item)
    return result


def _safe_name(value):
    text = _text(value, "source")
    text = re.sub(r"[^A-Za-z0-9_.-]+", "-", text)
    return text.strip("-") or "source"


def _safe_filename(value):
    name = Path(_text(value, "material")).name
    name = re.sub(r"[^A-Za-z0-9_.-]+", "-", name)
    return name.strip(".-") or "material"


def _is_url(value):
    return bool(re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", value))


def _write_text(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


if __name__ == "__main__":
    raise SystemExit(main())
