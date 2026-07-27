# ds-skill-n8n

一个面向 Codex 的多国家 DolphinScheduler 3.4 调度 skill 与 n8n 中转模板，支持查询、调度控制、任务实例排障，以及 SQL / SHELL 任务的追加、修改、下线和删除。

当前仓库这版能力已在 `mx` 环境空项目上完成全链路实测，覆盖 `create_workflow`、SQL/SHELL 任务新增与修改、实例与日志排障、调度创建更新及上下线。

## 目标

这个仓库解决两件事：

1. 让 Codex 能把用户的 DS 调度操作意图转换成标准 webhook 请求
2. 让 n8n 接收这些请求后，按国家路由到对应跳板机，再调用跳板机上的 `ds-scheduler-gateway` 执行 DS 3.4 API

## 当前支持

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

## 已实测通过

- `list_projects`
- `list_workflows`
- `create_workflow`
- `get_workflow`
- `dump_workflow_graph`
- `online_workflow`
- `offline_workflow`
- `trigger_workflow`
- `list_instances`
- `get_instance`
- `retry_instance`
- `list_task_instances`
- `get_task_log`
- `append_shell_task`
- `update_shell_task`
- `append_sql_task`
- `append_task` + `task_type=SQL`
- `update_sql_task`
- `extract_task_runtime_config`
- `create_schedule`
- `get_schedule`
- `list_schedules`
- `update_schedule`
- `online_schedule`
- `offline_schedule`
- `schedule_blast_radius`
- `list_datasources`
- `get_datasource`

补充说明：

- `create_workflow` 现在会创建 bootstrap shell 节点，便于后续继续追加 SQL 或 SHELL 任务
- `update_shell_task` 是正式显式动作，用于修改已有 SHELL 任务脚本内容
- `update_sql_task` 推荐直接传顶层 `sql`，网关会改写成 DS 接受的更新结构
- `local_params` / `task_local_params` 可用于填写 DS 任务“自定义参数”
- `resource_list` / `resources` 可用于填写 DS 任务“资源”，底层映射到 `taskParams.resourceList`
- 显式传 `resource_list` 时默认整体替换原资源列表；如需在保留原资源基础上追加，传 `replace_resource_list=false`
- 如果用 `build_ds_webhook_payload.py` 生成请求，想保留原资源再追加新资源，可加 `--merge-resource-list`
- `online_schedule` / `offline_schedule` 已增加短轮询确认，返回时会尽量让 `get_schedule` 直接读到目标状态

## 明确禁止

这套 skill 当前明确不支持以下高风险动作：

- 删除项目
- 删除工作流

当前删除能力仅限：

- 删除任务节点 `delete_task`

## 仓库结构

```text
.
├── SKILL.md
├── REFERENCE.md
├── EXAMPLES.md
├── scripts/
│   └── build_ds_webhook_payload.py
└── n8n/
    ├── README.md
    └── workflow-template.json
```

## 正式链路

```text
User
  -> Codex skill
  -> n8n webhook
  -> 解析并标准化请求
  -> If(valid)
  -> 按国家分流
  -> Execute Command
  -> SSH 到各国跳板机
  -> /root/ds-scheduler-gateway/scripts/ds_scheduler_entry.py
  -> DolphinScheduler 3.4 API
  -> 内容解析
  -> Respond to Webhook
```

## 权限与 token 规则

- `ds_token` 必须由最终使用者自己提供
- `ds_token` 决定这次请求能操作哪些项目、工作流、实例
- skill 和 n8n 都不应该默认内置共享 token
- 当用户没有提供 token 时，Codex 应先提示用户补充自己的 token，再执行正式请求

## 快速开始

### 1. 生成 webhook 请求

```bash
python3 scripts/build_ds_webhook_payload.py \
  --webhook-url "https://your-n8n/webhook/ds-scheduler" \
  --country cn \
  --action trigger_workflow \
  --ds-token "YOUR_DS_TOKEN" \
  --workflow-code 158515019593728 \
  --custom-params-json '{"dt":"2026-06-05"}'
```

其中：

- `YOUR_DS_TOKEN` 需要替换成调用人的真实 DS token
- `country` 需要和目标环境一致
- 这个请求只是发给 n8n，中间不会自动提权

### 2. n8n 侧执行

n8n 推荐按国家分别配置 `Execute Command` 节点，直接 SSH 到跳板机执行：

```bash
ssh -p 36000 root@10.20.47.14 "cd /root/ds-scheduler-gateway && python3 scripts/ds_scheduler_entry.py --country cn --action '{{$json.action}}' --ds-token '{{$json.ds_token}}' --request-id '{{$json.request_id}}' --payload-b64 '{{$json.payload_b64}}'"
```

其他国家只替换两部分：

- SSH 地址
- `--country`

### 2.1 跳板机代码更新命令

`ds-scheduler-gateway` 这套仓库不能再用 `git pull origin main` 更新。

原因：

- 这套 gateway 仓库里的 `origin` 仍可能指向旧的 `scaffold`
- 正式 gateway 代码应从 `gateway-github` 或 `internal` 拉取

推荐在各国家“代码拉取”节点统一使用：

```bash
ssh -p 36000 root@10.20.47.14 "cd /root/ds-scheduler-gateway && git pull gateway-github main"
```

如果走内网仓，则改成：

```bash
ssh -p 36000 root@10.20.47.14 "cd /root/ds-scheduler-gateway && git pull internal main"
```

不要再使用：

```bash
git pull origin main
```

## 新增：任务实例与任务日志

现在 skill 额外支持两类运行态排障动作：

- `list_task_instances`
  - 按工作流实例查询该次运行下的任务实例明细
- `get_task_log`
  - 拉取某个任务实例的实际运行日志

典型用法：

1. 先用 `get_instance` 或 `list_instances` 找到 `instance_id`
2. 再用 `list_task_instances` 查看这次实例里有哪些任务
3. 最后用 `get_task_log` 按 `task_instance_id` 或 `task_name` 拉日志

这样就能把“实例状态 -> 任务状态 -> 任务日志”整条链路串起来。

## 固定模板：批量精确下线任务

这次已经验证过的标准做法是：

1. 先查出目标任务分别属于哪个工作流
2. 按“每个工作流 + 每个任务”逐条调用 `disable_task`
3. 不删除节点，只把节点下线
4. 如需保持工作流原状态，传：
   - `restore_original_state=true`
   - `auto_offline=true`

推荐动作：

- 用 `disable_task` 做批量精确下线
- 用 `disable_tasks_except` 做“白名单保留，其余批量下线”
- 用 `delete_task` 做真正删除节点

不推荐：

- 用模糊前缀去误伤同名任务
- 把“下线节点”和“删除节点”混为一谈

## 依赖

- Python 3.9+
- n8n
- 各国家跳板机上已部署 `/root/ds-scheduler-gateway`
- n8n 可通过 `Execute Command` 节点访问对应跳板机
- 跳板机到目标 DS 环境网络可达

## 安全说明

- `ds_token` 必须由调用方提供，而且应当是调用方自己的 token
- 本仓库不负责扩大 DS 权限
- 允许删除任务节点
- 禁止删除项目
- 禁止删除工作流
- 建议 n8n 侧额外校验：
  - 共享密钥
  - 国家白名单
  - 动作白名单

## 备注

这是一版可运行骨架。

第二版可以继续补：
- `update_workflow`
- 资源文件上传
- 审计与幂等控制
