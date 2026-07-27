---
name: dw-code-knowledge
description: Use when the user is authorized to inspect production warehouse Git code through SR Box code search and file read APIs, including ETL SQL, workflow scripts, table build logic, and code provenance, without executing SQL.
---

# 数仓代码库

Use this skill only when code viewing is allowed and the user asks for warehouse Git code, ETL SQL, workflow scripts, table build logic, or code provenance.

For local 4888 development, use `$dw-code-knowledge-dev` instead.

## Scope

- Search production warehouse code through SR Box read-only code APIs.
- Read exact code files through SR Box read-only code APIs.
- Return source id, path, snippet/content boundary, retrieval time, and any active source metadata available from the API.

## APIs

Production base URL:

```text
https://data-map-dev.kuainiu.io
```

Code knowledge:

```text
GET /api/code/search?q=<query>
GET /api/code/files?path=<code-source-relative-path>
```

## Helper

Code search:

```bash
python3 skills/dw-code-knowledge/scripts/fetch_remote_knowledge.py \
  --profile prod \
  --operation code-search \
  --query "dwb_fox_mission_recovery_d"
```

Code file read:

```bash
python3 skills/dw-code-knowledge/scripts/fetch_remote_knowledge.py \
  --profile prod \
  --operation code-file \
  --path "th/dwb_fox_mission_recovery_d.sql"
```

## Behavior

- Reuse `$sr-box` SSO login/session only to authenticate read-only code API calls.
- `fetch_remote_knowledge.py` sends `Authorization: Bearer <token>` from `--token`, `WS_CODE_KNOWLEDGE_API_TOKEN`, `WAREHOUSE_KNOWLEDGE_API_TOKEN`, `FUXI_API_TOKEN`, or `~/.config/sr-skills/session-data-map-dev.json`.
- Use search before file read unless the user provided an exact path.
- If the code API denies access, report that code viewing permission is unavailable; do not fall back to local Git working trees.
- Do not read `/Users/admin/IdeaProjects/starrocks` or SR Box materialized source directories directly from this skill.

## Boundaries

- Do not execute SQL.
- Do not manage Git sources, pull branches, refresh sources, or activate sources.
- Do not read document knowledge, semantic context, or Dify knowledge from this skill. Use `$dw-knowledge`.
- Do not bypass code-view permission by using local Git paths.
- Do not send Jira comments, reports, PDF, email, or group messages.
