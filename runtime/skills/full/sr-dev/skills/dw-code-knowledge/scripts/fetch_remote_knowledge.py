#!/usr/bin/env python3
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode, urljoin
from urllib.request import Request, urlopen


LOCAL_SESSION_FILE = Path("~/.config/sr-skills/session-local-dev.json")
PRODUCTION_SESSION_FILE = Path("~/.config/sr-skills/session-data-map-dev.json")
LOCAL_BASE_URLS = {"http://127.0.0.1:4888", "http://localhost:4888"}
PRODUCTION_BASE_URL = "https://data-map-dev.kuainiu.io"
DEV_BASE_URL = "http://127.0.0.1:4888"


def normalized_base_url(base_url):
    return str(base_url or "").rstrip("/")


def resolve_base_url(base_url=None, profile="prod"):
    configured = normalized_base_url(base_url or os.environ.get("WS_CODE_KNOWLEDGE_BASE_URL"))
    if configured:
        return configured
    if str(profile or "").lower() in {"dev", "local", "local-dev"}:
        return DEV_BASE_URL
    return PRODUCTION_BASE_URL


def default_session_file(base_url):
    configured = os.environ.get("SR_SKILLS_SESSION_FILE")
    if configured:
        return Path(configured).expanduser()
    normalized = normalized_base_url(base_url)
    if normalized in LOCAL_BASE_URLS:
        return LOCAL_SESSION_FILE.expanduser()
    return PRODUCTION_SESSION_FILE.expanduser()


def read_json(path):
    path = Path(path).expanduser()
    if not path.is_file():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    return payload if isinstance(payload, dict) else {}


def parse_instant(value):
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def session_is_valid(session):
    if not session.get("sessionToken"):
        return False
    expires_at = parse_instant(session.get("expiresAt"))
    return expires_at is None or expires_at > datetime.now(timezone.utc)


def resolve_token(base_url, cli_token=None):
    if cli_token:
        return cli_token, "cli"
    for env_name in ("WS_CODE_KNOWLEDGE_API_TOKEN", "WAREHOUSE_KNOWLEDGE_API_TOKEN", "FUXI_API_TOKEN"):
        env_token = os.environ.get(env_name)
        if env_token:
            return env_token, env_name
    session = read_json(default_session_file(base_url))
    if session_is_valid(session):
        return str(session["sessionToken"]), "sr-skills-session"
    return None, "none"


def safe_relative_file(path_value):
    value = str(path_value or "").replace("\\", "/").lstrip("/")
    path = Path(value)
    if path.is_absolute() or ".." in path.parts:
        raise ValueError(f"unsafe code file path: {path_value}")
    return path


def request_json(base_url, path, token=None):
    url = urljoin(base_url.rstrip("/") + "/", path.lstrip("/"))
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = Request(url, headers=headers, method="GET")
    try:
        with urlopen(request, timeout=20) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"code knowledge API request failed: HTTP {exc.code} {url} {body}") from exc
    if isinstance(payload, dict) and "data" in payload:
        return payload["data"]
    return payload


def search_code(base_url, query, token=None):
    token, token_source = resolve_token(base_url, token)
    result = request_json(base_url, "/api/code/search?" + urlencode({"q": str(query or "")}), token=token)
    if isinstance(result, dict):
        result.setdefault("tokenSource", token_source)
    return result


def read_code_file(base_url, path, token=None):
    token, token_source = resolve_token(base_url, token)
    relative_path = safe_relative_file(path).as_posix()
    result = request_json(base_url, "/api/code/files?" + urlencode({"path": relative_path}), token=token)
    if isinstance(result, dict):
        result.setdefault("tokenSource", token_source)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description="Search or read authorized warehouse code through SR Box.")
    parser.add_argument("--base-url")
    parser.add_argument("--profile", default=os.environ.get("WS_CODE_KNOWLEDGE_PROFILE", "prod"),
                        choices=("prod", "dev", "local", "local-dev"))
    parser.add_argument("--operation", required=True, choices=("code-search", "code-file"))
    parser.add_argument("--query")
    parser.add_argument("--path")
    parser.add_argument("--token")
    args = parser.parse_args(argv)

    base_url = resolve_base_url(args.base_url, args.profile)
    if args.operation == "code-search":
        if not args.query:
            parser.error("--query is required for --operation code-search")
        result = search_code(base_url, args.query, token=args.token)
    else:
        if not args.path:
            parser.error("--path is required for --operation code-file")
        result = read_code_file(base_url, args.path, token=args.token)
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
