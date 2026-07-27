# Warehouse Modeling 使用说明

> 作者：owenzhang
> 模块 ID：`dw-modeling`
> 展示名称：`数仓建模决策能力`

## 定位

`$dw-modeling` 用于数仓需求拆解、模型设计、知识缺口确认、重复资产判断和输出路由。它不再负责最终 SQL package，也不执行 SQL。

典型问题：

- 这个需求应该建 DWD、DWB/DWS、ADS 还是复用已有表？
- 小时更新需要哪些源表、SLA、分区和补数知识？
- 现有表或 ETL 是否已经覆盖，是否重复建设？
- 缺少哪些业务口径、字段含义、owner 或调度事实，需要先问用户？
- 后续应该交给 `$dw-sql-builder` 写 SQL，还是交给 `$dw-dev` 做完整 testdb 开发闭环？

## 核心协作

```text
dw-modeling
  -> $dw-knowledge       # 业务口径、语义上下文、补问材料
  -> $dw-code-knowledge  # 现有 ETL、workflow、表构建和重复资产证据
  -> $dw-standards       # 分层、命名、表设计、安全和上线前规范
  -> $dw-sql-builder  # 已确认方案后的 SQL 编写和 SQL package
  -> $dw-dev      # testdb 验证、sr-box evidence、上线/回滚草稿
```

## 输出

推荐写入中文目录：

- `开发计划/01-建模决策.md`
- `开发计划/02-知识缺口与阻断项.md`
- `开发计划/03-重复资产与复用判定.md`
- `协作请求/dw-sql-builder-请求.yaml`
- `协作请求/dw-dev-请求.yaml`

## 小时更新检查

遇到小时更新需求时，必须先确认：

- 使用业务时间、入仓时间还是快照时间。
- 上游是否小时级更新，是否有延迟到数。
- 需要新小时表，还是扩展已有日表。
- 分区是 `dt + hour`、时间戳范围，还是其他策略。
- 是否需要历史回刷、补数、幂等和重跑边界。
- DS 调度和上游依赖是否已存在。
- 是否已有同主题小时表可复用。

缺失这些知识时，输出阻断项，不要猜测。

## 元数据扫描计划

如需 live metadata evidence，先生成 `$sr-box` 只读查询计划：

```bash
python3 skills/dw-modeling/scripts/metadata_collector.py \
  --countries cn,th,mx,ph,pk,id \
  --domain fox \
  --output-dir tickets/DATA-3001
```

该命令只生成计划，不执行 SQL。

## 边界

- 不执行 SQL。
- 不生成最终 SQL package；SQL 落地交给 `$dw-sql-builder`。
- 不宣称模型已验证，除非已有真实 `$sr-box` evidence。
- 不绕过 `$dw-standards`。
- 不自动做生产 DDL/DML、DS 变更、回刷、上线或 Jira 写回。
