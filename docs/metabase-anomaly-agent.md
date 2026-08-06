# Metabase 异常数据侧取证 Agent

当前推荐部署的是 **ZNZB 单阶段看板编排 + n8n 转发 + Dify Agent 决策 + 只读取证网关**：

`国家巡检与公共证据准备 → 同一看板全部异常指标一次分析 → 结论收敛 → 最终通知与历史落库`。

导入 [n8n-metabase-anomaly-dynamic-evidence-agent.template.json](../n8n-metabase-anomaly-dynamic-evidence-agent.template.json)。其生产 Webhook 路径固定为：

`POST /webhook/metabase-anomaly-dynamic-evidence-agent`

Dify ReAct Agent 可调用 6 个只读工具完成 SQL、底表实值、血缘、Wattrel 与 DS 核查，但不能执行重跑、修复、写入或权限变更。每次请求最多 8 次迭代、6 次工具调用；相同工具和参数不得重复。n8n 只负责验证协议、调用 Dify、校验结构化结果并回调 ZNZB，不在 n8n 内创建无界循环。

## 必填配置与凭证边界

导入模板后，直接替换 JSON 中的 `REPLACE_WITH_*` 占位符；不要使用 `$env` 或 `$vars`，也不要把真实值提交到仓库。

| 用途 | 模板位置 / ZNZB 配置 | 必须使用的凭证 |
| --- | --- | --- |
| ZNZB → n8n 动态入口 | `REPLACE_WITH_METABASE_ANOMALY_AGENT_WEBHOOK_TOKEN` / `METABASE_ANOMALY_AGENT_N8N_TOKEN` | 同一个非空随机 Bearer token |
| n8n → ZNZB Card SQL | `REPLACE_WITH_METABASE_AGENT_CALLBACK_TOKEN` | 与 `METABASE_ANOMALY_AGENT_CALLBACK_TOKEN` 完全相同 |
| n8n → ZNZB 最终 callback | callback 的 `Authorization` | 与 `METABASE_ANOMALY_AGENT_CALLBACK_TOKEN` 完全相同 |
| n8n → Dify | `REPLACE_WITH_DIFY_API_KEY` | Dify 应用“后端服务 API”的 `app-` key |

`DIFY_WAREHOUSE_LINEAGE_TOOL_TOKEN` 不属于上述任一项，**不得**填入 Card SQL、callback 或 Dify API 节点。动态流程由 n8n 调用公共只读网关，Dify 不持有该 token。

平台 `.env` 的最小配置如下（均为示例占位符）：

```dotenv
METABASE_ANOMALY_AGENT_ENABLED=true
METABASE_ANOMALY_AGENT_N8N_ASYNC=true
METABASE_ANOMALY_AGENT_MODE=recursive_evidence
METABASE_ANOMALY_AGENT_N8N_WEBHOOK_URL=http://127.0.0.1:5678/webhook/metabase-anomaly-evidence-agent
METABASE_ANOMALY_AGENT_N8N_TOKEN=replace-with-dynamic-agent-ingress-token

# n8n 容器回调宿主服务：固定内网地址，不能使用公网域名。
METABASE_ANOMALY_AGENT_CALLBACK_URL=http://172.19.0.1:28787/api/metabase-anomaly-analysis/callback
METABASE_ANOMALY_AGENT_CALLBACK_TOKEN=replace-with-long-random-callback-token
```

入口 token、callback token 和 Card SQL 读取 token 均为必填项。入口 token 只用于平台到 n8n 的派单；callback token 只用于 n8n 读取受保护 Card SQL 并回调平台，二者不能互换。动态模板将 callback 目标写死为 `REPLACE_WITH_DUTY_PLATFORM_INTERNAL_CALLBACK_URL`；它忽略请求中的 `callback.url`，因此不能被用作任意 URL 转发。

在协议 v5 n8n 模板中只需替换：

1. `REPLACE_WITH_METABASE_ANOMALY_AGENT_WEBHOOK_TOKEN`：必须与 ZNZB 的 `METABASE_ANOMALY_AGENT_N8N_TOKEN` 相同。
2. `REPLACE_WITH_METABASE_AGENT_CALLBACK_TOKEN`：必须与 ZNZB 的 `METABASE_ANOMALY_AGENT_CALLBACK_TOKEN` 相同。
3. `REPLACE_WITH_DIFY_API_KEY`：Dify 应用“后端服务 API”页面生成的 `app-` key；不是工具提供者 token，也不是 `.env` 变量名。

模板已固定使用内网 Dify Agent API `http://172.20.0.234/v1/chat-messages` 和 ZNZB 容器回调地址 `http://172.19.0.1:28787`。生产 n8n 服务器不允许访问公网，因此不能替换为 Dify 公网域名。Dify 使用已导入的 6 个只读工具完成取证；n8n 不直接持有 DS 或 SR 的写权限。

新版 Agent 仅支持 `response_mode: streaming`。模板的 HTTP 节点以文本接收 SSE，并在 `Parse Dify Batch Response` 节点合并所有 `data:` 事件中的 `answer` 内容；不要改回 `blocking`，否则 Dify 会返回 `Agent App only supports streaming response mode`。

