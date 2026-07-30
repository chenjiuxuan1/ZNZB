# Metabase 异常数据侧取证 Agent

当前推荐并默认部署的是 **n8n 编排 + Dify 决策 + 只读取证网关**：

`ZNZB 异步派单 → n8n 读取 Card SQL → Dify 决策 → n8n 执行受控取证 → Dify 再决策 → 固定内网 callback`。

导入 [n8n-metabase-anomaly-dynamic-evidence-agent.template.json](../n8n-metabase-anomaly-dynamic-evidence-agent.template.json)。其生产 Webhook 路径固定为：

`POST /webhook/metabase-anomaly-dynamic-evidence-agent`

Dify 只返回下一步的 JSON 动作（`trace_lineage`、`check_partition`、`check_ds_workflow` 或 `finish`），不会直接访问 ZNZB、StarRocks、DS，也不能执行重跑、修复、写入或权限变更。n8n 只接受已发现的表名，且硬限制为：血缘深度 3、总工具调用 10、分区检查 3、DS 检查 3。完整循环与 Dify 输出契约见 [n8n Dify 动态取证决策环](n8n-dify-decision-loop.md)。

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
4. `REPLACE_WITH_N8N_PUBLIC_HOST` 为已发布取证网关的稳定 n8n 主机；保留 `/webhook/warehouse-lineage`、`/webhook/warehouse-partition-evidence`、`/webhook/ds-runtime-evidence` 三个路径。所有模板中的 `REPLACE_WITH_EVIDENCE_GATEWAY_TOKEN` 必须替换为同一个共享随机 Bearer token；它仅保护可复用只读网关，独立于 Dify、平台 callback 和 Card SQL token。“公共”不代表匿名访问。
5. 发布动态 Agent 及三个网关。公共复用不等于匿名开放：入口及网关须由 n8n/反向代理的组织认证保护。

分区网关必须先绑定各国只读 StarRocks 凭证；DS 网关必须先绑定已审核的只读候选查询工作流。未完成绑定时它们只返回 `unavailable` 证据，绝不重跑 DS 或改写数据。

## 行为与结果

平台创建异步任务后即显示“分析取证中”。任务完成后，n8n 使用同一 `jobId` 回调，写入分析与受限证据。没有 SQL、权限不足、只有 `declared_dependency_only`、分区或 DS 证据不足时，结论必须为 `insufficient_evidence`；原巡检告警不会由本 Agent 自动关闭。

分析结果写入 `config/metabase-anomaly-analyses.json`，默认保留最近 7 天；该文件已被 Git 忽略。

## 已移除的旧模板

`n8n-metabase-anomaly-evidence-agent.template.json` 已从仓库交付中移除：它使用不安全的入口与 callback 设计，不能再导入、发布或作为兼容模板保留。已有该旧工作流的实例应下线，并迁移至本文顶部的动态模板及 `/webhook/metabase-anomaly-dynamic-evidence-agent`。

未配置 n8n 时，项目仍保留直连 OpenAI 兼容模型的摘要模式作为兼容回退。它不具备动态血缘、分区或 DS 取证能力，也不是当前生产推荐路径。
