# Grafana 值班机器人

这个项目用于巡检 Grafana 报表，自动识别报表查询失败、无数据和自定义阈值异常，并把结果推送到值班渠道。

机器人支持两种工作路径：

1. 直接走 Grafana HTTP API。
2. 如果 API 被网关拦截，就先用真实 Chrome 登录拿 session cookie，再继续走 API。

## 当前接入对象

- Dashboard 链接：`https://sr-monitor.empoweroceanin.com/d/aeqalqv4yq5fkf/7d32b5ce-c485-5a73-ab80-9841241ed4ba?orgId=1&refresh=2h`
- Dashboard UID：`aeqalqv4yq5fkf`

多国家入口配置在 `./config/countries.config.json`：

- `INE` 印尼：已发现 public dashboard，可巡检。
- `PK` 巴基斯坦：已发现 public dashboard，可巡检。
- `PH` 菲律宾：Grafana 网关当前返回 401，需要先完成网页登录态。
- `TH` 泰国：Grafana 网关当前返回 401，需要先完成网页登录态。
- `MX` 墨西哥：Grafana 网关当前返回 401，需要先完成网页登录态。

## 方案说明

2026-06-08 实测访问这个链接会跳到 `https://sr-monitor.empoweroceanin.com/login`，所以机器人默认走 Grafana HTTP API，而不是依赖浏览器页面抓取。

支持的认证方式：

1. `GRAFANA_SERVICE_ACCOUNT_TOKEN`：推荐，使用 Grafana Service Account Token。
2. `GRAFANA_COOKIE`：如果暂时拿不到 Token，可以先复用浏览器 Cookie。
3. `GRAFANA_BASIC_AUTH_USER` + `GRAFANA_BASIC_AUTH_PASSWORD`：如你们环境允许，也可以走 Basic Auth。

如果网关不接受 Basic Auth，但接受正常网页登录，机器人会自动尝试浏览器登录，并把 session 保存到 `./.state/grafana-storage-state.json`。

`discover` 运行时会在终端打印当前步骤。如果停在“打开 Grafana 页面”，通常说明网络、VPN、网关、SSO 或浏览器设备信任还没有放行。

遇到 headless Chrome 加载超时时，可以先运行一次可见浏览器登录：

```bash
npm run login
```

这会打开一个 Chrome 窗口。你在窗口里完成登录并打开报表后，回到终端按 Enter，机器人会保存登录态。之后再运行：

```bash
npm run discover
```

如果保存登录态后仍看到 nginx `401 Unauthorized`，机器人会再尝试把 Grafana API 请求放进 Chrome 页面内执行。这个路径更适合需要浏览器指纹、SSO 或设备信任的网关。

## 快速开始

1. 准备环境变量：

```bash
export GRAFANA_SERVICE_ACCOUNT_TOKEN='你的 token'
export DUTY_BOT_WEBHOOK_URL='你的 webhook'
```

如果你现在先用账号密码验证，可以改成：

```bash
export GRAFANA_BASIC_AUTH_USER='admin'
export GRAFANA_BASIC_AUTH_PASSWORD='你的密码'
```

2. 先看报表面板清单：

```bash
npm run discover
```

这个命令会把面板清单写到 `./config/discovered-panels.json`。如果 dashboard 是文本目录页，输出里也会包含文本摘要和链接，方便继续定位真正有数据查询的报表。

如果想把面板清单导出到文件：

```bash
node ./src/cli.mjs discover --config ./config/monitor.config.json --out ./config/discovered-panels.json
```

3. 按照 `./config/monitor.config.json` 里的 `rules` 配置你关心的异常规则。

如果入口 dashboard 指向 Metabase public dashboard，可以继续发现真实数据卡片：

```bash
npm run discover-public
```

它会写入 `./config/discovered-public-dashboards.json`。之后可以运行基础巡检：

```bash
npm run check-public
```

基础巡检会检查卡片查询失败和空数据，并把结果写到 `./config/public-check-result.json`；具体指标阈值写在 `./config/public-monitor.config.json`。

如果需要把公共报表巡检结果发到 TV 告警机器人：

```bash
export TV_ALERT_WEBHOOK_URL='https://tv-service-alert.kuainiu.chat/alert'
export TV_ALERT_BOT_ID='bc454a50-43f9-408d-8dfe-5e36f27250fc'
npm run notify-test
npm run check-public-notify
```

`notify-test` 会先发一条测试消息；`check-public-notify` 会执行巡检，并把异常明细发到 TV。

### 多国家命令

单国家发现 Grafana 目录：

```bash
npm run discover:id
npm run discover:pk
npm run discover:ph
npm run discover:th
npm run discover:mx
```

单国家发现 Metabase public dashboard：

```bash
npm run discover-public:id
npm run discover-public:pk
```

已接入国家合并巡检：

```bash
npm run check-public:ready
```

已接入国家合并巡检并推送 TV：

```bash
export TV_ALERT_WEBHOOK_URL='https://tv-service-alert.kuainiu.chat/alert'
export TV_ALERT_BOT_ID='bc454a50-43f9-408d-8dfe-5e36f27250fc'
npm run check-public-notify:ready
```

