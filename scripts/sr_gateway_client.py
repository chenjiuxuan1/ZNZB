#!/usr/bin/env python3
"""Fuxi Gateway SR sandbox helper for the production sr-box data-query skill."""

import argparse
from dataclasses import dataclass
import json
import os
import re
import sys
import time
import webbrowser
from datetime import datetime, timezone
import urllib.error
import urllib.parse
import urllib.request


def _int_env_default(name, fallback):
    value = os.environ.get(name)
    if value in (None, ""):
        return fallback
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if parsed > 0 else fallback


DEFAULT_BASE_URL = "https://data-map-dev.kuainiu.io"
DEFAULT_TOKEN = "fuxi_demo_token"
DEFAULT_PAGE = 1
DEFAULT_PAGE_SIZE = 100
DEFAULT_TIMEOUT = 60
TOKEN_CONFIG_ENV = "SR_SKILLS_TOKEN_FILE"
DEFAULT_TOKEN_CONFIG_PATH = os.path.expanduser("~/.config/sr-skills/token-data-map-dev.json")
SESSION_CONFIG_ENV = "SR_SKILLS_SESSION_FILE"
DEFAULT_SESSION_CONFIG_PATH = os.path.expanduser("~/.config/sr-skills/session-data-map-dev.json")
LOGIN_ATTEMPT_CONFIG_ENV = "SR_SKILLS_LOGIN_ATTEMPT_FILE"
DEFAULT_LOGIN_ATTEMPT_CONFIG_PATH = os.path.expanduser("~/.config/sr-skills/login-data-map-dev.json")
SESSION_IDLE_TIMEOUT_ENV = "SR_SKILLS_SESSION_IDLE_TIMEOUT_SECONDS"
DEFAULT_LOGIN_TIMEOUT = _int_env_default("FUXI_GATEWAY_SSO_LOGIN_TIMEOUT_SECONDS", 60)
DEFAULT_SESSION_IDLE_TIMEOUT_SECONDS = _int_env_default(SESSION_IDLE_TIMEOUT_ENV, 3600)
DEFAULT_LOGIN_POLL_INTERVAL = 2
DEFAULT_AUTH_SERVICE_URL = "http://127.0.0.1:8787"
AUTH_MODE_ENV = "FUXI_GATEWAY_SSO_AUTH_MODE"
USE_LOCAL_AUTH_SERVICE_ENV = "FUXI_GATEWAY_SSO_USE_LOCAL_AUTH_SERVICE"
AUTH_SERVICE_URL_ENV = "FUXI_GATEWAY_SSO_AUTH_SERVICE_URL"
AUTH_BRIDGE_SUBJECT_ENV = "FUXI_GATEWAY_SSO_AUTH_BRIDGE_SUBJECT"
AUTH_BRIDGE_CLIENT_ID_ENV = "FUXI_GATEWAY_SSO_AUTH_BRIDGE_CLIENT_ID"
AUTH_BRIDGE_SCOPE_ENV = "FUXI_GATEWAY_SSO_AUTH_BRIDGE_SCOPE"
DEFAULT_AUTH_BRIDGE_SUBJECT = "sr-box"
DEFAULT_AUTH_BRIDGE_CLIENT_ID = "sr-box"
DEFAULT_AUTH_BRIDGE_SCOPE = "openid profile email offline_access"
DEFAULT_SSO_INITIALIZATION_RETRIES = _int_env_default("FUXI_GATEWAY_SSO_INITIALIZATION_RETRIES", 5)
DEFAULT_SSO_INITIALIZATION_WAIT_SECONDS = _int_env_default("FUXI_GATEWAY_SSO_INITIALIZATION_WAIT_SECONDS", 5)
WRITE_DATABASE = "testdb"
READ_ONLY_KEYWORDS = {"select", "with", "show", "desc", "describe", "explain"}
WRITE_KEYWORDS = {
    "insert",
    "update",
    "delete",
    "create",
    "alter",
    "drop",
    "truncate",
    "replace",
    "merge",
    "refresh",
}
SUPPORTED_COUNTRIES = {"cn", "th", "mx", "ph", "pk", "id"}


class GuardrailError(ValueError):
    """Raised when SQL violates the local write guardrail."""


class GatewayError(RuntimeError):
    """Raised when the gateway returns an HTTP or JSON error."""

    def __init__(self, message, status_code=None, payload=None):
        super().__init__(message)
        self.status_code = status_code
        self.payload = payload


@dataclass
class TokenInfo:
    token: str
    source: str
    auth_type: str = "token"
    expires_at: str = None


def env_default(name, fallback):
    value = os.environ.get(name)
    return value if value not in (None, "") else fallback


def token_config_path():
    return os.path.expanduser(os.environ.get(TOKEN_CONFIG_ENV, DEFAULT_TOKEN_CONFIG_PATH))


def session_config_path():
    return os.path.expanduser(
        os.environ.get(SESSION_CONFIG_ENV, DEFAULT_SESSION_CONFIG_PATH)
    )


def login_attempt_config_path():
    return os.path.expanduser(
        os.environ.get(LOGIN_ATTEMPT_CONFIG_ENV, DEFAULT_LOGIN_ATTEMPT_CONFIG_PATH)
    )


def read_json_config(path):
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as handle:
        try:
            data = json.load(handle)
        except json.JSONDecodeError:
            return {}
    return data if isinstance(data, dict) else {}


def write_private_json(path, payload):
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, mode=0o700, exist_ok=True)
        try:
            os.chmod(directory, 0o700)
        except OSError:
            pass
    encoded = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True).encode(
        "utf-8"
    )
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(encoded)
        handle.write(b"\n")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return payload


def load_token_config():
    return read_json_config(token_config_path())


def save_token_config(token, base_url=None):
    if not token or not token.strip():
        raise GuardrailError("Token is empty.")
    path = token_config_path()
    payload = {
        "token": token.strip(),
        "baseUrl": base_url or env_default("FUXI_BASE_URL", DEFAULT_BASE_URL),
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    }
    return write_private_json(path, payload)


def clear_token_config():
    path = token_config_path()
    if os.path.exists(path):
        os.remove(path)
        return True
    return False


def load_session_config():
    return read_json_config(session_config_path())


