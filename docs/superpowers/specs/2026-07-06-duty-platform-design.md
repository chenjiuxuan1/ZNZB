# 值班平台轻量 Web 控制台设计

日期：2026-07-06

## 背景

当前值班机器人是一个 Node.js CLI 项目。它通过 Grafana API、Metabase public API、Metabase 只读 API 或 BI Gateway 拉取报表数据，再根据 `config/*.json` 里的规则判断异常，最后把结果推送到 TV 等告警渠道。

现有方式的问题是配置都在 JSON 文件里：

- 国家、看板、卡片、规则、通知渠道分散在多个文件。
- 数据研发需要手写规则，容易写错字段名、card 范围、日期口径和参数。
- 规则改完后要靠命令行试跑，调试反馈慢。
- 很难在发送前预览异常文案和 TV 通知格式。
- 新同学不容易理解“某条规则为什么命中”。

第一版目标是做一个当前项目内的轻量 Web 控制台，用最小改动把“配置 + 离线试跑”跑通。

## 产品定位

第一版面向数据研发和平台同学，不面向普通运营同学。

它是配置和调试工作台，不是运营大屏，不是完整调度平台，也不是低代码系统。

核心闭环：

```text
读取现有配置
  -> 浏览国家 / 看板 / 卡片
  -> 编辑规则
  -> 离线试跑
  -> 查看命中原因
  -> 预览通知
  -> 保存回 JSON
```

## 第一版范围

### 包含

- 当前项目内新增轻量 Web 服务。
- 当前项目内新增前端页面。
- 读取现有 JSON 配置。
- 保存规则配置回 `config/public-monitor.config.json`。
- Metabase 看板直接从 Metabase 配置和 inventory 读取，不再依赖 Grafana 目录页跳转发现。
- 浏览国家、看板、卡片、字段、样例 rows。
- 对单国家、单 dashboard、单 card、单 rule 做离线试跑。
- 展示试跑输入 rows、规则参数、命中结果和异常文案。
- 基于本地巡检结果生成通知预览。
- 保留现有 CLI 命令和规则引擎。

### 不包含

- 不访问线上 Metabase/Grafana 做真实试跑。
- 不保存真实密钥。
- 不发送真实通知。
- 不做定时调度。
- 不做登录、用户、角色权限系统。
- 不迁移到数据库。
- 不修改现有 CLI 的行为。
- 不重写规则引擎。

## 推荐实现路线

采用当前项目内轻量 Web 控制台。

新增结构：

```text
src/
  server.mjs
  platform-api.mjs
  platform-validation.mjs

web/
  index.html
  src/
    app.js
    api.js
    state.js
    styles.css
    views/
      dashboard.js
      countries.js
      inventory.js
      rules.js
      sandbox.js
      notify-preview.js
```

后端只做薄封装，复用现有模块：

```text
src/utils.mjs
  readJsonFile
  writeJsonFile

src/metabase-public-monitor.mjs
  evaluateRowsAgainstRule

src/notifier.mjs
  buildPublicCheckMessage
  buildPublicCheckMessages
```

## 页面设计

### 1. 总览

用途：快速看当前配置覆盖范围和最近本地巡检结果。

展示：

- 国家数量。
- dashboard 数量。
- card 数量。
- 规则数量。
- 最近一次 `public-check-result.ready.json` 的异常数。
- 数据质量异常数。
- 每个国家的 dashboard/card/异常概览。

第一版只读，不做复杂趋势。

### 2. 国家配置

用途：查看和编辑 `config/countries.config.json`。

字段：

- `code`
- `name`
- `timezone`
- `grafanaDashboardUrl`
- `dataQualityDashboardUrl`
- `monitorConfigFile`
- `status`

第一版可以先支持编辑基础文本字段。保存前校验：

- `code` 不为空。
- `timezone` 不为空。
- URL 字段为空或是合法 URL。
- `status` 是 `ready` 或其他明确字符串。

### 3. 看板与卡片

用途：浏览 `config/discovered-public-dashboards.ready.json`。

Metabase 看板在平台里作为一等配置对象处理。后续真实试跑或重新发现卡片时，平台应直接访问 Metabase public API 或只读 API，不再通过 Grafana 看板目录跳转定位 Metabase 链接。Grafana 仅保留 Grafana 原生巡检和数据质量看板用途。

