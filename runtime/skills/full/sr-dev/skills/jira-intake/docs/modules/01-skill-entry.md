# 模块：jira-intake-skill

> 名称：`jira-intake-skill`
> 文件：`jira-intake/SKILL.md`
> 展示名称：`Jira Intake`

## 1. 用途

`jira-intake-skill` 是 Jira 入口的人工和 Agent 使用说明。它定义什么时候使用 `jira-intake`、什么时候优先调用 `@atlassian-rovo`、默认能做什么、哪些动作必须停止并等待人工确认。

适用场景：

- 消费 `@atlassian-rovo` 返回的 Jira issue、搜索结果、状态和 transitions 信息。
- 对保存的 Rovo/Jira JSON 做统计、分类和格式化。
- 推断或保留 `数据平台Jira工单分类`（`customfield_11541`）一级/二级目录。
- 生成本地需求入口文件。
- 生成 Jira comment 或 transition 的本地操作计划。
- 记录 Rovo 或 REST fallback 执行后的本地操作审计。
- 在 Rovo 不可用时使用 REST fallback 读取 Jira。

不适用场景：

- 直接执行 SQL。
- 调用 `$sr-box-new`。
- 自动回写 Jira。
- 把 Jira API token 当作默认必填项。
- 修改生产数仓资产。

## 2. 直接使用方式

用户可以直接唤醒 `$jira-intake`，目标是把 Jira/Rovo 需求证据转成本地任务 artifact。

示例：

```text
使用 @atlassian-rovo 读取 DATA-2048，然后用 $jira-intake 生成 tickets/DATA-2048。
```

对应 CLI：

```bash
python3 jira-intake/scripts/jira_intake.py workspace-from-file \
  --input /tmp/rovo-issue.json \
  --issue-key DATA-2048 \
  --output-dir tickets/DATA-2048
```

## 3. Agent 编排方式

当 `$dw-dev` 需要消费 Jira 输入时，交接只通过本地文件完成：

```text
@atlassian-rovo / saved Jira JSON
  -> jira-intake
  -> 00-requirement.md
  -> 01-requirement.yaml
  -> 06-evidence/jira-issue.json
  -> dw-dev context / route / handoff
```

`jira-intake-skill` 不拥有任务生命周期，也不决定后续执行；开发编排交给 `$dw-dev`，知识上下文交给 `$dw-knowledge`。

## 4. 安全边界

- 默认 Rovo/local-file 路径不需要 Jira API token。
- 创建或准备 `DATA` 项目 Jira 需求时，`数据平台Jira工单分类` 必须使用受控枚举；用户未给出时按场景推断，不只写一级目录。
- 写回先生成 plan，实际 Jira 动作优先通过 `@atlassian-rovo`。
- 真实 comment、transition、edit、attachment 必须用户明确确认。
- REST fallback 只有在 Rovo 不可用或不能解决问题时启用。
- 不保存 Jira token。
- 不把 Jira 作为 SQL 执行或生产变更入口。
