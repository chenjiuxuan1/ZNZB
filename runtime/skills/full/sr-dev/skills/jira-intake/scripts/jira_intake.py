#!/usr/bin/env python3
import argparse
import base64
import getpass
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

try:
    import yaml
except ModuleNotFoundError:
    yaml = None


DEFAULT_FIELDS = (
    "summary,description,status,assignee,reporter,priority,labels,components,"
    "fixVersions,created,updated,duedate,issuetype,project,parent,customfield_11541"
)
JIRA_CATEGORY_FIELD_KEY = "customfield_11541"
JIRA_CATEGORY_FIELD_NAME = "数据平台Jira工单分类"
JIRA_CATEGORY_SOURCE_SHEET_URL = (
    "https://docs.google.com/spreadsheets/d/"
    "1_1jzg0wUko-2XnNgm8Ftvlqxjr1yt7AI0QvAnbFTexs/edit?gid=0#gid=0"
)
DEFAULT_BASE_URL = "https://kylith.atlassian.net"
DEFAULT_JIRA_URL = f"{DEFAULT_BASE_URL}/jira/software/c/projects/DATA/boards/789"
DEFAULT_CONFIG_PATH = Path.home() / ".codex" / "jira-intake" / "config.yaml"
DEFAULT_PROFILE = "kylith"
DEFAULT_TRANSPORT = "rovo"
DEFAULT_GROUP_BY = [
    "status",
    "status_category",
    "assignee",
    "priority",
    "component",
    "label",
    "ownership_prefix",
    "jira_category",
    "country",
    "business_domain",
    "request_type",
]


class JiraConfigError(RuntimeError):
    pass


class JiraRequestError(RuntimeError):
    pass


def yaml_safe_load(text):
    if yaml is not None:
        return yaml.safe_load(text)
    if not str(text or "").strip():
        return None
    return json.loads(text)


def yaml_safe_dump(data, allow_unicode=True, sort_keys=False):
    if yaml is not None:
        return yaml.safe_dump(data, allow_unicode=allow_unicode, sort_keys=sort_keys)
    return json.dumps(data, ensure_ascii=not allow_unicode, indent=2) + "\n"


def parse_jira_url_defaults(jira_url):
    url = (jira_url or DEFAULT_JIRA_URL).strip()
    parsed = urllib.parse.urlparse(url)
    base_url = f"{parsed.scheme}://{parsed.netloc}".rstrip("/") if parsed.scheme and parsed.netloc else DEFAULT_BASE_URL
    path_parts = [part for part in parsed.path.split("/") if part]
    result = {"base_url": base_url or DEFAULT_BASE_URL}
    if "projects" in path_parts:
        index = path_parts.index("projects")
        if index + 1 < len(path_parts):
            result["default_project"] = path_parts[index + 1]
    if "boards" in path_parts:
        index = path_parts.index("boards")
        if index + 1 < len(path_parts):
            result["default_board_id"] = path_parts[index + 1]
    return result


def load_local_config(config_path=None):
    path = Path(config_path or DEFAULT_CONFIG_PATH)
    if not path.is_file():
        return {}
    data = yaml_safe_load(path.read_text(encoding="utf-8")) or {}
    return data if isinstance(data, dict) else {}


