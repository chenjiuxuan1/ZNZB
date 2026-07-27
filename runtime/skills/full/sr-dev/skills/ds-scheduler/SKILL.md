---
name: ds-scheduler
description: Use when the user wants Codex to inspect or operate DolphinScheduler 3.4 projects, workflows, schedules, task instances, task logs, datasources, or append/update/disable/delete SQL and SHELL tasks through the multi-country n8n gateway for cn, ine, mx, ph, pk, or th. The current skill has been live-tested for create_workflow, create/update/online/offline schedule, get_task_log, retry_instance, append/update SQL tasks, and append/update SHELL tasks.
---

# DS Scheduler

把 Codex 侧的调度请求，转换成标准化的 n8n webhook 调用，并通过各国跳板机上的 `ds-scheduler-gateway` 执行实际 DS API 操作，覆盖查询、调度控制、运行态排障，以及 SQL / SHELL 任务的追加、修改、下线和删除。

当前这版 skill 已在 `mx` 项目上完成实测，重点确认过：
- `create_workflow`
- `append_shell_task`
- `update_shell_task`
- `append_sql_task`
- `append_task` + `task_type=SQL`
- `update_sql_task`
- `get_task_log`
- `retry_instance`
- `create_schedule`
- `update_schedule`
- `online_schedule`
- `offline_schedule`

其中 schedule 上下线现在会在网关侧做短轮询确认，尽量保证动作返回时 `get_schedule` 已能读到新状态。

## 何时使用

适用：
- 用户要通过 n8n 中转访问 DolphinScheduler 3.4
- 用户要操作 `cn / ine / mx / ph / pk / th`
- 用户要做：
  - `list_projects`
  - `list_workflows`
  - `create_workflow`
  - `list_schedules`
  - `get_schedule`
  - `create_schedule`
  - `update_schedule`
  - `online_schedule`
  - `offline_schedule`
  - `schedule_blast_radius`
  - `get_workflow`
  - `online_workflow`
  - `offline_workflow`
  - `trigger_workflow`
  - `list_instances`
  - `get_instance`
  - `list_task_instances`
  - `get_task_log`
  - `retry_instance`
  - `list_datasources`
  - `get_datasource`
  - `extract_task_runtime_config`
  - `dump_workflow_graph`
  - `append_task`
  - `append_sql_task`
  - `append_shell_task`
  - `update_task`
  - `update_sql_task`
  - `update_shell_task`
  - `disable_task`
  - `disable_tasks_except`
  - `delete_task`
- 用户希望由 Codex 输出标准 webhook body、`curl`、测试方式，或者直接根据现有 n8n 契约构造请求

不适用：
- 用户要直接从 Codex 打内网 DS API
- 用户要修改 n8n 之外的独立调度系统
- 用户要大规模重构 workflow JSON 生成逻辑但没有明确目标

## 当前架构

请求链路：
1. Codex 构造标准 webhook body
2. n8n `Webhook` 接收请求
3. n8n `解析并标准化请求` 节点补充 `payload_json` / `payload_b64`
4. n8n `按国家分流`
5. 各国家 `Execute Command` 通过跳板机 SSH 到远端
6. 远端执行：
   - `cd /root/ds-scheduler-gateway`
   - `python3 scripts/ds_scheduler_entry.py ...`
7. 远端网关调用对应国家的 DS API
8. n8n `内容解析`
9. `Respond to Webhook`

## 默认工作方式

收到请求后按下面顺序处理：
1. 识别国家、动作、目标对象
2. 校验动作是否在支持列表内
3. 校验必填字段
4. 如果动作会修改工作流定义，先做工作流完整性检查
5. 构造标准 JSON body
6. 如果用户要“给我调用代码”，输出可执行 `curl`
7. 如果用户要“测试一下”，优先给正式 webhook 请求
8. 如果用户要“看返回结果”，直接解释 n8n 返回 JSON 中的 `success/data/error`

## 必要输入

最少要确认：
- `country`
- `action`
- `ds_token`

常见补充：
- `project_code`
- `workflow_code`
- `workflow_name`
- `instance_id`
- `process_instance_id`
- `task_instance_id`
- `task_name`
- `task_code`
- `page_no`
- `page_size`
- `search_val`
- `state_type`
- `custom_params`
- `schedule_id`
- `crontab`
- `schedule_json`
- `start_time`
- `end_time`
- `warning_type`
- `warning_group_id`
- `failure_strategy`
- `process_instance_priority`
- `worker_group`

新增任务相关：
- `task_type`
- `task_name`
- `template_task_name`
- `sql` 或 `script`
- `sql_type`
- `local_params` / `task_local_params`
- `replace_local_params`
- `resource_list` / `resources`
- `replace_resource_list`
- `upstream_task_name` / `upstream_task_code`
- `restore_original_state`
- `auto_offline`

修改已有任务相关：
- `task_name` 或 `task_code`
- `sql`
- `script`
- `sql_type`
- `datasource`
- `local_params` / `task_local_params`
- `replace_local_params`
- `resource_list` / `resources`
- `replace_resource_list`
- `pre_statements`
- `post_statements`
- `task_params_patch`
- `title`
- `receivers`
- `receivers_cc`
- `show_type`
- `conn_params`

## 输出要求

默认输出尽量包含：
- 国家
- 动作
- 标准 webhook body
- 可执行 `curl`
- 字段说明

