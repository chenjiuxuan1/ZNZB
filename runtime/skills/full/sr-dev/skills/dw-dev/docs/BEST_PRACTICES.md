# DW Dev 数仓开发最佳实践

> 作者：owenzhang

## 一句话原则

`$dw-dev` 只做轻量编排和证据包装；业务分析、建模判断、SQL 编写、执行和调度都由 Codex 或 Claude Code 协调对应 skill 完成。

## 推荐顺序

1. 先收集用户输入、Jira、文档和本地资料。
2. 每次补充资料先进入 `原始资料`；截图、本地文件、SQL 文件需要验证和收纳，外链不可读就标阻断。
3. 用 `$dw-knowledge` 查文档和知识库，先取 Git-backed 文档，再看召回。
4. 只有 ETL、workflow 或表构建事实需要代码证据时，才用 `$dw-code-knowledge`。
5. 生成 `$dw-modeling` handoff，先确定粒度、层级、主键、刷新频率和复用。
6. 建模清楚后生成 `$dw-sql-builder` handoff。
7. 同时准备生产/testdb 表映射、系统验证 SQL和用户只读验收 SQL，再生成 `$sr-box` 执行请求。
8. 只有用户明确要求 DS 操作时生成 `$ds-scheduler` handoff。
9. 每次补问、口径确认、需求调整和验收反馈都更新 `QA/00-需求QA记录.md`。
10. 每次交付范围、上线材料或验收结论变化，都覆盖更新 `交付文档/00-交付清单.md`。

## DATA-2232 测试样例

DATA-2232 是 MexiCash-MGM 看板二期优化。最佳处理方式：

- DATA-2232 是当前需求。
- DATA-2111 是一期已完成依据，包含 M1/M2 漏斗、渠道归因、CDC 快照和 30 天转化窗口。
- DATA-2262 是已完成邀请表字段依据，`dwb.dwb_c_user_invite.user_invite_channel` 可作为既定事实。
- `data.kuainiu.io/collection/2452-mexicash-mgm` 如果 403，只记录为不可读来源。
- trace_id 到 M2 ID、入口事件字段、M2 应用/放款口径缺失时，先补问，不生成执行 SQL。

## 阻断时怎么写

阻断不是失败包装，而是安全停止：

- 缺 country/datasource：补 route。
- 缺业务粒度：补 query_spec。
- 缺映射表：补来源表或 ETL 证据。
- 外部看板 403：要求截图、字段清单或可访问文档。
- SQL 写入非 `testdb.*`：阻断在 `$sr-box` handoff 前。
- 缺少用户验收 SQL、结果列/通过条件说明或生产/testdb 一一映射：标记 `blocked_validation_contract`。
- 截图或本地文件不存在：记录到 `原始资料/01-资料收纳清单.md`，不进入事实结论。
- 用户调整需求：更新 QA 和交付文档，最新需求覆盖旧交付描述。

## 不要做

- 不在 `$dw-dev` 内部写复杂 SQL 生成器。
- 不把未执行 SQL 写成验收结果。
- 不把召回内容覆盖用户当前输入。
- 不默认生成 DS 发布包、Jira 评论、旧版 `08-delivery.md` 或 reviewer 文件。
- 不修改 `$sr-box`、`$dw-knowledge`、`$dw-code-knowledge`、`$dw-modeling`、`$dw-sql-builder`、`$ds-scheduler`。
