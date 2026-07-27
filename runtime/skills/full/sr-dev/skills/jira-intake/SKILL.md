---
name: jira-intake
description: Use when Atlassian Rovo or saved Jira JSON should be normalized into DW Dev requirement artifacts, statistics, classification, DATA project Jira category inference, or controlled Jira operation plans; REST API token mode is fallback only.
---

# Jira Intake

Use this skill as the Jira-facing intake and local orchestration adapter for DW Dev work.

It can be used directly by a user, or orchestrated by `$dw-dev` through local requirement artifacts. When `@atlassian-rovo` is available, use Rovo as the primary Jira read/write surface. `jira-intake` then normalizes Rovo/Jira JSON, builds local artifacts, produces statistics/classification, and records operation plans or after-action audits. Jira REST API token mode is only a fallback for standalone or Rovo-unavailable cases.

## Core Rules

- Prefer `@atlassian-rovo` for live Jira reads and writes because it is company-controlled.
- Use `jira-intake` for local orchestration: normalize saved Rovo/Jira JSON, generate DW Dev artifacts, build statistics/classification, and record operation plans/audits.
- When creating, normalizing, or preparing Jira requirements, keep a leading ownership prefix in the title such as `【数仓Agent】`, `【数据开发】`, `【数据需求】`, `【基础建设】`, or `【底表迭代】`. If the user did not provide one, infer it from the title, description, components, and labels; use `【数据需求】` as the fallback.
- When creating or preparing Jira requirements in project `DATA`, also fill `数据平台Jira工单分类` (`customfield_11541`, cascading select). If the user did not provide first/second category, infer it from the actual scenario and only use values from the controlled enum below.
- Keep new Jira summaries concise: `【归属】 + capability/action name` only. Do not put background, process notes, due dates, implementation details, or long acceptance text in the title; put those in the description, comments, attachments, or local artifacts.
- Do not require Jira API token for the default Rovo/local-file path.
- Use Jira REST API only as fallback for issue fetch, comments, field/status/transition lookup, bounded JQL search, or explicitly confirmed writes when Rovo cannot solve the task.
- Write local artifacts first: `00-requirement.md`, `01-requirement.yaml`, `06-evidence/jira-issue.json`, and Jira operation plans.
- Treat status transitions as evidence-backed operations. Before moving an issue to `开发中`/`处理中`/`待评审`/`已评审`/`完成`, check that the Jira issue has enough context for that state: concise summary, clear background/scope, current status, due date when applicable, and relevant design, usage, evidence, or delivery documents. If materials are missing, prepare or supplement them before the transition; record the before/after audit.
- Never add comments, transition issues, edit issues, delete comments, or upload attachments unless the user explicitly confirms the exact operation. Prefer executing those confirmed Jira actions through Rovo; use REST token fallback only if Rovo is unavailable or insufficient.
- Do not execute SQL, call `$sr-box-new`, or change production warehouse assets.
- Do not store Jira tokens in repo files, tickets, Markdown, logs, or eval cases.

## Configuration

Default Jira site is `https://kylith.atlassian.net`.

Default transport is Rovo/local-file mode:

```bash
JIRA_TRANSPORT="rovo"
```

No Jira API token is required for this default mode. Optional context defaults:

```bash
JIRA_BASE_URL="https://kylith.atlassian.net"
JIRA_DEFAULT_PROJECT="DATA"
JIRA_DEFAULT_BOARD_ID="789"
```

REST fallback mode requires:

```bash
JIRA_TRANSPORT="rest"
JIRA_EMAIL="name@example.com"
JIRA_API_TOKEN="***"
```

Use local skill-managed profiles for quick setup and switching. Rovo mode can be initialized without email or token:

```bash
python3 jira-intake/scripts/jira_intake.py config init \
  --transport rovo
```

Initialize REST fallback only when Rovo cannot solve the task:

```bash
python3 jira-intake/scripts/jira_intake.py config init \
  --transport rest \
  --email name@example.com \
  --api-token "***"
```

Common profile checks:

```bash
python3 jira-intake/scripts/jira_intake.py config check
python3 jira-intake/scripts/jira_intake.py config check --require-rest
python3 jira-intake/scripts/jira_intake.py config profiles
python3 jira-intake/scripts/jira_intake.py config use kylith
```

