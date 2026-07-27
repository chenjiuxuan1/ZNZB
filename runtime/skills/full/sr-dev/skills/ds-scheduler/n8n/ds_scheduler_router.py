#!/usr/bin/env python3
"""n8n-side DS 3.4 router for multi-country scheduler operations."""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, Tuple


COUNTRY_REPOS = {
    "cn": "/Users/jiangchuanchen/Desktop/CN-Intelligent-Alarm-Repair-Assistant",
    "ine": "/Users/jiangchuanchen/Desktop/INE-Intelligent-Alarm-Repair-Assistant",
    "mx": "/Users/jiangchuanchen/Desktop/MX-Intelligent-Alarm-Repair-Assistant",
    "ph": "/Users/jiangchuanchen/Desktop/PH-Intelligent-Alarm-Repair-Assistant",
    "pk": "/Users/jiangchuanchen/Desktop/PK-Intelligent-Alarm-Repair-Assistant",
    "th": "/Users/jiangchuanchen/Desktop/TH-Intelligent-Alarm-Repair-Assistant",
}


def load_request() -> Dict[str, Any]:
    raw = sys.stdin.read().strip()
    if not raw:
        raise ValueError("empty request body")
    return json.loads(raw)


def load_country_config(country: str) -> Dict[str, Any]:
    repo = COUNTRY_REPOS.get(country)
    if not repo:
        raise ValueError(f"unsupported country: {country}")

    module_path = Path(repo) / "config" / "config.py"
    spec = importlib.util.spec_from_file_location(f"{country}_config", module_path)
    if spec is None or spec.loader is None:
        raise ValueError(f"unable to load config for {country}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return {
        "repo": repo,
        "ds": dict(module.DS_CONFIG),
        "workspace": dict(module.WORKSPACE_CONFIG),
    }


def ds_request(
    method: str,
    base_url: str,
    token: str,
    path: str,
    query: Dict[str, Any] | None = None,
    form: Dict[str, Any] | None = None,
) -> Tuple[bool, Any]:
    query_string = ""
    if query:
        query_string = "?" + urllib.parse.urlencode({k: v for k, v in query.items() if v not in ("", None)})
    url = base_url.rstrip("/") + path + query_string

    data = None
    headers = {
        "token": token,
        "Accept": "application/json, text/plain, */*",
    }
    if form is not None:
        data = urllib.parse.urlencode({k: v for k, v in form.items() if v not in ("", None)}).encode("utf-8")
        headers["Content-Type"] = "application/x-www-form-urlencoded"

    request = urllib.request.Request(url, data=data, headers=headers, method=method.upper())
    try:
        with urllib.request.urlopen(request, timeout=30) as resp:
            body = resp.read().decode("utf-8", errors="replace")
        try:
            return True, json.loads(body)
        except json.JSONDecodeError:
            return True, {"raw": body}
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(body)
        except json.JSONDecodeError:
            parsed = {"raw": body}
        return False, {"status": exc.code, "body": parsed, "url": url}
    except Exception as exc:  # pragma: no cover
        return False, {"error": repr(exc), "url": url}


def do_list_workflows(ctx: Dict[str, Any], payload: Dict[str, Any], token: str) -> Tuple[bool, Any]:
    project_code = payload.get("project_code") or ctx["ds"]["project_code"]
    query = {
        "pageNo": payload.get("page_no", 1),
        "pageSize": payload.get("page_size", 20),
        "searchVal": payload.get("search_val", ""),
    }
    return ds_request("GET", ctx["ds"]["base_url"], token, f"/projects/{project_code}/workflow-definition", query=query)


def do_get_workflow(ctx: Dict[str, Any], payload: Dict[str, Any], token: str) -> Tuple[bool, Any]:
    project_code = payload.get("project_code") or ctx["ds"]["project_code"]
    workflow_code = payload.get("workflow_code")
    if workflow_code:
        return ds_request("GET", ctx["ds"]["base_url"], token, f"/projects/{project_code}/workflow-definition/{workflow_code}")
    ok, data = do_list_workflows(ctx, payload, token)
    if not ok:
        return ok, data
    workflow_name = payload.get("workflow_name")
    items = data.get("data", {}).get("totalList", [])
    for item in items:
        if str(item.get("name", "")).strip() == str(workflow_name).strip():
            return True, item
    return False, {"message": f"workflow not found by name: {workflow_name}"}


