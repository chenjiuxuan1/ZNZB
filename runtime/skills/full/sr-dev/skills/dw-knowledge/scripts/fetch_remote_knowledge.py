#!/usr/bin/env python3
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
from urllib.parse import parse_qs, quote, urljoin, urlparse, urlencode
from urllib.error import HTTPError
from urllib.request import Request, urlopen


EMPTY_VERSION = "empty_0000000000A"
LOCAL_SESSION_FILE = Path("~/.config/sr-skills/session-local-dev.json")
PRODUCTION_SESSION_FILE = Path("~/.config/sr-skills/session-data-map-dev.json")
LOCAL_BASE_URLS = {"http://127.0.0.1:4888", "http://localhost:4888"}
PRODUCTION_BASE_URL = "https://data-map-dev.kuainiu.io"
DEV_BASE_URL = "http://127.0.0.1:4888"


def skills_root():
    current = Path(__file__).resolve()
    for parent in current.parents:
        if parent.name == "skills":
            return parent
    return current.parents[2]


def computed_default_cache_root():
    return skills_root() / "cache" / "dw-knowledge"


def default_cache_root():
    return Path(os.environ.get("WS_KNOWLEDGE_CACHE_ROOT", computed_default_cache_root())).expanduser()


def normalized_base_url(base_url):
    return str(base_url or "").rstrip("/")


def resolve_base_url(base_url=None, profile="prod"):
    configured = normalized_base_url(base_url or os.environ.get("WAREHOUSE_KNOWLEDGE_BASE_URL"))
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
    for env_name in ("WS_KNOWLEDGE_API_TOKEN", "WAREHOUSE_KNOWLEDGE_API_TOKEN", "FUXI_API_TOKEN"):
        env_token = os.environ.get(env_name)
        if env_token:
            return env_token, env_name
    session = read_json(default_session_file(base_url))
    if session_is_valid(session):
        return str(session["sessionToken"]), "sr-skills-session"
    return None, "none"


def is_forbidden_skill_content_path(path):
    parts = Path(path).expanduser().resolve().parts
    for index, part in enumerate(parts):
        if part == "skills" and index + 1 < len(parts):
            return parts[index + 1] != "cache"
    return False


def sha256_text(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def request_json(base_url, path, token=None, method="GET", payload=None):
    url = urljoin(base_url.rstrip("/") + "/", path.lstrip("/"))
    headers = {"Accept": "application/json"}
    data = None
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if payload is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = Request(url, data=data, headers=headers, method=method)
    try:
        with urlopen(request, timeout=20) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"knowledge API request failed: HTTP {exc.code} {url} {body}") from exc
    if isinstance(payload, dict) and "data" in payload:
        return payload["data"]
    return payload


def load_state(state_path):
    if not state_path.is_file():
        return {}
    return json.loads(state_path.read_text(encoding="utf-8"))


def write_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")


def safe_relative_file(path_value):
    value = str(path_value or "").replace("\\", "/").lstrip("/")
    path = Path(value)
    if path.is_absolute() or ".." in path.parts:
        raise ValueError(f"unsafe knowledge file path: {path_value}")
    return path


def file_content_path(file_row):
    content_url = str(file_row.get("contentUrl") or file_row.get("content_url") or "")
    if content_url:
        parsed = urlparse(content_url)
        query = parse_qs(parsed.query)
        if "path" in query and query["path"]:
            return parsed.path + "?" + urlencode({"path": query["path"][0]})
        return parsed.path + (f"?{parsed.query}" if parsed.query else "")
    file_path = str(file_row.get("path") or "")
    return "/api/knowledge/files?" + urlencode({"path": file_path})


