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

### 清理历史巡检中的旧公开看板链接

当前巡检以“看板与卡片”模块发现的内部 `/dashboard/{id}` 链接为准。旧的
`config/public-check-result*.json` 和 `config/batch-check-run-history.json`
可能仍保存 `/public/dashboard/{uuid}`。UUID 不能可靠换算为内部数字 ID，因此迁移只删除旧记录中的
`dashboardUrl` 字段，不修改其他字段。

先检查影响范围，不写文件：

```bash
npm run history-urls:check
```

确认输出中的文件数和字段数后执行清理：

```bash
npm run history-urls:cleanup
```

发生修改时，原文件会先备份到 `config/history-url-backups/<时间戳>/`，随后原子写回。
命令可重复执行；再次检查应显示 `changedFileCount: 0`。平台启动时也会执行同一幂等迁移，
因此部署最新代码并重启服务可以自动处理生产机上未纳入 Git 的历史文件。

### n8n 部署与 Wattrel 多国家连接

Wattrel 告警页面需要直接查询各国 `wattrel_quality_result`。因为每个国家的 Wattrel 数据库不同，推荐把本项目部署在 n8n 能 SSH 到、并且能访问各国数据库的服务器上；n8n 只负责拉代码、启动服务或触发接口。

参考 `智能告警修复-印尼` 工作流，n8n 可以使用 SSH 节点执行下面这类命令：

```bash
ssh -p 36000 root@192.168.21.236 '
  cd /root/ZNZB &&
  git fetch origin &&
  git reset --hard origin/codex-show-scanned-dashboards &&
  npm install &&
  cp -n config/wattrel.config.example.json config/wattrel.config.json || true &&
  nohup npm run platform > platform.log 2>&1 &
'
```

各国 Wattrel 连接建议用环境变量注入，不要把密码写进仓库。变量名规则如下：

```bash
export WATTREL_INE_DB_HOST='印尼 Wattrel host'
export WATTREL_INE_DB_PORT='3306'
export WATTREL_INE_DB_USER='账号'
export WATTREL_INE_DB_PASSWORD='密码'
export WATTREL_INE_DB_NAME='库名'

export WATTREL_PH_DB_HOST='菲律宾 Wattrel host'
export WATTREL_PH_DB_PORT='3306'
export WATTREL_PH_DB_USER='账号'
export WATTREL_PH_DB_PASSWORD='密码'
export WATTREL_PH_DB_NAME='库名'

export WATTREL_TH_DB_HOST='泰国 Wattrel host'
export WATTREL_PK_DB_HOST='巴基斯坦 Wattrel host'
export WATTREL_MX_DB_HOST='墨西哥 Wattrel host'
export WATTREL_CN_DB_HOST='中国 Wattrel host'
```

每个国家都支持同样的五个变量：`WATTREL_<国家代码>_DB_HOST`、`WATTREL_<国家代码>_DB_PORT`、`WATTREL_<国家代码>_DB_USER`、`WATTREL_<国家代码>_DB_PASSWORD`、`WATTREL_<国家代码>_DB_NAME`。国家代码使用 `INE`、`PH`、`TH`、`PK`、`MX`、`CN`。

如果服务器没有安装 Node MySQL 驱动，项目会回退使用本机 `mysql` 命令行，因此服务器至少要满足二选一：

- 安装 Node 依赖中的 `mysql2`。
- 或安装系统 `mysql` 客户端，并保证命令名为 `mysql`，也可以通过 `WATTREL_MYSQL_COMMAND` 指定。

启动后访问：

```text
https://big-data-duty-management-platform.kuainiujinke.com/#/wattrel-alerts
```

页面会自动按国家查询当前 Wattrel 告警。未配置连接的国家会显示“未配置连接”；已配置但查询失败会显示失败原因；点击国家卡片可以查看该国家当前具体告警。

通知里的巡检明细链接默认使用：

```text
https://big-data-duty-management-platform.kuainiujinke.com/
```

如需临时覆盖，可在启动服务前设置 `DUTY_PLATFORM_BASE_URL` 或 `PLATFORM_BASE_URL`。

#### 通过 n8n Wattrel 查询中台读取 Wattrel

推荐使用 n8n 查询中台，而不是让值班平台所在机器直接 SSH 各国机器。导入仓库里的：

```text
n8n-wattrel-query-gateway.json
```

导入并启用后，把 n8n Webhook 地址配置给值班平台：

```bash
export WATTREL_GATEWAY_WEBHOOK_URL='https://<n8n-domain>/webhook/wattrel-query'
```

如果中台开启了鉴权，再设置：

```bash
export WATTREL_GATEWAY_TOKEN='你的中台 token'
```

值班平台会按国家并发调用该 webhook；n8n 中台会按国家 SSH 到对应机器，读取远端 `.env.local`，再执行 mysql 查询 `wattrel_quality_result`。这与智能告警修复中通过 n8n/SSH 节点查询 Wattrel 的链路一致。

#### 通过各国跳板机读取 Wattrel

`config/wattrel.config.example.json` 已内置各国跳板机 SSH 连接方式。平台会 SSH 到对应国家机器，优先读取：

```bash
/root/Global-Intelligent-Alarm-Repair-Assistant/.env.local
```

如果不存在，再读取对应国家老目录：

```bash
/root/<国家>-Intelligent-Alarm-Repair-Assistant/.env.local
```

远端 `.env.local` 需要包含 `DB_HOST`、`DB_PORT`、`DB_USER`、`DB_PASSWORD`、`DB_NAME`。平台不会保存数据库密码，只通过远端环境变量执行 mysql。

各国跳板机：

