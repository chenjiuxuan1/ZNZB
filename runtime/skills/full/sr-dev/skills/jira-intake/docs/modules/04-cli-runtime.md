# 模块：jira-intake-cli

> 名称：`jira-intake-cli`
> 文件：`jira-intake/scripts/jira_intake.py`
> 入口命令：`python3 jira-intake/scripts/jira_intake.py`

## 1. 用途

`jira-intake-cli` 是当前 `jira-intake` 的实际运行入口。默认用于消费 Atlassian Rovo 或 Jira REST 保存下来的 JSON，生成本地 JSON、Markdown、YAML artifact，并支持统计、分类、操作计划和操作审计。

REST API token 模式保留为 fallback：当 Rovo 不可用或某个 Jira 操作无法通过 Rovo 完成时，CLI 可以直接调用 Jira Cloud REST API v3。

## 2. 命令清单

| 命令 | 用途 | 是否需要 Jira token | 是否写 Jira |
|---|---|---|---|
| `config init --transport rovo` | 初始化 Rovo/local-file profile | 否 | 否 |
| `config init --transport rest` | 初始化 REST fallback profile | 是 | 否 |
| `config check` | 检查默认配置 | 否 | 否 |
| `config check --require-rest` | 检查 REST fallback 凭证 | 是 | 否 |
| `config check --connect` | 调 Jira REST `/myself` smoke | 是 | 否 |
| `config show` | 展示当前 profile，token 自动脱敏 | 否 | 否 |
| `config profiles` | 列出本地 profile | 否 | 否 |
| `config use` | 切换当前 profile | 否 | 否 |
| `stats --input` | 读取本地 Rovo/Jira search JSON 并保存分组统计 | 否 | 否 |
| `classify` | 对本地 Jira issue/search JSON 做分类标注 | 否 | 否 |
| `workspace-from-file` | 从本地 Rovo/Jira issue JSON 生成 DW Dev artifact | 否 | 否 |
| `audit-operation` | 记录 Rovo/REST 操作后的本地审计 evidence | 否 | 否 |
| `comment-plan` | 生成 comment 写回计划 | 否 | 否 |
| `transition-plan` | 生成 transition 写回计划 | 否 | 否 |
| `fetch` | REST fallback 拉取单个 issue，生成本地任务入口文件 | 是 | 否 |
| `search` | REST fallback 执行有上限的 JQL 查询并保存 JSON | 是 | 否 |
| `stats --jql` | REST fallback 执行 JQL 并保存分组统计 JSON | 是 | 否 |
| `transitions` | REST fallback 读取某个 issue 的可用状态流转 | 是 | 否 |
| `add-comment` | REST fallback 执行 comment 写回 | 是 | 是，必须 `--confirm` |
| `transition` | REST fallback 执行状态流转并可写入 before/after 审计 evidence | 是 | 是，必须 `--confirm` |

## 3. 输入

默认 Jira 站点为 `https://kylith.atlassian.net`。默认 transport 是：

```bash
JIRA_TRANSPORT=rovo
```

默认 Rovo/local-file 模式不需要 `JIRA_EMAIL` 或 `JIRA_API_TOKEN`。可选上下文：

```bash
JIRA_BASE_URL
JIRA_DEFAULT_PROJECT
JIRA_DEFAULT_BOARD_ID
```

REST fallback 网络调用至少需要：

```bash
JIRA_TRANSPORT=rest
JIRA_EMAIL
JIRA_API_TOKEN
```

推荐先初始化本地 profile：

```bash
python3 jira-intake/scripts/jira_intake.py config init \
  --transport rovo
```

需要 REST fallback 时再初始化凭证：

```bash
python3 jira-intake/scripts/jira_intake.py config init \
  --transport rest \
  --email name@example.com \
  --api-token "***"
```

profile 写入 `~/.codex/jira-intake/config.yaml`，文件权限会设置为 `0600`。运行时读取顺序为：

