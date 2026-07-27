#!/usr/bin/env python3
import argparse
import json
from pathlib import Path
import sys


SUPPORTED_COUNTRIES = ("cn", "th", "mx", "ph", "pk", "id")
WAREHOUSE_SCHEMAS = ("ods", "dwd", "dwb", "dwt", "dws", "ads", "dim")
FIELD_PATTERNS = (
    "asset_item_no",
    "asset_item_number",
    "asset_id",
    "debtor_id",
    "dt",
    "etl_create_time",
    "etl_update_time",
)


class MetadataCollectorError(ValueError):
    """Raised when metadata query generation is invalid."""


def build_metadata_queries(country, domain="fox"):
    country = normalize_country(country)
    domain = str(domain or "fox").strip().lower()
    route = {"country": country}

    queries = [
        query_spec("sanity_select", route, "SELECT 1 AS ok"),
    ]
    for schema in ("ods", "dwd", "dwb", "dim", "dws", "ads"):
        queries.append(
            query_spec(
                f"show_{schema}_{domain}_tables",
                route,
                f"SHOW TABLES FROM {schema} LIKE '%{escape_like(domain)}%'",
            )
        )

    schemas_sql = ", ".join(f"'{schema}'" for schema in WAREHOUSE_SCHEMAS)
    fields_sql = ", ".join(f"'{field}'" for field in FIELD_PATTERNS)
    queries.extend(
        [
            query_spec(
                f"{domain}_field_dictionary",
                route,
                f"""SELECT
    table_schema,
    table_name,
    column_name,
    data_type,
    is_nullable,
    column_default,
    column_comment,
    ordinal_position
FROM information_schema.columns
WHERE table_schema IN ({schemas_sql})
  AND lower(table_name) LIKE '%{escape_sql_literal(domain)}%'
  AND lower(column_name) IN ({fields_sql})
ORDER BY table_schema, table_name, ordinal_position
LIMIT 2000""",
            ),
            query_spec(
                f"{domain}_ods_dwd_candidates",
                route,
                f"""SELECT
    table_schema,
    table_name,
    COUNT(*) AS matched_columns
FROM information_schema.columns
WHERE table_schema IN ('ods', 'dwd')
  AND lower(table_name) LIKE '%{escape_sql_literal(domain)}%'
  AND lower(column_name) IN ({fields_sql})
GROUP BY table_schema, table_name
ORDER BY table_schema, table_name
LIMIT 1000""",
            ),
            query_spec(
                f"{domain}_colocate_property_candidates",
                route,
                f"""SELECT
    table_schema,
    table_name,
    create_options,
    table_comment
FROM information_schema.tables
WHERE table_schema IN ('dwd', 'dwb', 'dwt', 'dws', 'ads', 'dim')
  AND lower(table_name) LIKE '%{escape_sql_literal(domain)}%'
  AND lower(create_options) LIKE '%colocate%'
ORDER BY table_schema, table_name
LIMIT 1000""",
            ),
        ]
    )
    return queries


def write_dry_run(output_dir, countries=None, domain="fox"):
    output_dir = Path(output_dir)
    metadata_dir = output_dir / "03-metadata"
    metadata_dir.mkdir(parents=True, exist_ok=True)

    countries = parse_countries(countries)
    country_files = {}
    for country in countries:
        queries = build_metadata_queries(country, domain=domain)
        path = metadata_dir / f"{country}-sr-box-new-queries.json"
        write_json(path, queries)
        country_files[country] = str(path)

    summary_path = metadata_dir / "metadata-summary.md"
    write_text(summary_path, render_summary(countries, domain, country_files))
    return {
        "success": True,
        "status": "generated",
        "domain": domain,
        "summary": str(summary_path),
        "countries": country_files,
    }


def query_spec(name, route, sql):
    return {
        "name": name,
        "tool": "sr-box-new",
        "route": dict(route),
        "mode": "query",
        "sql": sql.strip(),
    }


def render_summary(countries, domain, country_files):
    lines = [
        f"# {domain} 元数据扫描计划",
        "",
        "本文件由 `dw-modeling` 生成，只包含 `sr-box-new` 只读查询计划，不执行 SQL。",
        "",
        "## 国家",
        "",
    ]
    for country in countries:
        lines.append(f"- `{country}`: `{country_files[country]}`")
    lines.extend(
        [
            "",
            "## 扫描重点",
            "",
            "- ODS/DWD/DWB/DWS/ADS/DIM 中与业务域相关的表清单。",
            "- `asset_item_no` / `asset_item_number` / `debtor_id` / `dt` 等字段统一情况。",
            "- `etl_create_time` / `etl_update_time` 字段覆盖情况。",
            "- `CREATE_OPTIONS` 中的 Colocate 线索，用于判断是否参考泰国贷后域经验；如需全局 Colocation Group 健康状态，可由人工使用 `$sr-box-new` 另行尝试 `SHOW PROC '/colocation_group'`。",
            "",
            "## 使用边界",
            "",
            "- 只读元数据查询可以通过 `$sr-box-new` 执行。",
            "- DDL/DML 执行仍需交给 `$sr-box`，写入目标必须是 `testdb.*`。",
        ]
    )
    return "\n".join(lines) + "\n"


def parse_countries(countries):
    if countries is None:
        return list(SUPPORTED_COUNTRIES)
    if isinstance(countries, str):
        raw = [item.strip() for item in countries.split(",")]
    else:
        raw = [str(item).strip() for item in countries]
    parsed = [normalize_country(country) for country in raw if country]
    if not parsed:
        raise MetadataCollectorError("at least one country is required")
    return parsed


def normalize_country(country):
    country = str(country).strip().lower()
    if country not in SUPPORTED_COUNTRIES:
        raise MetadataCollectorError(
            f"unsupported country {country!r}; expected one of {', '.join(SUPPORTED_COUNTRIES)}"
        )
    return country


def escape_like(value):
    return escape_sql_literal(value).replace("%", "\\%").replace("_", "\\_")


def escape_sql_literal(value):
    return str(value).replace("'", "''")


def write_json(path, payload):
    write_text(path, json.dumps(payload, ensure_ascii=False, indent=2) + "\n")


def write_text(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Generate sr-box-new read-only metadata query plans."
    )
    parser.add_argument(
        "--countries",
        default=",".join(SUPPORTED_COUNTRIES),
        help="Comma-separated countries, default: all supported countries.",
    )
    parser.add_argument("--domain", default="fox", help="Business domain keyword.")
    parser.add_argument("--output-dir", required=True, help="Output directory.")
    args = parser.parse_args(argv)

    try:
        result = write_dry_run(
            Path(args.output_dir),
            countries=parse_countries(args.countries),
            domain=args.domain,
        )
    except Exception as exc:
        print(json.dumps({"success": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