def save_session_config(session_token, base_url, user=None, expires_at=None):
    if not session_token or not session_token.strip():
        raise GuardrailError("SSO session token is empty.")
    now = datetime.now(timezone.utc).isoformat()
    payload = {
        "sessionToken": session_token.strip(),
        "baseUrl": base_url or env_default("FUXI_BASE_URL", DEFAULT_BASE_URL),
        "user": user or {},
        "expiresAt": expires_at,
        "updatedAt": now,
        "lastAccessedAt": now,
    }
    return write_private_json(session_config_path(), payload)


def clear_session_config():
    path = session_config_path()
    if os.path.exists(path):
        os.remove(path)
        return True
    return False


def load_login_attempt_config():
    return read_json_config(login_attempt_config_path())


def clear_login_attempt_config():
    path = login_attempt_config_path()
    if os.path.exists(path):
        os.remove(path)
        return True
    return False


def login_attempt_is_active(config):
    if not config:
        return False
    expires_at = parse_instant(config.get("expiresAt"))
    return expires_at is None or expires_at > datetime.now(timezone.utc)


def active_sso_login_attempt(base_url):
    config = load_login_attempt_config()
    if not config:
        return {}
    if not login_attempt_is_active(config):
        clear_login_attempt_config()
        return {}
    if not config.get("loginSessionId") or not config.get("loginUrl"):
        return {}
    stored_base_url = config.get("baseUrl")
    if stored_base_url and normalize_base_url(stored_base_url) != normalize_base_url(base_url):
        return {}
    return config


def login_attempt_expires_at(timeout_sec, expires_at=None):
    parsed = parse_instant(expires_at)
    if parsed and parsed > datetime.now(timezone.utc):
        return parsed.isoformat()
    now = datetime.now(timezone.utc)
    return datetime.fromtimestamp(
        now.timestamp() + timeout_sec, tz=timezone.utc
    ).isoformat()


def record_login_attempt_if_needed(authorization_url, timeout_sec):
    existing = load_login_attempt_config()
    if login_attempt_is_active(existing):
        return False
    now = datetime.now(timezone.utc)
    payload = {
        "authorizationUrl": authorization_url,
        "openedAt": now.isoformat(),
        "expiresAt": datetime.fromtimestamp(
            now.timestamp() + timeout_sec, tz=timezone.utc
        ).isoformat(),
    }
    write_private_json(login_attempt_config_path(), payload)
    return True


def record_sso_login_attempt(base_url, login_session_id, login_url, timeout_sec, expires_at=None):
    if active_sso_login_attempt(base_url):
        return False
    now = datetime.now(timezone.utc)
    payload = {
        "baseUrl": normalize_base_url(base_url),
        "loginSessionId": login_session_id,
        "loginUrl": login_url,
        "authorizationUrl": login_url,
        "openedAt": now.isoformat(),
        "expiresAt": login_attempt_expires_at(timeout_sec, expires_at),
    }
    write_private_json(login_attempt_config_path(), payload)
    return True


def parse_instant(value):
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=timezone.utc)
        return parsed
    except ValueError:
        return None


def session_idle_timeout_seconds():
    return _int_env_default(SESSION_IDLE_TIMEOUT_ENV, DEFAULT_SESSION_IDLE_TIMEOUT_SECONDS)


def session_idle_expired(config):
    last_accessed_at = parse_instant(
        config.get("lastAccessedAt") or config.get("updatedAt")
    )
    if last_accessed_at is None:
        return False
    idle_seconds = (datetime.now(timezone.utc) - last_accessed_at).total_seconds()
    return idle_seconds > session_idle_timeout_seconds()


def session_is_valid(config):
    token = config.get("sessionToken")
    if not token:
        return False
    expires_at = parse_instant(config.get("expiresAt"))
    if expires_at is not None and expires_at <= datetime.now(timezone.utc):
        return False
    return not session_idle_expired(config)


def touch_session_config(config=None):
    payload = dict(config or load_session_config())
    if not payload.get("sessionToken"):
        return {}
    payload["lastAccessedAt"] = datetime.now(timezone.utc).isoformat()
    return write_private_json(session_config_path(), payload)


def load_valid_session_config(touch=False, clear_expired=True):
    config = load_session_config()
    if not config:
        return {}
    if not session_is_valid(config):
        if clear_expired:
            clear_session_config()
        return {}
    if touch:
        return touch_session_config(config)
    return config


def mask_token(token):
    if not token:
        return ""
    if len(token) <= 8:
        return "*" * len(token)
    return f"{token[:4]}...{token[-4:]}"


def resolve_token(cli_token=None):
    if cli_token:
        raise GuardrailError("This production sr-box skill uses SSO only; --token is not supported.")
    session = load_valid_session_config(touch=True)
    if session:
        return TokenInfo(
            session["sessionToken"],
            "session",
            auth_type="sso-session",
            expires_at=session.get("expiresAt"),
        )
    return TokenInfo("", "none", auth_type="none")


def is_local_sso_gateway(base_url):
    normalized = normalize_base_url(base_url)
    return normalized in {"http://127.0.0.1:4888", "http://localhost:4888"}


def is_sso_login_gateway(base_url):
    normalized = normalize_base_url(base_url)
    return normalized in {
        "https://data-map-dev.kuainiu.io",
        "http://127.0.0.1:4888",
        "http://localhost:4888",
    }


def is_production_sso_gateway(base_url):
    return normalize_base_url(base_url) == "https://data-map-dev.kuainiu.io"


def sso_auth_mode():
    legacy_enabled = os.environ.get(USE_LOCAL_AUTH_SERVICE_ENV, "").strip().lower()
    if legacy_enabled in {"1", "true", "yes", "on"}:
        return "local-token"
    return env_default(AUTH_MODE_ENV, "gateway-browser").strip().lower()


def local_auth_service_unavailable_error(exc):
    message = str(exc).lower()
    auth_service_url = env_default(AUTH_SERVICE_URL_ENV, DEFAULT_AUTH_SERVICE_URL).lower()
    if auth_service_url not in message and "127.0.0.1:8787" not in message:
        return False
    return any(
        marker in message
        for marker in (
            "connection refused",
            "could not reach",
            "failed to establish",
            "connection reset",
            "name or service not known",
        )
    )


