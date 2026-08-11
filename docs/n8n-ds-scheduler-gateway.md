# DS Scheduler n8n 网关巡检契约

DS 巡检完全采用“本轮定时巡检单次判定”规则。平台不会在本轮失败或发现异常后等待 30 分钟复检，也不会重试巡检请求；后续只由下一次正常定时巡检重新检查。

平台请求 `check_failed_instances` 时携带：

```json
{
  "payload": {
    "project_code": "项目编码",
    "monitor_policy": "scheduled_today_once",
    "schedule_scope": "today_due",
    "run_scope": "today",
    "success_state": "SUCCESS",
    "include_checked_workflows": true,
    "include_not_run_workflows": true,
    "include_abnormal_workflows": true
  }
}
```

网关必须以国家对应的 DolphinScheduler 时区执行以下逻辑：

1. 读取项目中已上线、当前有效的调度。
2. 根据调度 Cron 计算今天零点至本次巡检时刻之间是否存在计划执行时间。
3. 只把存在计划执行时间的工作流纳入 `checked_workflows`。
4. 查询这些工作流今天的定时调度实例；没有任何实例的写入 `not_run_workflows`。
5. 有实例时，成功状态优先：当天存在 `SUCCESS` 即视为成功；没有成功但存在运行中状态，则返回运行中状态；否则返回实际异常状态。
6. 最终状态不是 `SUCCESS` 的写入 `abnormal_workflows`。
7. 手动执行、尚未到今天计划时间、未上线或已过有效期的调度均不得纳入结果。

返回示例：

```json
{
  "success": true,
  "data": {
    "total_should_run": 3,
    "checked_workflows": [
      { "workflow_code": "daily_loan", "workflow_name": "每日放款", "crontab": "0 0 9 * * ?" }
    ],
    "not_run_workflows": [
      {
        "workflow_code": "daily_repay",
        "workflow_name": "每日还款",
        "schedule_status": "ONLINE",
        "not_run_reason": "scheduled_today_not_run",
        "not_run_message": "今天截至巡检时间应运行但未运行",
        "crontab": "0 0 9 * * ?"
      }
    ],
    "abnormal_workflows": [
      {
        "workflow_code": "daily_risk",
        "workflow_name": "每日风控",
        "schedule_status": "ONLINE",
        "abnormal_reason": "scheduled_today_abnormal_state",
        "abnormal_message": "今天定时调度实例状态异常",
        "instance_id": "9988",
        "instance_state": "FAILURE",
        "start_time": "2026-08-10T09:00:02.000+08:00",
        "end_time": "2026-08-10T09:03:10.000+08:00"
      }
    ]
  }
}
```

平台暂时兼容旧网关的 `stale_workflows` 和 `failed_workflows` 返回字段，但新网关应使用 `not_run_workflows` 与 `abnormal_workflows`。旧的 `stuck_workflows`、`consecutive_failures` 和固定时间窗 `no_recent_run` 不再参与监控判定。

## 按国家精准提醒

DS 配置中的 `alertRouting` 对所有国家使用同一套通知逻辑和 TV 机器人。`countryMentions` 按国家代码维护负责人；同一国家下的全部项目均由该国负责人监管。

平台按国家分别生成消息。某国任一项目出现未运行、状态异常或巡检失败时，只在该国消息中 @ `countryMentions` 配置的负责人；正常国家的消息不 @ 任何人。负责人邮箱会自动去重。

当前已将 `jingxiao@kn.group` 和 `ericyou@kn.group` 配置为墨西哥 `mx` 的负责人，其他国家暂为空，后续可直接补充对应邮箱。
