---
name: dw-knowledge-init
description: Use when admins or developers initialize or normalize Warehouse Knowledge Pack documents, domain manifests, versions.yaml, and index.yaml before committing Git-backed knowledge sources for SR Box document APIs.
---

# Warehouse Knowledge Init

Internal admin/developer skill for preparing Git-backed Warehouse Knowledge Packs. It creates normalized domain files and version metadata that SR Box later serves through URL APIs.

## Boundary

- Use only for admin/developer initialization of large document sets.
- Write files into the selected Git knowledge source, usually `doc/knowledge-pack`.
- Do not put business knowledge under `.codex/skills`; runtime consumers cache under `~/.codex/cache/warehouse-knowledge`.
- Do not run Git pull, push, merge, or conflict resolution. Git remains an admin workflow outside this skill.
- Do not execute SQL, call SR, send Jira comments, or publish reports.

## Version Model

Each domain folder should contain:

```text
manifest.yaml
versions.yaml
index.yaml
*.md
```

Domain versions use explicit IDs such as `fox_2026070611X`. File versions are independent and derived from the domain version plus a per-file sequence, for example `fox_2026070611X_001`.

`versions.yaml` records domain-level update history. `index.yaml` records file path, `file_version`, `sha256`, size, update time, and SR Box `content_url`.

## Initialize A Domain

```bash
python3 scripts/init_knowledge_pack.py \
  --source-dir /path/to/raw-docs \
  --output-root /Users/admin/IdeaProjects/starrocks/doc/knowledge-pack \
  --domain fox \
  --display-name "贷后 FOX" \
  --version fox_2026070611X \
  --author owenzhang \
  --source-note "初始化 fox 知识包"
```

The script copies `.md` and `.txt` files, writes `manifest.yaml`, `versions.yaml`, and `index.yaml`, and preserves unchanged file versions when an existing index has the same SHA-256.

## Validate

```bash
python3 scripts/init_knowledge_pack.py --help
python3 scripts/test_init_knowledge_pack.py
```

After committing and pushing the Git source, use SR Box admin document management to pull/refresh the server-side materialized knowledge pack.