def resolve_query_token(base_url, cli_token=None):
    if cli_token:
        raise GuardrailError("This production sr-box skill uses SSO only; --token is not supported.")
    session = load_valid_session_config(touch=True)
    if session:
        return TokenInfo(
            session["sessionToken"],
            "session",
            auth_type="sso-session",
            expires_at=session.get("expiresAt"),
        )
    if is_sso_login_gateway(base_url):
        sso_login(base_url, open_browser=True, auto_approve=False)
        session = load_valid_session_config(touch=True)
        if session:
            return TokenInfo(
                session["sessionToken"],
                "session",
                auth_type="sso-session",
                expires_at=session.get("expiresAt"),
            )
        raise GatewayError("SSO login completed but no valid session was saved.")
    raise GuardrailError("This production sr-box skill uses SSO only; use data-map-dev.kuainiu.io or the local SSO dev gateway.")


def stale_local_sso_error(base_url, token_info, exc, cli_token=None):
    if cli_token or token_info.auth_type != "sso-session" or not is_sso_login_gateway(base_url):
        return False
    message = str(exc)
    return "HTTP 401" in message and (
        "SSO session" in message or "srbs_" in message or "已吊销" in message
    )


def gateway_error_code(exc):
    payload = getattr(exc, "payload", None)
    if isinstance(payload, dict):
        data = payload.get("data")
        if isinstance(data, dict) and data.get("code"):
            return data.get("code")
    return None


def sso_initializing_error(exc):
    return gateway_error_code(exc) == "SSO_ACCOUNT_INITIALIZING" or "SSO_ACCOUNT_INITIALIZING" in str(exc)


def run_query_with_sso_retry(base_url, cli_token, operation):
    token_info = resolve_query_token(base_url, cli_token)
    initializing_attempts = 0
    while True:
        try:
            return operation(token_info), token_info
        except GatewayError as exc:
            if stale_local_sso_error(base_url, token_info, exc, cli_token):
                clear_session_config()
                token_info = resolve_query_token(base_url, None)
                continue
            if (
                token_info.auth_type == "sso-session"
                and is_sso_login_gateway(base_url)
                and sso_initializing_error(exc)
                and initializing_attempts < DEFAULT_SSO_INITIALIZATION_RETRIES
            ):
                initializing_attempts += 1
                sys.stderr.write(
                    "SSO 账号权限正在初始化，等待 "
                    f"{DEFAULT_SSO_INITIALIZATION_WAIT_SECONDS}s 后重试 "
                    f"({initializing_attempts}/{DEFAULT_SSO_INITIALIZATION_RETRIES})...\n"
                )
                time.sleep(DEFAULT_SSO_INITIALIZATION_WAIT_SECONDS)
                continue
            raise


def token_status_payload():
    config = load_token_config()
    token = config.get("token")
    return {
        "success": True,
        "configured": bool(token),
        "source": "config" if token else "default",
        "tokenPreview": mask_token(token or DEFAULT_TOKEN),
        "baseUrl": config.get("baseUrl") or env_default("FUXI_BASE_URL", DEFAULT_BASE_URL),
        "path": token_config_path(),
        "updatedAt": config.get("updatedAt"),
    }


def session_status_payload():
    config = load_session_config()
    if config and not session_is_valid(config):
        clear_session_config()
        config = {}
    user = config.get("user") if isinstance(config.get("user"), dict) else {}
    return {
        "success": True,
        "configured": bool(config.get("sessionToken")),
        "valid": session_is_valid(config),
        "source": "session" if config.get("sessionToken") else "none",
        "sessionPreview": mask_token(config.get("sessionToken", "")),
        "baseUrl": config.get("baseUrl") or env_default("FUXI_BASE_URL", DEFAULT_BASE_URL),
        "path": session_config_path(),
        "updatedAt": config.get("updatedAt"),
        "lastAccessedAt": config.get("lastAccessedAt"),
        "expiresAt": config.get("expiresAt"),
        "user": {
            "email": user.get("email"),
            "displayName": user.get("displayName"),
            "srUser": user.get("srUser"),
        },
    }


def attach_client_metadata(result, token_info):
    if isinstance(result, dict):
        result.setdefault("_client", {})
        result["_client"]["tokenSource"] = token_info.source
        result["_client"]["authType"] = token_info.auth_type
        if token_info.expires_at:
            result["_client"]["expiresAt"] = token_info.expires_at
    return result


def attach_token_permissions_summary(result):
    if not isinstance(result, dict):
        return result

    data = result.get("data")
    if not isinstance(data, dict):
        return result

    result.setdefault("_client", {})
    result["_client"]["permissionSummary"] = {
        "authType": data.get("authType"),
        "kylithEmail": data.get("kylithEmail"),
        "srUser": data.get("srUser"),
        "country": data.get("country"),
        "datasource": data.get("datasource"),
        "tokenOwner": data.get("tokenOwner"),
        "tokenPrefix": data.get("tokenPrefix"),
        "allowedDatasources": data.get("allowedDatasources"),
        "allowedDatabases": data.get("allowedDatabases"),
        "allowHiveRead": data.get("allowHiveRead"),
        "allowedHiveDatabases": data.get("allowedHiveDatabases"),
        "allowedSqlTypes": data.get("allowedSqlTypes"),
        "allowWrite": data.get("allowWrite"),
    }
    return result


def normalize_base_url(base_url):
    return base_url.rstrip("/")


def split_sql_statements(sql):
    statements = []
    current = []
    quote = None
    line_comment = False
    block_comment = False
    i = 0

    while i < len(sql):
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < len(sql) else ""

        if line_comment:
            if ch == "\n":
                line_comment = False
                current.append(ch)
            i += 1
            continue

        if block_comment:
            if ch == "*" and nxt == "/":
                block_comment = False
                i += 2
            else:
                i += 1
            continue

        if quote:
            current.append(ch)
            if ch == "\\" and nxt:
                current.append(nxt)
                i += 2
                continue
            if ch == quote:
                quote = None
            i += 1
            continue

        if ch in ("'", '"', "`"):
            quote = ch
            current.append(ch)
            i += 1
            continue

        if ch == "-" and nxt == "-":
            line_comment = True
            i += 2
            continue

        if ch == "/" and nxt == "*":
            block_comment = True
            i += 2
            continue

        if ch == ";":
            statement = "".join(current).strip()
            if statement:
                statements.append(statement)
            current = []
            i += 1
            continue

        current.append(ch)
        i += 1

    statement = "".join(current).strip()
    if statement:
        statements.append(statement)
    return statements