Profiles are stored under `~/.codex/jira-intake/config.yaml` with `0600` permissions. Do not store Jira tokens in repo files, tickets, Markdown, logs, or eval cases. If REST fallback is required and `JIRA_EMAIL` or `JIRA_API_TOKEN` is missing, stop before network calls and ask the user to run `config init --transport rest`.

## Direct Usage

Primary Rovo workflow:

```text
@atlassian-rovo reads issue/search/transitions or executes a confirmed Jira operation
  -> save or provide the JSON/result evidence
  -> jira-intake normalizes, classifies, writes local artifacts, or records audit
  -> dw-dev parse / plan / route
```

Build grouped Jira statistics from a saved Rovo or Jira search result:

```bash
python3 jira-intake/scripts/jira_intake.py stats \
  --input /tmp/rovo-jira-search.json \
  --group-by status,assignee,ownership_prefix,jira_category,country,business_domain,request_type \
  --output /tmp/jira-stats.json
```

Title ownership classification is emitted as `ownership_prefix` and `title_with_ownership` in `classify`, `stats`, `workspace-from-file`, `01-requirement.yaml`, and `11-map-summary.yaml`. Preserve an existing prefix; otherwise infer one before creating or updating the Jira summary.

Summary style for issue creation:

```text
Good: 【数仓Agent】 知识上下文能力
Good: 【数据开发】 贷后宽表字段补充
Bad:  【数仓Agent】 知识上下文能力开发，参考 dw-dev，补充设计文档，7月20前完成
```

Put the extra context in the description or attachments, not the summary.

Jira data-platform category for issue creation:

```json
{
  "customfield_11541": {
    "value": "一级类目",
    "child": {"value": "二级类目"}
  }
}
```

Controlled enum source: Google Sheet `jira 工单分类 / 类目表`, `A:B`, https://docs.google.com/spreadsheets/d/1_1jzg0wUko-2XnNgm8Ftvlqxjr1yt7AI0QvAnbFTexs/edit?gid=0#gid=0 . If this sheet changes, update this skill and tests.

| 一级类目 | 二级类目 |
|---|---|
| 业务需求 | 报表迭代/新增；指标需求；业务取数；数据分析支持；数据产品支持 |
| 数据同步需求 | 新数据源接入；离线同步；实时同步；接口 / API 同步；第三方 SaaS 数据同步；同步链路改造 |
| 数据中台建设 | 数据集成；数据质量；数据地图；数据权限；实时数据资产；数据服务 / API；监控告警；安全生产；架构设计 |
| 宽表建设 | 用户主题宽表；订单主题宽表；商品主题宽表；营销主题宽表；财务主题宽表；经营分析宽表；风控主题宽表 |
| 数据治理 | 指标口径治理；数据标准；表 / 字段命名规范；数据质量治理；数据资产治理；权限治理；生命周期治理；成本治理；安全合规治理 |
| 运维与稳定性 | 数据延迟处理；数据异常排查；告警优化；SLA 保障；性能优化；容量 / 资源治理；ds 调度平台融合；安全生产；监控告警；superset 优化；jupyterhub on k8s |
| 技术债与优化 | 架构重构；老任务下线；公共逻辑复用；脚本规范化；存储优化；计算资源优化 |
| 临时支持 | 查数导数；问题排查 |

Inference examples:

- `DATA-2402` / `菲律宾/墨西哥/泰国营销主题宽表优惠券逻辑处理` -> `宽表建设 / 营销主题宽表`.
- `DATA-2405` / `中国高内存占用 DS 调度排查与治理` -> `运维与稳定性 / 容量 / 资源治理`.

If multiple categories match, choose the most specific business scenario. Do not create a Jira issue with only the first category when the second category is inferable. If no controlled enum value fits, leave the field out, mark `classification.jira_category.source=unknown`, and ask for clarification before a confirmed Jira write.

Create a DW Dev requirement workspace from a saved Rovo or Jira issue JSON:

```bash
python3 jira-intake/scripts/jira_intake.py workspace-from-file \
  --input /tmp/rovo-issue.json \
  --issue-key DATA-2048 \
  --output-dir tickets/DATA-2048
```

Record evidence after a confirmed Rovo Jira operation:

