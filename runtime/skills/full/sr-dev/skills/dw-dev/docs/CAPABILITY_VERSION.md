# DW Dev Capability Version

> 作者：owenzhang
> 当前能力版本：`WDEV-07.2-validation-contract`
> 定位：数仓开发轻量编排、原始资料收纳、QA 记录、交付文档、上下文优先级和下游 skill handoff。

## 核心能力

| 能力 | 状态 | 说明 |
|---|---|---|
| 需求归一化 | 可用 | 支持直接输入、Jira、文档、本地资料、SQL package |
| 原始资料收纳 | 可用 | 生成 `原始资料/00-原始提问.md` 和 `原始资料/01-资料收纳清单.md`，截图和本地文件会验证/复制或标阻断 |
| 中文工作区 | 可用 | 生成最小锚点 `原始资料`、`上下文`、`QA`、`交付文档`，按需生成 `需求文档`、`参考资料`、`开发计划`、`协作请求` |
| 上下文优先级 | 可用 | 用户输入 > 索引查询 > `$dw-knowledge` 文档 > `$dw-knowledge` 召回 > 可选 `$dw-code-knowledge` |
| QA 记录 | 可用 | 记录补问、答案、需求调整和验收反馈 |
| 交付文档 | 可用 | 固定写入 `交付文档/00-交付清单.md`，需求调整时覆盖为最新交付状态 |
| 建模协作 | 可用 | 生成 `$dw-modeling` handoff |
| SQL 协作 | 可用 | 生成 `$dw-sql-builder` handoff |
| SR 执行协作 | 可用 | 有 `testdb.*` SQL 时生成 `$sr-box` handoff |
| `testdb` 写保护 | 可用 | 非 `testdb.*` 写验证阻断在执行请求前 |
| 双层验收 SQL | 可用 | 分离系统验证 SQL和用户可直接执行的只读验收 SQL |
| 生产/testdb 表映射 | 可用 | 强制生产表与 testdb 表一一对应并校验表模型一致 |
| DS 协作 | 可选 | 用户明确要求时生成 `$ds-scheduler` handoff |
| 原生智能体协调 | 可用 | Codex 或 Claude Code 负责跨 skill 分析、调用和判断 |

## 默认不再做

- 不把复杂分析写进 `$dw-dev` 脚本内部。
- 不默认执行 SQL、调度、Jira 写入、外部文档发布或交付发送。
- 不默认生成 legacy 目录：`05-sql`、`06-evidence`、`release/ds`。
- 不默认生成 reviewer、旧版 `08-delivery.md`、Jira comment、上线报告等可选产物。

## 验收口径

一次完成的编排应分开说明：

- 需求和上下文是否已整理。
- 原始资料是否已验证收纳，截图或不可读来源是否标明状态。
- QA 是否记录当前问题、答案、变更和验收反馈。
- 参考资料附录是否标明来源和不可读来源。
- `$dw-modeling` handoff 是否已生成或被阻断。
- `$dw-sql-builder` handoff 是否已生成或被阻断。
- `$sr-box` 是否真实执行；没有执行就不能写验收通过。
- `$ds-scheduler` 是否只是 handoff，还是后续经用户确认执行。
- `交付文档/00-交付清单.md` 是否反映最新需求状态。
