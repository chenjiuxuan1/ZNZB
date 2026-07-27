#!/usr/bin/env python3
"""Render DS metadata SQL for the ds-schedule-manager skill."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from textwrap import dedent


@dataclass(frozen=True)
class CountryConfig:
    country: str
    sr_country: str
    ds_country: str
    db: str
    style: str

    @property
    def definition_table(self) -> str:
        return f"t_ds_{self.style}_definition"

    @property
    def definition_log_table(self) -> str:
        return f"t_ds_{self.style}_definition_log"

    @property
    def relation_table(self) -> str:
        return f"t_ds_{self.style}_task_relation"

    @property
    def instance_table(self) -> str:
        return f"t_ds_{self.style}_instance"

    @property
    def definition_code_field(self) -> str:
        return f"{self.style}_definition_code"

    @property
    def definition_version_field(self) -> str:
        return f"{self.style}_definition_version"

    @property
    def parent_instance_field(self) -> str:
        return f"{self.style}_instance_id"


COUNTRIES = {
    "cn": CountryConfig("cn", "cn", "cn", "cn_dolphin", "workflow"),
    "th": CountryConfig("th", "th", "th", "dolphin_scheduler", "workflow"),
    "mx": CountryConfig("mx", "mx", "mx", "mex_dolphin", "process"),
    "ph": CountryConfig("ph", "ph", "ph", "phl_dolphin", "process"),
    "pk": CountryConfig("pk", "pk", "pk", "pak_dolphin", "workflow"),
    "id": CountryConfig("id", "id", "ine", "dolphin_scheduler", "workflow"),
}


def qname(config: CountryConfig, table: str) -> str:
    return f"ds_catalog.{config.db}.{table}"


def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def render_summary(config: CountryConfig) -> str:
    definition = qname(config, config.definition_table)
    schedules = qname(config, "t_ds_schedules")
    workflow_instances = qname(config, config.instance_table)
    task_instances = qname(config, "t_ds_task_instance")
    return dedent(
        f"""
        SELECT metric, state, cnt
        FROM (
          SELECT 'workflow_release_state' AS metric, release_state AS state, COUNT(*) AS cnt
          FROM {definition}
          GROUP BY release_state
          UNION ALL
          SELECT 'schedule_release_state' AS metric, release_state AS state, COUNT(*) AS cnt
          FROM {schedules}
          GROUP BY release_state
          UNION ALL
          SELECT 'recent_workflow_instance_state' AS metric, state, COUNT(*) AS cnt
          FROM {workflow_instances}
          WHERE start_time >= DATE_SUB(NOW(), INTERVAL 7 DAY)
          GROUP BY state
          UNION ALL
          SELECT 'recent_task_instance_state' AS metric, state, COUNT(*) AS cnt
          FROM {task_instances}
          WHERE start_time >= DATE_SUB(NOW(), INTERVAL 7 DAY)
          GROUP BY state
        ) ds_schedule_summary
        ORDER BY metric, state;
        """
    ).strip()


def render_table_to_task(config: CountryConfig, table_name: str) -> str:
    needle = sql_literal(table_name)
    return dedent(
        f"""
        -- table_to_task_query: find DS tasks/workflows/schedules that mention {table_name}
        SELECT
          p.name AS project_name,
          p.code AS project_code,
          w.name AS workflow_name,
          w.code AS workflow_code,
          w.release_state AS workflow_release_state,
          td.name AS task_name,
          td.code AS task_code,
          td.version AS task_version,
          td.task_type,
          td.flag AS task_flag,
          td.worker_group,
          td.environment_code,
          s.id AS schedule_id,
          s.release_state AS schedule_release_state,
          s.crontab,
          s.start_time AS schedule_start_time,
          s.end_time AS schedule_end_time,
          u.user_name AS owner_name
        FROM {qname(config, "t_ds_task_definition")} td
        LEFT JOIN {qname(config, config.relation_table)} r
          ON td.code = r.post_task_code
         AND td.version = r.post_task_version
        LEFT JOIN {qname(config, config.definition_table)} w
          ON r.{config.definition_code_field} = w.code
         AND r.{config.definition_version_field} = w.version
        LEFT JOIN {qname(config, "t_ds_project")} p
          ON td.project_code = p.code
        LEFT JOIN {qname(config, "t_ds_user")} u
          ON w.user_id = u.id
        LEFT JOIN {qname(config, "t_ds_schedules")} s
          ON w.code = s.{config.definition_code_field}
        WHERE LOWER(td.task_params) LIKE CONCAT('%', LOWER({needle}), '%')
           OR LOWER(td.name) LIKE CONCAT('%', LOWER({needle}), '%')
        ORDER BY w.release_state DESC, s.release_state DESC, w.name, td.name
        LIMIT 100;
        """
    ).strip()


def render_workflow_schedule(
    config: CountryConfig, workflow_code: str | None, workflow_name: str | None
) -> str:
    predicates = []
    if workflow_code:
        predicates.append(f"w.code = {workflow_code}")
    if workflow_name:
        predicates.append(
            f"LOWER(w.name) LIKE CONCAT('%', LOWER({sql_literal(workflow_name)}), '%')"
        )
    if not predicates:
        predicates.append("w.code = <workflow_code>")
    where_clause = "\n   OR ".join(predicates)
    return dedent(
        f"""
        -- workflow_schedule_status: verify workflow and schedule上线 state
        SELECT
          p.name AS project_name,
          w.project_code,
          w.code AS workflow_code,
          w.name AS workflow_name,
          w.release_state AS workflow_release_state,
          w.global_params,
          s.id AS schedule_id,
          s.release_state AS schedule_release_state,
          s.crontab,
          s.start_time,
          s.end_time,
          s.worker_group,
          s.tenant_code,
          s.environment_code
        FROM {qname(config, config.definition_table)} w
        LEFT JOIN {qname(config, "t_ds_project")} p
          ON w.project_code = p.code
        LEFT JOIN {qname(config, "t_ds_schedules")} s
          ON w.code = s.{config.definition_code_field}
        WHERE {where_clause}
        ORDER BY s.release_state DESC, s.update_time DESC;
        """
    ).strip()


def render_recent_task_runs(config: CountryConfig, task_code: str, days: int) -> str:
    return dedent(
        f"""
        -- recent_task_runs: latest task execution, state, and log locator
        SELECT
          wi.id AS workflow_instance_id,
          wi.name AS workflow_instance_name,
          wi.{config.definition_code_field} AS workflow_definition_code,
          wi.state AS workflow_state,
          wi.start_time AS workflow_start_time,
          wi.end_time AS workflow_end_time,
          ti.id AS task_instance_id,
          ti.task_code,
          ti.name AS task_name,
          ti.state AS task_state,
          ti.start_time AS task_start_time,
          ti.end_time AS task_end_time,
          ti.host,
          ti.log_path,
          ti.executor_name
        FROM {qname(config, "t_ds_task_instance")} ti
        JOIN {qname(config, config.instance_table)} wi
          ON ti.{config.parent_instance_field} = wi.id
        WHERE ti.task_code = {task_code}
          AND ti.start_time >= DATE_SUB(NOW(), INTERVAL {days} DAY)
        ORDER BY ti.start_time DESC
        LIMIT 50;
        """
    ).strip()


def render_failed_tasks(config: CountryConfig, project_code: str, days: int) -> str:
    return dedent(
        f"""
        -- failed_tasks: failed/abnormal tasks for one DS project
        SELECT
          p.name AS project_name,
          wi.{config.definition_code_field} AS workflow_code,
          wi.name AS workflow_instance_name,
          wi.id AS workflow_instance_id,
          wi.state AS workflow_state,
          ti.id AS task_instance_id,
          ti.task_code,
          ti.name AS task_name,
          ti.state AS task_state,
          ti.start_time,
          ti.end_time,
          ti.host,
          ti.log_path
        FROM {qname(config, "t_ds_task_instance")} ti
        JOIN {qname(config, config.instance_table)} wi
          ON ti.{config.parent_instance_field} = wi.id
        LEFT JOIN {qname(config, "t_ds_project")} p
          ON ti.project_code = p.code
        WHERE ti.project_code = {project_code}
          AND ti.start_time >= DATE_SUB(NOW(), INTERVAL {days} DAY)
          AND ti.state IN (6, 8, 9)
        ORDER BY ti.start_time DESC
        LIMIT 50;
        """
    ).strip()


def render_slow_tasks(config: CountryConfig, project_code: str, days: int) -> str:
    return dedent(
        f"""
        -- slow_tasks: longest successful task runs for one DS project
        SELECT
          ti.task_code,
          ti.name AS task_name,
          COUNT(*) AS run_count,
          AVG(TIMESTAMPDIFF(SECOND, ti.start_time, ti.end_time)) AS avg_duration_sec,
          MAX(TIMESTAMPDIFF(SECOND, ti.start_time, ti.end_time)) AS max_duration_sec,
          MAX(ti.start_time) AS last_start_time,
          MAX(ti.id) AS sample_task_instance_id,
          MAX(ti.{config.parent_instance_field}) AS sample_workflow_instance_id,
          MAX(ti.log_path) AS sample_log_path
        FROM {qname(config, "t_ds_task_instance")} ti
        WHERE ti.project_code = {project_code}
          AND ti.start_time >= DATE_SUB(NOW(), INTERVAL {days} DAY)
          AND ti.end_time IS NOT NULL
          AND ti.state = 7
        GROUP BY ti.task_code, ti.name
        ORDER BY max_duration_sec DESC, avg_duration_sec DESC
        LIMIT 50;
        """
    ).strip()


def render_daily_table_case(config: CountryConfig, table_name: str) -> str:
    token = sql_literal(table_name)
    return "\n\n".join(
        [
            "-- CASE 1: table_to_task_query\n" + render_table_to_task(config, table_name),
            "-- CASE 2: workflow_schedule_status\n"
            + render_workflow_schedule(config, "<workflow_code_from_case_1>", None),
            dedent(
                f"""
                -- CASE 3: recent_daily_instances
                SELECT
                  ti.id AS task_instance_id,
                  ti.task_code,
                  ti.name AS task_name,
                  ti.state AS task_state,
                  ti.start_time,
                  ti.end_time,
                  ti.{config.parent_instance_field} AS workflow_instance_id,
                  ti.host,
                  ti.log_path
                FROM {qname(config, "t_ds_task_instance")} ti
                WHERE ti.start_time >= DATE_SUB(NOW(), INTERVAL 14 DAY)
                  AND (
                    LOWER(ti.task_params) LIKE CONCAT('%', LOWER({token}), '%')
                    OR LOWER(ti.name) LIKE CONCAT('%', LOWER({token}), '%')
                  )
                ORDER BY ti.start_time DESC
                LIMIT 100;
                """
            ).strip(),
        ]
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--country", required=True, choices=sorted(COUNTRIES))
    parser.add_argument(
        "--query",
        required=True,
        choices=[
            "summary",
            "table-to-task",
            "workflow-schedule",
            "recent-task-runs",
            "failed-tasks",
            "slow-tasks",
            "daily-table-case",
        ],
    )
    parser.add_argument("--table-name")
    parser.add_argument("--workflow-code")
    parser.add_argument("--workflow-name")
    parser.add_argument("--task-code")
    parser.add_argument("--project-code")
    parser.add_argument("--days", type=int, default=30)
    return parser


def require(value: str | None, flag: str) -> str:
    if not value:
        raise SystemExit(f"{flag} is required for this query")
    return value


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    config = COUNTRIES[args.country]

    if args.query == "summary":
        sql = render_summary(config)
    elif args.query == "table-to-task":
        sql = render_table_to_task(config, require(args.table_name, "--table-name"))
    elif args.query == "workflow-schedule":
        sql = render_workflow_schedule(config, args.workflow_code, args.workflow_name)
    elif args.query == "recent-task-runs":
        sql = render_recent_task_runs(
            config, require(args.task_code, "--task-code"), args.days
        )
    elif args.query == "failed-tasks":
        sql = render_failed_tasks(
            config, require(args.project_code, "--project-code"), args.days
        )
    elif args.query == "slow-tasks":
        sql = render_slow_tasks(
            config, require(args.project_code, "--project-code"), args.days
        )
    elif args.query == "daily-table-case":
        sql = render_daily_table_case(config, require(args.table_name, "--table-name"))
    else:
        parser.error(f"Unsupported query: {args.query}")

    print(sql)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
