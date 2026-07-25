# DS Scheduler n8n 网关升级契约

平台请求 `check_failed_instances` 时会携带：

```json
{ "payload": { "stale_policy": "one_full_schedule_cycle" } }
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
