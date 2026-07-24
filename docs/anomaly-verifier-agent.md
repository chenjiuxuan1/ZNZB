# 异常复核 Agent

异常复核 Agent 位于现有 Metabase 波动检测和通知发送之间。现有规则产生的异常只作为候选异常；Agent 使用 Qwen 理解候选异常并提供调查建议，使用配置好的表血缘和 SR Box 只读 SQL 做二次验证，再由确定性规则决定最终是否保留告警。

## 核心原则

- 不替换现有规则引擎。
- 不允许 Agent 执行任何写 SQL。
- 没有血缘、查询失败、无权限或证据不足时，必须保留原异常。
- 只有数据库明确返回正常且置信度达到门槛时，才将候选异常标记为误报并抑制通知。
- 原始异常和复核证据都会保留在结果及批量巡检历史中。
- Qwen 的结论只作为解释和调查建议，不能覆盖 SR Box 数据库判定。
- Qwen 建议的 SQL 不会自动执行，且任何写 SQL 建议都会被丢弃。

## 调用链

```text
Metabase 批量巡检
  -> 候选异常
  -> Qwen 分析指标和可能原因
  -> 匹配复核计划
  -> DESC / SHOW CREATE TABLE 检查表结构
  -> SR Box 执行只读验证 SQL
  -> Qwen 解释标准化证据
  -> 生成复核证据
  -> confirmed_anomaly / false_positive / data_quality_issue / unverified
  -> 过滤误报
  -> 通知与历史记录
```

自动巡检接入点：

- `runBatchCheck` 先生成候选异常，再调用复核 Agent。
- `runBatchCheckAndNotify` 只对复核后的最终异常发送通知。
- 定时批量巡检复用同一流程。
- `POST /api/anomaly-verifier/verify` 可对传入的历史结果执行手动复核。

## 配置

复制示例文件：

```bash
cp config/anomaly-verifier.config.example.json config/anomaly-verifier.config.json
```

生产配置文件默认被 `.gitignore` 排除，避免提交本机 Skill 路径或内部验证 SQL。

启用前需要：

1. 使用 `dw-knowledge` 确认指标口径和权威表。
2. 使用 `dw-code-knowledge` 查找 Card SQL、ETL SQL 和真实表血缘。
3. 为每类指标编写只读复核 SQL。
4. 手工执行 SR Box SSO 登录并确认只读权限。
5. 用单条历史异常测试复核结果。
6. 最后将 `enabled` 改为 `true`。

## Qwen 模型配置

Agent 使用阿里云 DashScope 的 OpenAI 兼容接口，默认配置为：

```json
{
  "llm": {
    "enabled": true,
    "provider": "dashscope",
    "model": "qwen3.6-plus",
    "baseUrl": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    "apiKeyEnv": "DASHSCOPE_API_KEY",
    "temperature": 0.1,
    "maxTokens": 1800,
    "timeoutSeconds": 60
  }
}
```

默认地址是新加坡地域。其他地域只需要修改 `baseUrl`，不要修改客户端代码。

API Key 只能通过环境变量提供：

```bash
export DASHSCOPE_API_KEY='新生成的 API Key'
```

不要把 API Key 写入：

- `anomaly-verifier.config.json`
- `.env` 之外的版本控制文件
- SQL、提示词或巡检历史
- 测试和日志

Qwen 有两种工作模式：

1. `plan-suggestion`：没有正式血缘计划时，分析可能原因、给出血缘调查方向和待审核只读 SQL。最终状态仍是 `unverified`。
2. `evidence-review`：数据库复核完成后，解释标准化证据并给出调查建议。最终状态仍以确定性数据库判定为准。

模型输出采用 JSON，包含：

- `summary`
- `likelyCause`
- `lineageHints`
- `suggestedReadOnlySql`
- `recommendation`
- `confidence`
- `warnings`

其中 `recommendation` 仅供展示和调查，不参与误报过滤。

## 复核计划

每个计划包含：

