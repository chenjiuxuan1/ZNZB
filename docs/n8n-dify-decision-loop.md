# n8n Dify 动态取证决策环

导入 `n8n-metabase-anomaly-dynamic-evidence-agent.template.json` 后，工作流会立即返回 `accepted/jobId`，随后异步执行并通过平台既有 callback 写回结果。`jobId` 必须由 ZNZB 异步请求生成并提供；缺失或格式不合法的请求会被拒绝，n8n 不会自行生成 ID，以保证 callback 与平台任务一一对应。

流程固定为：平台 Card SQL → Dify 决策 → 校验 → 只读公共网关 → 截断并追加证据 → Dify 再决策。结束时，n8n 会逐字段校验并保留合法的 Dify `finish` 结论；无效或缺失字段才回退为 `insufficient_evidence/enrich_only`。

## Dify 输入契约

每次调用都会发送已经过长度限制和归一化的 `run_id`、`country_code`、`anomaly_index`、`anomaly_message`、`dashboard_title`、`card_title`、`dashboard_url`，以及只读取证状态的 `state_json`。Dify 必须以这些字段为准；`state_json` 仅是追加上下文，不替代任何上述输入字段。Card SQL 由 ZNZB 返回的 `{ success, card: { dataset_query, native_query } }` 读取，模板优先使用 `card.dataset_query.native.query`，同时兼容顶层旧字段；模型不能提供、替换或构造 SQL。

## Dify 输出契约

Dify 可在文字说明后追加一个 JSON 对象；n8n 只解析最后一个 JSON 对象。它必须返回：

```json
{ "action": "trace_lineage", "table": "ads.daily_orders", "reason": "Card SQL 的根表需要追溯" }
```

允许的 `action` 是：

- `trace_lineage`
- `check_wattrel`
- `check_ds_workflow`
- `check_ds_status`
- `finish`

对于除 `finish` 外的动作，`table` 必须是已从 Card SQL 识别、或由 `producer_sql` 血缘结果验证过的 `schema.table`。任意 SQL、URL、凭据、工作流执行/重跑参数都会被忽略或结案。硬限制为深度 3、总工具调用 12、Wattrel 检查 3、DS 匹配 3、DS 状态检查 3；超过限制立即保守结案。

日期只从异常消息中的 `YYYY-MM-DD` 或 `YYYY/MM/DD` 提取，并验证为真实日期；找不到时使用当天，基准日默认前一天。网关仍会独立执行其自己的输入验证。

## 导入后的配置

模板没有任何真实 token、主机或 n8n Variables 引用。导入后在节点中替换下列明确标注的占位符：

- `REPLACE_WITH_DUTY_PLATFORM_HOST` 与 `REPLACE_WITH_METABASE_AGENT_CALLBACK_TOKEN`：平台受保护的 Card SQL 读取接口。后者必须与 ZNZB `.env` 的 `METABASE_ANOMALY_AGENT_CALLBACK_TOKEN` 完全相同；它也用于 n8n → 平台 callback。绝不能在这里填写 Dify App API Key 或 `DIFY_WAREHOUSE_LINEAGE_TOOL_TOKEN`。
- `REPLACE_WITH_DIFY_WORKFLOW_RUN_URL` 与 `REPLACE_WITH_DIFY_API_KEY`：Dify Workflow API。当前环境 URL 必须完整写为 `http://172.20.0.234/v1/workflows/run`，不得自动拼接路径，也不能填写公网域名。
- `REPLACE_WITH_N8N_PUBLIC_HOST`：已发布的固定公共网关主机；路径必须分别保持 `/webhook/warehouse-lineage`（血缘）、`/webhook/wattrel-query`（Wattrel 质量告警）、`/webhook/ds-scheduler`（DS 运行状态）。DS 任务匹配通过 `executeWorkflow` 节点直接调用已有子流程（`REPLACE_WITH_DS_TASK_MATCH_WORKFLOW_ID`），不需要 HTTP 网关。
- `REPLACE_WITH_EVIDENCE_GATEWAY_TOKEN`：血缘网关的随机 Bearer token。Wattrel 和 DS scheduler 网关通过 webhook 路径隔离。`REPLACE_WITH_DS_API_TOKEN` 是 DolphinScheduler API token，仅用于只读查询任务状态。`REPLACE_WITH_DS_TASK_MATCH_WORKFLOW_ID` 是 DS 匹配子流程的 workflow ID。
- `REPLACE_WITH_METABASE_ANOMALY_AGENT_WEBHOOK_TOKEN`：动态 Agent 入口的专用随机 Bearer token。ZNZB 的 `METABASE_ANOMALY_AGENT_N8N_TOKEN` 必须使用同一个值；没有该 token 时平台不会派发任务。
- `REPLACE_WITH_DUTY_PLATFORM_INTERNAL_CALLBACK_URL`：固定为值班平台的内网 callback，例如 `http://172.19.0.1:28787/api/metabase-anomaly-analysis/callback`。不要填写公网域名，也不要从请求 body 中读取或信任 `callback.url`。

先导入并发布血缘网关、Wattrel 网关和 DS scheduler 网关。DS 任务匹配通过 `executeWorkflow` 复用已有 `DS任务匹配候选查询` 子流程，不需要额外导入网关模板。分区核验由 Codex `sr_box` 技能人工只读执行。DS 失败重跑工作流**不得**被取证流程调用。当 producer SQL 不可信或 DS 候选为空时，对应分支返回 `unavailable` 证据，而不是执行或重跑任务。

平台侧应配置 `METABASE_ANOMALY_AGENT_N8N_ASYNC=true`、动态模板 webhook URL、`METABASE_ANOMALY_AGENT_N8N_TOKEN`、固定内网 `METABASE_ANOMALY_AGENT_CALLBACK_URL` 和非空的 `METABASE_ANOMALY_AGENT_CALLBACK_TOKEN`。callback token 由 ZNZB 在每次任务请求中携带，n8n 只会把它发送到模板中固定的内网 callback URL；缺失 token 或 jobId 的请求会失败。

## 公共 webhook 的边界

“公共使用”表示这些网关可被已授权工作流复用，不表示匿名开放。动态 Agent 入口必须带 Bearer token，三个取证网关也内置统一的 Bearer 校验，且 callback 目的地在模板中固定。不要把任意 URL、重定向 URL、metadata 地址、SQL、凭据或重跑参数交给它；模板会忽略 callback URL 并拒绝不在契约内的顶层字段。
