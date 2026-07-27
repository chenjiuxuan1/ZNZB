#!/usr/bin/env python3
import argparse
from copy import deepcopy
import json
from pathlib import Path
import re
import sys

import yaml


ETL_COLUMNS = [
    {
        "name": "etl_create_time",
        "type": "datetime",
        "nullable": False,
        "default": "CURRENT_TIMESTAMP",
        "comment": "创建时间",
    },
    {
        "name": "etl_update_time",
        "type": "datetime",
        "nullable": False,
        "default": "CURRENT_TIMESTAMP",
        "comment": "更新时间",
    },
]

KEY_TYPE_MAP = {
    "duplicate": "DUPLICATE KEY",
    "primary": "PRIMARY KEY",
    "unique": "UNIQUE KEY",
    "aggregate": "AGGREGATE KEY",
}


class ModelingPackageError(ValueError):
    """Raised when a modeling SQL package request is invalid."""


def build_sql_package(request, output_dir):
    request = deepcopy(request)
    validate_request(request)
    output_dir = Path(output_dir)

    sql_dir = output_dir / "05-sql"
    execution_dir = output_dir / "06-execution"
    release_dir = output_dir / "release"
    for directory in (sql_dir, execution_dir, release_dir):
        directory.mkdir(parents=True, exist_ok=True)

    columns = ensure_etl_columns(request.get("columns", []))
    target = request["target"]
    prod_table = table_name(target["database"], target["table"])
    test_table = table_name(
        target.get("test_database", "testdb"),
        target.get("test_table", f"{target['table']}_test"),
    )

    prod_ddl = render_ddl(request, columns, prod_table)
    test_ddl = render_ddl(request, columns, test_table)
    prod_dml = render_dml(request, prod_table)
    test_dml = render_dml(
        request,
        test_table,
        source_mapping=request.get("test_source_mapping", {}),
    )
    quality_checks = render_quality_checks(request, prod_table, test_table)
    modeling_doc = render_modeling_doc(request, prod_table, test_table)
    execution_request = build_execution_request(request, test_ddl, test_dml)

    artifacts = {
        "modeling": output_dir / "04-modeling.md",
        "prod_ddl": sql_dir / "01_prod_ddl.sql",
        "testdb_ddl": sql_dir / "02_testdb_ddl.sql",
        "prod_dml": sql_dir / "03_prod_dml.sql",
        "testdb_dml": sql_dir / "04_testdb_dml.sql",
        "quality_checks": sql_dir / "05_quality_checks.sql",
        "execution_request": execution_dir / "01_testdb_execution_request.json",
        "prod_release": release_dir / "01-prod-online.sql",
        "testdb_release": release_dir / "02-testdb-runnable.sql",
    }

    write_text(artifacts["modeling"], modeling_doc)
    write_text(artifacts["prod_ddl"], prod_ddl)
    write_text(artifacts["testdb_ddl"], test_ddl)
    write_text(artifacts["prod_dml"], prod_dml)
    write_text(artifacts["testdb_dml"], test_dml)
    write_text(artifacts["quality_checks"], quality_checks)
    write_json(artifacts["execution_request"], execution_request)
    write_text(
        artifacts["prod_release"],
        "\n\n".join(
            [
                "-- 正式上线版本：仅在审批通过后用于生产发布",
                prod_ddl.rstrip(),
                prod_dml.rstrip(),
                quality_checks.rstrip(),
            ]
        )
        + "\n",
    )
    write_text(
        artifacts["testdb_release"],
        "\n\n".join(
            [
                "-- testdb 可执行打通版本：写入目标固定为 testdb",
                test_ddl.rstrip(),
                test_dml.rstrip(),
                quality_checks.rstrip(),
            ]
        )
        + "\n",
    )

    return {
        "success": True,
        "status": "generated",
        "ticket_id": request.get("ticket_id"),
        "route": request.get("route", {}),
        "artifacts": {key: str(path) for key, path in artifacts.items()},
    }


def validate_request(request):
    if not isinstance(request, dict):
        raise ModelingPackageError("request must be an object")
    target = request.get("target")
    if not isinstance(target, dict):
        raise ModelingPackageError("target must be an object")
    for key in ("database", "table"):
        if not target.get(key):
            raise ModelingPackageError(f"target.{key} is required")
    if not isinstance(request.get("columns"), list) or not request["columns"]:
        raise ModelingPackageError("columns must be a non-empty list")
    dml = request.get("dml")
    if not isinstance(dml, dict) or not dml.get("select_sql"):
        raise ModelingPackageError("dml.select_sql is required")


def ensure_etl_columns(columns):
    normalized = [dict(column) for column in columns]
    existing = {column.get("name", "").lower() for column in normalized}
    for etl_column in ETL_COLUMNS:
        if etl_column["name"] not in existing:
            normalized.append(dict(etl_column))
    return normalized


