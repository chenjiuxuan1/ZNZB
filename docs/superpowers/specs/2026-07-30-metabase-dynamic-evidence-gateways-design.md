# Metabase 动态取证公共网关设计

## 目标

将 Metabase 异常 Agent 从静态 SQL/代码血缘分析升级为只读动态取证闭环。Dify 仅决定下一步；n8n 调用公共网关获取真实分区和 DS 运行态证据，再将结果回传 Dify 结案。

## 非目标与安全边界

- 不执行重跑、修复、告警关闭、通知、权限变更或任意 SQL。
- 不复用“各国-DS失败自动重跑统一入口”；它具有写入副作用。
- 不复用 SQL 优化通知工作流的通知/MySQL 写入部分。
- 公共 Webhook 只能接受国家白名单、合法表名、固定日期和受控操作；凭证只能绑定在 n8n Credentials，不能包含在 JSON 导出文件中。

## 公共网关

### 1. `POST /webhook/warehouse-partition-evidence`

输入：`countryCode`、`table`、`anomalyDate`、`baselineDate`、可选 `metricHint`。

输出：表描述、分区键、两个日期的存在性、行数，以及仅对已识别日期列的受控聚合。网关将按国家路由到预配置的只读 StarRocks Credential；禁止请求方传入 SQL、库地址或凭证。

若表没有可验证的日期列、无只读连接或查询失败，返回结构化 `unavailable` 证据，不伪造零值。

### 2. `POST /webhook/ds-runtime-evidence`

输入：`countryCode`、`table`、`producerFiles`、`sourceSql`、`anomalyDate`。

输出：DS 候选任务、匹配置信度，以及每个高置信候选在异常日附近的最新实例状态、开始/结束时间和失败信息。

网关内部复用 `DS任务匹配候选查询_execute_workflow` 的只读匹配能力；仅高置信、可验证的候选才查询运行态。没有候选时返回 `no_verified_ds_reference`。

## 主 Agent 循环

1. 获取卡片 SQL，提取初始表。
2. Dify 返回 `trace_lineage`、`check_partition`、`check_ds_workflow` 或 `finish`。
3. n8n 校验目标必须来自已发现表/血缘证据，然后调用对应公共网关。
4. n8n 追加证据和预算状态后回到 Dify。
5. 达到深度、调用次数或时限后保守结案。

默认预算：血缘深度 3、总工具调用 10、分区检查 3 张表、DS 运行态检查 3 个高置信候选。

## 结论规则

- 只有“异常日分区缺失/显著变小”与“相关 DS 失败或未运行”等真实证据一致时，Dify 才能判定 `data_issue`。
- 分区/DS 均正常且指标逻辑可解释时才可判定 `business_change`。
- 没有动态证据、DS 候选低置信或静态依赖无法验证时必须是 `insufficient_evidence`。

## 验证

1. 用现有 INE 异常 `ads_3005_gmv_dashboard_sumary_d` 验证血缘、分区、DS 三类证据。
2. 验证所有 Webhook 对任意 SQL、非法国家、非法表名均拒绝。
3. 验证没有任何节点调用 DS 重跑入口或写入通知/MySQL。
4. 验证最终回调只保存有界、无凭证的证据。
