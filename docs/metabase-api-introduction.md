# Metabase API 使用说明

本文整理 Metabase 官方 API 文档中和值班机器人相关的部分，并说明本项目应如何选择调用方式。

官方 API 文档入口：

- https://www.metabase.com/docs/latest/api
- OpenAPI 规格文件：https://www.metabase.com/docs/latest/api.json

当前官方文档使用 OpenAPI 3.1 描述接口。Metabase API 大体可以分成两类：

1. 公开分享接口：`/api/public/...`
2. 登录或 API Key 认证接口：`/api/...`

## 认证方式

普通 Metabase API 使用 API Key 时，把 key 放在请求头里。值班机器人使用的 API Key 必须是只读权限：只能查看 dashboard/card/database 元信息和执行查询，不能创建、更新、删除看板或卡片。

```http
X-API-Key: <METABASE_API_KEY>
Accept: application/json
```

示例：

```bash
curl -s 'https://data.kuainiu.io/api/session/properties' \
  -H 'X-API-Key: <METABASE_API_KEY>' \
  -H 'Accept: application/json'
```

也可以使用账号密码登录 session：

```http
POST /api/session
Content-Type: application/json
```

```json
{
  "username": "<USERNAME>",
  "password": "<PASSWORD>"
}
```

但对于值班机器人，优先使用只读 API Key 或 public dashboard API。不要把账号密码写进仓库。

## Public Dashboard API

Public API 用于读取已经开启公开分享的 dashboard 或 card。官方文档说明这类接口不需要认证，但前提是 Metabase 实例开启 public sharing，且目标 dashboard/card 已生成公开链接。

### 获取公开 dashboard

```http
GET /api/public/dashboard/{uuid}
```

用途：

- 读取公开 dashboard 的标题、参数、dashcard 列表。
- 找到每张卡片的 `dashcard-id`、`card-id`、展示类型和参数映射。

示例：

```bash
curl -s 'https://data.kuainiu.io/api/public/dashboard/<DASHBOARD_UUID>' \
  -H 'Accept: application/json'
```

### 查询公开 dashboard 里的卡片

```http
GET /api/public/dashboard/{uuid}/dashcard/{dashcard-id}/card/{card-id}
```

用途：

- 获取公开 dashboard 中某张 card 的查询结果。

### 以指定格式查询公开 card

```http
POST /api/public/dashboard/{uuid}/dashcard/{dashcard-id}/card/{card-id}/{export-format}
Content-Type: application/json
```

常用 `export-format`：

- `json`：返回 JSON rows，最适合巡检规则引擎。
- `csv`、`xlsx`：适合人工导出，不适合本项目实时巡检。

请求体可以带 dashboard 参数：

```json
{
  "parameters": [
    {
      "id": "<PARAMETER_ID>",
      "type": "date/all-options",
      "target": ["dimension", ["template-tag", "stat_date"], { "stage-number": 0 }],
      "value": "past30days~"
    }
  ]
}
```

本项目当前使用的就是这个接口：

```text
POST /api/public/dashboard/:dashboardUuid/dashcard/:dashcardId/card/:cardId/json
```

对应代码：

- `src/metabase-public-client.mjs`
- `src/metabase-discovery.mjs`
- `src/metabase-public-monitor.mjs`

## 普通认证 API

普通 API 适用于读取未公开的 Metabase 资源。它需要 API Key 或登录 session，并受 Metabase 权限组控制。

本项目只允许使用只读能力。下面文档只介绍读取和查询接口；创建、更新、删除类接口即使官方 API 支持，也不应授予值班机器人。

### 查看实例属性

```http
GET /api/session/properties
```

用途：

- 验证实例是否可访问。
- 查看当前用户或匿名状态下可读的实例设置。

### 查看数据库

```http
GET /api/database
```

常用参数：

- `include=tables`：返回数据库下的表。
- `include=schemas`：返回可见 schema。
- `saved=true`：包含 saved questions 虚拟数据库。

用途：

- 检查 API Key 能看到哪些数据库。
- 判断权限组是否具备底层数据访问权限。

### 查看集合

```http
GET /api/collection
```

用途：