def fetch_domain(base_url, domain, cache_root=None, source_id="default", token=None, force=False):
    cache_root = Path(cache_root or default_cache_root()).expanduser()
    if is_forbidden_skill_content_path(cache_root):
        raise ValueError("warehouse knowledge cache must live under <skills-root>/cache/dw-knowledge, not inside a skill directory")
    token, token_source = resolve_token(base_url, token)
    domain = str(domain).strip()
    domain_root = cache_root / source_id / domain
    state_path = domain_root / "state.json"
    state = load_state(state_path)

    version_data = request_json(base_url, f"/api/knowledge/domains/{quote(domain)}/version", token=token)
    current_version = str(version_data.get("currentVersion") or version_data.get("domainVersion") or "")
    if not current_version:
        raise ValueError("remote version response did not include currentVersion")

    local_version = str(state.get("currentVersion") or "")
    version_dir = domain_root / current_version
    if not force and local_version == current_version and version_dir.is_dir():
        return {
            "domain": domain,
            "currentVersion": current_version,
            "localVersion": local_version,
            "cacheRoot": cache_root.as_posix(),
            "versionDir": version_dir.as_posix(),
            "checkedRemote": True,
            "downloaded": 0,
            "changed": False,
            "tokenSource": token_source,
        }

    since = local_version or EMPTY_VERSION
    changes_path = f"/api/knowledge/domains/{quote(domain)}/changes?" + urlencode({"since": since})
    changes_data = request_json(base_url, changes_path, token=token)
    changed_files = changes_data.get("changedFiles") or changes_data.get("files") or []
    if not changed_files:
        index_data = request_json(base_url, f"/api/knowledge/domains/{quote(domain)}/index", token=token)
        changed_files = index_data.get("files") or []
    else:
        index_data = {"files": changed_files}

    downloaded = 0
    for file_row in changed_files:
        file_data = request_json(base_url, file_content_path(file_row), token=token)
        content = str(file_data.get("content") or "")
        expected_hash = str(file_row.get("sha256") or "")
        if expected_hash and sha256_text(content) != expected_hash:
            raise ValueError(f"sha256 mismatch for {file_row.get('path')}")
        target = version_dir / safe_relative_file(file_row.get("path") or file_data.get("path"))
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        downloaded += 1

    write_json(version_dir / "index.json", index_data)
    write_json(state_path, {
        "domain": domain,
        "sourceId": source_id,
        "currentVersion": current_version,
        "versionDir": version_dir.as_posix(),
        "remoteVersion": version_data,
    })
    return {
        "domain": domain,
        "currentVersion": current_version,
        "localVersion": local_version,
        "cacheRoot": cache_root.as_posix(),
        "versionDir": version_dir.as_posix(),
        "checkedRemote": True,
        "downloaded": downloaded,
        "changed": downloaded > 0 or current_version != local_version,
        "tokenSource": token_source,
    }


def search_git_docs(base_url, query, domain="", token=None):
    token, _ = resolve_token(base_url, token)
    params = {"q": str(query or "")}
    if str(domain or "").strip():
        params["domain"] = str(domain).strip()
    return request_json(base_url, "/api/knowledge/search?" + urlencode(params), token=token)


def search_wrapped_knowledge(
        base_url,
        query,
        country="",
        category="",
        layer="",
        dataset_id="",
        top_k=10,
        token=None,
        retrieval_model=None,
):
    token, _ = resolve_token(base_url, token)
    payload = compact({
        "query": str(query or ""),
        "country": str(country or ""),
        "category": str(category or ""),
        "layer": str(layer or ""),
        "datasetId": str(dataset_id or ""),
        "topK": int(top_k or 10),
        "retrievalModel": retrieval_model,
    })
    return request_json(base_url, "/api/knowledge/search", token=token, method="POST", payload=payload)


def compact(payload):
    return {
        key: value
        for key, value in payload.items()
        if value is not None and value != ""
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description="Fetch or search warehouse document knowledge on demand.")
    parser.add_argument("--base-url")
    parser.add_argument("--profile", default=os.environ.get("WS_KNOWLEDGE_PROFILE", "prod"),
                        choices=("prod", "dev", "local", "local-dev"))
    parser.add_argument("--operation", default="fetch-domain",
                        choices=("fetch-domain", "git-search", "knowledge-search"))
    parser.add_argument("--domain")
    parser.add_argument("--query")
    parser.add_argument("--path")
    parser.add_argument("--country", default="")
    parser.add_argument("--category", default="")
    parser.add_argument("--layer", default="")
    parser.add_argument("--dataset-id", default="")
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--cache-root", type=Path, default=default_cache_root())
    parser.add_argument("--source-id", default="default")
    parser.add_argument("--token")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args(argv)
    base_url = resolve_base_url(args.base_url, args.profile)
    if args.operation == "fetch-domain":
        if not args.domain:
            parser.error("--domain is required for --operation fetch-domain")
        result = fetch_domain(
            base_url,
            args.domain,
            cache_root=args.cache_root,
            source_id=args.source_id,
            token=args.token,
            force=args.force,
        )
    elif args.operation == "git-search":
        if not args.query:
            parser.error("--query is required for --operation git-search")
        result = search_git_docs(base_url, args.query, domain=args.domain or "", token=args.token)
    else:
        if not args.query:
            parser.error("--query is required for --operation knowledge-search")
        result = search_wrapped_knowledge(
            base_url,
            args.query,
            country=args.country,
            category=args.category,
            layer=args.layer,
            dataset_id=args.dataset_id,
            top_k=args.top_k,
            token=args.token,
        )
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
