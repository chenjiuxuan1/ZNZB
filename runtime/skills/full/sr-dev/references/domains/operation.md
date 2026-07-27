---
domain: operation
display_name: 运营分析
owner: owenzhang
last_updated: 2026-06-10
status: active
source_tier: governed_ref
---

# 运营分析

## 1. 业务背景

运营分析覆盖活动、实验、转化、留存、用户行为和业务漏斗。P0 重点支持 `operation.ab_experiment_effect`，用于 AB 实验效果分析和 Jira DATA-2048 类型需求。

本文件是 governed reference。当前 AB 实验效果 seed 的物理 canonical table 仍为 `unknown`，因此不能直接生成可执行 SQL，必须先确认实验 ID、国家、时间窗口、实验分组、转化事件和样本口径。

## 2. 核心实体和粒度

| 实体 | 推荐粒度 | 说明 |
|---|---|---|
| 实验 | `experiment_id` | 必须明确实验 ID 或实验名称 |
| 用户 | `user_id` | 常用于实验组和对照组去重 |
| 曝光 / 分桶 | `experiment_id + user_id` | 需确认用户是否可能跨组 |
| 转化事件 | `event_id` / `user_id + event_time` | 需确认转化窗口和事件定义 |

## 3. 标准过滤

- 默认排除测试、内部和压测账号：`exclude_test_account`。
- 排除实验前已完成目标行为的用户，除非业务另有说明。
- 明确实验起止时间和转化观察窗口。
- 国家和 datasource 必须明确，不允许跨国家混算后直接输出结论。

## 4. 关键维度

| 概念 | 候选字段 | 说明 |
|---|---|---|
| 国家 | `country` / `country_code` | 必须与 SR datasource 一致 |
| 时间 | `event_time` / `dt` | 区分事件时间和分区时间 |
| 实验组 | `experiment_group` / `variant` | 需要确认 treatment/control 枚举 |
| 渠道 | `channel` / `source` | 与投放分析联动时需确认来源 |

## 5. 关键表

### `unresolved:operation.ab_experiment_effect`

- 粒度：实验用户或实验事件，待确认。
- 覆盖范围：AB 实验效果 seed 的 draft 物理资产占位。
- 何时使用：只能在需求方或数据 owner 确认真实表、字段、分桶逻辑后使用。
- 何时不要使用：实验 ID、国家、时间窗口、分组字段或转化事件缺失时。
- Join key：待确认，常见为 `experiment_id + user_id`。
- 时间字段：待确认，常见为 `event_time` 和 `dt`。
- 更新频率：待确认，执行前必须检查最新分区或事件延迟。
- Owner：owenzhang / operation data owner 待最终确认。

## 6. 常见坑点

1. 曝光人数、独立用户数、转化事件数不能混作同一分母。
2. 用户跨组、重复曝光和延迟转化会影响实验结论。
3. AB 实验通常至少是 medium risk，结论需保留置信度和局限。
4. 未确认实验 ID 或转化事件时必须补问。
5. 当前 physical asset unresolved，禁止直接交给 SQL reviewer 执行。

## 7. 常见分析模式

- AB 实验：确认实验 ID、国家、时间窗口、分组字段、转化事件和输出形式。
- 漏斗分析：先定义每一步事件，再确认用户粒度和时间窗口。
- 活动效果：先区分曝光、点击、申请、放款、留存等指标层级。

## 8. 交叉引用

- 语义层：`semantic-layer/metrics/operation/ab_experiment_effect.yaml`
- 标准维度：`semantic-layer/dimensions/country.yaml`、`semantic-layer/dimensions/time.yaml`
- 标准过滤：`semantic-layer/segments/exclude_test_account.yaml`
- 风控分析：`references/domains/risk.md`
- 投放分析：`references/domains/marketing.md`