- 查看当前 API Key 可读的 collection。
- 响应里通常会包含 `can_write`，可判断是否有写权限。

值班机器人通常只需要读权限。

### 查看 dashboard

```http
GET /api/dashboard
GET /api/dashboard/{id}
```

用途：

- 获取 dashboard 清单。
- 获取指定 dashboard 的 cards、tabs、参数和布局信息。

注意：官方文档标注 `GET /api/dashboard` 是兼容接口，可能和前端最新行为不完全一致。程序化搜索 dashboard 时可以优先使用 `/api/search`。

禁止给值班机器人开放以下写操作：

```http
POST /api/dashboard
PUT /api/dashboard/{id}
DELETE /api/dashboard/{id}
POST /api/dashboard/{dashboard-id}/public_link
DELETE /api/dashboard/{dashboard-id}/public_link
```

### 查看 card

```http
GET /api/card
GET /api/card/{id}
```

用途：

- 获取 question、metric、model。
- 查看 card 的 `dataset_query`、展示类型、参数、结果元数据。

禁止给值班机器人开放以下写操作：

```http
POST /api/card
PUT /api/card/{id}
DELETE /api/card/{id}
POST /api/card/{card-id}/public_link
DELETE /api/card/{card-id}/public_link
```

### 搜索资源

```http
GET /api/search
```

用途：

- 搜索 dashboard、card、collection、table 等资源。
- 适合用来发现 API Key 可见内容。

示例：

```bash
curl -s 'https://data.kuainiu.io/api/search?limit=20' \
  -H 'X-API-Key: <METABASE_API_KEY>' \
  -H 'Accept: application/json'
```

## 查询数据接口

### 查询 saved question

```http
POST /api/card/{card-id}/query
Content-Type: application/json
```

用途：

- 运行一张 saved question。
- 返回 Metabase 标准查询结果。

适用场景：

- 已知道 `card-id`。
- API Key 对该 card 和底层数据有读取权限。

### 在 dashboard 上下文中查询 card

```http
POST /api/dashboard/{dashboard-id}/dashcard/{dashcard-id}/card/{card-id}/query
Content-Type: application/json
```

用途：

- 在 dashboard 参数上下文里运行 card。
- 适合 dashboard 里使用了筛选器、变量映射、dashcard 参数的场景。

请求体可以包含：

```json
{
  "parameters": [
    {
      "id": "<PARAMETER_ID>",
      "type": "string/=",
      "target": ["variable", ["template-tag", "country"]],
      "value": ["ID"]
    }
  ]
}
```

### 执行临时 dataset 查询

```http
POST /api/dataset
Content-Type: application/json
```

用途：

- 执行临时 MBQL 或 native SQL 查询。
- 不依赖已有 card。

注意：

- 这个接口权限要求更高。
- 如果用于值班机器人，需要严格限制查询来源和参数，避免把机器人变成通用 SQL 代理。

## 本项目推荐接入方式

### 已公开的运营看板

优先使用 public dashboard API：

```text
GET  /api/public/dashboard/{uuid}
POST /api/public/dashboard/{uuid}/dashcard/{dashcard-id}/card/{card-id}/json
```

优点：

- 不需要保存 Metabase API Key。
- 和现有 `discover-public`、`check-public` 流程匹配。
- 返回 rows JSON，规则引擎可以直接检查日期缺失、空数据、波动异常。

缺点：

- 只能访问已经公开分享的 dashboard。
- 公开链接泄露后，任何能访问网络的人都可能读取该公开报表。

### 未公开的内部看板

使用普通认证 API：

```text
GET  /api/search
GET  /api/dashboard/{id}
POST /api/dashboard/{dashboard-id}/dashcard/{dashcard-id}/card/{card-id}/query
```

优点：

- 不依赖 public sharing。
- 权限由 Metabase group 控制。
- 可以把权限限制为只读，只允许查看看板和查询结果。

缺点：

- 需要保存和轮换 API Key。
- API Key 权限配置不当时，可能看不到 database、collection、dashboard 或 card。
- 查询失败时需要区分网络问题、认证问题、Metabase 权限问题和底层数据库权限问题。
- 如果错误授予写权限，机器人凭据泄露后可能被用来修改或删除看板。

