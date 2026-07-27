---
name: dw-knowledge
description: Use when building warehouse semantic context, document knowledge, knowledge-base search, query specs, clarification drafts, or 04-context.md artifacts through production SR Box knowledge APIs without viewing code or executing SQL.
---

# 数仓知识库

Use this skill for production warehouse document knowledge, knowledge-base search, and semantic context. It owns the non-code KNOW context path and reads production SR Box at `https://data-map-dev.kuainiu.io`.

For local 4888 development, use `$dw-knowledge-dev` instead.

## Scope

- Build `04-context.md`, query spec, and `02-clarification.md` from `01-requirement.yaml`, semantic-layer files, reference docs, and remote document knowledge.
- Read Git-backed document knowledge APIs, domain versions, indexes, file content, and wrapped knowledge search.
- Coordinate code questions through `$dw-code-knowledge`. If `$dw-code-knowledge` is not installed or available, answer: `没有查看代码权限：未安装 dw-code-knowledge，无法查询数仓代码库。`

## Inputs

- `01-requirement.yaml`
- `semantic-layer/manifest.yaml`
- `semantic-layer/metrics/**`
- `references/domains/*.md`
- Optional production SR Box document and wrapped knowledge APIs.

## Build Context

```bash
python3 skills/dw-knowledge/scripts/build_context.py \
  tickets/DATA-2048/01-requirement.yaml \
  --context-output tickets/DATA-2048/04-context.md \
  --query-spec-output /tmp/query-spec.yaml \
  --clarification-output tickets/DATA-2048/02-clarification.md
```

## Remote Knowledge

Default production base URL:

```text
https://data-map-dev.kuainiu.io
```

Read document and knowledge APIs only:

```text
GET /api/knowledge/catalog
GET /api/knowledge/tree?domain=<domain>
GET /api/knowledge/domains/{domain}/version
GET /api/knowledge/domains/{domain}/index
GET /api/knowledge/domains/{domain}/changes?since=<localVersion>
GET /api/knowledge/search?q=<query>&domain=<domain>
GET /api/knowledge/files?path=<knowledge-pack-relative-path>
GET /api/knowledge/domains/{domain}/docs/{docId}
GET /api/knowledge/dify/datasets?includeAll=true&keyword=&page=1&limit=100
GET /api/knowledge/dify/datasets/{datasetId}/documents?keyword=&status=&page=1&limit=100
POST /api/knowledge/dify/datasets/{datasetId}/retrieve
POST /api/knowledge/search
```

## Behavior

- Match semantic metrics by exact ID, then normalized exact name or alias.
- Use domain references only when semantic has no unique match.
- Default remote base URL is `https://data-map-dev.kuainiu.io`. Reuse `$sr-box` SSO login/session for document and knowledge reads only.
- Resolve knowledge in this order:
  1. Git-backed document knowledge APIs for managed docs, domain versions, indexes, file content, and latest knowledge-pack context.
  2. Wrapped knowledge search when Git docs miss or the user asks for similar, semantic, or reference knowledge.
  3. Local semantic/reference files when remote APIs are unavailable or the requirement is already fully resolved locally.
- When the user asks for ETL SQL, workflow scripts, table build logic, code provenance, or any code file, do not call code endpoints from this skill. Call `$dw-code-knowledge`; if it is unavailable, state `没有查看代码权限：未安装 dw-code-knowledge，无法查询数仓代码库。`
- Store fetched remote knowledge under `<skills-root>/cache/dw-knowledge`, for example `/Users/admin/.codex/skills/cache/dw-knowledge`. Never store business knowledge inside a specific skill directory.
- Do not read Git source directories such as `/Users/admin/IdeaProjects/starrocks/doc/knowledge-pack` or SR Box materialized directories such as `src/source/knowledge-pack` directly. Use SR Box APIs or `fetch_remote_knowledge.py` first, then read the fetched copy under the cache root.
- `fetch_remote_knowledge.py` sends `Authorization: Bearer <token>` from `--token`, `WS_KNOWLEDGE_API_TOKEN`, `WAREHOUSE_KNOWLEDGE_API_TOKEN`, `FUXI_API_TOKEN`, or the SR Skills SSO session file. Production uses `~/.config/sr-skills/session-data-map-dev.json`.
- Return `semantic_miss` when neither semantic nor reference can resolve the request.
- Generate query spec only when country, time range, canonical table, and required parameters are usable.
- Generate clarification when information is missing or canonical assets are unresolved.

## Helper

Use the helper only after a requirement actually needs a remote domain:

```bash
python3 skills/dw-knowledge/scripts/fetch_remote_knowledge.py \
  --profile prod \
  --domain fox \
  --source-id starrocks
```

Git document search:

```bash
python3 skills/dw-knowledge/scripts/fetch_remote_knowledge.py \
  --profile prod \
  --operation git-search \
  --query "fox DWB 宽表" \
  --domain fox
```

Wrapped knowledge search:

```bash
python3 skills/dw-knowledge/scripts/fetch_remote_knowledge.py \
  --profile prod \
  --operation knowledge-search \
  --query "放款统计" \
  --country cn \
  --category report \
  --top-k 5
```

## Boundaries

- Do not execute SQL.
- Do not call `sr-box-new`.
- Do not use `$sr-box` or `$data-query-dev` for SQL execution from this skill.
- Do not read code. Code questions belong to `$dw-code-knowledge`.
- Do not store business knowledge documents inside a skill directory.
- Do not invent table names when semantic/reference misses.
- Do not send Jira comments, reports, PDF, email, or group messages.
- Do not edit shared contracts from this skill; open a separate maintenance task when a contract change is needed.
