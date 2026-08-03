# Metabase 异常 Agent 加速设计（保留精准 ReAct 能力）

## 目标与边界

一次巡检可能有约 20 个异常看板。当前 `triggerDashboardGroupedAnalysis` 对每个看板依次 `await analyzeMetabaseAnomaly`；每个任务进入 Dify ReAct 并串行调用多个远程工具，通常耗时 2--3 分钟。因此巡检收尾会被延长约 40--60 分钟。

本设计的目标是在不降低单看板判断精度、不复用历史 AI 结论、不过载单机 Dify/n8n 的前提下，将正常的 20 看板批次的 AI 分析完成时间降至约 3--5 分钟。

以下内容不在范围内：关闭既有告警、用 DS 成功状态判定“数据正确”、把多个看板合并为一个模糊结论、将前一轮/前一天的结论作为本轮判断依据。

## 当前基线

- ZNZB 的 `runBatchScheduleNow` 与 `runDueBatchSchedule` 均会在巡检记录落库并发送通知后调用 `triggerDashboardGroupedAnalysis`。
- 当前用户工作区的 `triggerDashboardGroupedAnalysis` 按 `country + dashboard` 聚合，但对每个聚合结果串行调用 `analyzeMetabaseAnomaly`。
- `analyzeMetabaseAnomaly` 将任务异步派给 n8n；n8n 调用 Dify 的 5 工具 ReAct Agent，任务结束后回调 ZNZB。
- Agent 需要得到当日的卡片 SQL、StarRocks 实际值、递归血缘、Wattrel 告警和 DS 实例状态。这些事实必须保持实时和逐看板可追溯。

## 方案：快照优先、实时深挖兜底

新增一个**仅保存本轮原始证据**的“巡检证据快照”能力，以及 Dify 的可选第 6 工具 `get_current_anomaly_evidence`。该工具是加速器，不替代现有 5 工具。

### 两种模式

| 调用来源 | Agent 行为 |
| --- | --- |
| 人工或外部用户调用 | 不传 `snapshotId`；完全沿用现有 5 工具 ReAct 实时调查。 |
| ZNZB 自动巡检 | 传入 `runId`、`snapshotId`；先取本轮原始快照，再自行决定是否调用现有工具补证。 |

因此 Dify Agent 的通用调查能力、工具权限和人工使用方式不变。快照中不存在结论字段；Agent 也不能把快照视为“正常”的默认依据。

### 快照内容与有效性

每个看板在本轮仅生成一份独立证据包。其动态证据全部绑定 `runId + countryCode + anomalyIndex + anomalyDate`，至少包括：

- 经受保护接口读取的卡片 SQL、解析出的底表和解析状态；
- 与卡片口径对应的当日底表查询原始返回值、SQL、查询时间和截断标记；
- 至多 3 层的每层血缘原始返回值；
- 相关表的 Wattrel 原始返回值；
- 由 producer SQL 匹配到的 DS 工作流、当日实例、开始/结束时间和状态原始返回值；
- 各子查询的 `collectedAt`、成功/失败状态及错误信息。

快照有效条件：`runId` 一致、`anomalyDate` 一致、所有动态项在当前巡检开始后生成、且未超过配置的短 TTL（建议 10 分钟）。任一关键项缺失、过期、解析不确定或与卡片异常矛盾时，快照工具必须返回 `complete:false` 与缺失原因；Agent 必须使用原有实时工具补查，或输出 `insufficient_evidence`。不得读取其他 `runId` 的动态项。

可以维护“卡片 SQL -> 表 -> 血缘/工作流”的静态索引来减少解析开销，但它只能帮助决定本轮要刷新哪些事实。索引失效或版本不一致时必须重新读取当前卡片 SQL；它不能代替动态取证。

## 调度与资源保护

新增独立的、持久化的加速任务队列；不得在 `runBatchScheduleNow` 或 `runDueBatchSchedule` 的正常巡检 Promise 中等待它完成。

1. 正常巡检维持现有顺序：检查、记录、通知；完成后仅提交“自动分析批次”任务。
2. 队列以 `runId` 为批次，按看板生成证据快照任务。相同批次中可复用**同一次外部请求的原始响应**，但每个看板仍保留自己的证据引用与最终 AI 结论。
3. 每个下游设置独立令牌桶/并发池，初始值为：SR 3、DS 2、Wattrel 3、血缘 3、Dify 轻量裁决 2。不得使用“20 个 ReAct 同时启动”的统一并发。
4. 快照完成后，每个看板仍独立提交 Dify。巡检模式下指令要求先调用快照工具；若 `complete:false`，继续走既有 5 工具的深度调查。
5. 失败仅影响对应自动分析任务，记录 `failed`/`fallback`/`pending`；不改变巡检成功状态、不延迟通知、不关闭或降级原有异常。

