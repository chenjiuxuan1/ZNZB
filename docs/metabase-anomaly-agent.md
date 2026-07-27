# Metabase 异常原因分析 Agent

推荐通过 n8n 调用模型与 Langfuse。私有工作流 `n8n-metabase-anomaly-agent.json` 在本地维护且被 Git 忽略，不会随代码仓库上推；导入该文件后，可按需在 n8n Variables 中配置：

```text
DASHSCOPE_API_KEY
DASHSCOPE_API_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1
DASHSCOPE_MODEL=qwen3.7-plus
LANGFUSE_BASE_URL=http://172.20.0.234:3000
LANGFUSE_BASIC_AUTH=base64(publicKey:secretKey)
METABASE_ANOMALY_AGENT_WEBHOOK_TOKEN=optional-shared-token
```

激活工作流后，在平台根目录 `.env` 配置 n8n Webhook：

```dotenv
METABASE_ANOMALY_AGENT_ENABLED=true
METABASE_ANOMALY_AGENT_N8N_WEBHOOK_URL=http://127.0.0.1:5678/webhook/metabase-anomaly-agent
METABASE_ANOMALY_AGENT_N8N_TOKEN=optional-shared-token
```

未配置 n8n 时，仍可在项目根目录的 `.env` 中配置 DashScope 或任意 OpenAI 兼容模型服务直连：

```dotenv
# 可选：显式关闭 Agent。未设置或设为 true 时，只要以下三项完整就会启用。
METABASE_ANOMALY_AGENT_ENABLED=true
METABASE_ANOMALY_AGENT_BASE_URL=https://your-llm.example/v1
METABASE_ANOMALY_AGENT_API_KEY=replace-with-your-api-key
METABASE_ANOMALY_AGENT_MODEL=your-model-name
```

DashScope 国际站示例：

```dotenv
METABASE_ANOMALY_AGENT_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1
METABASE_ANOMALY_AGENT_API_KEY=replace-with-dashscope-api-key
METABASE_ANOMALY_AGENT_MODEL=qwen3.7-plus
```

直连模式可选地写入 Langfuse。Agent 会创建一条 trace 和一条 generation，记录受限证据、Prompt、原始模型输出、结构化结果、模型名与 Token 用量：

```dotenv
METABASE_ANOMALY_LANGFUSE_ENABLED=true
METABASE_ANOMALY_LANGFUSE_BASE_URL=https://your-langfuse-host
METABASE_ANOMALY_LANGFUSE_PUBLIC_KEY=pk-...
METABASE_ANOMALY_LANGFUSE_SECRET_KEY=sk-...
```

重启平台后，进入“定时巡检 -> 历史明细”，展开某个 Metabase 异常，在异常卡片中点击“AI 分析原因”。

Agent 只接收该异常的看板名称、卡片名称、规则类型、原始告警信息和最多 5 条同看板异常作为证据，返回：现象摘要、可能原因、核查步骤、建议处理、置信度与限制说明。它不会执行 SQL、修改 Metabase、修复数据或发送通知。模型返回非 JSON 时会生成保守分析并标记低置信度；Langfuse 写入失败不会影响页面分析结果。

分析结果写入 `config/metabase-anomaly-analyses.json`，自动保留最近 7 天；该文件已被 Git 忽略。相同巡检记录、国家和异常序号再次查看时会读取缓存，不会重复调用模型。