def tokenize_sql(statement):
    tokens = []
    current = []
    quote = None
    line_comment = False
    block_comment = False
    i = 0

    while i < len(statement):
        ch = statement[i]
        nxt = statement[i + 1] if i + 1 < len(statement) else ""

        if line_comment:
            if ch == "\n":
                line_comment = False
            i += 1
            continue

        if block_comment:
            if ch == "*" and nxt == "/":
                block_comment = False
                i += 2
            else:
                i += 1
            continue

        if quote:
            current.append(ch)
            if ch == "\\" and nxt:
                current.append(nxt)
                i += 2
                continue
            if ch == quote:
                quote = None
                tokens.append("".join(current))
                current = []
            i += 1
            continue

        if ch in ("'", '"', "`"):
            if current:
                tokens.append("".join(current))
                current = []
            quote = ch
            current.append(ch)
            i += 1
            continue

        if ch == "-" and nxt == "-":
            if current:
                tokens.append("".join(current))
                current = []
            line_comment = True
            i += 2
            continue

        if ch == "/" and nxt == "*":
            if current:
                tokens.append("".join(current))
                current = []
            block_comment = True
            i += 2
            continue

        if ch.isspace() or ch in "(),;":
            if current:
                tokens.append("".join(current))
                current = []
            i += 1
            continue

        current.append(ch)
        i += 1

    if current:
        tokens.append("".join(current))
    return tokens


def unquote_identifier(identifier):
    identifier = identifier.strip()
    if len(identifier) >= 2 and identifier[0] == identifier[-1] and identifier[0] in "`\"'":
        return identifier[1:-1]
    return identifier


def normalize_table_reference(reference):
    parts = [unquote_identifier(part) for part in reference.split(".") if part]
    if len(parts) < 2:
        raise GuardrailError(
            f"Write target {reference!r} must be qualified as testdb.<table>."
        )
    return parts[0].lower(), ".".join(parts[1:])


def require_testdb_target(reference):
    database, _table = normalize_table_reference(reference)
    if database != WRITE_DATABASE:
        raise GuardrailError(
            f"Write target {reference!r} is not allowed. Writes must target testdb only."
        )


def next_token(tokens, start, skip=None):
    index = next_token_index(tokens, start, skip)
    if index is None:
        return None
    return tokens[index]


def next_token_index(tokens, start, skip=None):
    skip = skip or set()
    index = start
    while index < len(tokens) and tokens[index].lower() in skip:
        index += 1
    if index >= len(tokens):
        return None
    return index


def qualified_identifier_at(tokens, index):
    if index + 2 < len(tokens) and tokens[index + 1] == ".":
        return f"{tokens[index]}.{tokens[index + 2]}"
    return tokens[index]


def extract_write_targets(statement):
    tokens = tokenize_sql(statement)
    if not tokens:
        return []

    keyword = tokens[0].lower()

    if keyword == "insert":
        target_index = next_token_index(tokens, 1, {"ignore", "into", "overwrite"})
    elif keyword == "replace":
        target_index = next_token_index(tokens, 1, {"into"})
    elif keyword == "update":
        target_index = next_token_index(tokens, 1)
    elif keyword == "delete":
        target_index = next_token_index(tokens, 1, {"from"})
    elif keyword == "merge":
        target_index = next_token_index(tokens, 1, {"into"})
    elif keyword == "alter":
        target_index = next_token_index(tokens, 1, {"table", "view", "materialized"})
    elif keyword == "drop":
        target_index = next_token_index(tokens, 1, {"table", "view", "materialized", "if", "exists"})
    elif keyword == "truncate":
        target_index = next_token_index(tokens, 1, {"table"})
    elif keyword == "create":
        target_index = next_token_index(
            tokens,
            1,
            {"temporary", "table", "view", "materialized", "if", "not", "exists", "or", "replace"},
        )
    elif keyword == "refresh":
        target_index = next_token_index(tokens, 1, {"materialized", "view"})
    else:
        raise GuardrailError(f"Unsupported mutating SQL starts with {tokens[0]!r}.")

    if target_index is None:
        raise GuardrailError(f"Could not identify write target in SQL: {statement}")
    target = qualified_identifier_at(tokens, target_index)
    return [target]


def first_keyword(statement):
    tokens = tokenize_sql(statement)
    if not tokens:
        return ""
    return tokens[0].lower()


def validate_sql_guardrails(sql, sql_mode="query"):
    if not sql or not sql.strip():
        raise GuardrailError("SQL is empty.")

    statements = split_sql_statements(sql)
    if not statements:
        raise GuardrailError("SQL is empty.")

    for statement in statements:
        keyword = first_keyword(statement)
        if keyword in READ_ONLY_KEYWORDS and keyword not in WRITE_KEYWORDS:
            continue
        if keyword not in WRITE_KEYWORDS:
            raise GuardrailError(
                f"SQL starts with unsupported keyword {keyword!r}; only read SQL or testdb writes are allowed."
            )
        for target in extract_write_targets(statement):
            require_testdb_target(target)

    return True


def request_json(method, url, token=None, payload=None, timeout=DEFAULT_TIMEOUT):
    headers = {"Accept": "application/json"}
    body = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    if token:
        headers["Authorization"] = f"Bearer {token}"

    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            text = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        error_text = exc.read().decode("utf-8", errors="replace")
        payload = None
        try:
            payload = json.loads(error_text) if error_text else None
        except json.JSONDecodeError:
            payload = None
        raise GatewayError(
            f"HTTP {exc.code} from {url}: {error_text}",
            status_code=exc.code,
            payload=payload,
        ) from exc
    except urllib.error.URLError as exc:
        raise GatewayError(f"Could not reach {url}: {exc.reason}") from exc

    try:
        return json.loads(text) if text else {}
    except json.JSONDecodeError as exc:
        raise GatewayError(f"Gateway returned non-JSON response from {url}: {text[:300]}") from exc


def execute_country_sql(
    base_url,
    token,
    country,
    sql,
    task_name="sr-country-query",
    purpose="agent",
    access_mode="local",
    sql_mode="query",
    page=DEFAULT_PAGE,
    page_size=DEFAULT_PAGE_SIZE,
    timeout_sec=DEFAULT_TIMEOUT,
):
    if country not in SUPPORTED_COUNTRIES:
        raise GuardrailError(
            f"Unsupported country {country!r}. Use one of: {', '.join(sorted(SUPPORTED_COUNTRIES))}."
        )
    validate_sql_guardrails(sql, sql_mode)
    payload = {
        "taskName": task_name,
        "country": country,
        "purpose": purpose,
        "accessMode": access_mode,
        "sqlMode": sql_mode,
        "sql": sql,
        "page": page,
        "pageSize": page_size,
        "timeoutSec": timeout_sec,
    }
    url = f"{normalize_base_url(base_url)}/api/rust/v1/sr-sandboxes/sql-executions"
    return request_json("POST", url, token, payload, timeout_sec)