多国家巡检共用 `./config/public-monitor.config.json`。规则里的 `timezone` 使用 `dashboard`，运行时会按 dashboard 上的国家时区计算，例如印尼 `Asia/Jakarta`、巴基斯坦 `Asia/Karachi`。放款统计已按国家区分进度窗口：印尼使用 `05:00~23:30`，菲律宾、泰国、巴基斯坦、墨西哥按全天窗口计算。

数据质量监控也接入同一轮巡检。每个国家在 `./config/countries.config.json` 里配置 `dataQualityDashboardUrl` 和 `monitorConfigFile`，巡检会先打开该国家原 Grafana 看板刷新 SSO 登录态，再读取数据质量看板里标题匹配 `dataQuality.panelTitlePattern` 的“当前异常数/异常数”面板，并把当前异常数追加到 TV 总览和对应国家明细中。

### BI Gateway 模式

如果不想依赖使用者本机网络，需要像 `sr-box-new` 一样部署一个公司网络内可访问报表的 HTTPS Gateway。机器人已支持通过 Gateway 查询 Metabase 卡片，规则引擎和 TV 告警格式保持不变。

设置 Gateway：

```bash
export BI_GATEWAY_BASE_URL='https://bi-monitor-gateway.example.com'
export BI_GATEWAY_TOKEN='由管理员发放的只读 token'
```

走 Gateway 巡检：

```bash
npm run check-public-gateway:ready
```

走 Gateway 巡检并推送 TV：

```bash
export TV_ALERT_WEBHOOK_URL='https://tv-service-alert.kuainiu.chat/alert'
export TV_ALERT_BOT_ID='bc454a50-43f9-408d-8dfe-5e36f27250fc'
npm run check-public-gateway-notify:ready
```

Gateway API 契约见 `./docs/bi-monitor-gateway.md`。注意：Skill 本身不能绕过网络隔离，必须有 Gateway 服务端在公司网络内代查报表。

4. 运行一次巡检：

```bash
npm run check
```

5. 持续巡检：

```bash
npm run watch
```

## 规则类型

- `latestValueOutsideRange`：最新值超出阈值。
- `changeRateOutsideRange`：相邻两个点的变化率超出阈值。
- `staleLatestTimestamp`：最新时间戳太旧。
- `requiredDatePresent`：检查指定日期是否有数据，支持 D0 当日和 D-1 前一日。
- `tableRowCountOutsideRange`：表格行数异常。
- `textMissing`：缺少某段预期文本。
- `textPresent`：出现某段异常文本。
- `noData`：面板无数据。

支持通过 `panelId` 或 `panelTitle` 绑定规则；如果你需要定位某条序列，还可以补充：

- `refId`
- `fieldNameContains`

`completeDayChange` 支持 `correlatedChangeSuppressions`，用于同一张卡片里多个指标联动变化时降噪。例如 `放款成本`、`总花费`、`注册成本` 同向变化，且波动幅度差距不超过 `maxRelativeRateGap`，则不报这组联动异常。

## 告警通道

`alerts.channel` 支持：

- `console`
- `feishu`
- `wecom`
- `slack`
- `tv`
- `generic`

如果没填 `alerts.webhookUrl`，机器人只会在控制台输出。

TV 使用 `Content-Type: application/json`，请求体固定为 `{ "botId": "...", "message": "..." }`；通过 `alerts.botId` 或环境变量 `TV_ALERT_BOT_ID` 指定机器人。巡检消息会先发一条总览，再按国家各发一条聚合明细；国家明细采用运营卡片格式，包含巡检时间、异常概览、数据缺失、数据波动和看板链接。同一报表卡片的多条异常会合并为一组，只展示最大波动、核心数值变化和可点击的报表链接。当前 TV 文本消息不会渲染 HTML 折叠块，因此不会发送 `<details>/<summary>` 标签。

## 建议落地方式

推荐你们在 Grafana 里先创建一个只读的 Service Account，并授予这个 Dashboard 所需的最小权限。Grafana 官方文档说明：

- Dashboard HTTP API: [https://grafana.com/docs/grafana/latest/http_api/dashboard/](https://grafana.com/docs/grafana/latest/http_api/dashboard/)
- Data source HTTP API: [https://grafana.com/docs/grafana/latest/developer-resources/api-reference/http-api/api-legacy/data_source/](https://grafana.com/docs/grafana/latest/developer-resources/api-reference/http-api/api-legacy/data_source/)
- Service accounts: [https://grafana.com/docs/grafana/latest/administration/service-accounts/](https://grafana.com/docs/grafana/latest/administration/service-accounts/)

## 注意事项

- 不同数据源的 query 结构不完全一样；这个机器人直接复用 Dashboard 里的 `targets` 去请求 `/api/ds/query`，对大多数标准面板有效。
- 如果某些面板用了复杂变量、前端 transformation、library panel 或特殊插件，可能需要根据 `discover` 结果再做定制。
- 状态文件默认写到 `./.state/monitor-state.json`，用于避免同一个异常反复刷屏。
- 浏览器登录态默认写到 `./.state/grafana-storage-state.json`，便于下次复用。