```text
环境变量 > 当前本地 profile > 默认值
```

`stats --input` 主要输入：

- `--input`，本地 Rovo/Jira search JSON、标准化 evidence JSON 或 issue JSON。
- `--group-by`，支持逗号分隔或重复传入；默认维度为 `status,status_category,assignee,priority,component,label,ownership_prefix,jira_category,country,business_domain,request_type`。
- `--output`。

`workspace-from-file` 主要输入：

- `--input`，本地 Rovo/Jira issue JSON，也可以是只包含一个 issue 的 search JSON。
- `--issue-key`，当输入里有多个 issue 时用于精确选择。
- `--output-dir`，本地 ticket 目录。

`audit-operation` 主要输入：

- `--source-transport`，默认 `atlassian-rovo`。
- `--operation`，例如 `transition`、`comment`、`edit`。
- `--issue-key`。
- before/after 状态、transition 信息和 actor 信息。
- `--output`。

REST fallback 的 `fetch`、`search`、`stats --jql`、`transitions`、`add-comment`、`transition` 会初始化 `JiraClient`，因此必须通过 `validate_rest_config`。

## 4. 输出

`workspace-from-file` 和 REST fallback `fetch` 写入：

```text
00-state.yaml
00-requirement.md
01-requirement.yaml
06-evidence/jira-issue.json
10-decision-trace.yaml
11-map-summary.yaml
```

其中：

- `00-state.yaml` 是 `$dw-dev` 可继续管理的最小任务状态。
- `00-requirement.md` 是可读需求来源。
- `01-requirement.yaml` 是后续 `$dw-dev` 可消费的结构化入口，并包含 `jira_category`。
- `06-evidence/jira-issue.json` 是标准化后的 Jira evidence，并保留 `source_transport`。
- `10-decision-trace.yaml` 和 `11-map-summary.yaml` 是 `$dw-dev` / `$dw-dev` 可展示的最小审计和摘要入口。

`search`、`stats`、`classify`、`transitions`、`audit-operation` 和 plan 命令只写 JSON 到用户指定路径。

`stats` 写入：

```text
schema_version
source_transport
summary.returned
summary.jira_total
groups.<dimension>.<value>
issues[].classification
```

`classification` 包含：

- `countries`
- `business_domain`
- `request_type`
- `ownership_prefix`
- `title_with_ownership`
- `jira_category`：`数据平台Jira工单分类`（`customfield_11541`）的一级/二级目录、字段写入形态、来源和置信度
- `needs_manual_parse`

## 5. 写回闸口

推荐由 `@atlassian-rovo` 执行用户明确确认过的 Jira 写操作，`jira-intake` 负责生成 plan 和记录 audit。

REST fallback 的 `add-comment` 和 `transition` 在没有 `--confirm` 时会拒绝执行。

```bash
python3 jira-intake/scripts/jira_intake.py add-comment DATA-2048 \
  --body-file tickets/DATA-2048/09-jira-comment.md
```

上面命令会失败，因为缺少 `--confirm`。

只有用户确认目标 issue、正文和动作后，才允许执行：

```bash
python3 jira-intake/scripts/jira_intake.py add-comment DATA-2048 \
  --body-file tickets/DATA-2048/09-jira-comment.md \
  --confirm
```

状态流转前建议先通过 Rovo 或 REST fallback 读取 transitions：

```bash
python3 jira-intake/scripts/jira_intake.py transitions DATA-2048 \
  --output tickets/DATA-2048/06-evidence/jira-transitions.json
```

执行 REST fallback 状态流转时可保留审计 evidence：

```bash
python3 jira-intake/scripts/jira_intake.py transition DATA-2048 \
  --transition-id 31 \
  --output tickets/DATA-2048/06-evidence/jira-transition-result.json \
  --confirm
```

Rovo 执行状态流转后，使用本地 audit 命令记录：

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

## 6. 验证

```bash
python3 -m unittest jira-intake/scripts/test_jira_intake.py -v
```