def execute_datasource_sql(
    base_url,
    token,
    datasource,
    sql,
    task_name="generic-sandbox-query",
    engine="starrocks-sql",
    sql_mode="query",
    page=DEFAULT_PAGE,
    page_size=DEFAULT_PAGE_SIZE,
    timeout_sec=DEFAULT_TIMEOUT,
):
    validate_sql_guardrails(sql, sql_mode)
    payload = {
        "taskName": task_name,
        "engine": engine,
        "datasource": datasource,
        "sqlMode": sql_mode,
        "sql": sql,
        "page": page,
        "pageSize": page_size,
        "timeoutSec": timeout_sec,
    }
    url = f"{normalize_base_url(base_url)}/api/fuxi/sandbox/execute"
    return request_json("POST", url, token, payload, timeout_sec)


def get_catalog(base_url, token):
    url = f"{normalize_base_url(base_url)}/api/rust/v1/sr-sandboxes/catalog"
    return request_json("GET", url, token)


def get_guardrails(base_url, token):
    url = f"{normalize_base_url(base_url)}/api/rust/v1/sr-sandboxes/guardrails"
    return request_json("GET", url, token)


def get_token_permissions(base_url, token, country=None, purpose=None, access_mode=None):
    params = {
        "country": country,
        "purpose": purpose,
        "accessMode": access_mode,
    }
    query = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    url = f"{normalize_base_url(base_url)}/api/rust/v1/sr-sandboxes/token-permissions"
    if query:
        url = f"{url}?{query}"
    return request_json("GET", url, token)


def create_sso_login_session(base_url):
    query = urllib.parse.urlencode(
        {
            "baseUrl": normalize_base_url(base_url),
            "clientType": "codex-skill",
            "skillName": "sr-box",
        }
    )
    url = f"{normalize_base_url(base_url)}/api/rust/v1/sr-sandboxes/auth/login-sessions?{query}"
    return request_json("POST", url, None)


def login_state_from_url(login_url):
    parsed = urllib.parse.urlsplit(login_url)
    query = urllib.parse.parse_qs(parsed.query)
    values = query.get("state") or []
    return values[0] if values else None


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def redirect_location(url, timeout=15):
    opener = urllib.request.build_opener(NoRedirectHandler)
    request = urllib.request.Request(
        url,
        headers={"Accept": "text/html,application/xhtml+xml", "User-Agent": "Mozilla/5.0"},
        method="GET",
    )
    try:
        opener.open(request, timeout=timeout)
    except urllib.error.HTTPError as exc:
        if exc.code in {301, 302, 303, 307, 308}:
            return exc.headers.get("Location")
        raise
    return None


def gateway_oauth_error(login_url):
    try:
        authorization_url = redirect_location(login_url)
        if not authorization_url:
            return None
        next_url = redirect_location(authorization_url)
    except (urllib.error.URLError, TimeoutError, ValueError):
        return None
    if not next_url:
        return None
    parsed = urllib.parse.urlsplit(next_url)
    query = urllib.parse.parse_qs(parsed.query)
    error = (query.get("error") or [""])[0]
    if not error:
        return None
    auth_query = urllib.parse.parse_qs(urllib.parse.urlsplit(authorization_url).query)
    return {
        "error": error,
        "description": (query.get("error_description") or [""])[0],
        "redirectUri": (auth_query.get("redirect_uri") or [""])[0],
    }


def ensure_gateway_oauth_login_available(login_url):
    diagnostic = gateway_oauth_error(login_url)
    if not diagnostic:
        return
    description = diagnostic.get("description") or diagnostic.get("error")
    redirect_uri = diagnostic.get("redirectUri")
    if "redirect_uri" in description:
        raise GatewayError(
            "Kylith OAuth 拒绝了生产网关登录：redirect_uri 未在 OAuth Client 预注册。"
            f" 请在 Kylith Client 中加入回调地址 {redirect_uri}，"
            "或临时设置 FUXI_GATEWAY_SSO_AUTH_MODE=local-token 并启动本机 Kylith auth-service。"
        )
    raise GatewayError(f"Kylith OAuth 拒绝了生产网关登录：{diagnostic.get('error')} {description}")


def auth_service_base_url():
    return env_default(AUTH_SERVICE_URL_ENV, DEFAULT_AUTH_SERVICE_URL).rstrip("/")


def auth_bridge_subject():
    return env_default(AUTH_BRIDGE_SUBJECT_ENV, DEFAULT_AUTH_BRIDGE_SUBJECT)


def auth_bridge_client_id():
    return env_default(AUTH_BRIDGE_CLIENT_ID_ENV, DEFAULT_AUTH_BRIDGE_CLIENT_ID)


def auth_bridge_scope():
    return env_default(AUTH_BRIDGE_SCOPE_ENV, DEFAULT_AUTH_BRIDGE_SCOPE)


def request_local_kylith_token(force=False):
    params = {
        "subject": auth_bridge_subject(),
        "client_id": auth_bridge_client_id(),
        "scope": auth_bridge_scope(),
    }
    if force:
        params["force"] = "1"
    url = f"{auth_service_base_url()}/skill-token?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(url, headers={"Accept": "application/json"}, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            text = response.read().decode("utf-8")
            payload = json.loads(text) if text else {}
            token = payload.get("access_token")
            if not token:
                raise GatewayError("Local Kylith auth-service returned no access_token.")
            return {"status": "authorized", "accessToken": token}
    except urllib.error.HTTPError as exc:
        error_text = exc.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(error_text) if error_text else {}
        except json.JSONDecodeError:
            payload = {}
        if exc.code == 401 and payload.get("authorization_url"):
            return {
                "status": "authorization_required",
                "authorizationUrl": payload.get("authorization_url"),
                "message": payload.get("message"),
            }
        message = payload.get("message") or payload.get("error") or error_text
        raise GatewayError(f"Local Kylith auth-service HTTP {exc.code}: {message}") from exc
    except urllib.error.URLError as exc:
        raise GatewayError(
            f"Local Kylith auth-service is unavailable at {auth_service_base_url()}: {exc.reason}"
        ) from exc


