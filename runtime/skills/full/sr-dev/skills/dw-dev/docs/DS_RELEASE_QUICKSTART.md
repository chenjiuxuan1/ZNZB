# DS Scheduler Handoff Boundary

> 作者：owenzhang
> 适用对象：需要从 `$dw-dev` 进入 DolphinScheduler 查询、追加任务、上下线或定时协作的使用者。

## 定位

`$dw-dev` 不再生成完整 DS 发布包，也不直接执行 DolphinScheduler 变更。它只在用户明确要求 DS 操作时生成：

```text
调度上线/01-ds-scheduler-协作请求.yaml
```

之后由 Codex 或 Claude Code 读取该 handoff，再按 `$ds-scheduler` 的真实能力和 token 状态执行或停止询问。

## 何时生成

只有满足以下任一条件时生成 DS handoff：

- 用户明确要求调度上线、下线、追加任务、修改任务、补数或触发 workflow。
- request 中显式设置 `ds_scheduler.enabled=true`。
- CLI 使用 `--ds-release` 兼容参数。

## 仍需人工确认

DS handoff 不是上线证据。执行前至少确认：

- country / project / workflow / task 信息完整。
- 是否需要 `ds_token` 或 webhook。
- 是否涉及 workflow definition 结构修改。
- 是否有 `globalParams`、依赖关系、定时、补数窗口、回滚策略。
- `$sr-box` 或其他真实数据验收是否已经完成。

## CLI 兼容示例

```bash
python3 skills/dw-dev/scripts/build_dev_request.py \
  --ticket-id DATA-EXAMPLE \
  --country cn \
  --validation-sql-file ai_test/validate_testdb.sql \
  --ds-release \
  --ds-project-code 158515173456896 \
  --ds-workflow-code 168433072924352 \
  --ds-workflow-change-mode append_to_existing_workflow \
  --ds-task-type SHELL \
  --ds-template-task-name dwd_fox_vos_cdr \
  --ds-sql-file /Users/admin/IdeaProjects/starrocks/workflow/th/dwd/dwd_fox_vos_cdr/dwd_fox_vos_cdr.sql \
  --output tickets/DATA-EXAMPLE/dev-request.yaml
```

生成工作区后会看到 `$ds-scheduler` handoff，而不是旧的 `release/ds` payload。
