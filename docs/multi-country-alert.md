# 多国一致性校验告警（multi-country alert）

## 概述

在 6 个国家（中国/印尼/墨西哥/泰国/菲律宾/巴基斯坦）对资产宽表与资产期次宽表做交叉一致性校验，
发现数据不一致（`mismatch_cnt > 0`）时，同时通过 **TV 告警** 和 **KN Chat 私信** 通知。

## 执行架构（sr-box 网关 token 模式）

- 用户无法提供各国 StarRocks 直连信息，因此**通过 Fuxi SR 网关**执行校验 SQL（Bearer token + country route）。
- 网关地址（n8n 服务器内网可达）：`http://172.20.0.234:4888`
- 外部可达地址（Codex 环境）：`https://data-map-dev.kuainiu.io`
- Token：`fuxi_backend_query_all_20260518`（生产查询 token）
- API：`POST /api/rust/v1/sr-sandboxes/sql-executions`
  - body: `{"taskName":"mc-<cc>","country":"<cc>","purpose":"agent","accessMode":"local","sqlMode":"query","sql":"...","page":1,"pageSize":100,"timeoutSec":120}`
  - header: `Authorization: Bearer <token>`

## n8n 工作流

- 名称：`多国一致性校验告警`（n8n workflow id `E4B4wNzcUG0ow6BL`，已激活）
- 触发：Webhook `POST https://sql-cn.kuainiujinke.com/webhook/znzb-mc-verify-v4`
- 节点：`Webhook → 6国校验(Code) → 是否有异常(IF) → [有异常] 发送KN聊天 → 发送TV`；无异常走 `无异常结束`
- 校验逻辑：单个 Code 节点串行调网关 6 国（避免 n8n 并行分支 `$()` 跨节点引用问题），
  解析 `data.rows` 中 `mismatch_cnt > 0` 的项，构造告警文本，仅在有异常时发送。

## 校验 SQL

- 资产宽表交叉校验（asset_info_field_cross_check），作者 owenzhang。
- **分版本**：
  - 巴基斯坦（pk）：完整版，含 `asset_source_flag`（PAK007导流排除），`dwb.dwb_asset_info` 该字段只存在于巴基斯坦。
  - 其它 5 国（cn/id/mx/th/ph）：通用版，去掉 `asset_source_flag` 过滤（否则报列不存在）。
- 返回：`check_item, mismatch_cnt`，每行一个检查项；全部为 0 时通过。
- 已验证（2026-09-02）：
  | 国家 | 结果 |
  |------|------|
  | 中国 cn | ✅ 21 项全通过 |
  | 印尼 id | 🔴 repaid_fee_amt 异常 298 |
  | 墨西哥 mx | ✅ 全通过 |
  | 泰国 th | ✅ 全通过 |
  | 菲律宾 ph | ✅ 全通过 |
  | 巴基斯坦 pk | 🔴 7 项异常（first_* + repaid_*） |

## 通知通道

- **KN Chat**：数仓告警机器人 `Data_Warehouse_Alarm_Robot`
  - token: `1571271993:yL4eDfbVkYzp5WWTalPSY1cahU4fZuHvsOV`
  - API: `POST https://bot.kn.chat/bot<TOKEN>/sendMessage` `{"chat_id":-10950,"text":"..."}`
  - 目标群：**PL告警测试群 chat_id=-10950**（所有测试消息默认发这里，见 knchat_sender.py `DEFAULT_TEST_CHAT_ID`）
- **TV**：`POST https://tv-service-alert.kuainiu.chat/alert/v2/array`
  - body: `{"botId":"f82292a5-45c5-42ea-84da-272b4c81ebcc","message":"...","mentions":["adamyu@kn.group"]}`

## 平台告警注册条目

- 6 国条目：`mc_cn / mc_id / mc_mx / mc_th / mc_ph / mc_pk`（config/alert-registry*.json）
- 默认 `enabled=false`，命令带 `--dry-run`，knchat 目标 PL告警测试群。
- 提示：实际生产执行已由 n8n 工作流承载（见上），平台条目的脚本方式可作为备份/参考。

## 待办

- [ ] 电话告警（夜莺 ali-voice）：脚本校验异常 → 推送事件到夜莺 → ali-voice 规则电话。接收人待用户提供。
- [ ] 印尼 298 条 repaid_fee_amt 异常、巴基斯坦 7 项异常：数据侧需排查修复。
- [ ] 确认是否部署 6 国平台条目到生产并启用。
