# 数仓代码血缘只读网关

这是一个面向全平台的只读基础能力，而不是 Metabase 专用能力。Metabase 异常分析、Wattrel 数据质量、DS 失败根因、人工排查和未来的 Dify/n8n Agent 都应调用同一个接口。

## 范围与边界

- 国家：`cn`、`ine`、`ph`、`th`、`pk`、`mx`。
- 代码根目录：`/data/git/starrocks/workflow/{country}`。
- 当前稳定动作：`trace_table`，通过表名检索引用代码并返回上游表候选、代码位置及 DS 线索。
- 不执行仓库脚本、不拉取代码、不写文件、不接受任意 Shell/正则输入。
- 表名必须满足：`[database.]table_name`，仅小写字母、数字、下划线和一个可选点号。

## 公共接口

导入 [n8n-warehouse-lineage-gateway.template.json](../n8n-warehouse-lineage-gateway.template.json) 并发布后：

```text
POST http://127.0.0.1:5678/webhook/warehouse-lineage
Content-Type: application/json
Authorization: Bearer <shared-evidence-gateway-token>
```

请求：

```json
{
  "operation": "trace_table",
  "countryCode": "mx",
  "table": "dwd_example_table",
  "maxFiles": 10
}
```

`operation` 当前可省略，默认约定为 `trace_table`；调用方当前必须只传该动作。保留该字段是为了未来扩展而不改变调用方契约。

导入后必须把模板内所有 `REPLACE_WITH_EVIDENCE_GATEWAY_TOKEN` 替换为同一个组织共享的随机值。缺少或不匹配的 Bearer token 会返回 400，且不会进入 SSH 检索节点。“公共”仅表示可由多个已授权 n8n 工作流复用，绝不表示匿名开放；该 token 独立于 Dify API Key、值班平台 callback token 和 Card SQL token。

响应：

```json
{
  "success": true,
  "table": "dwd_example_table",
  "repository": "/data/git/starrocks/workflow/mx",
  "matchedFiles": [{ "path": "daily/job.sql", "matches": [] }],
  "upstreamTables": [],
  "relatedTables": ["ods_example_table"],
  "downstreamTables": [{ "table": "dws_example_table", "evidence": "declared_dependency" }],
  "dsRefs": [],
  "evidence": { "quality": "declared_dependency_only" },
  "truncated": false
}
```

`relatedTables` 是命中文件中的关联候选，不能直接当作上游血缘。只有后续版本从“产出目标表的 SQL”中解析出的 `upstreamTables` 才能供 Agent 递归查询；当前会明确把证据等级返回给调用方，避免错误追溯。

## 演进动作

后续动作继续使用相同路径和国家路由，但必须先实现并通过各自的安全校验后才会开放：

- `search_code`：按受限关键字寻找作业和表定义。
- `find_workflow`：根据表/文件映射 DS 项目和工作流。
- `impact_analysis`：从指定表向下游查受影响的作业和看板。

每个动作必须有独立的输入白名单和最多结果数，不能把用户输入拼为 Shell 或 SQL。

## 验证

```bash
curl -sS -X POST http://127.0.0.1:5678/webhook/warehouse-lineage \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <shared-evidence-gateway-token>' \
  -d '{"operation":"trace_table","countryCode":"mx","table":"dm_strategy_ps_mex017_c1c2_s1_month_start"}'
```

若返回 `repository not found`，说明跳板机上的目录缺失；若 SSH 失败，检查 n8n 中复用的国家跳板机 Credential，而不是放宽输入校验。
