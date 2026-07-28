# DS Scheduler n8n 网关升级契约

平台请求 `check_failed_instances` 时会携带：

```json
{
  "payload": {
    "stale_policy": "one_full_schedule_cycle",
    "include_checked_workflows": true,
    "failure_policy": "scheduled_today_final_failure",
    "include_failed_workflows": true,
    "include_offline_failures": true
  }
}
```

网关必须从 DolphinScheduler 的定时配置读取任务的调度表达式、时区、最近运行实例，并只将满足以下条件的 ONLINE 任务置入 `stale_workflows`：已经经过下一次计划执行时间，且该次执行之后仍没有运行实例。

每条旷工任务返回：

```json
{
  "schedule_status": "ONLINE",
  "stale_reason": "missed_schedule_cycle",
  "stale_message": "已跨过一个完整调度周期仍未运行",
  "schedule_cycle": "每月 10 日 02:00",
  "last_run_at": "2026-06-10T02:01:00.000+08:00",
  "next_run_at": "2026-07-10T02:00:00.000+08:00"
}
```

旧的 `no_recent_run` 固定时间窗结果不会再被平台告警，以避免月度及低频任务误报。完成 n8n 工作流修改后，需用一个月度任务和一个每日任务分别验证边界。

当 `include_checked_workflows` 为 `true` 时，网关还应返回本次扫描到的工作流清单，供平台历史详情和服务日志展示：

```json
{
  "checked_workflows": [
    { "workflow_code": "daily_loan", "workflow_name": "每日放款" }
  ]
}
```

当 `include_failed_workflows` 为 `true` 时，网关还必须返回 `failed_workflows`。通常只包含满足全部条件的在线工作流：当天计划执行时间已到、由定时调度触发、对应实例已结束且最终状态为失败、该失败实例之后没有成功实例。设置 `include_offline_failures: true` 后，已明确纳入巡检范围且当天仍有未恢复失败的离线工作流也必须返回，并在失败说明中标记调度已离线。尚未到当天调度时间、普通手动运行失败、历史失败但当天后续实例已成功、仍在运行的实例均不得返回。

```json
{
  "failed_workflows": [
    {
      "workflow_code": "daily_loan",
      "workflow_name": "每日放款",
      "schedule_status": "ONLINE",
      "failure_reason": "scheduled_instance_failed",
      "has_later_success": false,
      "failure_message": "今天 09:00 调度实例执行失败",
      "instance_id": "9988",
      "instance_state": "FAILURE",
      "start_time": "2026-07-27T09:00:02.000+08:00",
      "end_time": "2026-07-27T09:03:10.000+08:00"
    }
  ]
}
```