如果用户明确要直接发请求：
- 优先使用正式 webhook 地址
- 请求体必须符合 skill 契约
- 返回结果要解释成用户可理解的结论，而不是只贴原始 JSON

## 动作边界

### 查询类

- `list_projects`
- `list_workflows`
- `create_workflow`
- `get_workflow`
- `list_instances`
- `get_instance`
- `dump_workflow_graph`

### 控制类

- `online_workflow`
- `offline_workflow`
- `trigger_workflow`

### 结构修改类

- `append_task`
- `append_sql_task`
- `append_shell_task`
- `update_task`
- `update_sql_task`
- `update_shell_task`
- `delete_task`
- `disable_task`
- `disable_tasks_except`

## 任务追加规则

- `append_sql_task` 是 `append_task` 的 SQL 特化入口
- `append_shell_task` 是 `append_task` 的 SHELL 特化入口
- `update_sql_task` 是 `update_task` 的 SQL 特化入口
- `update_shell_task` 是 `update_task` 的 SHELL 特化入口
- `disable_task` 用于精确下线单个任务，不再依赖任务名前缀匹配
- `disable_tasks_except` 用于按任务名前缀圈定范围，然后保留白名单，其余统一禁用
- 推荐优先使用 `append_task`，并显式传 `task_type`
- SQL 任务：
  - `select / with / show / desc / explain` 默认推断为 `sql_type = query`
  - 其他执行型 SQL 默认推断为 `sql_type = non_query`
  - 也允许显式传：
    - `query / select / read / 查询`
    - `non_query / non-query / update / write / execute / 非查询`
  - 网关写回 DS 时会自动转换成 DS 内部兼容值，优先保证 DS 前端页面仍可继续人工编辑
- `update_sql_task` 推荐直接传顶层 `sql`，skill/gateway 会自动改写为 DS 接受的 `task_params_patch.sql`
- SQL 任务如果传 `datasource` 名称，网关会先解析成 DS 的 datasource id 再写回任务定义
- `local_params` / `task_local_params` 会写入任务的 `taskParams.localParams`
- `resource_list` / `resources` 会写入任务的 `taskParams.resourceList`
- 只要显式传了 `resource_list`，默认会按传入值整体替换原资源列表；如需保留原资源再追加，传 `replace_resource_list=false`
- SHELL 任务当前依赖工作流中已有一个 `SHELL` 模板任务可供克隆
- `create_workflow` 默认会先创建一个 bootstrap shell 节点，确保后续 `append_shell_task` / `append_sql_task` / `append_task` 能继续工作

## 已验证使用建议

- 拉任务日志时，优先直接传 `task_instance_id`
- 修改 SQL 任务时，优先使用 `update_sql_task`
- 修改 SHELL 任务脚本时，优先使用 `update_shell_task`
- 新增任务时，优先使用通用 `append_task` 并显式给 `task_type`
- 调度上下线后，如用户要确认状态，直接再调一次 `get_schedule` 即可；当前网关已尽量等待状态收敛

## 高风险保护

以下动作都会触发“更新整个工作流定义”，不是只改单个任务：

- `append_task`
- `append_sql_task`
- `append_shell_task`
- `update_task`
- `update_sql_task`
- `update_shell_task`
- `delete_task`
- `disable_task`
- `disable_tasks_except`

对这些动作，必须先检查工作流级变量是否完整，尤其是 DS 3.4 中常见的同步工作流变量：

- `src`
- `db`
- `dt`
- `full`
- `partition`
- `complement`

如果工作流中的任务脚本仍然引用了上述变量，例如：

- `${src}`
- `${db}`
- `${dt}`
- `${full}`

但工作流定义里的 `globalParams / globalParamList / globalParamMap` 已经为空，那么禁止继续执行任何结构修改类动作。

原因：

- 这类更新会重新提交整个 workflow definition
- 一旦把空的 `globalParams` 再次写回，任务运行时会出现：
  - `--src=`
  - `--db=`
  - `--dt=`
  - `--full=`
- 最终导致同步任务报错，看起来像“下线任务后任务跑坏了”

遇到这种情况的标准处理：

1. 先停止后续修改类操作
2. 先从 `t_ds_workflow_definition_log` 恢复该工作流历史版本中的 `global_params`
3. 恢复完成后再继续下线、删除或追加任务

## 风险判断要求

当用户要求执行以下任一动作时：

- 下线任务
- 批量下线任务
- 删除任务
- 新增任务

必须先补一句内部判断逻辑：

- 这是“改工作流定义”，不是简单改任务状态
- 如果是同步类工作流，优先检查 `globalParams` 是否为空
- 如果为空，先告警并要求先恢复，不直接继续修改

## 调用约束

- `ds_token` 必须由用户提供
- Skill 不持久化 token
- 不自行扩大任何国家的 DS 权限
- 如果用户没有提供 webhook 可达性环境，也照样输出 body 和 `curl`

## 参考与资源

- 协议和动作字段：见 [REFERENCE.md](REFERENCE.md)
- 常见调用示例：见 [EXAMPLES.md](EXAMPLES.md)
- 本地辅助脚本：见 [scripts/build_ds_webhook_payload.py](scripts/build_ds_webhook_payload.py)
- n8n 侧说明：见 [n8n/README.md](n8n/README.md)