def write_local_config(config_path, data):
    path = Path(config_path or DEFAULT_CONFIG_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(yaml_safe_dump(data, allow_unicode=True, sort_keys=False), encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return path


def save_profile_config(config_path, profile, values, make_current=False):
    data = load_local_config(config_path)
    profiles = data.setdefault("profiles", {})
    profile_name = profile or DEFAULT_PROFILE
    existing = profiles.get(profile_name) or {}
    jira_defaults = parse_jira_url_defaults(
        values.get("jira_url") or values.get("base_url") or existing.get("base_url") or DEFAULT_JIRA_URL
    )
    next_profile = {**existing, **jira_defaults}
    for source_key, target_key in (
        ("base_url", "base_url"),
        ("email", "email"),
        ("api_token", "api_token"),
        ("token", "api_token"),
        ("transport", "transport"),
        ("default_project", "default_project"),
        ("default_board_id", "default_board_id"),
    ):
        value = values.get(source_key)
        if value not in (None, ""):
            next_profile[target_key] = str(value).strip()
    next_profile.setdefault("base_url", DEFAULT_BASE_URL)
    next_profile.setdefault("transport", DEFAULT_TRANSPORT)
    next_profile.setdefault("default_project", "DATA")
    next_profile.setdefault("default_board_id", "789")
    profiles[profile_name] = next_profile
    if make_current or not data.get("current_profile"):
        data["current_profile"] = profile_name
    return write_local_config(config_path, data)


def resolve_jira_config(base_url=None, email=None, token=None, config_path=None, environ=None, profile=None):
    env = os.environ if environ is None else environ
    local = load_local_config(config_path)
    profile_name = profile or env.get("JIRA_PROFILE") or local.get("current_profile") or DEFAULT_PROFILE
    profiles = local.get("profiles") if isinstance(local.get("profiles"), dict) else {}
    local_profile = profiles.get(profile_name) or {}
    config = {
        "profile": profile_name,
        "base_url": DEFAULT_BASE_URL,
        "transport": DEFAULT_TRANSPORT,
        "email": "",
        "api_token": "",
        "default_project": "DATA",
        "default_board_id": "789",
        "config_path": str(Path(config_path or DEFAULT_CONFIG_PATH)),
    }
    for key in ("base_url", "transport", "email", "api_token", "default_project", "default_board_id"):
        if local_profile.get(key):
            config[key] = str(local_profile[key]).strip()
    env_mapping = {
        "JIRA_BASE_URL": "base_url",
        "JIRA_TRANSPORT": "transport",
        "JIRA_EMAIL": "email",
        "JIRA_API_TOKEN": "api_token",
        "JIRA_DEFAULT_PROJECT": "default_project",
        "JIRA_DEFAULT_BOARD_ID": "default_board_id",
    }
    for env_key, config_key in env_mapping.items():
        if env.get(env_key):
            config[config_key] = str(env[env_key]).strip()
    if base_url:
        config["base_url"] = str(base_url).strip()
    if email:
        config["email"] = str(email).strip()
    if token:
        config["api_token"] = str(token).strip()
    config["base_url"] = parse_jira_url_defaults(config["base_url"]).get("base_url", DEFAULT_BASE_URL).rstrip("/")
    config["transport"] = (config.get("transport") or DEFAULT_TRANSPORT).strip().lower()
    if config["transport"] not in {"rovo", "rest", "auto"}:
        config["transport"] = DEFAULT_TRANSPORT
    return config


def validate_rest_config(config):
    missing = []
    if not config.get("email"):
        missing.append("JIRA_EMAIL")
    if not config.get("api_token"):
        missing.append("JIRA_API_TOKEN")
    if missing:
        command = (
            "python3 jira-intake/scripts/jira_intake.py "
            "config init --transport rest --email <your-email> --api-token <token>"
        )
        raise JiraConfigError(
            "Missing required Jira REST fallback config: "
            + ", ".join(missing)
            + f". Default JIRA_BASE_URL is {DEFAULT_BASE_URL}. Run: {command}"
        )
    return True


def validate_required_config(config):
    return validate_rest_config(config)


def redacted_config(config):
    safe = dict(config)
    token = safe.get("api_token") or ""
    safe["api_token"] = f"{token[:4]}...{token[-4:]}" if len(token) >= 8 else "***" if token else ""
    return safe


def prompt_missing_value(name, current="", secret=False):
    if current:
        return current
    if sys.stdin.isatty():
        prompt = f"{name}: "
        return getpass.getpass(prompt) if secret else input(prompt).strip()
    raise SystemExit(
        f"{name} is required. Re-run config init with --{name.lower().replace('_', '-')}."
    )


def adf_to_text(value):
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    parts = []

    def walk(node):
        if isinstance(node, dict):
            text = node.get("text")
            if text:
                parts.append(str(text))
            for child in node.get("content") or []:
                walk(child)
            if node.get("type") in {"paragraph", "heading", "listItem"}:
                parts.append("\n")
        elif isinstance(node, list):
            for child in node:
                walk(child)

    walk(value)
    lines = [" ".join(line.split()) for line in "".join(parts).splitlines()]
    return "\n".join(line for line in lines if line).strip()


def _display_name(value):
    return value.get("displayName") if isinstance(value, dict) else ""


def _field_name(value):
    return value.get("name") if isinstance(value, dict) else ""


def _field_names(values):
    if not isinstance(values, list):
        return []
    return [item.get("name") for item in values if isinstance(item, dict) and item.get("name")]


def _parse_cascading_option(value):
    if not isinstance(value, dict):
        return {"primary": "", "secondary": "", "display": ""}
    primary = str(value.get("value") or value.get("name") or "").strip()
    child = value.get("child") if isinstance(value.get("child"), dict) else {}
    secondary = str(child.get("value") or child.get("name") or "").strip()
    display = _format_jira_category(primary, secondary)
    return {"primary": primary, "secondary": secondary, "display": display}


def _comments_from_response(comments):
    records = []
    for comment in comments or []:
        if not isinstance(comment, dict):
            continue
        records.append(
            {
                "id": str(comment.get("id") or ""),
                "author": _display_name(comment.get("author")),
                "created": comment.get("created") or "",
                "updated": comment.get("updated") or "",
                "body": adf_to_text(comment.get("body")),
            }
        )
    return records


def normalize_jira_payload(data):
    if not isinstance(data, dict):
        return {"issues": [], "total": 0, "source_transport": "unknown"}

    issues_container = data.get("issues")
    if isinstance(issues_container, dict) and isinstance(issues_container.get("nodes"), list):
        page_info = issues_container.get("pageInfo") or {}
        nodes = []
        for issue in issues_container.get("nodes") or []:
            if isinstance(issue, dict):
                copied = dict(issue)
                copied.setdefault("source_transport", "atlassian-rovo")
                nodes.append(copied)
        return {
            "issues": nodes,
            "total": issues_container.get("totalCount", len(nodes)),
            "isLast": not bool(page_info.get("hasNextPage")),
            "nextPageToken": page_info.get("endCursor") or "",
            "webUrl": issues_container.get("webUrl") or "",
            "source_transport": "atlassian-rovo",
        }

    if isinstance(issues_container, list):
        return {
            **data,
            "source_transport": data.get("source_transport") or data.get("transport") or "jira-rest",
        }

    if data.get("fields"):
        copied = dict(data)
        copied.setdefault("source_transport", data.get("source_transport") or data.get("transport") or "jira-rest")
        return {"issues": [copied], "total": 1, "isLast": True, "source_transport": copied["source_transport"]}

    return data


def build_issue_record(issue, comments=None, base_url=""):
    fields = issue.get("fields") or {}
    key = issue.get("key") or fields.get("key")
    status = fields.get("status") or {}
    project = fields.get("project") or {}
    record = {
        "key": key,
        "ticket_id": key,
        "source": "jira",
        "source_transport": issue.get("source_transport") or issue.get("transport") or "jira-rest",
        "source_url": f"{base_url.rstrip('/')}/browse/{key}" if base_url and key else "",
        "title": fields.get("summary") or key or "",
        "description": adf_to_text(fields.get("description")),
        "jira": {
            "site": base_url.rstrip("/") if base_url else "",
            "issue_id": str(issue.get("id") or ""),
            "issue_key": key,
            "project_key": project.get("key") or "",
            "issue_type": _field_name(fields.get("issuetype")),
            "status": status.get("name") or "",
            "status_category": (status.get("statusCategory") or {}).get("name") or "",
            "priority": _field_name(fields.get("priority")),
            "reporter": _display_name(fields.get("reporter")),
            "assignee": _display_name(fields.get("assignee")),
            "components": _field_names(fields.get("components")),
            "labels": fields.get("labels") if isinstance(fields.get("labels"), list) else [],
            "data_platform_category": _parse_cascading_option(fields.get(JIRA_CATEGORY_FIELD_KEY)),
            "created": fields.get("created") or "",
            "updated": fields.get("updated") or "",
            "due": fields.get("duedate") or "",
        },
        "comments": _comments_from_response(comments),
    }
    return record


COUNTRY_ALIASES = {
    "cn": ["中国", "china", " cn ", "cn_", "/cn/"],
    "mx": ["墨西哥", "mexico", " mx ", "mx_", "/mx/"],
    "th": ["泰国", "thailand", " th ", "th_", "/th/"],
    "id": ["印尼", "印度尼西亚", "indonesia", " ine ", " id ", "id_", "/ine/", "/id/"],
    "pk": ["巴基斯坦", "pakistan", " pk ", "pk_", "/pk/"],
    "ph": ["菲律宾", "philippines", " ph ", "ph_", "/ph/"],
}

BUSINESS_DOMAIN_ALIASES = [
    ("afterloan", ["贷后", "afterloan", "fox", "boc", "催收", "回款", "资产"]),
    ("risk", ["风控", "risk", "授信", "反欺诈", "逾期"]),
    ("marketing", ["营销", "marketing", "投放", "渠道", "获客"]),
    ("operation", ["运营", "operation", "客服", "工单"]),
    ("finance", ["财务", "finance", "对账", "账务"]),
    ("platform", ["平台", "治理", "元数据", "权限", "调度", "质量", "dqc"]),
]

REQUEST_TYPE_ALIASES = [
    ("development", ["开发", "改造", "变更", "上线", "建表", "建模", "字段", "testdb", "修复验证"]),
    ("quality", ["质量", "dqc", "稽核", "校验", "延迟", "freshness", "异常", "报错", "修复"]),
    ("analysis", ["分析", "查询", "统计", "口径", "报表", "日报", "周报", "看一下"]),
    ("access", ["权限", "账号", "申请", "开通"]),
]

JIRA_CATEGORY_OPTIONS = {
    "业务需求": ["报表迭代/新增", "指标需求", "业务取数", "数据分析支持", "数据产品支持"],
    "数据同步需求": [
        "新数据源接入",
        "离线同步",
        "实时同步",
        "接口 / API 同步",
        "第三方 SaaS 数据同步",
        "同步链路改造",
    ],
    "数据中台建设": [
        "数据集成",
        "数据质量",
        "数据地图",
        "数据权限",
        "实时数据资产",
        "数据服务 / API",
        "监控告警",
        "安全生产",
        "架构设计",
    ],
    "宽表建设": [
        "用户主题宽表",
        "订单主题宽表",
        "商品主题宽表",
        "营销主题宽表",
        "财务主题宽表",
        "经营分析宽表",
        "风控主题宽表",
    ],
    "数据治理": [
        "指标口径治理",
        "数据标准",
        "表 / 字段命名规范",
        "数据质量治理",
        "数据资产治理",
        "权限治理",
        "生命周期治理",
        "成本治理",
        "安全合规治理",
    ],
    "运维与稳定性": [
        "数据延迟处理",
        "数据异常排查",
        "告警优化",
        "SLA 保障",
        "性能优化",
        "容量 / 资源治理",
        "ds 调度平台融合",
        "安全生产",
        "监控告警",
        "superset 优化",
        "jupyterhub on k8s",
    ],
    "技术债与优化": ["架构重构", "老任务下线", "公共逻辑复用", "脚本规范化", "存储优化", "计算资源优化"],
    "临时支持": ["查数导数", "问题排查"],
}

JIRA_CATEGORY_RULES = [
    {
        "category": ("运维与稳定性", "容量 / 资源治理"),
        "aliases": ["容量", "资源治理", "资源限额", "高内存", "内存", "大扫描", "强杀", "resource-governance"],
        "confidence": "high",
    },
    {
        "category": ("运维与稳定性", "ds 调度平台融合"),
        "aliases": ["ds 调度", "dolphinscheduler", "ds workflow", "工作流", "调度平台"],
        "confidence": "high",
    },
    {
        "category": ("运维与稳定性", "数据延迟处理"),
        "aliases": ["延迟", "freshness", "产出慢", "未产出"],
        "excludes_any": ["宽表", "主题表"],
        "confidence": "high",
    },
    {
        "category": ("运维与稳定性", "数据异常排查"),
        "aliases": ["异常", "报错", "失败", "问题排查", "排查"],
        "confidence": "medium",
    },
    {
        "category": ("运维与稳定性", "性能优化"),
        "aliases": ["性能", "优化", "耗时", "慢查询", "降频", "错峰"],
        "confidence": "medium",
    },
    {
        "category": ("宽表建设", "营销主题宽表"),
        "aliases": ["营销", "优惠券", "coupon", "活动"],
        "requires_any": ["宽表", "主题表", "dws", "dwb", "dm_"],
        "confidence": "high",
    },
    {
        "category": ("宽表建设", "风控主题宽表"),
        "aliases": ["贷后", "fox", "逾期", "催收", "授信", "风控", "risk", "回款"],
        "requires_any": ["宽表", "主题表", "dwd", "dwb", "dws", "dm_", "表"],
        "confidence": "high",
    },
    {
        "category": ("宽表建设", "财务主题宽表"),
        "aliases": ["财务", "对账", "账务", "回款"],
        "requires_any": ["宽表", "主题表", "dwd", "dwb", "dws", "dm_", "表"],
        "confidence": "medium",
    },
    {
        "category": ("业务需求", "报表迭代/新增"),
        "aliases": ["报表", "看板", "日报", "周报", "统计", "dashboard"],
        "confidence": "high",
    },
    {
        "category": ("业务需求", "指标需求"),
        "aliases": ["指标", "口径", "计算口径"],
        "confidence": "high",
    },
    {
        "category": ("业务需求", "业务取数"),
        "aliases": ["取数", "查数", "导数", "明细"],
        "confidence": "high",
    },
    {
        "category": ("数据同步需求", "新数据源接入"),
        "aliases": ["新数据源", "数据源接入", "接入数据源"],
        "confidence": "high",
    },
    {
        "category": ("数据同步需求", "离线同步"),
        "aliases": ["离线同步", "离线接入", "批同步"],
        "confidence": "high",
    },
    {
        "category": ("数据同步需求", "实时同步"),
        "aliases": ["实时同步", "实时接入", "flink"],
        "confidence": "high",
    },
    {
        "category": ("数据同步需求", "接口 / API 同步"),
        "aliases": ["api 同步", "接口同步", "接口 / api", "接口/api"],
        "confidence": "high",
    },
    {
        "category": ("数据中台建设", "数据地图"),
        "aliases": ["数据地图", "datamap"],
        "confidence": "high",
    },
    {
        "category": ("数据中台建设", "数据权限"),
        "aliases": ["权限", "账号", "授权"],
        "confidence": "high",
    },
    {
        "category": ("数据中台建设", "数据质量"),
        "aliases": ["数据质量", "dqc", "质量校验"],
        "confidence": "high",
    },
    {
        "category": ("数据中台建设", "监控告警"),
        "aliases": ["监控", "告警"],
        "confidence": "medium",
    },
    {
        "category": ("数据中台建设", "架构设计"),
        "aliases": ["架构", "agent", "skill", "dw-dev", "jira-intake", "$sr-box"],
        "confidence": "medium",
    },
    {
        "category": ("数据治理", "指标口径治理"),
        "aliases": ["指标治理", "口径治理", "口径统一"],
        "confidence": "high",
    },
    {
        "category": ("数据治理", "表 / 字段命名规范"),
        "aliases": ["命名规范", "字段规范", "表规范"],
        "confidence": "high",
    },
    {
        "category": ("技术债与优化", "架构重构"),
        "aliases": ["重构", "架构优化"],
        "confidence": "high",
    },
    {
        "category": ("技术债与优化", "老任务下线"),
        "aliases": ["下线", "停调度", "老任务"],
        "confidence": "medium",
    },
    {
        "category": ("临时支持", "问题排查"),
        "aliases": ["临时", "排查", "看一下"],
        "confidence": "low",
    },
]

DEFAULT_OWNERSHIP_PREFIX = "数据需求"

OWNERSHIP_PREFIX_ALIASES = [
    (
        "数仓Agent",
        [
            "数仓agent",
            "ws agent",
            "dw-dev",
            "dw-modeling",
            "dw-sql-builder",
            "jira-intake",
            "dw-knowledge",
            "rovo",
            "skill",
            "agent workbench",
        ],
    ),
    (
        "数据开发",
        [
            "数据开发",
            "etl",
            "dolphinscheduler",
            "starrocks",
            "hive",
            "paimon",
            "建表",
            "改表",
            "建模",
            "上线",
            "生产发布",
            "testdb",
            "ddl",
            "dml",
        ],
    ),
    (
        "底表迭代",
        [
            "底表",
            "底层表",
            "底层",
            "宽表",
            "dwd",
            "dwb",
            "dws",
            "ods",
            "dim",
            "明细表",
        ],
    ),
    (
        "基础建设",
        [
            "基础建设",
            "平台",
            "治理",
            "元数据",
            "权限",
            "调度",
            "监控",
            "告警",
            "数据质量",
            "dqc",
            "组件",
            "工具",
        ],
    ),
    (
        "数据需求",
        [
            "数据需求",
            "取数",
            "报表",
            "看板",
            "指标",
            "分析",
            "查询",
            "统计",
            "日报",
            "周报",
        ],
    ),
]


def _classification_text(record):
    jira = record.get("jira") or {}
    values = [
        record.get("ticket_id") or "",
        record.get("title") or "",
        record.get("description") or "",
        " ".join(jira.get("components") or []),
        " ".join(jira.get("labels") or []),
    ]
    return " " + " ".join(values).lower().replace("\\", "/") + " "


def _match_aliases(text, aliases):
    for alias in aliases:
        if alias.lower() in text:
            return True
    return False


def _format_jira_category(primary, secondary=""):
    primary = str(primary or "").strip()
    secondary = str(secondary or "").strip()
    if primary and secondary:
        return f"{primary} / {secondary}"
    return primary or secondary or "unknown"


def _jira_category_field_value(primary, secondary=""):
    primary = str(primary or "").strip()
    secondary = str(secondary or "").strip()
    if not primary:
        return {}
    value = {"value": primary}
    if secondary:
        value["child"] = {"value": secondary}
    return value


def _build_jira_category(primary, secondary="", source="inferred", confidence="medium", reason=""):
    primary = str(primary or "").strip()
    secondary = str(secondary or "").strip()
    valid = primary in JIRA_CATEGORY_OPTIONS and (
        not secondary or secondary in JIRA_CATEGORY_OPTIONS.get(primary, [])
    )
    return {
        "field_key": JIRA_CATEGORY_FIELD_KEY,
        "field_name": JIRA_CATEGORY_FIELD_NAME,
        "primary": primary,
        "secondary": secondary,
        "display": _format_jira_category(primary, secondary),
        "field_value": _jira_category_field_value(primary, secondary),
        "source": source,
        "confidence": confidence,
        "valid_option": bool(valid),
        "source_sheet": JIRA_CATEGORY_SOURCE_SHEET_URL,
        "reason": reason,
    }


def _category_rule_matches(text, rule):
    if rule.get("requires_any") and not _match_aliases(text, rule.get("requires_any")):
        return False
    if rule.get("excludes_any") and _match_aliases(text, rule.get("excludes_any")):
        return False
    return _match_aliases(text, rule.get("aliases") or [])


def infer_jira_category(record):
    existing = (record.get("jira") or {}).get("data_platform_category") or {}
    if existing.get("primary"):
        return _build_jira_category(
            existing.get("primary"),
            existing.get("secondary"),
            source="jira_field",
            confidence="confirmed",
            reason="existing Jira cascading field",
        )

    text = _classification_text(record)
    for rule in JIRA_CATEGORY_RULES:
        if _category_rule_matches(text, rule):
            primary, secondary = rule["category"]
            return _build_jira_category(
                primary,
                secondary,
                source="inferred",
                confidence=rule.get("confidence") or "medium",
                reason=", ".join(rule.get("aliases") or []),
            )

    ownership_prefix = infer_ownership_prefix(record)
    fallback = {
        "基础建设": ("数据中台建设", "架构设计"),
        "底表迭代": ("宽表建设", "经营分析宽表"),
        "数据需求": ("业务需求", "数据分析支持"),
        "数据开发": ("技术债与优化", "公共逻辑复用"),
        "数仓Agent": ("数据中台建设", "架构设计"),
    }.get(ownership_prefix)
    if fallback:
        return _build_jira_category(
            fallback[0],
            fallback[1],
            source="ownership_fallback",
            confidence="low",
            reason=f"ownership_prefix={ownership_prefix}",
        )
    return _build_jira_category("", "", source="unknown", confidence="none")


def extract_ownership_prefix(title):
    title = str(title or "").strip()
    if not title.startswith("【"):
        return ""
    end_index = title.find("】")
    if end_index <= 1:
        return ""
    return title[1:end_index].strip()


def strip_ownership_prefix(title):
    title = str(title or "").strip()
    prefix = extract_ownership_prefix(title)
    if not prefix:
        return title
    return title[title.find("】") + 1 :].strip()


def infer_ownership_prefix(record):
    existing = extract_ownership_prefix(record.get("title") or "")
    if existing:
        return existing
    text = _classification_text(record)
    for prefix, aliases in OWNERSHIP_PREFIX_ALIASES:
        if _match_aliases(text, aliases):
            return prefix
    return DEFAULT_OWNERSHIP_PREFIX


def ensure_ownership_title(title, ownership_prefix=None):
    title = str(title or "").strip()
    existing = extract_ownership_prefix(title)
    if existing:
        return title
    prefix = ownership_prefix or DEFAULT_OWNERSHIP_PREFIX
    return f"【{prefix}】 {title}".strip() if title else f"【{prefix}】"


def classify_issue_record(record):
    text = _classification_text(record)
    countries = [country for country, aliases in COUNTRY_ALIASES.items() if _match_aliases(text, aliases)]
    business_domain = "unknown"
    for domain, aliases in BUSINESS_DOMAIN_ALIASES:
        if _match_aliases(text, aliases):
            business_domain = domain
            break
    request_type = "unknown"
    for type_name, aliases in REQUEST_TYPE_ALIASES:
        if _match_aliases(text, aliases):
            request_type = type_name
            break
    ownership_prefix = infer_ownership_prefix(record)
    jira_category = infer_jira_category(record)
    return {
        "countries": countries,
        "business_domain": business_domain,
        "request_type": request_type,
        "ownership_prefix": ownership_prefix,
        "jira_category": jira_category,
        "title_with_ownership": ensure_ownership_title(
            record.get("title") or record.get("ticket_id") or "",
            ownership_prefix,
        ),
        "needs_manual_parse": not (
            countries
            and business_domain != "unknown"
            and request_type != "unknown"
            and jira_category.get("valid_option")
        ),
    }


def render_requirement_markdown(record):
    jira = record.get("jira") or {}
    comment_lines = []
    for comment in record.get("comments") or []:
        header = f"- {comment.get('author') or 'unknown'} / {comment.get('created') or ''}"
        body = comment.get("body") or ""
        comment_lines.append(f"{header}\n\n  {body}")
    return f"""# {record.get('title') or record.get('ticket_id')}

## 来源

- Source: jira
- Jira Key: {record.get('ticket_id') or ''}
- Jira URL: {record.get('source_url') or ''}
- Project: {jira.get('project_key') or ''}
- Reporter: {jira.get('reporter') or ''}
- Assignee: {jira.get('assignee') or ''}
- Status: {jira.get('status') or ''}
- Priority: {jira.get('priority') or ''}
- Components: {", ".join(jira.get('components') or [])}
- Labels: {", ".join(jira.get('labels') or [])}
- Created: {jira.get('created') or ''}
- Updated: {jira.get('updated') or ''}
- Due: {jira.get('due') or ''}

## 需求描述

{record.get('description') or ''}

## Jira 评论

{chr(10).join(comment_lines) if comment_lines else "无"}
"""


def render_requirement_yaml(record):
    classification = classify_issue_record(record)
    return {
        "ticket_id": record.get("ticket_id"),
        "source": "jira",
        "source_url": record.get("source_url") or "",
        "title": record.get("title") or "",
        "ownership_prefix": classification["ownership_prefix"],
        "title_with_ownership": classification["title_with_ownership"],
        "jira_category": classification["jira_category"],
        "status": record.get("jira", {}).get("status") or "unknown",
        "jira": record.get("jira") or {},
        "request_type": classification["request_type"],
        "business_domain": "" if classification["business_domain"] == "unknown" else classification["business_domain"],
        "countries": classification["countries"],
        "needs_manual_parse": classification["needs_manual_parse"],
    }


def render_initial_state(record):
    ticket_id = record.get("ticket_id") or record.get("key") or "unknown"
    return {
        "ticket_id": ticket_id,
        "status": "new",
        "current_phase": "intake",
        "current_skill": "dw-dev",
        "risk_level": "unknown",
        "source_tier": "unknown",
        "confidence": "uncertain",
        "requires_sr_execution": False,
        "requires_human_approval": ["jira_comment"],
        "context_loaded": [],
        "pending_decisions": [],
        "completed_steps": ["jira_intake"],
        "next_action": "parse_requirement",
        "updated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
    }


def render_initial_decision_trace(record):
    return {
        "ticket_id": record.get("ticket_id") or record.get("key") or "unknown",
        "schema_version": "1.0.0",
        "steps": [
            {
                "skill": "jira-intake",
                "action": "fetch",
                "decision": "Jira issue was fetched into local DW Dev artifacts.",
                "evidence": ["06-evidence/jira-issue.json"],
            }
        ],
    }


def render_initial_map_summary(record):
    ticket_id = record.get("ticket_id") or record.get("key") or "unknown"
    classification = record.get("classification") or classify_issue_record(record)
    title = classification.get("title_with_ownership") or record.get("title") or ticket_id
    return {
        "ticket_id": ticket_id,
        "schema_version": "1.0.0",
        "title": title,
        "display": {
            "title": title[:21] + "..." if len(title) > 22 else title,
            "subtitle": ticket_id,
            "detail_title": title,
        },
        "status": "new",
        "current_phase": "intake",
        "current_skill": "dw-dev",
        "route": {"route_type": "unknown", "target_skill": "dw-dev"},
        "summary": {
            "problem": title,
            "conclusion": "",
            "next_action": "parse_requirement",
        },
        "materials": {
            "requirement": "present",
            "state": "present",
            "clarification": "missing",
            "task_plan": "missing",
            "context": "missing",
            "sql": "missing",
            "evidence": "present",
            "review": "missing",
            "delivery": "missing",
            "jira_comment": "missing",
            "decision_trace": "present",
        },
        "blockers": [],
        "missing_materials": [
            "03-task-plan.md",
            "04-context.md",
            "05-sql/",
            "07-review.md",
            "08-delivery.md",
            "09-jira-comment.md",
        ],
        "artifact_order": [
            "00-requirement.md",
            "01-requirement.yaml",
            "02-clarification.md",
            "03-task-plan.md",
            "04-context.md",
            "05-sql/01_check_source.sql",
            "05-sql/02_validate_testdb.sql",
            "05-sql/03_final_query.sql",
            "06-evidence/01_sr_query_result.md",
            "06-evidence/02_freshness_check.md",
            "07-review.md",
            "08-delivery.md",
            "09-jira-comment.md",
            "10-decision-trace.yaml",
        ],
        "updated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
    }


def write_issue_workspace(output_dir, record):
    output = Path(output_dir)
    (output / "06-evidence").mkdir(parents=True, exist_ok=True)
    files = {
        "00-state.yaml": yaml_safe_dump(
            render_initial_state(record),
            allow_unicode=True,
            sort_keys=False,
        ),
        "00-requirement.md": render_requirement_markdown(record),
        "01-requirement.yaml": yaml_safe_dump(
            render_requirement_yaml(record),
            allow_unicode=True,
            sort_keys=False,
        ),
        "06-evidence/jira-issue.json": json.dumps(record, ensure_ascii=False, indent=2),
        "10-decision-trace.yaml": yaml_safe_dump(
            render_initial_decision_trace(record),
            allow_unicode=True,
            sort_keys=False,
        ),
        "11-map-summary.yaml": yaml_safe_dump(
            render_initial_map_summary(record),
            allow_unicode=True,
            sort_keys=False,
        ),
    }
    protected_existing = {"00-state.yaml", "10-decision-trace.yaml", "11-map-summary.yaml"}
    written = []
    for relative, content in files.items():
        path = output / relative
        if relative in protected_existing and path.exists():
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        written.append(relative)
    return sorted(written)


def _group_increment(groups, group_name, value):
    if not isinstance(value, list):
        value = [value]
    if not value:
        value = ["unknown"]
    bucket = groups.setdefault(group_name, {})
    for item in value:
        key = str(item or "unknown")
        bucket[key] = bucket.get(key, 0) + 1


def _group_values(record, group_name):
    jira = record.get("jira") or {}
    classification = record.get("classification") or classify_issue_record(record)
    if group_name == "status":
        return jira.get("status") or "unknown"
    if group_name == "status_category":
        return jira.get("status_category") or "unknown"
    if group_name == "assignee":
        return jira.get("assignee") or "unassigned"
    if group_name == "reporter":
        return jira.get("reporter") or "unknown"
    if group_name == "priority":
        return jira.get("priority") or "unknown"
    if group_name == "issue_type":
        return jira.get("issue_type") or "unknown"
    if group_name == "component":
        return jira.get("components") or ["none"]
    if group_name == "label":
        return jira.get("labels") or ["none"]
    if group_name == "ownership_prefix":
        return classification.get("ownership_prefix") or "unknown"
    if group_name == "jira_category":
        category = classification.get("jira_category") or {}
        return category.get("display") or "unknown"
    if group_name == "jira_category_primary":
        category = classification.get("jira_category") or {}
        return category.get("primary") or "unknown"
    if group_name == "jira_category_secondary":
        category = classification.get("jira_category") or {}
        return category.get("secondary") or "unknown"
    if group_name == "country":
        return classification.get("countries") or ["unknown"]
    if group_name == "business_domain":
        return classification.get("business_domain") or "unknown"
    if group_name == "request_type":
        return classification.get("request_type") or "unknown"
    return "unsupported"


def parse_group_by(value):
    if not value:
        return list(DEFAULT_GROUP_BY)
    if isinstance(value, str):
        raw_values = value.split(",")
    else:
        raw_values = []
        for item in value:
            raw_values.extend(str(item).split(","))
    return [item.strip() for item in raw_values if item.strip()]


def build_search_report(search_data, base_url="", jql="", group_by=None):
    search_data = normalize_jira_payload(search_data)
    group_names = parse_group_by(group_by)
    records = []
    groups = {}
    for issue in search_data.get("issues") or []:
        record = build_issue_record(issue, base_url=base_url)
        record["classification"] = classify_issue_record(record)
        records.append(record)
        for group_name in group_names:
            _group_increment(groups, group_name, _group_values(record, group_name))
    return {
        "schema_version": "1.0.0",
        "source": "jira",
        "source_transport": search_data.get("source_transport") or "jira-rest",
        "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "jql": jql,
        "summary": {
            "returned": len(records),
            "jira_total": search_data.get("total", len(records)),
            "is_last": search_data.get("isLast"),
            "next_page_token": search_data.get("nextPageToken") or "",
        },
        "group_by": group_names,
        "groups": groups,
        "issues": records,
    }


def classify_input_data(data, base_url=""):
    if isinstance(data, dict) and data.get("fields"):
        record = build_issue_record(data, base_url=base_url)
        classification = classify_issue_record(record)
        return {
            "schema_version": "1.0.0",
            "source": "jira",
            "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
            "issue": record,
            "classification": classification,
        }
    data = normalize_jira_payload(data)
    if isinstance(data, dict) and isinstance(data.get("issues"), list):
        return build_search_report(data, base_url=base_url)
    record = data
    classification = classify_issue_record(record)
    return {
        "schema_version": "1.0.0",
        "source": "jira",
        "generated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "issue": record,
        "classification": classification,
    }


def build_operation_plan(operation, issue_key, transition_id="", comment_path="", attachment_paths=None):
    inputs = []
    if comment_path:
        inputs.append(comment_path)
    inputs.extend(attachment_paths or [])
    return {
        "schema_version": "1.0.0",
        "issue_key": issue_key,
        "operation": operation,
        "transition_id": transition_id,
        "inputs": inputs,
        "requires_confirmation": True,
        "executed": False,
        "created_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "safety_boundary": "Do not execute Jira writes unless the user explicitly confirms the exact operation.",
    }


def build_operation_audit(
    source_transport,
    operation,
    issue_key,
    before,
    after,
    transition=None,
    result=None,
    actor=None,
    executed=True,
):
    return {
        "schema_version": "1.0.0",
        "source": "jira",
        "source_transport": source_transport or "atlassian-rovo",
        "operation": operation,
        "issue_key": issue_key,
        "executed": bool(executed),
        "created_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "actor": actor or {},
        "transition": transition or {},
        "before": before or {},
        "after": after or {},
        "result": result or {},
        "safety_boundary": "Executed only after explicit user confirmation; record contains no credentials.",
    }


class JiraClient:
    def __init__(self, base_url=None, email=None, token=None, config_path=None, environ=None, profile=None):
        config = resolve_jira_config(
            base_url=base_url,
            email=email,
            token=token,
            config_path=config_path,
            environ=environ,
            profile=profile,
        )
        validate_rest_config(config)
        self.config = config
        self.base_url = config["base_url"].rstrip("/")
        self.email = config["email"]
        self.token = config["api_token"]

    def request(self, method, path, query=None, body=None):
        url = f"{self.base_url}{path}"
        if query:
            url = f"{url}?{urllib.parse.urlencode(query)}"
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Authorization": "Basic "
            + base64.b64encode(f"{self.email}:{self.token}".encode("utf-8")).decode("ascii"),
        }
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                text = response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise JiraRequestError(f"{method} {path} failed: HTTP {exc.code}: {detail}") from exc
        if not text:
            return {}
        return json.loads(text)

    def issue(self, issue_key):
        return self.request(
            "GET",
            f"/rest/api/3/issue/{urllib.parse.quote(issue_key)}",
            query={
                "fields": DEFAULT_FIELDS,
                "expand": "renderedFields,names,schema,changelog",
            },
        )

    def comments(self, issue_key):
        data = self.request("GET", f"/rest/api/3/issue/{urllib.parse.quote(issue_key)}/comment")
        return data.get("comments") or []

    def search(self, jql, max_results=50):
        return self.request(
            "GET",
            "/rest/api/3/search/jql",
            query={"jql": jql, "maxResults": int(max_results), "fields": DEFAULT_FIELDS},
        )

    def transitions(self, issue_key):
        return self.request("GET", f"/rest/api/3/issue/{urllib.parse.quote(issue_key)}/transitions")

    def myself(self):
        return self.request("GET", "/rest/api/3/myself")

    def add_comment(self, issue_key, body_text):
        return self.request(
            "POST",
            f"/rest/api/3/issue/{urllib.parse.quote(issue_key)}/comment",
            body={"body": text_to_adf(body_text)},
        )

    def transition(self, issue_key, transition_id):
        return self.request(
            "POST",
            f"/rest/api/3/issue/{urllib.parse.quote(issue_key)}/transitions",
            body={"transition": {"id": str(transition_id)}},
        )


def _transition_status_snapshot(issue):
    record = build_issue_record(issue)
    jira = record.get("jira") or {}
    return {
        "issue_key": record.get("ticket_id") or "",
        "title": record.get("title") or "",
        "status": jira.get("status") or "",
        "status_category": jira.get("status_category") or "",
    }


def _find_transition(transitions_data, transition_id):
    transitions = transitions_data.get("transitions") if isinstance(transitions_data, dict) else []
    for transition in transitions or []:
        if str(transition.get("id")) == str(transition_id):
            return transition
    available = [
        {"id": str(item.get("id") or ""), "name": item.get("name") or ""}
        for item in transitions or []
        if isinstance(item, dict)
    ]
    raise JiraRequestError(
        f"Transition id {transition_id!r} is not available for this issue. Available transitions: {available}"
    )


def execute_transition_with_audit(client, issue_key, transition_id):
    before_issue = client.issue(issue_key)
    transitions_data = client.transitions(issue_key)
    transition = _find_transition(transitions_data, transition_id)
    result = client.transition(issue_key, transition_id)
    after_issue = client.issue(issue_key)
    target = transition.get("to") if isinstance(transition.get("to"), dict) else {}
    return {
        "schema_version": "1.0.0",
        "source": "jira",
        "operation": "transition",
        "issue_key": issue_key,
        "executed": True,
        "created_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "transition": {
            "id": str(transition.get("id") or transition_id),
            "name": transition.get("name") or "",
            "target_status": target.get("name") or "",
            "target_status_category": (target.get("statusCategory") or {}).get("name") or "",
        },
        "before": _transition_status_snapshot(before_issue),
        "after": _transition_status_snapshot(after_issue),
        "result": result,
        "safety_boundary": "Executed only after --confirm; record contains no Jira token.",
    }


