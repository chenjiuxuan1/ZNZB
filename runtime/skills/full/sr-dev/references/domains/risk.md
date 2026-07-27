---
domain: risk
display_name: 风控分析
owner: owenzhang
last_updated: 2026-06-10
status: active
source_tier: governed_ref
---

# 风控分析

## 1. 业务背景

风控分析覆盖授信、放款、还款、逾期、催回和风控策略效果。P0 重点支持 `risk.d7_overdue_rate`，用于巴铁 D7 逾期率、部分还款修正和指标修复验证类需求。

本文件是 governed reference，不替代 `semantic-layer/metrics/risk/d7_overdue_rate.yaml`。历史 SQL、需求文档和人工经验只能作为材料，真实执行前必须核验国家、datasource、字段、单位、分区和 owner。

## 2. 核心实体和粒度

| 实体 | 推荐粒度 | 说明 |
|---|---|---|
| 用户 | `user_id` | 跨产品或跨期统计时需确认是否去重 |
| 借据 / 放款单 | `loan_id` / `order_id` | D7 指标常以放款单为基础粒度 |
| 还款事件 | `repay_id` / `loan_id + repay_time` | 部分还款和结清时间会影响逾期判断 |
| 分区 | `dt` | 用于 freshness，不等同于业务发生日 |

## 3. 标准过滤

- 默认排除测试、内部和压测账号：`exclude_test_account`。
- 排除取消、作废或无效放款状态。
- 国家必须与 `$sr-box-new` 路由和 datasource 一致。
- 时间窗口必须区分放款日、应还日、还款日和分区日。

## 4. 关键维度

| 概念 | 候选字段 | 说明 |
|---|---|---|
| 国家 | `country` / `country_code` | 使用前核验枚举和值域 |
| 时间 | `loan_date` / `due_date` / `repay_time` / `dt` | D7 默认关注放款后 7 天表现 |
| 产品 | `product_id` / `product_type` | 跨产品汇总需确认是否可合并 |
| 逾期天数 | `overdue_days` | 需确认是否按自然日、账龄或系统快照计算 |

## 5. 关键表

### `risk_dw.dws_repay_detail_di`

- 粒度：候选还款/借据明细，使用前核验。
- 覆盖范围：D7 逾期率种子中的 draft canonical table。
- 何时使用：需要计算放款金额、逾期金额、逾期天数时。
- 何时不要使用：字段、金额单位、分区或部分还款逻辑未核验时。
- Join key：`loan_id` / `order_id`，以实际表结构为准。
- 时间字段：`loan_date`、`dt`，以实际表结构为准。
- 更新频率：默认 T+1，执行前必须 `max(dt)` 检查。
- Owner：owenzhang / risk data owner 待最终确认。

## 6. 常见坑点

1. 金额字段可能以分、元或本币最小单位存储，输出前必须确认换算。
2. 部分还款会影响逾期金额和分母，不能只看还款状态。
3. `dt` 是分区日期，不一定是放款日或还款日。
4. 不同国家的逾期定义、宽限期和账龄规则可能不同。
5. 历史修复 SQL 只能作为参考，不能越过 semantic-layer 和 reviewer。

## 7. 常见分析模式

- D7 指标修复验证：先确认国家、时间窗口、金额单位、部分还款规则，再生成 `testdb` 验证计划。
- 趋势分析：按自然日或放款日聚合，必须说明数据新鲜度。
- 异常归因：先比较分子、分母、过滤条件，再检查上游分区和口径变化。

## 8. 交叉引用

- 语义层：`semantic-layer/metrics/risk/d7_overdue_rate.yaml`
- 标准维度：`semantic-layer/dimensions/country.yaml`、`semantic-layer/dimensions/time.yaml`
- 标准过滤：`semantic-layer/segments/exclude_test_account.yaml`
- 运营分析：`references/domains/operation.md`
- 投放分析：`references/domains/marketing.md`