```bash
# 中国 CN
ssh -p 36000 root@10.20.47.14

# 泰国 TH
ssh -p 36000 root@192.168.20.236

# 印尼 INE
ssh -p 36000 root@192.168.21.236

# 巴基斯坦 PK
ssh root@10.20.84.176

# 墨西哥 MX
ssh -p 36000 root@172.20.220.165

# 菲律宾 PH
ssh root@10.20.10.12
```

4. 运行一次巡检：

```bash
npm run check
```

5. 持续巡检：

```bash
npm run watch
```


## 调度网关使用统计

值班平台新增「DS网关使用统计」视图（`#/ds-scheduler-usage`），展示 n8n `ds-scheduler-router` 网关的审计记录：每天哪些人使用、调用哪些动作、成功率、风险操作与耗时。

- 数据源：`warning_rule.ds_operation_audit_log`（10.20.47.19:3306）；默认通过中国跳板机 SSH + mysql 读取，也可用独立 n8n 工作流 `n8n-ds-usage-report.json` 走 gateway 模式免 SSH 取数。
- 配置：`config/ds-scheduler.config.json` 的 `usage` 段（支持 `ssh` / `gateway` / `snapshot` 三种数据源）。
- 接口：`GET /api/ds-scheduler/usage`、`POST /api/ds-scheduler/usage/refresh`。
- 详细说明见 [调度网关使用统计](./docs/ds-scheduler-gateway-usage.md)。

### 用户权限与管控（极端情况限制）

「DS网关使用统计」页内置「**用户权限与管控**」区块，为网关的每个用户提供管控能力：

- **不允许大量新建/删除**：按小时/日限额拦截 `create_workflow`、`delete_task`、`disable_task` 等批量操作；
- **删除动作只对个别用户开放**：`delete` 类动作默认受限，只有显式开放删除权限的用户（通常管理员）可执行；
- **可配置用户权限**：按用户名配置角色（只读/运维/高级/管理员）、动作黑/白名单、独立限额；
- **对每个用户的管理能力**：封锁/解封、移除显式配置、模拟校验、违规记录、一键封锁超限用户。

管控分两层：值班平台负责配置与违规检测，`ds-scheduler-gateway` 的 `gateway/access.py` 在每次请求执行前真正拦截。
配置后需「下发策略」并部署网关代码到 6 国机器才生效。

- 配置：`config/ds-scheduler-access-policy.json`（gitignore；示例见 `config/ds-scheduler-access-policy.example.json`）
- 接口：`GET/PUT /api/ds-scheduler/access*`、`PUT/DELETE /api/ds-scheduler/access/users/:name`、`POST /api/ds-scheduler/access/evaluate|publish`
- 下发脚本：`scripts/publish-ds-access-policy.mjs`（`--dry-run` 先看计划）
- 详细说明见 [DS 网关用户权限与管控](./docs/ds-scheduler-access-control.md)。

## 规则类型

Metabase 数据缺失、动态更新周期、各国时区、执行时间截止、查询重试和本次对话全部改造记录见 [Metabase 巡检改造完整说明](./docs/metabase-missing-rule-adjustments.md)。

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

## 告警中心（n8n + 夜莺集成）

值班平台（`npm run platform`，默认 8787）提供 **告警中心** 页面（`/#/alerts`），综合查看：

- **综合看板**：夜莺活跃告警（按业务组/级别）、n8n 失败执行、Grafana 巡检状态三边总览
- **Tabs**：活跃告警 / 历史告警 / 告警规则 / 通知规则 / n8n工作流 / n8n执行
- **手动刷新**：页面"刷新数据"按钮拉取最新（不做定时轮询）

### 凭据配置（服务器部署）

凭据走环境变量或项目根 `.env`（已被 `.gitignore` 覆盖，不会提交）：

```bash
# 夜莺 v8 API Token（X-User-Token 认证）
export N9E_BASE_URL='https://bigdata-alert.kuainiu.io'
export N9E_TOKEN='<夜莺 API Token>'

# n8n API Key（X-N8N-API-KEY 认证）
export N8N_BASE_URL='https://sql-cn.kuainiujinke.com'
export N8N_API_KEY='<n8n API Key>'
```

`config/alerts.config.json` 提供 `${ENV}` 占位模板（可提交）；实际 token 只存在于服务器环境变量或本地 `.env`，前端经 `/api/alerts/*` 后端代理访问，token 不出现在浏览器。

### 告警中心 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/alerts/overview` | 综合看板（三边计数+最新） |
| GET | `/api/alerts/active` | 夜莺活跃告警 |
| GET | `/api/alerts/history` | 夜莺历史告警（`stime/etime` Unix秒） |
| GET | `/api/alerts/rules?busiGroup=` | 告警规则 |
| GET | `/api/alerts/busi-groups` | 业务组 |
| GET | `/api/alerts/datasources` | 数据源 |
| GET | `/api/alerts/notify-rules` | 通知规则+渠道（电话打给谁） |
| GET | `/api/alerts/n8n/workflows` | n8n 工作流（精简字段） |
| GET | `/api/alerts/n8n/executions` | n8n 执行（精简字段） |
| GET | `/api/ds-n8n-failure-watch?country=ph&days=7` | 读取 DS 告警实际触发的“各国-DS失败自动重跑统一入口”n8n 执行日志；项目编号和项目名称以 n8n 执行详情中的 DS 告警载荷为准，不依赖 ZNZB 项目范围 |
| POST | `/api/ds-n8n-failure-watch/notification-receipt` | 接收原 n8n 自动重跑脚本的国家群发回执并写入通知进程；Bearer token 必须匹配该国家现有 DS token，同一 receiptId 自动去重 |
| GET | `/api/alerts/config` | 配置脱敏信息 |
| GET | `/api/alerts/health` | 上游连通性 |

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
