---
domain: marketing
display_name: 投放分析
owner: owenzhang
last_updated: 2026-06-10
status: active
source_tier: governed_ref
---

# 投放分析

## 1. 业务背景

投放分析覆盖渠道花费、归因、CPA、ROI、渠道异常和平台账单对账。P0 重点支持 `marketing.channel_cost`，用于墨西哥 smartconnect 投放花费异常这类需求。

本文件是 governed reference。当前渠道花费 seed 的物理 canonical table 仍为 `unknown`，因此只能作为补问和上下文依据，不能直接生成可执行 SQL。

## 2. 核心实体和粒度

| 实体 | 推荐粒度 | 说明 |
|---|---|---|
| 渠道 | `channel` / `media_source` | 需确认平台、渠道名和归因口径 |
| 账单日期 | `cost_date` | 可能与事件日、安装日、分区日不同 |
| 国家 | `country` | 投放费用通常按国家或市场拆分 |
| 结算来源 | `settlement_source` | 平台账单、ADS、BI 展示口径可能不同 |

## 3. 标准过滤

- 默认排除测试、内部和压测账号：`exclude_test_account`。
- 明确国家、渠道、时间窗口、币种和结算来源。
- 花费类指标必须确认金额单位和汇率来源。
- 当天或近实时账单可能回补，需检查 freshness。

## 4. 关键维度

| 概念 | 候选字段 | 说明 |
|---|---|---|
| 国家 | `country` / `country_code` | 必须与 datasource 一致 |
| 时间 | `cost_date` / `dt` | 区分账单日期和分区日期 |
| 渠道 | `channel` / `media_source` / `campaign` | 异常归因常需要多层级拆分 |
| 币种 | `currency` | 汇总前需统一币种 |

## 5. 关键表

### `unresolved:marketing.channel_cost`

- 粒度：渠道 + 日期 + 国家，待确认。
- 覆盖范围：channel cost seed 的 draft 物理资产占位。
- 何时使用：只能在确认真实结算表、字段、币种和更新频率后使用。
- 何时不要使用：国家、渠道、结算来源、金额单位或 freshness 缺失时。
- Join key：待确认，常见为 `channel + cost_date + country`。
- 时间字段：待确认，常见为 `cost_date` 和 `dt`。
- 更新频率：待确认，近实时或 T+1 回补需单独说明。
- Owner：owenzhang / marketing data owner 待最终确认。

## 6. 常见坑点

1. BI 展示口径、ADS 聚合口径和平台结算口径可能不一致。
2. 金额可能是本币、美元或最小货币单位，必须确认单位和汇率。
3. smartconnect 等渠道名可能存在大小写、别名或映射表。
4. 当天账单可能回补，不能在 freshness 未确认时输出强结论。
5. 未确认物理表前，不得编造 table name。

## 7. 常见分析模式

- 渠道花费异常：先确认渠道、国家、时间窗口、币种和结算来源，再比较不同口径。
- CPA 分析：同时需要花费和转化/放款口径，必须明确分母。
- 投放趋势：先按日粒度检查整体，再下钻渠道、campaign 和结算来源。

## 8. 交叉引用

- 语义层：`semantic-layer/metrics/marketing/channel_cost.yaml`
- 标准维度：`semantic-layer/dimensions/country.yaml`、`semantic-layer/dimensions/time.yaml`
- 标准过滤：`semantic-layer/segments/exclude_test_account.yaml`
- 风控分析：`references/domains/risk.md`
- 运营分析：`references/domains/operation.md`