交互：

- 按国家筛选。
- 按 dashboard 筛选。
- 按 card 标题搜索。
- 点 card 后展示详情。

card 详情：

- 国家。
- dashboard 标题和 URL。
- card 标题。
- `cardId`
- `dashcardId`
- display 类型。
- columns。
- sampleRows。
- queryStatus。
- error。

这页是规则配置和试跑的入口。用户能从 card 详情跳到“新建规则”或“试跑规则”。

### 4. 规则配置

用途：编辑 `config/public-monitor.config.json` 中的 `rules`。

列表展示：

- 规则类型。
- 适用国家。
- dashboard 范围。
- card 范围。
- 日期列或核心字段。
- 是否有 parameters。
- context。
- 是否存在 exclude。

支持操作：

- 新增规则。
- 复制规则。
- 编辑规则。
- 删除规则。
- JSON 预览。
- 保存配置。

第一版表单覆盖当前项目最常用规则类型：

- `requiredDatePresent`
- `completeDayChange`
- `intradayProgress`
- `intradayTimePointCompleteness`
- `intradayTimePointChange`

对于复杂字段，如 `parameters`、`exclude`、`correlatedChangeSuppressions`，第一版允许直接编辑 JSON 片段，并做 JSON 语法校验。

保存前校验：

- `type` 必须存在。
- 必须至少提供 dashboard 匹配条件或 card 匹配条件。
- 日期类规则需要日期列或能接受缺省日期列。
- 数值波动类规则需要阈值字段。
- `parameters`、`exclude` 必须是数组。

### 5. 离线试跑

用途：验证“某张卡片 + 某条规则”会不会命中，以及命中文案是什么。

输入：

- 国家。
- dashboard。
- card。
- rule。
- rows 来源：
  - card 的 `sampleRows`。
  - 最近巡检结果里的本地结果，若可用。

输出：

- 本次试跑使用的 rows。
- 规则 JSON。
- 匹配范围说明。
- 命中状态。
- 异常 message。
- context。
- dashboard/card 链接。

实现方式：

1. 前端把 `dashboard`、`card`、`rule` 和 `rows` 提交给后端。
2. 后端调用 `evaluateRowsAgainstRule(rows, rule)`。
3. 后端把返回的 messages 规整成前端可显示结构。

第一版不调用线上 API，不触发真实通知。

### 6. 通知预览

用途：预览 TV 告警最终会怎么显示。

数据来源：

- `config/public-check-result.ready.json`
- 或后续由离线试跑临时结果组成的 preview result。

功能：

- 展示汇总消息。
- 展示按国家聚合的明细消息。
- 展示异常数量、卡片数量、数据缺失、数据波动。
- 支持复制消息文本。

第一版不发送真实 webhook。

## 后端 API

后端使用 Node 内置 HTTP 服务即可，不引入 Express。

### `GET /api/summary`

返回总览数据。

读取：

- `config/countries.config.json`
- `config/discovered-public-dashboards.ready.json`
- `config/public-monitor.config.json`
- `config/public-check-result.ready.json`

返回：

```json
{
  "countries": 5,
  "dashboards": 42,
  "cards": 300,
  "rules": 30,
  "lastResult": {
    "checkedAt": "2026-07-06T00:00:00.000Z",
    "anomalyCount": 0,
    "dataQualityAnomalyCount": 0
  }
}
```

### `GET /api/countries`

返回国家配置。

### `PUT /api/countries`

保存国家配置。

要求：

- 校验基本结构。
- 原子写入 JSON：先写临时文件，再替换目标文件。

### `GET /api/inventory`

返回 discovered dashboard/card 清单。

支持 query：

- `countryCode`
- `dashboardTitle`
- `q`

### `GET /api/rules`

返回 `public-monitor.config.json` 中规则和 alerts/dataQuality/gateway 概览。

### `PUT /api/rules`

保存规则配置。

要求：

- 只允许更新 `rules` 和安全的展示配置。
- 不允许前端写入真实 webhook、token、API key 明文。
- 校验失败返回 400 和错误列表。

### `POST /api/sandbox/evaluate`

离线试跑。

请求：

```json
{
  "dashboard": {},
  "card": {},
  "rule": {},
  "rows": []
}
```