### 本机无法访问 Metabase

使用本项目的 BI Gateway 模式：

```text
值班机器人 -> BI Gateway -> Metabase -> rows JSON -> 规则引擎 -> TV 告警
```

相关文档：

- `docs/bi-monitor-gateway.md`

Gateway 应该只开放白名单 dashboard/card，不应该做通用 URL 代理或通用 SQL 代理。

## 权限排查顺序

当 API Key 可用但查不到资源时，按下面顺序排查：

1. 调用 `GET /api/session/properties`，确认实例可访问且认证头没有被网关拦截。
2. 调用 `GET /api/search?limit=20`，确认当前 key 是否能看到任何内容。
3. 调用 `GET /api/database`，确认底层数据库读权限。
4. 调用 `GET /api/collection`，确认 collection 读权限。
5. 调用 `GET /api/dashboard` 或 `GET /api/dashboard/{id}`，确认 dashboard 读权限。
6. 调用 `GET /api/card` 或 `GET /api/card/{id}`，确认 card 读权限。
7. 调用查询接口，确认 card 对应的数据库、表、字段也对当前 key 可读。

常见现象：

- `401`：认证失败，API Key 缺失、错误或被网关拦截。
- `403`：认证有效，但权限不足。
- `200` 但列表为空：认证有效，但当前 key 所属权限组没有可见资源。
- public API 返回错误：public sharing 未开启、uuid 不存在、链接已撤销或网络不可达。
- query API 返回底层错误：Metabase 能执行请求，但数据库查询失败。

## 安全建议

- 不要把真实 API Key 写进仓库、配置样例或文档。
- 用环境变量传递 API Key，例如 `METABASE_API_KEY`。
- 给 API Key 绑定最小权限 group，只授予值班机器人需要读取的 dashboard/card/database。
- 权限必须限制为只读：允许 `GET` 元信息接口和查询接口，禁止 dashboard/card/collection/database 的创建、更新、删除权限。
- 禁止授予管理 API Key、管理用户、管理权限组、修改 public link、编辑 dashboard/card 的权限。
- 定期轮换 API Key，尤其是在聊天、日志或终端输出中暴露过之后。
- Gateway 服务端保存凭据时，需要加审计日志和白名单校验。
- 值班机器人只需要读数据，不应该拥有创建、更新、删除 dashboard/card 的权限。

推荐的权限边界：

| 能力 | 是否允许 | 说明 |
| --- | --- | --- |
| 查看实例属性 | 允许 | 用于连通性和环境检查，例如 `GET /api/session/properties`。 |
| 搜索可见资源 | 允许 | 用于发现当前 key 能看到的 dashboard/card，例如 `GET /api/search`。 |
| 查看 database/collection/dashboard/card | 允许 | 只读元信息，用于定位看板和卡片。 |
| 执行 card/dashboard 查询 | 允许 | 用于获取 rows 并进行巡检。 |
| 创建、更新、删除 dashboard/card | 禁止 | 值班机器人不应修改 BI 内容。 |
| 创建、更新、删除 database/collection | 禁止 | 防止误改数据源或组织结构。 |
| 创建、轮换、删除 API Key | 禁止 | API Key 生命周期应由管理员处理。 |
| 管理用户、权限组、SSO 设置 | 禁止 | 超出巡检职责范围。 |

## 与现有代码的对应关系

```text
src/metabase-public-client.mjs
  直接调用 Metabase public API，获取 dashboard 和 card rows。

src/metabase-discovery.mjs
  从 Grafana 发现出来的 public dashboard 链接中提取 uuid，
  再调用 public API 生成 dashboard/card 清单。

src/metabase-public-monitor.mjs
  读取已发现的 dashboard/card 清单，查询 rows，
  再按 public-monitor.config.json 里的规则判断异常。

src/bi-gateway-client.mjs
  在本机不能直接访问 Metabase 时，改为调用 BI Gateway，
  由 Gateway 代查 Metabase 并返回 rows。
```

当前项目默认路线是 public dashboard API。只有在需要巡检未公开看板，或者希望收敛 public link 暴露面时，才需要扩展普通认证 API 或 Gateway 模式。
