# 调度网关使用统计（n8n ds-scheduler-router）

值班平台新增「DS网关使用统计」视图，用于展示 n8n `ds-scheduler-router` 网关的审计记录：**每天有哪些人（operator）在使用、调用了哪些动作、成功率、风险操作与耗时**。

## 数据来源

网关的 n8n 工作流在每次请求后会把审计记录写入 MySQL 审计表：

- 库：`warning_rule`（10.20.47.19:3306）
- 表：`ds_operation_audit_log`
- 关键字段：`operator`（操作人）、`source_system`（来源系统）、`country`、`action`、`target_type`、`success`、`risk_level`、`duration_ms`、`operation_time`

审计写入由 n8n 通过中国跳板机执行，因此平台也走**中国跳板机 SSH + mysql** 读取该表（与 Wattrel 查询同一套链路）。

## 数据源配置

配置位于 `config/ds-scheduler.config.json` 的 `usage` 段：

```jsonc
"usage": {
  "enabled": true,
  "source": "gateway",      // ssh | gateway | snapshot
  "days": 30,
  "gateway": {
    "webhookUrl": "${DS_SCHEDULER_WEBHOOK_URL}",
    "action": "usage_report",
    "token": "${DS_GATEWAY_TOKEN}"
  },
  "ssh": {
    "host": "10.20.47.14",
    "port": 36000,
    "user": "root",
    "identityFile": ""
  },
  "auditDb": {
    "host": "10.20.47.19",
    "port": 3306,
    "user": "root",
    "password": "${DS_AUDIT_DB_PASSWORD}",
    "database": "warning_rule",
    "table": "ds_operation_audit_log"
  }
}
```

- `source: "ssh"`：通过跳板机直接查审计表（推荐，与现有 Wattrel 链路一致）。
- `source: "gateway"`：调用独立的 n8n 工作流 `n8n-ds-usage-report.json`（webhook 路径 `ds-usage-report`）拉取审计记录，不依赖平台机器直连跳板机；需在 n8n 中导入该工作流并激活。
- `source: "snapshot"`：只读取本地缓存快照 `config/ds-scheduler-usage-snapshot.json`，用于离线展示与测试。

审计库密码不写在配置里；`source: "gateway"` 模式下由值班平台从 `.env` 读取 `DS_AUDIT_DB_PASSWORD`，并通过 webhook 请求体的 `payload.auditPassword` 传给 n8n 节点执行 mysql 查询，因此**无需在 n8n 侧额外配置环境变量**。网关免鉴权，无需 token。

## n8n 工作流（免 SSH 取数）

仓库新增独立工作流 `n8n-ds-usage-report.json`，用于在 `source: "gateway"` 模式下由 n8n 侧查询审计表并返回使用统计，避免值班平台机器直连跳板机：

1. 在 n8n 中导入 `n8n-ds-usage-report.json`，激活后得到 webhook 地址 `/webhook/ds-usage-report`。
2. 设置平台 `usage.gateway.webhookUrl` 为该 webhook（默认 `${DS_USAGE_WEBHOOK_URL}`）；审计库密码由平台经 `payload.auditPassword` 自动下发，无需在 n8n 配置环境变量。
3. 确认 SSH 节点「中国跳板机查询审计表」引用的凭据已绑定。

请求体（值班平台自动发送）：`{ "source":"duty-platform", "action":"usage_report", "payload":{ "days": 30, "auditPassword": "..." } }`，返回 `{ "success":true, "rows":[...] }`。

## 接口
## 接口

- `GET /api/ds-scheduler/usage?days=30`：返回按日聚合的使用统计，优先返回 10 分钟内的缓存快照。
- `POST /api/ds-scheduler/usage/refresh`：强制从数据源刷新并更新本地快照；若数据源不可达则回退到缓存并返回 `refreshError`。

## 返回结构

```jsonc
{
  "generatedAt": "…",
  "dayCount": 30,
  "totalRequests": 1234,
  "totalSuccess": 1180,
  "totalFailed": 54,
  "totalRiskActions": 20,
  "totalSuccessRate": 95.6,
  "uniqueOperators": 8,
  "uniqueCountries": 6,
  "uniqueActions": 42,
  "days": [
    {
      "date": "2026-08-20",
      "requests": 80,
      "success": 75,
      "failed": 5,
      "successRate": 93.8,
      "uniqueOperators": 6,
      "riskActions": 3,
      "countries": { "cn": 40, "ine": 25, "pk": 15 },
      "actions": { "list_projects": 30, "create_workflow": 12 },
      "sources": { "codex-skill": 60, "n8n": 20 },
      "operators": [
        {
          "operator": "张三",
          "requests": 40,
          "success": 38,
          "failed": 2,
          "successRate": 95,
          "riskActions": 1,
          "countries": ["cn", "ine"],
          "sources": ["codex-skill"],
          "actions": { "list_projects": 20, "create_workflow": 8 },
          "avgDurationMs": 320,
          "maxDurationMs": 1500,
          "firstUsedAt": "2026-08-20 09:00:00",
          "lastUsedAt": "2026-08-20 18:30:00"
        }
      ]
    }
  ]
}
```

## 前端

新增导航「DS网关使用统计」（`#/ds-scheduler-usage`），视图文件：

- `web/src/views/ds-scheduler-usage.js`

页面展示：总览指标（天数、调用次数、使用人数、成功率、风险操作）、每日明细（国家/来源/动作分布 + 按操作人的明细表），并支持切换 7/14/30 天与手动刷新。

## 验证

```bash
node --test test/ds-scheduler-usage.test.mjs
node --test test/platform-api.test.mjs
node --test test/ds-scheduler-usage-view.test.mjs
node --test test/n8n-ds-usage-report.test.mjs
```
