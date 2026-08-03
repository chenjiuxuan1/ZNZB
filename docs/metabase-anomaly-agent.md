# Metabase 异常数据侧取证 Agent

当前推荐并默认部署的是 **n8n 编排 + Dify 决策 + 只读取证网关**：

`ZNZB 异步派单 → n8n 读取 Card SQL → Dify 决策 → n8n 执行受控取证 → Dify 再决策 → 固定内网 callback`。

导入 [n8n-metabase-anomaly-dynamic-evidence-agent.template.json](../n8n-metabase-anomaly-dynamic-evidence-agent.template.json)。其生产 Webhook 路径固定为：

`POST /webhook/metabase-anomaly-dynamic-evidence-agent`

Dify 只返回下一步的 JSON 动作（`trace_lineage`、`check_wattrel`、`check_ds_workflow`、`check_ds_status` 或 `finish`），不会直接访问 ZNZB、StarRocks、DolphinScheduler、Wattrel，也不能执行重跑、修复、写入或权限变更。n8n 只接受已发现的表名，且硬限制为：血缘深度 3、总工具调用 12、Wattrel 检查 3、DS 匹配 3、DS 状态检查 3。完整循环与 Dify 输出契约见 [n8n Dify 动态取证决策环](n8n-dify-decision-loop.md)，Dify 系统提示词见 [Dify 系统提示词](dify-metabase-anomaly-system-prompt.md)。完整循环与 Dify 输出契约见 [n8n Dify 动态取证决策环](n8n-dify-decision-loop.md)。

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
METABASE_ANOMALY_AGENT_N8N_WEBHOOK_URL=http://127.0.0.1:5678/webhook/metabase-anomaly-dynamic-evidence-agent
METABASE_ANOMALY_AGENT_N8N_TOKEN=replace-with-dynamic-agent-ingress-token

# n8n 容器回调宿主服务：固定内网地址，不能使用公网域名。
METABASE_ANOMALY_AGENT_CALLBACK_URL=http://172.19.0.1:28787/api/metabase-anomaly-analysis/callback
METABASE_ANOMALY_AGENT_CALLBACK_TOKEN=replace-with-long-random-callback-token
```

入口 token、callback token 和 Card SQL 读取 token 均为必填项。入口 token 只用于平台到 n8n 的派单；callback token 只用于 n8n 读取受保护 Card SQL 并回调平台，二者不能互换。动态模板将 callback 目标写死为 `REPLACE_WITH_DUTY_PLATFORM_INTERNAL_CALLBACK_URL`；它忽略请求中的 `callback.url`，因此不能被用作任意 URL 转发。

在模板中配置：

1. `REPLACE_WITH_DUTY_PLATFORM_HOST` 为 ZNZB 可被 n8n 容器访问的内部主机；`Get Verified Card SQL` 节点填写 `METABASE_ANOMALY_AGENT_CALLBACK_TOKEN`。
2. `REPLACE_WITH_DUTY_PLATFORM_INTERNAL_CALLBACK_URL` 为上面的固定内网 callback 地址。
3. `REPLACE_WITH_DIFY_WORKFLOW_RUN_URL` 必须直接填写完整内网地址 `http://172.20.0.234/v1/workflows/run`，不能拼接路径、不能填写公网域名；`REPLACE_WITH_DIFY_API_KEY` 为 Dify `app-` key。
4. `REPLACE_WITH_N8N_PUBLIC_HOST` 为已发布取证网关的稳定 n8n 主机；保留 `/webhook/warehouse-lineage`（血缘）、`/webhook/wattrel-query`（质量告警）、`/webhook/ds-scheduler`（DS 运行状态）三个路径。血缘网关的 `REPLACE_WITH_EVIDENCE_GATEWAY_TOKEN` 必须替换为共享随机 Bearer token；Wattrel 和 DS scheduler 网关通过 webhook 路径隔离，不需要额外 bearer token。
5. `REPLACE_WITH_DS_TASK_MATCH_WORKFLOW_ID`：DS 任务匹配子流程的 n8n workflow ID。动态 Agent 通过 `executeWorkflow` 节点直接调用该子流程，传入 producer SQL、国家、告警时间等上下文，而不是通过 HTTP 网关。
6. `REPLACE_WITH_DS_API_TOKEN`：DolphinScheduler API token，用于 DS scheduler 网关查询任务运行状态。仅用于只读查询，不能用于重跑或修改任务。
7. 发布动态 Agent 及三个网关（血缘、Wattrel、DS scheduler）。分区核验由 Codex `sr_box` 技能人工只读执行，不在 n8n 自动化流程中。DS 匹配通过 `executeWorkflow` 复用已有子流程，不新建 HTTP 网关。DS 失败重跑工作流**不得**被取证流程调用。

## 行为与结果

## AI-first 批量巡检（协议 v3）

启用前必须先导入并发布仓库中的 v3 n8n JSON、Dify DSL 和 OpenAPI v2.4.0 工具提供者。随后才在 ZNZB `.env` 显式开启：

```dotenv
METABASE_ANOMALY_BATCH_MODE=1
```

未设置该开关时仍运行旧流程，避免未完成导入时误派单。开启后，巡检的最终顺序是“国家巡检 → DS 核查 → AI 取证 → 通知 → 历史记录”：平台会先保留一份仅内部可见的待完成巡检，**不会**立即通知，也不会把它写入最终历史。

- 以 `国家 + 底表` 合并公共证据；同组最多 3 条指标，但每条都必须获得独立 `anomalyIndex` 结论。
- Dify 实际同时运行的批次硬限制为 2；只有某批 callback 已回写（或已超时）后，平台才提交下一批，绝不预投递全部队列。
- 单个批次最多 8 次 Agent 迭代、6 次工具调用；整个巡检目标 20 分钟，30 分钟后不再提交新批次，剩余项写为“AI 未核验”。
- 只有 `data_issue` / 未核验的异常进入告警通知；`business_change` 和 `hide_verified_normal` 仍留在历史审计，但不播报为数据异常。

新模板中的 n8n 节点只需要替换三个占位符：入口 token、回调 token、Dify `app-` API key。Callback URL 固定为 `/api/metabase-anomaly-analysis/batch-callback`，不得改回单条 `/callback`。

平台创建异步任务后即显示“分析取证中”。任务完成后，n8n 使用同一 `jobId` 回调，写入分析与受限证据。没有 SQL、权限不足、只有 `declared_dependency_only`、分区或 DS 证据不足时，结论必须为 `insufficient_evidence`；原巡检告警不会由本 Agent 自动关闭。

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
