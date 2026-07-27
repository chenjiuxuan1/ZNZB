# n8n DS Scheduler

这版 skill 对应的是当前已经打通的中转结构：

```text
Codex
  -> n8n Webhook
  -> 解析并标准化请求
  -> If(valid)
  -> 按国家分流
  -> 各国 Execute Command
  -> 内容解析
  -> Respond to Webhook
```

## 推荐节点

1. `Webhook`
2. `Code in JavaScript`
   - 节点名示例：`解析并标准化请求`
   - 把 `payload` 规范化成：
     - `payload_json`
     - `payload_b64`
     - `valid`
     - `errors`
3. `If`
   - `{{$json.valid}} == true`
4. `Switch`
   - `{{$json.country}}`
   - 分到 `cn / ine / mx / ph / pk / th`
5. 各国家 `Execute Command`
6. `Code in JavaScript`
   - 节点名示例：`内容解析`
   - 解析远端命令 stdout 中的 JSON
7. `Respond to Webhook`

## 各国家执行命令模式

每个国家节点都执行同一套网关，只是 SSH 目标不同。

示例结构：

```bash
ssh -p 36000 root@10.20.47.14 "cd /root/ds-scheduler-gateway && python3 scripts/ds_scheduler_entry.py --country cn --action '{{$json.action}}' --ds-token '{{$json.ds_token}}' --request-id '{{$json.request_id}}' --payload-b64 '{{$json.payload_b64}}'"
```

说明：
- `country` 固定写当前国家
- 其他参数直接透传上游解析节点结果
- 远端仓库路径固定为 `/root/ds-scheduler-gateway`

代码更新节点请不要写成：

```bash
git pull origin main
```

因为这个仓库里的 `origin` 可能仍指向旧的 `scaffold`。

统一推荐改成：

```bash
git pull gateway-github main
```

如需走内网仓，则使用：

```bash
git pull internal main
```

## 远端网关职责

远端 `ds-scheduler-gateway` 负责：
- 校验国家配置
- 解码 `payload_b64`
- 根据 `action` 调对应 handler
- 调 Dolphinscheduler API
- 返回统一 JSON

## 当前支持动作

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
- `append_task`
- `append_sql_task`
- `append_shell_task`
- `update_task`
- `update_sql_task`
- `update_shell_task`
- `disable_task`
- `disable_tasks_except`
- `delete_task`
- `dump_workflow_graph`

## 解析节点职责

`内容解析` 节点需要把 `Execute Command` 的结果：
- `code`
- `stdout`
- `stderr`

转换成最终 webhook 返回：

```json
{
  "success": true,
  "country": "mx",
  "action": "list_workflows",
  "request_id": "mx-test-001",
  "data": {},
  "error": null
}
```

如果 stdout 不是合法 JSON，则返回统一错误结构。

## 任务实例与任务日志链路

新增推荐排障链路如下：

1. `list_instances`
   - 先定位失败或目标运行实例
2. `get_instance`
   - 看实例基础状态
3. `list_task_instances`
   - 拉出该实例下所有任务实例
4. `get_task_log`
   - 根据 `task_instance_id` 或 `instance_id + task_name` 拉详细日志

这样 Codex 通过同一条 n8n webhook，就能继续往下追到具体任务日志，不需要再手工进 DS 页面点日志。

## 推荐正式 webhook

如果当前环境已经发布，可使用：

```text
https://sql-cn.kuainiujinke.com/webhook/ds-scheduler
```

如果是测试态，则使用 n8n 提供的 test webhook URL。
