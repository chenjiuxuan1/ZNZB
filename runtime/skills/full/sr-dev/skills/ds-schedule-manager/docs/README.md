# DS Schedule Manager 文档目录

> 作者：owenzhang
> 模块 ID：`ds-schedule-manager`

- [ARCHITECTURE.md](ARCHITECTURE.md)：DS 调度管理 skill 的架构、调用关系、证据来源和阻断规则。

运行时工具：

- `scripts/ds_token_manager.py`：导入、更新、查看或删除六国私有默认 token，不回显 token。
- `scripts/ds_scheduler_with_default_token.py`：仅在调用方未提供 token 时读取 manager 默认配置，并生成 `0600` 私有 ds-scheduler 请求文件。
- `scripts/ds_release_backfill_plan.py`：读取 YAML/JSON，输出生产发布与历史补数的确定性计划；不执行 SQL、不调用 DS API、不读取 token 或 secret。

详细查询模板和操作案例仍放在 `references/` 下：

- `references/metadata-query-playbook.md`
- `references/operation-playbook.md`
- `references/production-release-backfill-playbook.md`
- `references/ds-schedule-test-checklist.md`
- `references/live-validation-2026-07-08.md`
