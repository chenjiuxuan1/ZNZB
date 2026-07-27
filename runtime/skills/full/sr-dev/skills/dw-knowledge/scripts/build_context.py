#!/usr/bin/env python3
import argparse
import json
import re
from pathlib import Path

import yaml


DEFAULT_REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_SEMANTIC_ROOT = DEFAULT_REPO_ROOT / "semantic-layer"
DEFAULT_REFERENCES_ROOT = DEFAULT_REPO_ROOT / "references" / "domains"


def load_yaml(path):
    data = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    if data is None:
        return {}
    if not isinstance(data, dict):
        raise ValueError(f"YAML must be a mapping: {path}")
    return data


def normalize(value):
    text = str(value or "").strip().lower()
    return re.sub(r"[\s_-]+", "", text)


def load_semantic_entities(root=DEFAULT_SEMANTIC_ROOT):
    root = Path(root)
    manifest = load_yaml(root / "manifest.yaml")
    entities = []
    for entry in manifest.get("entities", []):
        if entry.get("kind") != "metric":
            continue
        path = root / entry["path"]
        entity = load_yaml(path)
        entity["_manifest"] = entry
        entity["_path"] = path.relative_to(DEFAULT_REPO_ROOT).as_posix()
        entities.append(entity)
    return entities


def find_metric(requirement, semantic_entities):
    requested = requirement.get("metrics") or []
    requested_values = [str(value) for value in requested if value]
    if not requested_values:
        return None

    for requested_value in requested_values:
        for entity in semantic_entities:
            if requested_value == entity.get("id"):
                return entity

    requested_normalized = {normalize(value) for value in requested_values}
    for entity in semantic_entities:
        names = [entity.get("name")] + list(entity.get("aliases") or [])
        if any(normalize(name) in requested_normalized for name in names):
            return entity
    return None


def load_reference(domain, references_root=DEFAULT_REFERENCES_ROOT):
    if not domain or domain == "unknown":
        return None
    path = Path(references_root) / f"{domain}.md"
    if not path.is_file():
        return None
    return {
        "domain": domain,
        "path": path.relative_to(DEFAULT_REPO_ROOT).as_posix(),
        "summary": _summarize_reference(path.read_text(encoding="utf-8")),
    }


def build_context_from_requirement(
    requirement_path,
    semantic_root=DEFAULT_SEMANTIC_ROOT,
    references_root=DEFAULT_REFERENCES_ROOT,
):
    requirement = load_yaml(requirement_path)
    entities = load_semantic_entities(semantic_root)
    metric = find_metric(requirement, entities)
    reference = load_reference(requirement.get("business_domain"), references_root)

    result = {
        "ticket_id": requirement.get("ticket_id", "unknown"),
        "status": "semantic_miss",
        "source_tier": "unknown",
        "confidence": "uncertain",
        "semantic_matches": [],
        "reference_matches": [],
        "query_spec": None,
        "clarification_questions": [],
        "context_markdown": "",
    }

    if metric is not None:
        result["semantic_matches"].append(_semantic_summary(metric))
        result["source_tier"] = "semantic"
        result["confidence"] = "medium"
        questions = _semantic_questions(requirement, metric)
        if questions:
            result["status"] = "needs_clarification"
            result["clarification_questions"] = questions
        else:
            result["status"] = "ready_for_execution"
            result["confidence"] = "high"
            result["query_spec"] = _build_query_spec(requirement, metric)
    elif reference is not None:
        result["status"] = "needs_clarification"
        result["source_tier"] = "governed_ref"
        result["confidence"] = "medium"
        result["reference_matches"].append(reference)
        result["clarification_questions"] = [
            "请确认具体指标口径或 metric_id；当前仅命中领域 reference，不能猜测表名。",
            "请确认 canonical table、datasource、字段、单位和 freshness。",
        ]
    else:
        result["clarification_questions"] = [
            "请确认业务域；当前未命中 semantic-layer 或 governed reference。",
            "请补充指标定义、国家、时间窗口、期望输出和数据 owner。",
        ]

    if reference is not None and not result["reference_matches"]:
        result["reference_matches"].append(reference)
    result["context_markdown"] = render_context_markdown(result)
    return result


