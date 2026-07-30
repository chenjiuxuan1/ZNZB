# Metabase 动态数据侧取证：执行报告

日期：2026-07-30

## 已交付

- `n8n-metabase-anomaly-dynamic-evidence-agent.template.json`：异步取证主流程。Dify 只决定下一步，n8n 执行只读调用并将最终结论与脱敏证据链回调 ZNZB。
- `n8n-warehouse-lineage-gateway.template.json`：可复用的只读代码血缘网关，支持反引号 SQL 标识符。
- `n8n-warehouse-partition-evidence-gateway.template.json`：可复用的只读 StarRocks 分区证据网关。
- `n8n-ds-runtime-evidence-gateway.template.json`：可复用的 DS 运行态候选查询网关；未绑定审核后的只读查询工作流时安全返回 `unavailable`，绝不重跑。
- ZNZB 回调/Card SQL 鉴权改为必须配置并安全比较 Bearer token；不再把 `jobId` 当作授权能力。

已下线旧的、会误导部署的直连 Dify/OpenAPI 和旧 n8n 取证模板；请只导入上面的四个模板。

## 导入与配置顺序

1. 导入并发布三个网关：血缘、分区、DS Runtime。
2. 在三个网关中把 `REPLACE_WITH_EVIDENCE_GATEWAY_TOKEN` 替换为同一个随机值。
3. 绑定六个国家的只读 StarRocks 凭据；未绑定前分区网关会返回 `unavailable`。
4. 绑定经过审核的只读 DS 候选查询工作流；不要绑定任何自动重跑/通知工作流。
5. 导入并发布动态主流程，配置：
   - `REPLACE_WITH_DIFY_WORKFLOW_RUN_URL`：`http://172.20.0.234/v1/workflows/run`
   - `REPLACE_WITH_DIFY_API_KEY`：Dify 应用的 `app-` API Key
   - `REPLACE_WITH_METABASE_AGENT_CALLBACK_TOKEN`：与 ZNZB `.env` 的 `METABASE_ANOMALY_AGENT_CALLBACK_TOKEN` 相同
   - `REPLACE_WITH_METABASE_ANOMALY_AGENT_WEBHOOK_TOKEN`：与 `.env` 的 `METABASE_ANOMALY_AGENT_N8N_TOKEN` 相同
   - `REPLACE_WITH_EVIDENCE_GATEWAY_TOKEN`：第 2 步的共享网关 token
   - `REPLACE_WITH_DUTY_PLATFORM_INTERNAL_CALLBACK_URL`：`http://172.19.0.1:28787/api/metabase-anomaly-analysis/callback`
6. ZNZB `.env` 必须同时具备：

```dotenv
METABASE_ANOMALY_AGENT_ENABLED=true
METABASE_ANOMALY_AGENT_N8N_ASYNC=true
METABASE_ANOMALY_AGENT_N8N_WEBHOOK_URL=http://127.0.0.1:5678/webhook/metabase-anomaly-dynamic-evidence-agent
METABASE_ANOMALY_AGENT_N8N_TOKEN=<动态入口token>
METABASE_ANOMALY_AGENT_CALLBACK_URL=http://172.19.0.1:28787/api/metabase-anomaly-analysis/callback
METABASE_ANOMALY_AGENT_CALLBACK_TOKEN=<平台callback/Card-SQL token>
```

## 安全与行为

- “公共网关”表示可被授权工作流复用，所有入口仍强制 Bearer token。
- 所有流程只读：不执行 DS 重跑、修复、权限变更或告警关闭。
- 回调地址在模板固定为内网地址，忽略请求携带的 `callback.url`。
- Dify 返回动作循环受限于：深度 3、总调用 10、分区检查 3、DS 检查 3。
- 外部 HTTP 的 4xx/5xx/超时会生成受限证据并保守回调，不会让 ZNZB 任务永久 pending。

## 验证结果

主工作区同步后执行：

- `npm test`：281 passed，0 failed
- 四份 n8n 模板 JSON 解析：通过
- `git diff --check`：通过

尚未执行线上导入、凭据绑定与真实服务 smoke；上述步骤需要在 hk-bigdata-monitor 的 n8n 中完成。