```bash
python3 jira-intake/scripts/jira_intake.py audit-operation \
  --source-transport atlassian-rovo \
  --operation transition \
  --issue-key DATA-2048 \
  --before-status "待评审" \
  --after-status "开发中" \
  --transition-id 31 \
  --transition-name "开始开发" \
  --output tickets/DATA-2048/06-evidence/jira-rovo-transition-audit.json
```

REST fallback can fetch a Jira issue into a local requirement workspace:

```bash
python3 jira-intake/scripts/jira_intake.py fetch DATA-2048 \
  --include-comments \
  --output-dir tickets/DATA-2048
```

REST fallback can search Jira with bounded JQL:

```bash
python3 jira-intake/scripts/jira_intake.py search \
  --jql 'project = DATA AND statusCategory != Done ORDER BY updated DESC' \
  --max-results 50 \
  --output /tmp/jira-search.json
```

REST fallback can build grouped Jira statistics from JQL:

```bash
python3 jira-intake/scripts/jira_intake.py stats \
  --jql 'project = DATA AND statusCategory != Done ORDER BY updated DESC' \
  --max-results 50 \
  --group-by status,assignee,ownership_prefix,jira_category,country,business_domain,request_type \
  --output /tmp/jira-stats.json
```

Classify a saved Jira issue or search JSON into management metadata:

```bash
python3 jira-intake/scripts/jira_intake.py classify \
  --input /tmp/jira-search.json \
  --output /tmp/jira-classified.json
```

REST fallback can read available transitions:

```bash
python3 jira-intake/scripts/jira_intake.py transitions DATA-2048 \
  --output tickets/DATA-2048/06-evidence/jira-transitions.json
```

Create a local write plan before any Jira mutation:

```bash
python3 jira-intake/scripts/jira_intake.py comment-plan DATA-2048 \
  --body-file tickets/DATA-2048/09-jira-comment.md \
  --output tickets/DATA-2048/06-evidence/jira-comment-plan.json
```

Execute writes only after explicit confirmation. Prefer Rovo for the actual Jira mutation; use these REST commands only when fallback is required:

```bash
python3 jira-intake/scripts/jira_intake.py add-comment DATA-2048 \
  --body-file tickets/DATA-2048/09-jira-comment.md \
  --confirm
```

REST transition execution also validates the transition against the current issue and can persist before/after audit evidence:

```bash
python3 jira-intake/scripts/jira_intake.py transition DATA-2048 \
  --transition-id 31 \
  --output tickets/DATA-2048/06-evidence/jira-transition-result.json \
  --confirm
```

For any status transition, check whether the target state needs supplemental material:

- `处理中` / `开发中`: background, scope, owner/assignee, due date if known, and next deliverable.
- `待评审`: design or usage document, implementation summary, review target, and evidence path if applicable.
- `已评审`: review conclusion, remaining risks, accepted documents, and reviewer context.
- `完成`: delivery summary, evidence, final document/comment draft, and unresolved boundary if any.

If these are missing, create a local operation plan and supplement Jira description/comment/attachments before the transition when the user has confirmed those writes.

## Agent Mode

When `$dw-dev` uses this module, the handoff is artifact-only:

```text
jira-intake
  -> 00-requirement.md
  -> 01-requirement.yaml
  -> 06-evidence/jira-issue.json
  -> dw-dev parse / plan / route
```

`$dw-dev` remains the lifecycle controller. This skill owns Jira input normalization, local artifacts, statistics/classification, operation plans, and operation audit records only.

## Reference

For transport, endpoint, and field rules, read `references/jira-api-contract.md`.

## Docs

- `docs/README.md`: end-to-end usage for standalone and `$dw-dev` handoff.
- `docs/modules/01-skill-entry.md`: skill entry name, modes, and boundaries.
- `docs/modules/02-pack-manifest.md`: `pack.yaml` module metadata and capability declarations.
- `docs/modules/03-openai-agent.md`: `agents/openai.yaml` display name and invocation policy.
- `docs/modules/04-cli-runtime.md`: CLI commands, outputs, and confirmation gates.
- `docs/modules/05-api-contract.md`: Rovo-first transport and REST API fallback contract usage.
- `docs/modules/06-tests.md`: local test coverage and verification command.