队列使用新增、独立的配置和存储文件；不得改变 `metabase-anomaly-analyses.json` 已有记录的语义。保留既有的 `force` 重试与 callback 竞争保护。

## Dify 与接口契约

新增工具的最小请求：

```json
{
  "runId": "当前巡检 ID",
  "country": "ine",
  "anomalyIndex": 0,
  "snapshotId": "不透明 ID"
}
```

响应只能包含上文的原始事实、来源、时间戳、完成状态和缺失项；不包含 `dataSideVerdict`、`notificationAction` 或任何历史 Agent 结论。工具需要限制读取范围，只允许当前任务绑定的身份读取，且沿用现有只读与 callback 鉴权边界。

Dify instruction 增加两个明确规则：

1. 有 `snapshotId` 时先调用 `get_current_anomaly_evidence`；`complete:true` 的每一项均可作为本轮事实，`complete:false` 不是“正常”。
2. 不能仅凭 DS 成功输出业务正常；底表实际值、卡片口径、血缘、质量告警和 DS 时间顺序有冲突时，继续调用现有工具或输出证据不足。

人工调用的 start 参数没有 `snapshotId` 时，该规则不触发，既有 5 工具调查流程和用户体验不变。

## 分阶段上线与回滚

新能力必须由全新开关控制，默认关闭：

```dotenv
METABASE_ANOMALY_AGENT_ACCELERATION_ENABLED=false
METABASE_ANOMALY_AGENT_SNAPSHOT_TTL_SECONDS=600
METABASE_ANOMALY_AGENT_SNAPSHOT_MAX_CONCURRENCY=2
```

阶段 1（影子模式）：巡检正常运行；后台建立快照并记录耗时/覆盖率，但不将 `snapshotId` 传给 Dify，也不影响现有 Agent。

阶段 2（单国家灰度）：对一个国家传入快照；对同一批抽样看板保留一次实时 ReAct 对照，比较引用事实是否一致，不比较措辞。

阶段 3（逐国家启用）：仅在快照完整率、事实一致率和资源指标达标后启用；始终保留实时回退。

回滚只需关闭 `METABASE_ANOMALY_AGENT_ACCELERATION_ENABLED`：新队列停止派单，原有 Dify/n8n/ZNZB 调用路径继续工作。不得删除快照记录，以便审计和定位，但其记录不得再供 Agent 判定使用。

## 验证、监控与验收

新增单元/集成测试至少覆盖：

- 开关关闭时，现有巡检、通知、手动 Agent 和 5 个工具请求完全不变；
- 自动巡检派发加速任务失败时，巡检仍返回原先的成功/部分失败结果；
- 快照跨 `runId`、日期、国家或异常序号访问被拒绝；
- 快照过期/不完整/矛盾时，Agent 请求实时工具或得到 `insufficient_evidence`，绝不产生“正常”结论；
- DS 成功但底表值异常的样本不能被短路；检测早于 DS 完成、而底表最终有真实值的样本必须保留“监测时序误报”证据；
- 人工调用未提供 `snapshotId` 时仍可完成当前 5 工具 ReAct 调查；
- 并发池从不超过配置上限，单个下游超时不会阻塞其他批次。

上线后按批次记录并告警：异常看板数、唯一表/工作流数、快照完整率、实时回退率、各下游 p50/p95、Dify 排队与执行时间、队列长度、总分析时长，以及影子对照中的事实一致率。

## 时长预估与容量结论

以 20 个异常看板、单机 Dify、当前完整 ReAct 单任务约 2--3 分钟为基线：

| 情况 | 预估总时长 | 说明 |
| --- | ---: | --- |
| 当前串行完整 ReAct | 40--60 分钟 | 当前自动触发路径。 |
| 加速路径正常命中 | 3--5 分钟 | 约 1--2.5 分钟刷新本轮事实，约 1--2 分钟以 Dify 并发 2 完成独立裁决，外加回调。 |
| 部分缺失并回退 | 5--12 分钟 | 少数看板进入 2 并发完整 ReAct。 |
| 全量缺失并回退 | 20--30 分钟 | 精度优先的最坏情况；不以提高并发换取速度。 |

