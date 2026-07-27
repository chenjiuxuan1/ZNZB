# 模块：jira-intake-openai-agent

> 名称：`jira-intake-openai-agent`
> 文件：`jira-intake/agents/openai.yaml`
> OpenAI Agent 显示名：`Jira Intake`

## 1. 用途

`agents/openai.yaml` 是 OpenAI Agent 侧的轻量入口配置，用于描述这个模块在 Agent 界面或运行时中的显示名、简介和默认提示词。

当前配置：

```yaml
interface:
  display_name: "Jira Intake"
  short_description: "归一化 Rovo/Jira 需求并生成本地入口文件"
  default_prompt: "Use @atlassian-rovo for Jira operations when available, then use $jira-intake to normalize evidence into DW Dev artifacts."
policy:
  allow_implicit_invocation: true
```

## 2. 使用方式

当用户明确提到 Jira issue、Jira 评论、JQL、状态流转、需求入口或 Rovo Jira 结果格式化时，Agent 可以根据这份配置触发 `jira-intake`。

推荐用户说法：

```text
使用 Rovo 读取 DATA-2048，然后用 Jira Intake 生成 tickets/DATA-2048。
```

推荐 Agent 行为：

1. 优先调用 `@atlassian-rovo` 完成 Jira 读取或用户已确认的 Jira 操作。
2. 将 Rovo/Jira JSON 交给 `jira-intake` 做统计、分类、artifact 或 audit。
3. 只有 Rovo 不可用或无法解决时，才检查 REST fallback 凭证。
4. 生成 `tickets/<ticket_id>/` 下的入口 artifact。
5. 提醒后续由 `$dw-dev` 继续解析和规划。

## 3. 隐式触发边界

`allow_implicit_invocation: true` 只表示可以根据上下文选择本模块处理 Jira intake。

它不代表可以隐式执行写回操作。以下动作仍必须显式确认，且优先交给 `@atlassian-rovo` 执行：

- Jira comment 回写。
- Jira transition。
- Jira issue edit。
- Jira attachment upload。

## 4. 改名规则

如果修改 `display_name` 或 `short_description`，需要同步检查：

- `jira-intake/docs/README.md` 的名称表。
- `jira-intake/pack.yaml` 的 `display_name`。
- Warehouse Map 或其他模块说明中引用的名称。