def wait_for_local_kylith_access_token(open_browser=True, timeout_sec=DEFAULT_LOGIN_TIMEOUT):
    deadline = time.time() + timeout_sec
    prompted = False
    last_status = None
    while time.time() <= deadline:
        result = request_local_kylith_token()
        last_status = result
        if result.get("status") == "authorized" and result.get("accessToken"):
            clear_login_attempt_config()
            return result["accessToken"]
        authorization_url = result.get("authorizationUrl")
        if authorization_url and not prompted:
            if record_login_attempt_if_needed(authorization_url, timeout_sec):
                print(
                    f"Open Kylith authorization URL: {authorization_url}",
                    file=sys.stderr,
                    flush=True,
                )
                if open_browser:
                    webbrowser.open(authorization_url)
            else:
                print(
                    f"Kylith authorization page is already open; waiting up to {timeout_sec}s.",
                    file=sys.stderr,
                    flush=True,
                )
            prompted = True
        time.sleep(DEFAULT_LOGIN_POLL_INTERVAL)
    clear_login_attempt_config()
    clear_session_config()
    raise GatewayError(
        f"账号未登录或授权超时：已等待 {timeout_sec}s，请完成 Kylith 登录后重试。"
        f" last_status={last_status!r}"
    )


def approve_sso_login_with_kylith_token(base_url, login_session_id, state, access_token):
    payload = {
        "loginSessionId": login_session_id,
        "state": state,
        "accessToken": access_token,
        "response": "json",
    }
    url = f"{normalize_base_url(base_url)}/api/rust/v1/sr-sandboxes/auth/external-token-approval"
    return request_json("POST", url, None, payload)


def get_sso_login_session_status(base_url, login_session_id):
    url = f"{normalize_base_url(base_url)}/api/rust/v1/sr-sandboxes/auth/login-sessions/{urllib.parse.quote(login_session_id)}"
    return request_json("GET", url, None)


def get_sso_me(base_url, session_token):
    url = f"{normalize_base_url(base_url)}/api/rust/v1/sr-sandboxes/auth/me"
    return request_json("GET", url, session_token)


def get_sso_account_permissions(base_url, session_token):
    url = f"{normalize_base_url(base_url)}/api/rust/v1/sr-sandboxes/auth/account-permissions"
    return request_json("GET", url, session_token)


def logout_sso(base_url, session_token):
    url = f"{normalize_base_url(base_url)}/api/rust/v1/sr-sandboxes/auth/logout"
    return request_json("POST", url, session_token)


def sso_approval_url(login_url, response="json"):
    parsed = urllib.parse.urlsplit(login_url)
    query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    query.extend([("approve", "true"), ("response", response)])
    return urllib.parse.urlunsplit(
        (
            parsed.scheme,
            parsed.netloc,
            parsed.path,
            urllib.parse.urlencode(query),
            parsed.fragment,
        )
    )


def poll_sso_login(base_url, login_session_id, timeout_sec, interval_sec):
    deadline = time.time() + timeout_sec
    last_status = None
    while time.time() <= deadline:
        result = get_sso_login_session_status(base_url, login_session_id)
        data = result.get("data", {}) if isinstance(result, dict) else {}
        last_status = data
        if data.get("status") == "APPROVED" and data.get("sessionToken"):
            return result
        time.sleep(interval_sec)
    raise GatewayError(
        f"SSO login timed out after {timeout_sec}s; last status={last_status!r}"
    )


def sso_login(base_url, open_browser=True, auto_approve=False, timeout_sec=DEFAULT_LOGIN_TIMEOUT):
    existing_attempt = active_sso_login_attempt(base_url)
    data = {}
    if existing_attempt:
        login_session_id = existing_attempt.get("loginSessionId")
        login_url = existing_attempt.get("loginUrl")
        print(
            f"SSO login page is already open; waiting up to {timeout_sec}s: {login_url}",
            file=sys.stderr,
            flush=True,
        )
    else:
        created = create_sso_login_session(base_url)
        data = created.get("data", {}) if isinstance(created, dict) else {}
        login_session_id = data.get("loginSessionId")
        login_url = data.get("loginUrl")
        if not login_session_id or not login_url:
            raise GatewayError(f"Gateway did not return a valid SSO login session: {created}")
    if is_production_sso_gateway(base_url) and sso_auth_mode() == "local-token":
        state = login_state_from_url(login_url)
        if not state:
            raise GatewayError(f"Gateway did not return a valid SSO state in login URL: {login_url}")
        try:
            access_token = wait_for_local_kylith_access_token(
                open_browser=open_browser,
                timeout_sec=timeout_sec,
            )
            approved = approve_sso_login_with_kylith_token(
                base_url,
                login_session_id,
                state,
                access_token,
            )
            approved_data = approved.get("data", {}) if isinstance(approved, dict) else {}
            save_session_config(
                approved_data.get("sessionToken"),
                base_url,
                user=approved_data.get("user"),
                expires_at=approved_data.get("expiresAt"),
            )
            clear_login_attempt_config()
            result = session_status_payload()
            result["message"] = "SSO session saved through Kylith token approval."
            return result
        except GatewayError as exc:
            if not local_auth_service_unavailable_error(exc):
                raise
            print(
                "Local Kylith auth-service is unavailable; falling back to production gateway browser SSO.",
                file=sys.stderr,
                flush=True,
            )
    if is_production_sso_gateway(base_url):
        ensure_gateway_oauth_login_available(login_url)
    if not existing_attempt and record_sso_login_attempt(
        base_url,
        login_session_id,
        login_url,
        timeout_sec,
        expires_at=data.get("expiresAt"),
    ):
        print(f"Open SSO login URL: {login_url}", file=sys.stderr, flush=True)
        if open_browser:
            webbrowser.open(login_url)
    elif not existing_attempt:
        print(
            f"SSO login page is already open; waiting up to {timeout_sec}s: {login_url}",
            file=sys.stderr,
            flush=True,
        )
    if auto_approve:
        request_json("GET", sso_approval_url(login_url, response="json"), None)
    approved = poll_sso_login(
        base_url,
        login_session_id,
        timeout_sec=timeout_sec,
        interval_sec=DEFAULT_LOGIN_POLL_INTERVAL,
    )
    approved_data = approved.get("data", {}) if isinstance(approved, dict) else {}
    save_session_config(
        approved_data.get("sessionToken"),
        base_url,
        user=approved_data.get("user"),
        expires_at=approved_data.get("expiresAt"),
    )
    clear_login_attempt_config()
    result = session_status_payload()
    result["message"] = "SSO session saved."
    return result


