#!/usr/bin/env python3
"""Manage private fallback tokens for DS Schedule Manager without echoing secrets."""

import argparse
import json
import os
from pathlib import Path
import sys
import tempfile


SUPPORTED_COUNTRIES = ("cn", "ine", "mx", "ph", "pk", "th")
DEFAULT_CONFIG_PATH = Path.home() / ".codex" / "secrets" / "ds-schedule-manager" / "tokens.json"
COUNTRY_ALIASES = {
    "cn": "cn",
    "中国": "cn",
    "ine": "ine",
    "id": "ine",
    "印尼": "ine",
    "印度尼西亚": "ine",
    "mx": "mx",
    "墨西哥": "mx",
    "ph": "ph",
    "菲律宾": "ph",
    "pk": "pk",
    "巴基斯坦": "pk",
    "th": "th",
    "泰国": "th",
}


class TokenResolution:
    def __init__(self, token, source, config_path=None):
        self.token = token
        self.source = source
        self.config_path = str(config_path) if config_path else ""


def normalize_country(value):
    normalized = str(value or "").strip().lower()
    country = COUNTRY_ALIASES.get(normalized)
    if country not in SUPPORTED_COUNTRIES:
        raise ValueError(f"unsupported DS country: {value}")
    return country


def configured_path(config_path=None, environ=None):
    environ = os.environ if environ is None else environ
    configured = config_path or environ.get("DS_SCHEDULE_MANAGER_TOKEN_CONFIG")
    return Path(configured).expanduser() if configured else DEFAULT_CONFIG_PATH


def read_token_config(config_path=None, environ=None):
    path = configured_path(config_path, environ)
    if not path.is_file():
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    raw_tokens = payload.get("tokens", payload) if isinstance(payload, dict) else {}
    if not isinstance(raw_tokens, dict):
        raise ValueError("token config must contain a tokens mapping")
    tokens = {}
    for raw_country, raw_token in raw_tokens.items():
        try:
            country = normalize_country(raw_country)
        except ValueError:
            continue
        token = str(raw_token or "").strip()
        if token:
            tokens[country] = token
    return tokens


def write_token_config(tokens, config_path=None):
    path = configured_path(config_path, {})
    path.parent.mkdir(parents=True, exist_ok=True)
    normalized = {}
    for raw_country, raw_token in dict(tokens or {}).items():
        country = normalize_country(raw_country)
        token = str(raw_token or "").strip()
        if token:
            normalized[country] = token
    payload = json.dumps(
        {"tokens": {country: normalized[country] for country in SUPPORTED_COUNTRIES if country in normalized}},
        ensure_ascii=False,
        indent=2,
        sort_keys=False,
    ) + "\n"
    file_descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        dir=str(path.parent),
        text=True,
    )
    temporary_path = Path(temporary_name)
    try:
        os.fchmod(file_descriptor, 0o600)
        with os.fdopen(file_descriptor, "w", encoding="utf-8") as handle:
            handle.write(payload)
        os.replace(str(temporary_path), str(path))
        os.chmod(path, 0o600)
    finally:
        if temporary_path.exists():
            temporary_path.unlink()
    return path


def resolve_token(country, explicit_token=None, config_path=None, environ=None):
    country = normalize_country(country)
    environ = os.environ if environ is None else environ
    token = str(explicit_token or "").strip()
    if token:
        return TokenResolution(token, "explicit")
    token = str(environ.get("DS_SCHEDULER_TOKEN") or "").strip()
    if token:
        return TokenResolution(token, "environment")
    path = configured_path(config_path, environ)
    token = read_token_config(path, {}).get(country, "")
    if token:
        return TokenResolution(token, "configured-file", path)
    return TokenResolution("", "none", path)


def parse_legacy_token_file(path):
    lines = Path(path).read_text(encoding="utf-8").splitlines()
    tokens = {}
    pending_country = None
    for raw_line in lines:
        line = raw_line.strip()
        if not line:
            continue
        alias = COUNTRY_ALIASES.get(line.lower())
        if alias:
            pending_country = alias
            continue
        if pending_country:
            tokens[pending_country] = line
            pending_country = None
    return tokens


def status_payload(config_path=None):
    path = configured_path(config_path, os.environ)
    tokens = read_token_config(path, {})
    return {
        "success": True,
        "config": str(path),
        "mode": oct(path.stat().st_mode & 0o777) if path.is_file() else None,
        "countries": {
            country: {"available": country in tokens, "source": "configured-file" if country in tokens else "none"}
            for country in SUPPORTED_COUNTRIES
        },
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description="管理 DS Schedule Manager 私有默认 token")
    subparsers = parser.add_subparsers(dest="command", required=True)

    import_parser = subparsers.add_parser("import-legacy", help="从本地 dstoken.md 导入")
    import_parser.add_argument("--source", required=True)
    import_parser.add_argument("--config")

    set_parser = subparsers.add_parser("set", help="从标准输入设置单国 token")
    set_parser.add_argument("--country", required=True)
    set_parser.add_argument("--config")

    status_parser = subparsers.add_parser("status", help="查看各国 token 是否可用")
    status_parser.add_argument("--config")

    delete_parser = subparsers.add_parser("delete", help="删除单国默认 token")
    delete_parser.add_argument("--country", required=True)
    delete_parser.add_argument("--config")

    args = parser.parse_args(argv)
    if args.command == "import-legacy":
        source = Path(args.source).expanduser()
        tokens = read_token_config(args.config, {})
        tokens.update(parse_legacy_token_file(source))
        path = write_token_config(tokens, args.config)
        os.chmod(source, 0o600)
        print(
            json.dumps(
                {
                    "success": True,
                    "config": str(path),
                    "countries": sorted(tokens),
                    "source_mode": oct(source.stat().st_mode & 0o777),
                },
                ensure_ascii=False,
            )
        )
        return 0
    if args.command == "set":
        country = normalize_country(args.country)
        token = sys.stdin.readline().strip()
        if not token:
            raise SystemExit("标准输入中的 token 不能为空")
        tokens = read_token_config(args.config, {})
        tokens[country] = token
        path = write_token_config(tokens, args.config)
        print(json.dumps({"success": True, "country": country, "config": str(path)}, ensure_ascii=False))
        return 0
    if args.command == "delete":
        country = normalize_country(args.country)
        tokens = read_token_config(args.config, {})
        removed = tokens.pop(country, None) is not None
        path = write_token_config(tokens, args.config)
        print(
            json.dumps(
                {"success": True, "country": country, "removed": removed, "config": str(path)},
                ensure_ascii=False,
            )
        )
        return 0
    print(json.dumps(status_payload(args.config), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