返回：

```json
{
  "ok": true,
  "matched": true,
  "messages": [
    "统计日期缺少 2026-07-06"
  ],
  "rowCount": 3
}
```

### `POST /api/notify-preview`

生成通知预览。

请求：

```json
{
  "result": {}
}
```

如果不传 `result`，后端使用本地 `public-check-result.ready.json`。

返回：

```json
{
  "messages": [
    {
      "title": "公共报表巡检正常",
      "body": "..."
    }
  ]
}
```

## 数据写入策略

第一版直接读写 JSON 文件，不上数据库。

写入规则：

1. 解析请求 JSON。
2. 校验结构。
3. 格式化成 2 空格缩进 JSON。
4. 写入同目录临时文件。
5. rename 替换目标文件。

这样避免保存中断造成配置半写坏。

## 安全边界

第一版必须满足：

- 前端不展示真实密钥。
- 前端不保存真实密钥。
- 后端不提供任何线上写操作。
- 后端不发送真实通知。
- 后端不调用线上 Metabase/Grafana。
- 后端只读写当前项目内白名单配置文件。
- 真实试跑留到后续版本，并且只能使用只读 API。

禁止接口：

```text
POST /api/dashboard
PUT /api/dashboard/{id}
DELETE /api/dashboard/{id}
POST /api/card
PUT /api/card/{id}
DELETE /api/card/{id}
POST/PUT/DELETE 任意 Metabase/Grafana 管理接口
```

## 与现有 CLI 的关系

现有 CLI 是事实上的执行引擎，Web 控制台是配置和调试入口。

Metabase 相关配置和调试以 Metabase 为直接入口。现有通过 Grafana 目录发现 Metabase public dashboard 的命令仍可保留兼容，但平台 MVP 不把 Grafana 中转作为主流程。

现有命令继续可用：

```bash
npm run discover-public:*
npm run check-public:ready
npm run check-public-notify:ready
npm run check-public-gateway:ready
```

新增命令建议：

```json
{
  "platform": "node ./src/server.mjs"
}
```

启动后访问：

```text
http://localhost:8787
```

## 前端体验原则

这是面向数据研发的平台，不做营销式页面。

界面风格：

- 信息密度高。
- 左侧导航，右侧工作区。
- 表格、筛选、详情抽屉、JSON 预览并重。
- 重点突出“配置是否正确”和“规则为什么命中”。
- 避免大 hero、装饰卡片、渐变背景。

关键交互：

- 每个保存按钮都显示校验结果。
- 每个规则都有“试跑”入口。
- 每个 card 都能跳到“新建规则”和“试跑”。
- JSON 编辑失败时给出具体行文案。
- 试跑结果同时展示“原始输入”和“规则解释”。

## 验收标准

第一版完成时应满足：

1. `npm run platform` 能启动本地 Web 控制台。
2. 浏览器能打开 `http://localhost:8787`。
3. 总览页能显示国家、dashboard、card、规则、最近异常统计。
4. 看板页能浏览 `discovered-public-dashboards.ready.json`。
5. 规则页能展示和编辑 `public-monitor.config.json` 的规则。
6. 保存规则时会校验 JSON 结构。
7. 离线试跑页能选择 card 和 rule，并展示命中结果。
8. 通知预览页能生成当前本地巡检结果的 TV 文案。
9. 不影响现有 CLI 流程。
10. 测试覆盖配置校验、规则试跑 API、通知预览 API。

## 后续版本

### V2：真实只读试跑

- 支持手动点击真实试跑。
- 只调用只读 Metabase/Grafana API。
- 展示请求 URL、耗时、状态码、错误信息。
- 显示“只读请求，不修改看板”。

### V3：调度和历史

- 增加巡检任务历史。
- 增加调度配置。
- 增加异常确认和恢复跟踪。

### V4：权限和审计

- 登录。
- 用户角色。
- 配置变更审计。
- 发布审批。

## 设计自检

- 没有把平台做成完整调度系统，第一版范围可控。
- 没有引入数据库，避免第一步迁移成本。
- 没有访问线上 API，满足安全边界。
- 规则引擎继续复用现有代码，避免重写。
- 现有 CLI 流程保持可用。
- MVP 能验证核心交互：浏览卡片、编辑规则、离线试跑、通知预览。