```json
{
  "id": "ine-okr-scale",
  "match": {
    "countryCode": "INE",
    "dashboardTitle": "OKR",
    "cardTitle": "规模",
    "types": ["completeDayChange"]
  },
  "route": "id",
  "sourceTables": [
    "dws.authoritative_metric_d",
    "dwd.independent_detail_d"
  ],
  "schemaSql": [
    "DESC dws.authoritative_metric_d",
    "DESC dwd.independent_detail_d"
  ],
  "verificationSql": "SELECT ...",
  "resultFields": {
    "verdict": "verdict",
    "confidence": "confidence",
    "reason": "reason",
    "sourceComplete": "source_complete",
    "isAnomaly": "is_anomaly",
    "dataQualityIssue": "data_quality_issue",
    "observedValue": "observed_value",
    "baselineLow": "baseline_low",
    "baselineHigh": "baseline_high"
  }
}
```

支持按照国家、Dashboard、Card、Card ID 和异常类型做精确、数组或正则匹配。

## SQL 返回契约

复核 SQL 至少返回一行。推荐字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `verdict` | string | `confirmed_anomaly`、`false_positive`、`data_quality_issue` 或 `unverified` |
| `confidence` | number | 0～1；误报结论必须达到 `minFalsePositiveConfidence` |
| `reason` | string | 人可读判定依据 |
| `source_complete` | boolean | 底层分区和数据是否完整 |
| `is_anomaly` | boolean | 独立重算后是否仍异常 |
| `data_quality_issue` | boolean | 是否为延迟、缺分区、重复等数据质量问题 |
| `observed_value` | number/string | 独立重算值 |
| `baseline_low` | number/string | 历史基线下界 |
| `baseline_high` | number/string | 历史基线上界 |

如果不返回 `verdict`，Agent 会按以下顺序推断：

1. `data_quality_issue=true` -> `data_quality_issue`
2. `source_complete=false` -> `unverified`
3. `is_anomaly=true` -> `confirmed_anomaly`
4. `is_anomaly=false` -> `false_positive`
5. 其他情况 -> `unverified`

即使 SQL 返回 `false_positive`，只要 `source_complete=false` 或置信度不足，Agent 仍会改判为 `unverified`。

## SQL 模板变量

验证 SQL 可以使用以下变量，Agent 会自动转义为 SQL 字面量：

- `{{countryCode}}`
- `{{countryName}}`
- `{{dashboardTitle}}`
- `{{dashboardUuid}}`
- `{{cardTitle}}`
- `{{cardId}}`
- `{{dashcardId}}`
- `{{anomalyType}}`
- `{{checkedAt}}`

不允许使用模板变量动态替换数据库名或表名。表名必须来自受控配置，不能来自异常消息或前端输入。

## 安全边界

执行器只接受单条：

- `SELECT`
- `WITH`
- `SHOW`
- `SHOW CREATE TABLE`
- `DESC`
- `DESCRIBE`
- `EXPLAIN`

执行器会拒绝 `INSERT`、`UPDATE`、`DELETE`、`CREATE`、`DROP`、`ALTER`、`TRUNCATE` 等操作，并通过官方 `sr_gateway_client.py` 调用生产 SR Box。

执行记录只保存：

- SQL SHA-256 摘要
- SR Box `traceId`
- 行数和耗时
- 标准化后的判定字段
- 配置声明的血缘表

不会把完整 SQL 或任意原始查询行写入巡检历史。

## 当前版本与后续阶段

当前第一版是配置驱动的复核 Agent。它已经完成：

- 候选异常匹配。
- Qwen `qwen3.6-plus` 规划和证据解释。
- DashScope OpenAI 兼容客户端。
- 缺少 API Key 时安全降级，不影响原异常。
- 过滤模型生成的非只读 SQL。
- SR Box 只读执行器。
- 表结构探测。
- 证据标准化。
- 保守的四状态判定。
- 误报过滤。
- 批量巡检、定时巡检、通知和历史接入。
- 可注入执行器测试，不连接生产库。

后续自动血缘阶段可以增加：

1. 使用 `dw-knowledge` 根据指标名查权威口径和语义资产。
2. 使用 `dw-code-knowledge` 搜索 Card SQL、ETL SQL 和建表代码。
3. 生成待审核的血缘计划，不直接执行未知 SQL。
4. 人工确认计划后写入 `anomaly-verifier.config.json`。
5. 收集误报反馈，逐步形成稳定的指标复核模板。