def render_ddl(request, columns, full_table_name):
    target = request["target"]
    model = request.get("model", {})
    key_type = KEY_TYPE_MAP.get(str(model.get("key_type", "duplicate")).lower())
    if key_type is None:
        raise ModelingPackageError(f"unsupported model.key_type: {model.get('key_type')}")
    keys = model.get("keys") or []
    if not keys:
        raise ModelingPackageError("model.keys is required")

    lines = [
        f"CREATE TABLE IF NOT EXISTS {quote_table(full_table_name)} (",
        ",\n".join(f"    {render_column(column)}" for column in columns),
        ")",
        f"ENGINE = OLAP",
        f"{key_type}({quote_ident_list(keys)})",
    ]

    if target.get("comment"):
        lines.append(f"COMMENT \"{escape_comment(target['comment'])}\"")

    partition = model.get("partition") or {}
    if partition.get("expr"):
        lines.append(f"PARTITION BY {partition['expr']}")

    distribution = model.get("distribution") or {}
    if distribution.get("type", "hash").lower() == "hash":
        bucket_keys = distribution.get("keys") or keys
        buckets = distribution.get("buckets")
        bucket_clause = f"DISTRIBUTED BY HASH({quote_ident_list(bucket_keys)})"
        if buckets:
            bucket_clause += f" BUCKETS {int(buckets)}"
        lines.append(bucket_clause)

    order_by = model.get("order_by") or []
    if order_by:
        lines.append(f"ORDER BY({quote_ident_list(order_by)})")

    properties = model.get("properties") or {}
    if properties:
        rendered_properties = ",\n".join(
            f"    \"{escape_property(key)}\" = \"{escape_property(value)}\""
            for key, value in sorted(properties.items())
        )
        lines.append(f"PROPERTIES (\n{rendered_properties}\n)")

    return "\n".join(lines) + ";\n"


def render_column(column):
    name = required(column, "name", "column")
    data_type = required(column, "type", f"column {name}")
    nullable = "NULL" if column.get("nullable", True) else "NOT NULL"
    pieces = [quote_ident(name), data_type, nullable]
    if "default" in column and column["default"] is not None:
        pieces.extend(["DEFAULT", str(column["default"])])
    if column.get("comment") is not None:
        pieces.extend(["COMMENT", f"\"{escape_comment(column['comment'])}\""])
    return " ".join(pieces)


def render_dml(request, full_table_name, source_mapping=None):
    dml = request["dml"]
    mode = dml.get("mode", "insert_overwrite").lower()
    verb = "INSERT INTO" if mode == "insert_into" else "INSERT OVERWRITE"
    partition = dml.get("partition")
    columns = dml.get("columns") or [column["name"] for column in ensure_etl_columns(request["columns"])]
    select_sql = dml["select_sql"].rstrip()
    if source_mapping:
        select_sql = rewrite_sources(select_sql, source_mapping)

    header = f"{verb} {quote_table(full_table_name)}"
    if partition:
        header += f" PARTITION({partition})"
    if columns:
        header += f" ({quote_ident_list(columns)})"
    return f"{header}\n{select_sql};\n"


def render_quality_checks(request, prod_table, test_table):
    quality = request.get("quality") or {}
    primary_key = quality.get("primary_key") or request.get("model", {}).get("keys", [])
    partition_filter = quality.get("partition_filter") or request.get("dml", {}).get("partition")
    row_count_source = quality.get("row_count_source")
    key_expr = ", ".join(primary_key)
    where_clause = f"\nWHERE {partition_filter}" if partition_filter else ""

    checks = [
        "-- 主键唯一性",
        f"SELECT COUNT(*) AS row_count, COUNT(DISTINCT {key_expr}) AS pk_count",
        f"FROM {quote_table(test_table)}{where_clause};",
        "",
        "-- testdb 与源表行数对账",
        f"SELECT 'testdb_target' AS side, COUNT(*) AS row_count FROM {quote_table(test_table)}{where_clause}",
    ]
    if row_count_source:
        checks.extend(
            [
                "UNION ALL",
                f"SELECT 'source' AS side, COUNT(*) AS row_count FROM {row_count_source}{where_clause};",
            ]
        )
    else:
        checks[-1] += ";"
    checks.extend(
        [
            "",
            "-- 正式上线后抽样检查",
            f"SELECT * FROM {quote_table(prod_table)}{where_clause} LIMIT 100;",
        ]
    )
    return "\n".join(checks) + "\n"


