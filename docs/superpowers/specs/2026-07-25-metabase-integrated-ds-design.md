# Metabase 集成 DS 巡检设计

## 目标

- 解决内部“每小时监控”看板长期停留在待发现且错误原因不可见的问题。
- DS 页面只负责项目配置和只读测试，不再拥有独立定时任务与通知配置。
- Metabase 定时巡检增加全局 DS 开关；开启后巡检全部已匹配项目的国家。
- DS 完全复用 Metabase 的通知渠道、KN Chat Bot Token、接收人和群聊配置。

## 每小时看板发现

- 看板页面提供按当前国家执行的“重新发现看板”操作。
- 服务端调用现有 panel source discovery，将成功结果合并进国家 inventory。
- 返回发现数量、可执行看板数量、执行时间和错误。
- 页面显示最后发现结果；认证缺失、401、网络错误必须可见。
- Metabase 手动和定时巡检仍在执行前自动发现。
- 待发现看板不参与卡片计数和规则执行。
- 左侧看板行使用可收缩文本区和固定状态区，避免徽标越界。

## DS 页面

保留项目名称、Token 高级配置、执行测试、最近测试结果。删除定时配置、独立通知配置、通知预览和发送测试。项目码继续只作为服务端内部字段。

DS 页面测试调用现有只读 DS 检查接口，不发送消息、不写入 Metabase 定时历史。

## Metabase 定时巡检集成

- 在 batch schedule 增加 `includeDsScheduler: boolean`，默认 `false`。
- Metabase 定时配置页面提供全局“同时执行 DS 调度巡检”开关。
- 定时任务开启后，在 Metabase 国家巡检完成后执行一次 DS 全国家检查。
- DS 检查仅包含项目名称已解析且 Token 已配置的国家。
- 使用 Metabase 当前 schedule/rules 生成的有效 `alerts` 发送 DS 通知。
- DS 结果写入同一次 batch history 的 `dsSchedulerSummary`。
- DS 失败不丢失 Metabase 结果，batch 状态标记为部分失败并记录错误。
- 手动“定时巡检测试”也遵循该开关；普通 Metabase 单看板手动扫描不自动执行 DS。

## 兼容

旧 DS schedule/notification 文件保留但不再由计时器和页面使用。服务端旧 API 暂时保留，避免外部调用立即失败。

## 验收

- 每小时看板可主动发现，失败原因清晰。
- 看板行状态不溢出。
- DS 页面不存在定时或通知配置。
- Metabase 定时页面存在一个全局 DS 开关。
- 开启后 batch history 包含 DS 结果且通知复用 Metabase 配置。
- 关闭后不调用 DS。
- 全量测试及浏览器验收通过。