def render_context_markdown(result):
    semantic_lines = _format_matches(result["semantic_matches"])
    reference_lines = _format_matches(result["reference_matches"])
    questions = result.get("clarification_questions") or []
    query_spec = result.get("query_spec")
    query_lines = ["- 无"]
    if query_spec:
        query_lines = [
            f"- metric_id: `{query_spec['metric_id']}`",
            f"- canonical_table: `{query_spec['canonical_table']}`",
            f"- country: `{query_spec['country']}`",
            f"- time_range: `{query_spec['time_range']['start_date']}..{query_spec['time_range']['end_date']}`",
        ]
    question_lines = [f"- {item}" for item in questions] or ["- 无"]
    return "\n".join(
        [
            "# 上下文和证据索引",
            "",
            "## Requirement",
            "",
            f"- ticket_id: `{result['ticket_id']}`",
            f"- status: `{result['status']}`",
            f"- source_tier: `{result['source_tier']}`",
            f"- confidence: `{result['confidence']}`",
            "",
            "## Semantic Layer",
            "",
            *semantic_lines,
            "",
            "## Reference Docs",
            "",
            *reference_lines,
            "",
            "## Query Spec",
            "",
            *query_lines,
            "",
            "## DataMap",
            "",
            "- P0 未接入 DataMap 在线语义 API。",
            "",
            "## SR / StarRocks",
            "",
            "- 本 skill 不执行 SQL；真实执行必须走 `$sr-box` 或用户明确指定的查询 skill。",
            "",
            "## Workflow / BI / DS",
            "",
            "- 未加载 workflow、BI 或 DS 证据。",
            "",
            "## 历史案例",
            "",
            "- 历史案例只能作为参考，不能替代 semantic-layer 或 governed reference。",
            "",
            "## 存疑事项",
            "",
            *question_lines,
            "",
        ]
    )


def render_clarification_markdown(result):
    questions = result.get("clarification_questions") or []
    question_lines = [f"{index}. {question}" for index, question in enumerate(questions, 1)]
    if not question_lines:
        question_lines = ["1. 当前无补问。"]
    return "\n".join(
        [
            "# 补问信息",
            "",
            "当前需求不能直接进入执行，缺少以下信息：",
            "",
            *question_lines,
            "",
            "## 建议 Jira Comment",
            "",
            "为避免口径错误，需要补充以上信息后再执行。本草稿不会自动发送。",
            "",
        ]
    )