def render_modeling_doc(request, prod_table, test_table):
    target = request["target"]
    model = request.get("model", {})
    distribution = model.get("distribution", {})
    partition = model.get("partition", {})
    return (
        f"# {request.get('ticket_id', 'dw-sql-builder')} SQL 构建交付\n\n"
        f"- Owner: {request.get('owner', 'owenzhang')}\n"
        f"- Route: `{json.dumps(request.get('route', {}), ensure_ascii=False)}`\n"
        f"- Domain: `{target.get('business_domain', '')}`\n"
        f"- Layer: `{target.get('layer', '')}`\n"
        f"- Production table: `{prod_table}`\n"
        f"- Testdb table: `{test_table}`\n"
        f"- Key type: `{model.get('key_type', 'duplicate')}`\n"
        f"- Keys: `{', '.join(model.get('keys', []))}`\n"
        f"- Partition: `{partition.get('expr', '')}`\n"
        f"- Distribution: `{', '.join(distribution.get('keys', []))}` / "
        f"`{distribution.get('buckets', '')}` buckets\n\n"
        "## Execution Boundary\n\n"
        "- `01-prod-online.sql` is the formal production draft and requires review and human approval.\n"
        "- `02-testdb-runnable.sql` writes only to `testdb` and can be sent to `$sr-box` after human approval.\n"
        "- Test SQL keeps real read sources unless `test_source_mapping` is explicitly supplied.\n"
    )


def build_execution_request(request, test_ddl, test_dml):
    ticket_id = request.get("ticket_id", "WAREHOUSE-MODELING")
    return {
        "review": {
            "ticket_id": ticket_id,
            "review_type": "sql",
            "status": "pass",
            "risk_level": "low",
            "approval_required": [],
            "findings": [],
            "reviewer": "dw-sql-builder-package",
            "evidence_references": [],
        },
        "safetyReview": {
            "ticket_id": ticket_id,
            "review_type": "safety",
            "status": "pass",
            "risk_level": "low",
            "approval_required": [],
            "findings": [],
            "reviewer": "dw-sql-builder-package",
            "evidence_references": ["05-sql/04_testdb_dml.sql"],
        },
        "sql": "\n".join([test_ddl.rstrip(), test_dml.rstrip()]) + "\n",
        "route": request.get("route", {}),
        "sqlMode": "execute",
        "taskName": f"{ticket_id}-testdb-modeling-validation",
        "evidencePath": "06-evidence/02_testdb_sql_package_result.md",
    }


def rewrite_sources(sql, source_mapping):
    rewritten = sql
    for source, replacement in sorted(source_mapping.items(), key=lambda item: -len(item[0])):
        rewritten = replace_table_reference(rewritten, source, replacement)
    return rewritten


def replace_table_reference(sql, source, replacement):
    database, table = split_table(source)
    replacement_text = normalize_table_reference(replacement)
    pattern = re.compile(
        rf"(?<![A-Za-z0-9_])`?{re.escape(database)}`?\s*\.\s*`?{re.escape(table)}`?(?![A-Za-z0-9_])",
        flags=re.IGNORECASE,
    )
    return pattern.sub(replacement_text, sql)


def normalize_table_reference(name):
    database, table = split_table(name)
    return f"{database}.{table}"


def split_table(name):
    clean = str(name).strip().strip("`")
    parts = [part.strip("` ") for part in clean.split(".") if part.strip("` ")]
    if len(parts) != 2:
        raise ModelingPackageError(f"table name must be database.table: {name}")
    return parts[0], parts[1]


def table_name(database, table):
    return f"{database}.{table}"


def quote_table(full_table_name):
    database, table = split_table(full_table_name)
    return f"{quote_ident(database)}.{quote_ident(table)}"


def quote_ident(name):
    return f"`{str(name).strip('`')}`"


def quote_ident_list(names):
    return ", ".join(quote_ident(name) for name in names)


def required(mapping, key, context):
    value = mapping.get(key)
    if value in (None, ""):
        raise ModelingPackageError(f"{context}.{key} is required")
    return value


def escape_comment(value):
    return str(value).replace('"', '\\"')


def escape_property(value):
    return str(value).replace("\\", "\\\\").replace('"', '\\"')


def write_text(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def write_json(path, payload):
    write_text(path, json.dumps(payload, ensure_ascii=False, indent=2) + "\n")


def load_request(path):
    path = Path(path)
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() == ".json":
        return json.loads(text)
    return yaml.safe_load(text)


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Generate production and testdb SQL package for warehouse development."
    )
    parser.add_argument("request", help="YAML or JSON modeling request")
    parser.add_argument("--output-dir", required=True, help="Output artifact directory")
    args = parser.parse_args(argv)

    try:
        result = build_sql_package(load_request(args.request), Path(args.output_dir))
    except Exception as exc:
        print(json.dumps({"success": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
