#!/usr/bin/env python3
"""Build a private ds-scheduler payload with manager-owned token fallback."""

import argparse
from contextlib import redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile

from ds_token_manager import resolve_token


DEFAULT_DS_SCHEDULER_PATH = Path.home() / ".codex" / "skills" / "ds-scheduler"
DEFAULT_WEBHOOK_URL = "https://sql-cn.kuainiujinke.com/webhook/ds-scheduler"


def load_ds_builder(skill_path):
    script = Path(skill_path).expanduser() / "scripts" / "build_ds_webhook_payload.py"
    if not script.is_file():
        raise SystemExit(f"ds-scheduler payload builder not found: {script}")
    spec = importlib.util.spec_from_file_location("ds_scheduler_payload_builder", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module, script


def write_private_payload(path, payload):
    path = Path(path).expanduser()
    path.parent.mkdir(parents=True, exist_ok=True)
    file_descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        dir=str(path.parent),
        text=True,
    )
    temporary_path = Path(temporary_name)
    try:
        os.fchmod(file_descriptor, 0o600)
        with os.fdopen(file_descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(str(temporary_path), str(path))
        os.chmod(path, 0o600)
    finally:
        if temporary_path.exists():
            temporary_path.unlink()
    return path


def main(argv=None):
    parser = argparse.ArgumentParser(description="使用 manager 默认 token 构造 ds-scheduler 私有请求")
    parser.add_argument("--country", required=True)
    parser.add_argument("--action", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--token-config")
    parser.add_argument("--ds-token")
    parser.add_argument("--ds-scheduler-skill-path", default=str(DEFAULT_DS_SCHEDULER_PATH))
    parser.add_argument("--webhook-url", default=DEFAULT_WEBHOOK_URL)
    args, forwarded = parser.parse_known_args(argv)

    resolution = resolve_token(
        args.country,
        explicit_token=args.ds_token,
        config_path=args.token_config,
    )
    if not resolution.token:
        raise SystemExit(
            f"country={args.country} 没有可用 token；请显式提供、设置 DS_SCHEDULER_TOKEN，或更新 manager 私有配置"
        )

    module, script = load_ds_builder(args.ds_scheduler_skill_path)
    builder_argv = [
        str(script),
        "--webhook-url",
        args.webhook_url,
        "--country",
        args.country,
        "--action",
        args.action,
        "--ds-token",
        resolution.token,
    ] + forwarded
    original_argv = sys.argv
    captured = io.StringIO()
    try:
        sys.argv = builder_argv
        with redirect_stdout(captured):
            module.main()
    finally:
        sys.argv = original_argv

    json_text = captured.getvalue().split("\n\n# curl", 1)[0].strip()
    payload = json.loads(json_text)
    output = write_private_payload(args.output, payload)
    print(
        json.dumps(
            {
                "success": True,
                "country": args.country,
                "action": args.action,
                "token_source": resolution.source,
                "output": str(output),
                "mode": oct(output.stat().st_mode & 0o777),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