def write_outputs(
    result,
    context_output=None,
    query_spec_output=None,
    clarification_output=None,
):
    if context_output:
        _write_text(context_output, result["context_markdown"])
    if query_spec_output and result.get("query_spec"):
        _write_text(
            query_spec_output,
            yaml.safe_dump(
                result["query_spec"],
                allow_unicode=True,
                sort_keys=False,
            ),
        )
    if clarification_output and result.get("clarification_questions"):
        _write_text(clarification_output, render_clarification_markdown(result))


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Build DW Dev semantic/reference context."
    )
    parser.add_argument("requirement", type=Path)
    parser.add_argument("--context-output", type=Path)
    parser.add_argument("--query-spec-output", type=Path)
    parser.add_argument("--clarification-output", type=Path)
    args = parser.parse_args(argv)

    result = build_context_from_requirement(args.requirement)
    write_outputs(
        result,
        context_output=args.context_output,
        query_spec_output=args.query_spec_output,
        clarification_output=args.clarification_output,
    )
    print(
        json.dumps(
            {
                "ticket_id": result["ticket_id"],
                "status": result["status"],
                "source_tier": result["source_tier"],
                "confidence": result["confidence"],
                "semantic_matches": result["semantic_matches"],
                "reference_matches": result["reference_matches"],
                "has_query_spec": result["query_spec"] is not None,
                "clarification_questions": result["clarification_questions"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def _semantic_questions(requirement, metric):
    questions = []
    country = requirement.get("country")
    countries = requirement.get("countries") or []
    if not country or country == "unknown" or not countries:
        questions.append("请确认统计国家；国家必须与 datasource 和 SR 路由一致。")

    time_range = requirement.get("time_range") or {}
    if (
        time_range.get("type") == "unknown"
        or not time_range.get("start_date")
        or not time_range.get("end_date")
    ):
        questions.append("请确认时间窗口；需要 start_date 和 end_date。")

    required_parameters = metric.get("query_spec", {}).get("required_parameters") or []
    for parameter in required_parameters:
        if parameter in {"country", "time_range"}:
            continue
        if parameter == "experiment_id":
            questions.append("请确认 experiment_id 或实验名称。")
        elif parameter == "amount_unit":
            continue
        elif parameter in {"experiment_group_field", "conversion_event"}:
            questions.append(f"请确认 {parameter}。")
        else:
            questions.append(f"请确认 {parameter}。")

    query_spec = metric.get("query_spec", {})
    canonical_table = query_spec.get("canonical_table")
    canonical_assets = metric.get("canonical_assets") or []
    if canonical_table == "unknown" or any(
        str(asset).startswith("unresolved:") for asset in canonical_assets
    ):
        questions.append("请确认物理表、datasource、字段、单位和 freshness。")
    return _unique(questions)


def _build_query_spec(requirement, metric):
    metric_query = metric["query_spec"]
    time_range = requirement["time_range"]
    return {
        "ticket_id": requirement.get("ticket_id"),
        "metric_id": metric["id"],
        "business_domain": metric["business_domain"],
        "country": requirement.get("country"),
        "countries": requirement.get("countries") or [requirement.get("country")],
        "time_range": {
            "type": time_range.get("type"),
            "start_date": time_range.get("start_date"),
            "end_date": time_range.get("end_date"),
        },
        "source_tier": "semantic",
        "confidence": "high",
        "datasource_hint": metric_query["datasource_hint"],
        "canonical_table": metric_query["canonical_table"],
        "metric_expression": metric_query["metric_expression"],
        "default_time_field": metric_query["default_time_field"],
        "default_granularity": metric_query["default_granularity"],
        "default_filters": metric_query.get("default_filters", []),
        "freshness": metric_query["freshness"],
        "unit": metric_query["unit"],
        "dimensions": metric.get("dimensions", []),
        "segments": metric.get("segments", []),
        "limitations": metric.get("limitations", []),
        "known_pitfalls": metric.get("known_pitfalls", []),
        "reviewer_required": True,
        "sr_execution_chain": "$sr-box",
    }


def _semantic_summary(metric):
    query_spec = metric.get("query_spec", {})
    return {
        "id": metric.get("id"),
        "name": metric.get("name"),
        "path": metric.get("_path"),
        "business_domain": metric.get("business_domain"),
        "status": metric.get("status"),
        "canonical_table": query_spec.get("canonical_table"),
        "canonical_assets": metric.get("canonical_assets", []),
        "owner": metric.get("owner", {}),
        "freshness": metric.get("freshness", {}),
    }


def _summarize_reference(text):
    lines = [
        line.strip()
        for line in text.splitlines()
        if line.strip() and not line.startswith("---")
    ]
    selected = [
        line
        for line in lines
        if line.startswith("#")
        or "使用前核验" in line
        or "不能直接生成可执行 SQL" in line
        or "governed reference" in line
    ]
    return " ".join(selected[:8])


def _format_matches(matches):
    if not matches:
        return ["- 无"]
    lines = []
    for item in matches:
        label = item.get("id") or item.get("domain")
        path = item.get("path")
        lines.append(f"- `{label}`: `{path}`")
        if item.get("canonical_table"):
            lines.append(f"  - canonical_table: `{item['canonical_table']}`")
        if item.get("summary"):
            lines.append(f"  - summary: {item['summary']}")
    return lines


def _write_text(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _unique(items):
    result = []
    for item in items:
        if item not in result:
            result.append(item)
    return result


if __name__ == "__main__":
    raise SystemExit(main())
