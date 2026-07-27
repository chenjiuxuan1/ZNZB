# 模块：jira-intake-api-contract

> 名称：`jira-intake-api-contract`
> 文件：`jira-intake/references/jira-api-contract.md`
> 参考资料：`docs/参考资料/11-Jira-API接入与需求入口设计.md`

## 1. 用途

`jira-intake-api-contract` 记录 Jira transport、字段、输出映射和写回约束。当前架构是 Rovo-first：优先由 `@atlassian-rovo` 读取 Jira 或执行用户明确确认的 Jira 操作，`jira-intake` 负责把 Rovo/Jira JSON 归一化为本地 artifact、统计、分类和审计记录。

Jira Cloud REST API v3 仍保留为 fallback，用于 Rovo 不可用、Rovo 无法覆盖的字段/分页/动作，或独立安装环境中没有 Rovo 的场景。

本 contract 还记录 `DATA` 项目 `数据平台Jira工单分类`（`customfield_11541`）的 cascading select 写入形态和受控枚举来源。创建或准备 Jira 需求时，`jira-intake` 应保留已有字段；缺失时按场景推断一级/二级目录，并把结果写入 `classification.jira_category`。

## 2. Rovo transport contract

Rovo 输入可以是 issue 节点、search 结果或操作结果。`jira-intake` 会把常见 Rovo search 结构：

```json
{
  "issues": {
    "nodes": [],
    "pageInfo": {},
    "webUrl": ""
  }
}
```

归一化为 REST-like 结构：

```json
{
  "issues": [],
  "total": 0,
  "isLast": true,
  "nextPageToken": "",
  "source_transport": "atlassian-rovo"
}
```

归一化后的 issue 会保留 `source_transport`，供 `06-evidence/jira-issue.json` 和统计输出审计。

## 3. REST fallback 读取类 API

| 需求 | API |
|---|---|
| Issue 详情 | `GET /rest/api/3/issue/{issueIdOrKey}` |
| 评论 | `GET /rest/api/3/issue/{issueIdOrKey}/comment` |
| 可用 transitions | `GET /rest/api/3/issue/{issueIdOrKey}/transitions` |
| JQL search | `GET /rest/api/3/search/jql` |
| 字段发现 | `GET /rest/api/3/field/search` |

读取 issue 时使用显式字段，避免把无关字段和敏感字段落盘；`customfield_11541` 属于需求分类必要字段，应包含在读取字段中。

## 4. 写回规则

| 需求 | 首选执行面 | REST fallback API | 默认策略 |
|---|---|---|---|
| 新增 comment | `@atlassian-rovo` | `POST /rest/api/3/issue/{issueIdOrKey}/comment` | plan/audit only |
| 状态流转 | `@atlassian-rovo` | `POST /rest/api/3/issue/{issueIdOrKey}/transitions` | plan/audit only |
| 编辑 issue | `@atlassian-rovo` | `PUT /rest/api/3/issue/{issueIdOrKey}` | 默认阻断 |
| 上传附件 | `@atlassian-rovo` | `POST /rest/api/3/issue/{issueIdOrKey}/attachments` | 确认后才允许 |

写回必须具备：

- 目标 issue key。
- 本地来源 artifact，例如 `09-jira-comment.md`。
- 用户明确确认。
- Rovo 或 REST 执行结果 evidence。
- before/after 状态或字段快照，能获取时必须记录。
- 无 token 或 secret 落盘。

## 5. 输出映射

API contract 约定 `jira-intake` 至少写出：

```text
00-requirement.md
01-requirement.yaml
06-evidence/jira-issue.json
```

`00-requirement.md` 面向人工阅读，`01-requirement.yaml` 面向 `$dw-dev` 解析，`06-evidence/jira-issue.json` 面向审计。

统计输出至少包含：

```text
schema_version
source_transport
summary.returned
summary.jira_total
groups
issues[].classification
```

`issues[].classification.jira_category` 至少包含：

```text
field_key
primary
secondary
display
field_value
source
confidence
valid_option
source_sheet
```

操作审计输出至少包含：

```text
schema_version
source_transport
operation
issue_key
executed
before
after
transition
safety_boundary
```

## 6. 维护规则

如果 Rovo 输出形态、Jira API 版本、字段、分页或写回规则变化，先更新本 contract，再更新 CLI 和测试。

涉及外部 API 行为时，优先查：

1. `jira-intake/references/jira-api-contract.md`
2. `docs/参考资料/11-Jira-API接入与需求入口设计.md`
3. Jira 官方 API 文档