以上是上线前假设，不能替代实测。阶段 1 必须以真实 p95 取证时延、唯一表/工作流数量和 Dify 推理时延重新校准并发与目标时间。

## 前端展示与历史加载

### 波动图谱：默认展示，只有“已核验正常”才隐藏

波动图谱当前直接从 `batch-check-run-history.json` 的原始异常建立点位；它不知道异步 AI 结论。因此，不能通过解析 AI 摘要、`notificationAction`、DS 成功状态或缺少结论来隐藏图中的点，这些条件都会造成误隐藏。

为每个已完成分析新增一个由后端校验的展示字段：

```json
{
  "chartVisibility": "show | hide_verified_normal",
  "verificationStatus": "pending | completed | failed",
  "verificationReason": "仅在 hide_verified_normal 时提供的简短证据摘要"
}
```

规则如下：

- 所有原始异常、分析进行中、分析失败、证据不足、`data_issue`、`business_change` 一律为 `chartVisibility: show`；这是默认值。
- 只有 Agent 以本轮原始证据明确确认“异常检测时点/查询结果正常、不是当前数据异常”时，才允许返回 `hide_verified_normal`。该结论必须至少引用底表实际值、查询时间/异常日期和 DS 时间顺序或等效的一条事实证据。
- 后端只接受枚举值；缺失、未知或不满足校验的值降级为 `show`。前端不得自行推断。
- 图谱请求一个轻量的“本次 `runId` 的 AI 展示索引”接口（只含 `countryCode`、`anomalyIndex`、`verificationStatus`、`chartVisibility` 和简短原因），再与原始异常按身份关联。不得把完整 AI 结论复制进历史文件，也不得修改/删除原始异常记录。
- 图谱渲染时排除仅 `hide_verified_normal` 的点，国家点数与总点数使用过滤后的数量；顶部显示“已隐藏 N 个 AI 已核验正常点（查看日志）”。这样用户知道点位被有意隐藏，而不是巡检漏报。

原始异常和完整 AI 分析仍留在巡检日志/详情页中。日志内将沿用现有的“AI 原因分析、核查步骤、建议处理、数据侧判定、置信度、限制”展示，并补充“AI 已核验正常（不展示于波动图谱）”标识、查询/取证方式以及 `verificationReason`。用户仍可重新 AI 分析；重试期间和结果未回调前，图谱默认重新展示该点。

### 历史请求改为显式加载

历史较大时不能作为全站启动依赖。现状中 `web/src/app.js` 在延迟加载阶段仍会请求 `/api/batch-history?limit=50`，而 `web/src/views/fluctuation-visual.js` 首次渲染会自动请求最近 1 条异常历史。改造后的行为：

| 页面/入口 | 初始行为 | 用户动作后的请求 |
| --- | --- | --- |
| 全站启动 | 不请求批量巡检历史。 | 无。 |
| 定时巡检页的历史面板 | 折叠显示“加载最近 3 次巡检记录”按钮；筛选控件在加载前禁用。 | 点击后请求 `/api/batch-history?limit=3`；之后筛选仍最多返回 3 条。 |
| 波动图谱 | 显示空态和“加载最新波动图谱”按钮，不自动取历史。 | 点击后请求 `/api/batch-history?status=anomaly&limit=1`，再按需加载所选点的真实序列。 |
| 通知链接直达的单次历史详情 | 保持自动加载。 | 只请求 `/api/batch-history?runId=...`，这是用户明确打开的一次记录。 |

若最近 3 条仍不能在目标时间内返回，配置将历史面板初始数量降为 1；波动图谱始终只请求最新 1 条。服务端已有 `limit` 与 `runId` 精简查询逻辑，前端不得再在启动期调用 `limit=50` 或 `limit=200`。

### 前端验收

- AI 未完成、失败、证据不足或任意未知判定的异常仍显示在波动图谱；
- 有 `hide_verified_normal` 的已完成分析点不显示在图中，但在日志详情能看到原始告警、AI 正常标识、取证方式、证据和结论；
- 用户点击“重新 AI 分析”后，该点立即恢复图谱可见，直到新的已核验正常结论回调；
- 首屏、定时巡检页和波动图谱在用户点击加载前均不请求批量历史；带 `historyRunId` 的通知详情链接仍正常自动打开；
- 历史按钮最多初始返回 3 条，波动图谱最多初始返回 1 条，并为加载/失败/空结果提供明确状态提示。
