# 上线计划草稿模板

> 生产变更需要人工确认；本模板不自动执行 DS、DDL 或 DML。

## 前置条件

- SQL review 通过。
- Safety review 通过。
- Answer review 通过。
- testdb 验证证据、freshness 和 trace id 已归档。

## 建议步骤

1. 人工复核验证证据。
2. 在正式变更系统补齐生产变更单。
3. 发布后重新运行只读校验并归档证据。