def get_health(base_url):
    url = f"{normalize_base_url(base_url)}/actuator/health"
    return request_json("GET", url, None)


def get_logs(base_url, token, params):
    query = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    url = f"{normalize_base_url(base_url)}/api/rust/v1/sr-sandboxes/logs"
    if query:
        url = f"{url}?{query}"
    return request_json("GET", url, token)


def auth_token(base_url, developer_id, app_name, scene, workspace_id, scopes, expires):
    payload = {
        "developerId": developer_id,
        "appName": app_name,
        "scene": scene,
        "workspaceId": workspace_id,
        "scopes": scopes,
        "expiresInMinutes": expires,
    }
    url = f"{normalize_base_url(base_url)}/api/fuxi/auth"
    return request_json("POST", url, None, payload)


def add_common_args(parser):
    parser.add_argument(
        "--base-url",
        default=env_default("FUXI_BASE_URL", DEFAULT_BASE_URL),
        help="Gateway base URL. Defaults to FUXI_BASE_URL or https://data-map-dev.kuainiu.io.",
    )


def build_parser():
    parser = argparse.ArgumentParser(
        description="Query Fuxi Gateway SR sandboxes with local testdb write guardrails."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    execute = subparsers.add_parser("execute", help="Execute SQL via country sandbox API.")
    add_common_args(execute)
    execute.add_argument("--country", default="cn", choices=sorted(SUPPORTED_COUNTRIES))
    execute.add_argument("--access-mode", default="local", choices=["local", "remote"])
    execute.add_argument("--purpose", default="agent")
    execute.add_argument("--sql-mode", default="query")
    execute.add_argument("--task-name", default="sr-country-query")
    execute.add_argument("--sql", required=True)
    execute.add_argument("--page", type=int, default=DEFAULT_PAGE)
    execute.add_argument("--page-size", type=int, default=DEFAULT_PAGE_SIZE)
    execute.add_argument("--timeout-sec", type=int, default=DEFAULT_TIMEOUT)

    datasource = subparsers.add_parser("datasource-execute", help="Execute SQL via datasource API.")
    add_common_args(datasource)
    datasource.add_argument("--datasource", required=True)
    datasource.add_argument("--engine", default="starrocks-sql")
    datasource.add_argument("--sql-mode", default="query")
    datasource.add_argument("--task-name", default="generic-sandbox-query")
    datasource.add_argument("--sql", required=True)
    datasource.add_argument("--page", type=int, default=DEFAULT_PAGE)
    datasource.add_argument("--page-size", type=int, default=DEFAULT_PAGE_SIZE)
    datasource.add_argument("--timeout-sec", type=int, default=DEFAULT_TIMEOUT)

    catalog = subparsers.add_parser("catalog", help="Fetch SR country sandbox catalog.")
    add_common_args(catalog)

    guardrails = subparsers.add_parser("guardrails", help="Fetch gateway guardrails.")
    add_common_args(guardrails)

    permissions = subparsers.add_parser(
        "permissions", help="Fetch permissions for the current SSO session."
    )
    add_common_args(permissions)
    permissions.add_argument("--country")
    permissions.add_argument("--purpose")
    permissions.add_argument("--access-mode")

    health = subparsers.add_parser("health", help="Fetch /actuator/health from the gateway.")
    health.add_argument(
        "--base-url",
        default=env_default("FUXI_BASE_URL", DEFAULT_BASE_URL),
        help="Gateway base URL. Defaults to FUXI_BASE_URL or https://data-map-dev.kuainiu.io.",
    )

    logs = subparsers.add_parser("logs", help="Fetch SR access logs.")
    add_common_args(logs)
    logs.add_argument("--country")
    logs.add_argument("--log-type", default="query")
    logs.add_argument("--event-type")
    logs.add_argument("--datasource")
    logs.add_argument("--success")
    logs.add_argument("--identity")
    logs.add_argument("--request-path")
    logs.add_argument("--sql-text")
    logs.add_argument("--task-name")
    logs.add_argument("--slow-only", action="store_true")
    logs.add_argument("--min-duration-ms", type=int)
    logs.add_argument("--from", dest="from_time")
    logs.add_argument("--to", dest="to_time")
    logs.add_argument("--page-no", type=int, default=1)
    logs.add_argument("--page-size", type=int, default=50)

    sso = subparsers.add_parser("sso", help="Manage SR Box SSO session login.")
    sso_subparsers = sso.add_subparsers(dest="sso_command", required=True)

    sso_login_parser = sso_subparsers.add_parser("login", help="Start SSO login and save the session.")
    sso_login_parser.add_argument(
        "--base-url",
        default=env_default("FUXI_BASE_URL", DEFAULT_BASE_URL),
        help="Gateway base URL. Defaults to FUXI_BASE_URL or https://data-map-dev.kuainiu.io.",
    )
    sso_login_parser.add_argument("--timeout-sec", type=int, default=DEFAULT_LOGIN_TIMEOUT)
    sso_login_parser.add_argument("--no-open", action="store_true", help="Do not open the login URL in a browser.")
    sso_login_parser.add_argument(
        "--auto-approve",
        action="store_true",
        help="Call the local dev approve URL automatically. Do not use for real Kylith OIDC login.",
    )
    sso_login_parser.add_argument(
        "--no-auto-approve",
        action="store_true",
        help="Deprecated no-op kept for old dev commands; real OIDC login never auto-approves unless --auto-approve is set.",
    )

    sso_subparsers.add_parser("status", help="Show saved SSO session status without revealing it.")

    sso_whoami = sso_subparsers.add_parser("whoami", help="Read the current SSO user from the gateway.")
    sso_whoami.add_argument(
        "--base-url",
        default=env_default("FUXI_BASE_URL", DEFAULT_BASE_URL),
        help="Gateway base URL. Defaults to FUXI_BASE_URL or https://data-map-dev.kuainiu.io.",
    )

    sso_permissions = sso_subparsers.add_parser("account-permissions", help="Read cached dynamic SR permissions for the current SSO account.")
    sso_permissions.add_argument(
        "--base-url",
        default=env_default("FUXI_BASE_URL", DEFAULT_BASE_URL),
        help="Gateway base URL. Defaults to FUXI_BASE_URL or https://data-map-dev.kuainiu.io.",
    )

    sso_logout = sso_subparsers.add_parser("logout", help="Revoke the current SSO session and clear local cache.")
    sso_logout.add_argument(
        "--base-url",
        default=env_default("FUXI_BASE_URL", DEFAULT_BASE_URL),
        help="Gateway base URL. Defaults to FUXI_BASE_URL or https://data-map-dev.kuainiu.io.",
    )

    sso_refresh = sso_subparsers.add_parser("refresh-policy", help="Fetch dynamic SR permissions for the current SSO session.")
    sso_refresh.add_argument(
        "--base-url",
        default=env_default("FUXI_BASE_URL", DEFAULT_BASE_URL),
        help="Gateway base URL. Defaults to FUXI_BASE_URL or https://data-map-dev.kuainiu.io.",
    )
    sso_refresh.add_argument("--country", default="cn", choices=sorted(SUPPORTED_COUNTRIES))
    sso_refresh.add_argument("--purpose", default="agent")
    sso_refresh.add_argument("--access-mode", default="local", choices=["local", "remote"])

    return parser


def print_json(payload, stream=None):
    if stream is None:
        stream = sys.stdout
    stream.write(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
    stream.write("\n")


def main():
    parser = build_parser()
    args = parser.parse_args()

    try:
        if args.command == "execute":
            validate_sql_guardrails(args.sql, args.sql_mode)
            result, token_info = run_query_with_sso_retry(
                args.base_url,
                None,
                lambda resolved: execute_country_sql(
                    args.base_url,
                    resolved.token,
                    args.country,
                    args.sql,
                    task_name=args.task_name,
                    purpose=args.purpose,
                    access_mode=args.access_mode,
                    sql_mode=args.sql_mode,
                    page=args.page,
                    page_size=args.page_size,
                    timeout_sec=args.timeout_sec,
                ),
            )
            result = attach_client_metadata(result, token_info)
        elif args.command == "datasource-execute":
            validate_sql_guardrails(args.sql, args.sql_mode)
            result, token_info = run_query_with_sso_retry(
                args.base_url,
                None,
                lambda resolved: execute_datasource_sql(
                    args.base_url,
                    resolved.token,
                    args.datasource,
                    args.sql,
                    task_name=args.task_name,
                    engine=args.engine,
                    sql_mode=args.sql_mode,
                    page=args.page,
                    page_size=args.page_size,
                    timeout_sec=args.timeout_sec,
                ),
            )
            result = attach_client_metadata(result, token_info)
        elif args.command == "catalog":
            result, token_info = run_query_with_sso_retry(
                args.base_url,
                None,
                lambda resolved: get_catalog(args.base_url, resolved.token),
            )
            result = attach_client_metadata(result, token_info)
        elif args.command == "guardrails":
            result, token_info = run_query_with_sso_retry(
                args.base_url,
                None,
                lambda resolved: get_guardrails(args.base_url, resolved.token),
            )
            result = attach_client_metadata(result, token_info)
        elif args.command == "permissions":
            result, token_info = run_query_with_sso_retry(
                args.base_url,
                None,
                lambda resolved: get_token_permissions(
                    args.base_url,
                    resolved.token,
                    country=args.country,
                    purpose=args.purpose,
                    access_mode=args.access_mode,
                ),
            )
            result = attach_client_metadata(result, token_info)
            result = attach_token_permissions_summary(result)
        elif args.command == "health":
            result = get_health(args.base_url)
        elif args.command == "logs":
            params = {
                "country": args.country,
                "logType": args.log_type,
                "eventType": args.event_type,
                "datasource": args.datasource,
                "success": args.success,
                "identity": args.identity,
                "requestPath": args.request_path,
                "sqlText": args.sql_text,
                "taskName": args.task_name,
                "slowOnly": str(args.slow_only).lower() if args.slow_only else None,
                "minDurationMs": args.min_duration_ms,
                "from": args.from_time,
                "to": args.to_time,
                "pageNo": args.page_no,
                "pageSize": args.page_size,
            }
            result, token_info = run_query_with_sso_retry(
                args.base_url,
                None,
                lambda resolved: get_logs(args.base_url, resolved.token, params),
            )
            result = attach_client_metadata(result, token_info)
        elif args.command == "sso":
            if args.sso_command == "login":
                result = sso_login(
                    args.base_url,
                    open_browser=not args.no_open,
                    auto_approve=args.auto_approve and not args.no_auto_approve,
                    timeout_sec=args.timeout_sec,
                )
            elif args.sso_command == "status":
                result = session_status_payload()
            elif args.sso_command == "whoami":
                result, token_info = run_query_with_sso_retry(
                    args.base_url,
                    None,
                    lambda resolved: get_sso_me(args.base_url, resolved.token),
                )
                result = attach_client_metadata(result, token_info)
            elif args.sso_command == "account-permissions":
                result, token_info = run_query_with_sso_retry(
                    args.base_url,
                    None,
                    lambda resolved: get_sso_account_permissions(
                        args.base_url,
                        resolved.token,
                    ),
                )
                result = attach_client_metadata(result, token_info)
            elif args.sso_command == "logout":
                token_info = resolve_token(None)
                if token_info.auth_type != "sso-session":
                    removed = clear_session_config()
                    result = {
                        "success": True,
                        "removed": removed,
                        "path": session_config_path(),
                        "message": "No valid SSO session was configured.",
                    }
                else:
                    result = attach_client_metadata(
                        logout_sso(args.base_url, token_info.token),
                        token_info,
                    )
                    clear_session_config()
            elif args.sso_command == "refresh-policy":
                result, token_info = run_query_with_sso_retry(
                    args.base_url,
                    None,
                    lambda resolved: get_token_permissions(
                        args.base_url,
                        resolved.token,
                        country=args.country,
                        purpose=args.purpose,
                        access_mode=args.access_mode,
                    ),
                )
                result = attach_client_metadata(result, token_info)
                result = attach_token_permissions_summary(result)
            else:
                parser.error(f"Unknown sso command: {args.sso_command}")
                return
        else:
            parser.error(f"Unknown command: {args.command}")
            return
        print_json(result)
    except GuardrailError as exc:
        print_json(
            {"success": False, "errorType": "GuardrailError", "message": str(exc)},
            stream=sys.stderr,
        )
        raise SystemExit(2)
    except GatewayError as exc:
        print_json(
            {"success": False, "errorType": "GatewayError", "message": str(exc)},
            stream=sys.stderr,
        )
        raise SystemExit(1)


if __name__ == "__main__":
    main()