def text_to_adf(text):
    return {
        "type": "doc",
        "version": 1,
        "content": [
            {
                "type": "paragraph",
                "content": [{"type": "text", "text": line}] if line else [],
            }
            for line in str(text or "").splitlines()
        ]
        or [{"type": "paragraph", "content": []}],
    }


def write_json(path, data):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def handle_config_command(args):
    config_path = Path(args.config_path or DEFAULT_CONFIG_PATH)
    if args.config_command == "init":
        existing = resolve_jira_config(config_path=config_path, profile=args.profile)
        transport = (args.transport or existing.get("transport") or DEFAULT_TRANSPORT).lower()
        email = args.email or existing.get("email") or ""
        token = args.api_token or existing.get("api_token") or ""
        if transport == "rest":
            email = prompt_missing_value("JIRA_EMAIL", email)
            token = prompt_missing_value("JIRA_API_TOKEN", token, secret=True)
        values = {
            "jira_url": args.jira_url or args.base_url or existing.get("base_url") or DEFAULT_JIRA_URL,
            "transport": transport,
            "email": email,
            "api_token": token,
            "default_project": args.default_project or existing.get("default_project") or "DATA",
            "default_board_id": args.default_board_id or existing.get("default_board_id") or "789",
        }
        path = save_profile_config(config_path, args.profile, values, make_current=True)
        config = resolve_jira_config(config_path=path, profile=args.profile)
        if config.get("transport") == "rest":
            validate_rest_config(config)
        print(
            json.dumps(
                {"success": True, "config_path": str(path), "config": redacted_config(config)},
                ensure_ascii=False,
            )
        )
        return

    if args.config_command == "show":
        config = resolve_jira_config(config_path=config_path, profile=args.profile)
        print(json.dumps(redacted_config(config), ensure_ascii=False, indent=2))
        return

    if args.config_command == "profiles":
        data = load_local_config(config_path)
        profiles = sorted((data.get("profiles") or {}).keys())
        print(
            json.dumps(
                {
                    "config_path": str(config_path),
                    "current_profile": data.get("current_profile") or "",
                    "profiles": profiles,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return

    if args.config_command == "use":
        data = load_local_config(config_path)
        profiles = data.get("profiles") or {}
        if args.profile_name not in profiles:
            raise SystemExit(f"Unknown Jira profile: {args.profile_name}")
        data["current_profile"] = args.profile_name
        write_local_config(config_path, data)
        print(json.dumps({"success": True, "current_profile": args.profile_name}, ensure_ascii=False))
        return

    if args.config_command == "check":
        config = resolve_jira_config(config_path=config_path, profile=args.profile)
        result = {"success": True, "config": redacted_config(config)}
        if args.connect or args.require_rest:
            validate_rest_config(config)
        if args.connect:
            client = JiraClient(config_path=config_path, profile=args.profile)
            myself = client.myself()
            result["jira_user"] = {
                "accountId": myself.get("accountId"),
                "displayName": myself.get("displayName"),
                "emailAddress": myself.get("emailAddress"),
            }
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return

    raise SystemExit(f"Unsupported config command: {args.config_command}")


def main():
    parser = argparse.ArgumentParser(description="Jira intake adapter for DW Dev.")
    sub = parser.add_subparsers(dest="command", required=True)

    config = sub.add_parser("config", help="Manage local Jira intake profiles.")
    config.add_argument("--config-path", default=str(DEFAULT_CONFIG_PATH))
    config_sub = config.add_subparsers(dest="config_command", required=True)

    config_init = config_sub.add_parser("init", help="Initialize or update a local Jira profile.")
    config_init.add_argument("--profile", default=DEFAULT_PROFILE)
    config_init.add_argument("--jira-url", default=DEFAULT_JIRA_URL)
    config_init.add_argument("--base-url", default="")
    config_init.add_argument("--transport", choices=["rovo", "rest", "auto"], default="")
    config_init.add_argument("--email", default="")
    config_init.add_argument("--api-token", default="")
    config_init.add_argument("--default-project", default="")
    config_init.add_argument("--default-board-id", default="")

    config_show = config_sub.add_parser("show", help="Show the active Jira profile with token redacted.")
    config_show.add_argument("--profile", default="")

    config_sub.add_parser("profiles", help="List local Jira profiles.")

    config_use = config_sub.add_parser("use", help="Switch the current Jira profile.")
    config_use.add_argument("profile_name")

    config_check = config_sub.add_parser("check", help="Check required Jira config and optionally connect.")
    config_check.add_argument("--profile", default="")
    config_check.add_argument("--connect", action="store_true")
    config_check.add_argument("--require-rest", action="store_true")

    fetch = sub.add_parser("fetch", help="Fetch one Jira issue into local requirement artifacts.")
    fetch.add_argument("issue_key")
    fetch.add_argument("--output-dir", required=True)
    fetch.add_argument("--include-comments", action="store_true")

    search = sub.add_parser("search", help="Run a bounded JQL search.")
    search.add_argument("--jql", required=True)
    search.add_argument("--max-results", type=int, default=50)
    search.add_argument("--output", required=True)

    stats = sub.add_parser("stats", help="Run JQL or read a Jira/Rovo JSON file and write grouped statistics.")
    stats.add_argument("--jql", default="")
    stats.add_argument("--input", default="")
    stats.add_argument("--max-results", type=int, default=50)
    stats.add_argument("--group-by", action="append", default=[])
    stats.add_argument("--output", required=True)

    classify = sub.add_parser("classify", help="Classify a Jira issue/search JSON file into management metadata.")
    classify.add_argument("--input", required=True)
    classify.add_argument("--output", required=True)

    transitions = sub.add_parser("transitions", help="Read available transitions for an issue.")
    transitions.add_argument("issue_key")
    transitions.add_argument("--output", required=True)

    comment_plan = sub.add_parser("comment-plan", help="Create a local Jira comment operation plan.")
    comment_plan.add_argument("issue_key")
    comment_plan.add_argument("--body-file", required=True)
    comment_plan.add_argument("--output", required=True)

    add_comment = sub.add_parser("add-comment", help="Add a Jira comment after explicit confirmation.")
    add_comment.add_argument("issue_key")
    add_comment.add_argument("--body-file", required=True)
    add_comment.add_argument("--confirm", action="store_true")

    transition_plan = sub.add_parser("transition-plan", help="Create a local Jira transition operation plan.")
    transition_plan.add_argument("issue_key")
    transition_plan.add_argument("--transition-id", required=True)
    transition_plan.add_argument("--output", required=True)

    transition = sub.add_parser("transition", help="Transition a Jira issue after explicit confirmation.")
    transition.add_argument("issue_key")
    transition.add_argument("--transition-id", required=True)
    transition.add_argument("--output", default="")
    transition.add_argument("--confirm", action="store_true")

    workspace_from_file = sub.add_parser(
        "workspace-from-file",
        help="Build DW Dev artifacts from a saved Jira REST or Atlassian Rovo issue JSON.",
    )
    workspace_from_file.add_argument("--input", required=True)
    workspace_from_file.add_argument("--issue-key", default="")
    workspace_from_file.add_argument("--base-url", default=DEFAULT_BASE_URL)
    workspace_from_file.add_argument("--output-dir", required=True)

    audit_operation = sub.add_parser("audit-operation", help="Write a local Jira/Rovo operation audit record.")
    audit_operation.add_argument("--source-transport", default="atlassian-rovo")
    audit_operation.add_argument("--operation", required=True)
    audit_operation.add_argument("--issue-key", required=True)
    audit_operation.add_argument("--before-status", default="")
    audit_operation.add_argument("--after-status", default="")
    audit_operation.add_argument("--transition-id", default="")
    audit_operation.add_argument("--transition-name", default="")
    audit_operation.add_argument("--target-status", default="")
    audit_operation.add_argument("--actor-name", default="")
    audit_operation.add_argument("--actor-email", default="")
    audit_operation.add_argument("--output", required=True)

    args = parser.parse_args()

    if args.command == "config":
        handle_config_command(args)
        return

    if args.command == "comment-plan":
        plan = build_operation_plan("comment", args.issue_key, comment_path=args.body_file)
        write_json(args.output, plan)
        print(json.dumps({"success": True, "output": args.output}, ensure_ascii=False))
        return
    if args.command == "transition-plan":
        plan = build_operation_plan("transition", args.issue_key, transition_id=args.transition_id)
        write_json(args.output, plan)
        print(json.dumps({"success": True, "output": args.output}, ensure_ascii=False))
        return

    if args.command in {"add-comment", "transition"} and not args.confirm:
        raise SystemExit("Refusing Jira write API call without --confirm")

    if args.command == "classify":
        data = json.loads(Path(args.input).read_text(encoding="utf-8"))
        result = classify_input_data(data)
        write_json(args.output, result)
        print(json.dumps({"success": True, "output": args.output}, ensure_ascii=False))
        return

    if args.command == "workspace-from-file":
        data = normalize_jira_payload(json.loads(Path(args.input).read_text(encoding="utf-8")))
        issues = data.get("issues") or []
        if args.issue_key:
            issues = [issue for issue in issues if issue.get("key") == args.issue_key]
        if len(issues) != 1:
            raise SystemExit(f"Expected exactly one issue, found {len(issues)}")
        record = build_issue_record(issues[0], base_url=args.base_url)
        written = write_issue_workspace(args.output_dir, record)
        print(json.dumps({"success": True, "output_dir": args.output_dir, "files": written}, ensure_ascii=False))
        return

    if args.command == "audit-operation":
        audit = build_operation_audit(
            source_transport=args.source_transport,
            operation=args.operation,
            issue_key=args.issue_key,
            before={"status": args.before_status} if args.before_status else {},
            after={"status": args.after_status} if args.after_status else {},
            transition={
                "id": args.transition_id,
                "name": args.transition_name,
                "target_status": args.target_status or args.after_status,
            },
            actor={"displayName": args.actor_name, "emailAddress": args.actor_email},
        )
        write_json(args.output, audit)
        print(json.dumps({"success": True, "output": args.output}, ensure_ascii=False))
        return

    client = None
    if args.command != "stats" or not args.input:
        client = JiraClient()
    if args.command == "fetch":
        issue = client.issue(args.issue_key)
        comments = client.comments(args.issue_key) if args.include_comments else []
        record = build_issue_record(issue, comments=comments, base_url=client.base_url)
        written = write_issue_workspace(args.output_dir, record)
        print(json.dumps({"success": True, "output_dir": args.output_dir, "files": written}, ensure_ascii=False))
    elif args.command == "search":
        data = client.search(args.jql, max_results=args.max_results)
        write_json(args.output, data)
        print(json.dumps({"success": True, "output": args.output, "total": data.get("total")}, ensure_ascii=False))
    elif args.command == "stats":
        if args.input:
            data = json.loads(Path(args.input).read_text(encoding="utf-8"))
        else:
            if not args.jql:
                raise SystemExit("stats requires --jql for REST fallback mode or --input for saved Jira/Rovo JSON")
            data = client.search(args.jql, max_results=args.max_results)
        report = build_search_report(
            data,
            base_url=client.base_url if client else DEFAULT_BASE_URL,
            jql=args.jql,
            group_by=parse_group_by(args.group_by),
        )
        write_json(args.output, report)
        print(
            json.dumps(
                {
                    "success": True,
                    "output": args.output,
                    "returned": report["summary"]["returned"],
                    "jira_total": report["summary"]["jira_total"],
                },
                ensure_ascii=False,
            )
        )
    elif args.command == "transitions":
        data = client.transitions(args.issue_key)
        write_json(args.output, data)
        print(json.dumps({"success": True, "output": args.output}, ensure_ascii=False))
    elif args.command == "add-comment":
        body = Path(args.body_file).read_text(encoding="utf-8")
        data = client.add_comment(args.issue_key, body)
        print(json.dumps({"success": True, "result": data}, ensure_ascii=False))
    elif args.command == "transition":
        data = execute_transition_with_audit(client, args.issue_key, args.transition_id)
        if args.output:
            write_json(args.output, data)
        print(json.dumps({"success": True, "output": args.output, "result": data}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (JiraConfigError, JiraRequestError) as exc:
        raise SystemExit(str(exc)) from exc
