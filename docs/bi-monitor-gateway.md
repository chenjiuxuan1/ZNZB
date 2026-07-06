# BI Monitor Gateway 设计

这个网关的目标是让值班机器人不依赖使用者本机网络。思路参考 `sr-box-new`：Codex 或 skill 只访问一个受控 HTTPS API，真正访问内网 Grafana、Metabase、StarRocks 的能力放在公司网络内的 Gateway 服务端。

## 调用链路

```text
Codex / Skill / 定时任务
  -> HTTPS + Bearer Token
  -> BI Monitor Gateway
  -> Metabase public dashboard / Grafana / SR
  -> 标准化 rows JSON
  -> 本项目规则引擎
  -> TV 告警机器人
```

Skill 不能凭空穿透内网；`sr-box-new` 能跑，是因为它背后有 `https://sr-box.kuainiu.io` 这类可访问内网资源的 Gateway。本项目也需要同类的 `BI Monitor Gateway`。

## 安全边界

- 只开放白名单 dashboard，不做通用 URL 代理。
- Token 使用最小权限，不在仓库里保存明文。
- Gateway 服务端保存内网 Cookie、Service Account Token 或数据源凭据。
- 所有请求写审计日志：调用人、国家、dashboard、card、耗时、traceId、成功状态。
- 返回值只返回巡检需要的查询结果，不返回敏感凭据或 SQL 执行细节。

## Endpoint

### `POST /api/bi-monitor/metabase/public-dashcard-json`

用于替代本地直连 Metabase public API：

```http
POST /api/bi-monitor/metabase/public-dashcard-json
Authorization: Bearer <BI_GATEWAY_TOKEN>
Content-Type: application/json
```

请求体：

```json
{
  "taskName": "metabase-public-dashcard-json",
  "country": {
    "code": "ID",
    "name": "印尼",
    "timezone": "Asia/Jakarta"
  },
  "dashboard": {
    "title": "Dashboard",
    "sourcePanelTitle": "OKR",
    "uuid": "9f577bde-1784-4b79-a4c6-ceed5e2f1502",
    "url": "https://data.kuainiu.io/public/dashboard/9f577bde-1784-4b79-a4c6-ceed5e2f1502"
  },
  "card": {
    "title": "转化漏斗",
    "cardId": 531,
    "dashcardId": 549,
    "display": "line"
  },
  "parameters": [
    {
      "id": "d3e4e97d",
      "type": "date/all-options",
      "target": ["dimension", ["template-tag", "stat_date"], { "stage-number": 0 }],
      "value": "past30days~"
    }
  ],
  "timeoutSec": 60
}
```

推荐响应体：

```json
{
  "success": true,
  "traceId": "trace-xxx",
  "data": {
    "rows": [
      {
        "统计日期": "2026-06-10",
        "注册数": 123
      }
    ]
  }
}
```

客户端同时兼容以下返回：

- `[{...}]`
- `{ "rows": [{...}] }`
- `{ "data": [{...}] }`
- `{ "data": { "rows": [{...}] } }`
- `{ "result": { "data": { "rows": [{...}] } } }`

错误响应建议：

```json
{
  "success": false,
  "message": "dashboard is not whitelisted",
  "traceId": "trace-xxx"
}
```

## 本项目使用方式

设置 Gateway 地址和 token：

```bash
export BI_GATEWAY_BASE_URL='https://bi-monitor-gateway.example.com'
export BI_GATEWAY_TOKEN='由管理员发放的只读 token'
```

只巡检不推送：

```bash
npm run check-public-gateway:ready
```

巡检并推送 TV：

```bash
export TV_ALERT_WEBHOOK_URL='https://tv-service-alert.kuainiu.chat/alert'
export TV_ALERT_BOT_ID='bc454a50-43f9-408d-8dfe-5e36f27250fc'
npm run check-public-gateway-notify:ready
```

也可以直接传 CLI 参数：

```bash
node ./src/cli.mjs check-public \
  --inventory ./config/discovered-public-dashboards.ready.json \
  --rules ./config/public-monitor.config.json \
  --out ./config/public-check-result.ready.json \
  --query-mode gateway \
  --gateway-url https://bi-monitor-gateway.example.com
```

## 后端实现建议

Gateway 服务端的核心逻辑是：

1. 校验 `Authorization` token。
2. 校验 `dashboard.url` 或 `dashboard.uuid` 是否在白名单。
3. 根据国家或域名选择可访问内网的网络路由。
4. 调用 Metabase public API：`POST /api/public/dashboard/:uuid/dashcard/:dashcardId/card/:cardId/json`。
5. 原样带上 `parameters`。
6. 将 Metabase 返回的 JSON rows 包装成 `{ success, traceId, data: { rows } }`。

如果后续不想暴露 Metabase public 链接，也可以让 Gateway 直接按 `country + dashboard key + card key` 映射到内部配置，本项目客户端只需要保持返回 rows 数组即可。