新版 Dify 导出文件的 `app.mode` 必须为 `agent`。旧的 Workflow DSL（`app.mode: workflow`）对应 `/v1/workflows/run`，不能与新版 Agent 的 `app-` Key 混用。更新 n8n 模板后，需要重新导入或同步修改已发布工作流中的 `Call Dify Batch Agent` 节点，并把 `REPLACE_WITH_DIFY_API_KEY` 替换为新应用 Key；真实 Key 不提交到 Git。

## 行为与结果

## AI-first 单阶段看板巡检（协议 v5）

启用前必须依次导入并发布 OpenAPI 工具提供者、新版 Dify Agent 包和协议 v5 n8n JSON。随后才在 ZNZB `.env` 显式开启：

```dotenv
METABASE_ANOMALY_BATCH_MODE=1
```

未设置该开关时仍运行旧流程，避免未完成导入时误派单。开启后，巡检的最终顺序是“国家巡检 → DS 核查 → AI 取证 → 通知 → 历史记录”：平台会先保留一份仅内部可见的待完成巡检，**不会**立即通知，也不会把它写入最终历史。

- 平台按 `国家 + 看板 UUID` 聚合，同一个看板的全部异常指标放入一个 `dashboard_analysis` 请求；Dify 必须为每个 `anomalyIndex` 返回且只返回一条最终结论。
- 只有被实时证据明确证明正常的指标才能输出 `verified_normal`。查询失败、结果为空、字段或维度不明确时必须输出 `insufficient_evidence`，不能直接消警。
- Dify 实际同时运行的请求硬限制为 3；只有某个 callback 已回写（或已超时）后，平台才从内存队列取下一项，绝不预投递全部任务。
- 单次请求不得超过 512 KiB；超限看板不会投递 Dify，其指标按“AI 未核验”保守处理。
- 每个请求最多 8 次工具调用；整个巡检目标 20 分钟，30 分钟后不再提交新请求，剩余项写为“AI 未核验”。
- 只有 `data_issue` / 未核验的异常进入告警通知；`business_change` 和 `hide_verified_normal` 仍留在历史审计，但不播报为数据异常。

新模板中的 n8n 节点只需要替换三个占位符：入口 token、回调 token、Dify `app-` API key。批量结果回调固定为 `/api/metabase-anomaly-analysis/batch-callback`，不得改回旧的单条 `/callback`。

页面显示看板批量分析进度，并在每条指标结果上展示最终数据侧结论。通知与最终历史只会在所有必要请求完成、失败或超时后生成。没有 SQL、权限不足、只有 `declared_dependency_only`、分区或 DS 证据不足时，最终结论必须为 `insufficient_evidence`；原巡检告警不会因缺少证据而被自动关闭。

分析结果写入 `config/metabase-anomaly-analyses.json`，默认保留最近 7 天；该文件已被 Git 忽略。

## 已移除的旧模板

`n8n-metabase-anomaly-evidence-agent.template.json` 已从仓库交付中移除：它使用不安全的入口与 callback 设计，不能再导入、发布或作为兼容模板保留。已有该旧工作流的实例应下线，并迁移至本文顶部的动态模板及 `/webhook/metabase-anomaly-dynamic-evidence-agent`。

未配置 n8n 时，项目仍保留直连 OpenAI 兼容模型的摘要模式作为兼容回退。它不具备动态血缘、分区或 DS 取证能力，也不是当前生产推荐路径。

## query_table_data 工具（SR 数据直查）

Dify Agent 的第 5 个工具 `query_table_data` 通过 Fuxi SR 网关直接查询 StarRocks 表数据，用于区分「数据未产出」vs「数据产出但值为 0」。

### 环境变量

- `FUXI_SR_TOKEN`（可选）：Fuxi SR 网关 API token。如果设置了则直接使用。
- `FUXI_SR_GATEWAY_URL`（可选）：默认 `http://172.20.0.234:4888`（内网直连，绕过 WAF）。
- `SR_SKILLS_SESSION_FILE`（可选）：sr-box skill 的 SSO session 文件路径，默认 `~/.config/sr-skills/session-data-map-dev.json`。

### Token 获取方式

平台自动按以下顺序解析 token：

1. 如果 `.env` 中设置了 `FUXI_SR_TOKEN`，直接使用该 token。
2. 否则自动读取 sr-box skill 的 SSO session 文件（`session-data-map-dev.json`），
   提取 `sessionToken`（`srbs_` 前缀），并检查 `expiresAt` 和空闲超时（默认 1 小时）。
3. 如果两者都不可用，返回 503 错误，提示在服务器上执行：
   ```bash
   python3 sr_gateway_client.py sso login
   ```
   完成浏览器 SSO 登录后，session 文件会自动生成，无需手动配置 token。

### 国家映射

ZNZB 使用 `ine` 表示印尼，SR 网关使用 `id`。平台自动映射：`cn->cn, ine->id, ph->ph, th->th, pk->pk, mx->mx`。

### 安全限制

- 仅允许 `SELECT`、`WITH`、`SHOW`、`DESC`、`DESCRIBE`、`EXPLAIN` 开头的 SQL。
- 禁止任何 `INSERT`、`UPDATE`、`DELETE`、`CREATE`、`ALTER`、`DROP`、`TRUNCATE`、`REPLACE`、`MERGE`、`REFRESH` 关键字。
- 单次查询最多返回 500 行。