def do_release_workflow(ctx: Dict[str, Any], payload: Dict[str, Any], token: str, release_state: str) -> Tuple[bool, Any]:
    project_code = payload.get("project_code") or ctx["ds"]["project_code"]
    workflow_code = payload.get("workflow_code")
    query = {"releaseState": release_state}
    return ds_request("POST", ctx["ds"]["base_url"], token, f"/projects/{project_code}/workflow-definition/{workflow_code}/release", query=query)


def do_trigger_workflow(ctx: Dict[str, Any], payload: Dict[str, Any], token: str) -> Tuple[bool, Any]:
    project_code = payload.get("project_code") or ctx["ds"]["project_code"]
    form = {
        "processDefinitionCode": payload.get("workflow_code"),
        "failureStrategy": "CONTINUE",
        "warningType": "NONE",
        "warningGroupId": "0",
        "processInstancePriority": "MEDIUM",
        "workerGroup": "default",
        "environmentCode": ctx["ds"].get("environment_code", ""),
        "tenantCode": ctx["ds"].get("tenant_code", ""),
        "taskDependType": "TASK_ONLY" if payload.get("start_node_list") else "TASK_POST",
        "runMode": "RUN_MODE_SERIAL",
        "execType": "START_PROCESS",
        "dryRun": "0",
        "scheduleTime": payload.get("schedule_time", ""),
    }
    if payload.get("start_node_list"):
        form["startNodeList"] = payload["start_node_list"]
    custom_params = payload.get("custom_params") or {}
    if custom_params:
        form["startParams"] = json.dumps(custom_params, ensure_ascii=False)
    return ds_request("POST", ctx["ds"]["base_url"], token, f"/projects/{project_code}/executors/start-process-instance", form=form)


def do_list_instances(ctx: Dict[str, Any], payload: Dict[str, Any], token: str) -> Tuple[bool, Any]:
    project_code = payload.get("project_code") or ctx["ds"]["project_code"]
    query = {
        "pageNo": payload.get("page_no", 1),
        "pageSize": payload.get("page_size", 20),
        "stateType": payload.get("state_type", ""),
        "searchVal": payload.get("search_val", ""),
    }
    return ds_request("GET", ctx["ds"]["base_url"], token, f"/projects/{project_code}/workflow-instances", query=query)


def do_get_instance(ctx: Dict[str, Any], payload: Dict[str, Any], token: str) -> Tuple[bool, Any]:
    project_code = payload.get("project_code") or ctx["ds"]["project_code"]
    instance_id = payload.get("instance_id")
    return ds_request("GET", ctx["ds"]["base_url"], token, f"/projects/{project_code}/workflow-instances/{instance_id}")


def route_action(request_data: Dict[str, Any]) -> Dict[str, Any]:
    country = request_data.get("country")
    action = request_data.get("action")
    token = request_data.get("ds_token")
    payload = request_data.get("payload") or {}
    request_id = request_data.get("request_id", "")

    if not token:
        return response(False, country, action, request_id, None, {"code": "MISSING_TOKEN", "message": "ds_token is required"})

    ctx = load_country_config(country)
    handlers = {
        "list_workflows": lambda: do_list_workflows(ctx, payload, token),
        "get_workflow": lambda: do_get_workflow(ctx, payload, token),
        "online_workflow": lambda: do_release_workflow(ctx, payload, token, "ONLINE"),
        "offline_workflow": lambda: do_release_workflow(ctx, payload, token, "OFFLINE"),
        "trigger_workflow": lambda: do_trigger_workflow(ctx, payload, token),
        "list_instances": lambda: do_list_instances(ctx, payload, token),
        "get_instance": lambda: do_get_instance(ctx, payload, token),
    }

    if action not in handlers:
        return response(False, country, action, request_id, None, {"code": "UNSUPPORTED_ACTION", "message": action})

    ok, result = handlers[action]()
    if ok:
        return response(True, country, action, request_id, result, None)
    return response(False, country, action, request_id, None, {"code": "DS_API_ERROR", "message": result})


def response(success: bool, country: str, action: str, request_id: str, data: Any, error: Any) -> Dict[str, Any]:
    return {
        "success": success,
        "country": country,
        "action": action,
        "request_id": request_id,
        "data": data,
        "error": error,
    }


def main() -> None:
    try:
        request_data = load_request()
        print(json.dumps(route_action(request_data), ensure_ascii=False))
    except Exception as exc:
        print(
            json.dumps(
                response(False, "", "", "", None, {"code": "ROUTER_ERROR", "message": repr(exc)}),
                ensure_ascii=False,
            )
        )
        raise


if __name__ == "__main__":
    main()
