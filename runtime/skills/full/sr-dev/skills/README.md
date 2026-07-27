# SR Dev Skills 介绍清单

> 作者：owenzhang
> 日期：2026-07-09
> 目标：说明 `sr-dev/skills` 中当前精简 skill 的定位、边界和维护入口。

## Source Of Truth

`sr-dev/skills/<skill-name>/` 是当前唯一维护目录。根目录 `skills` 是兼容 symlink，不再保存独立副本。

## Included Skills

| Skill 目录 | Skill 名称 | 定位 | 边界 |
|---|---|---|---|
| `ds-schedule-manager` | `$ds-schedule-manager` | DS 元数据查询、上线核查、运行态诊断和安全操作计划 | DS SQL 固定走 `$sr-box` production；DS 变更必须用户确认 |
| `ds-scheduler` | `$ds-scheduler` | DolphinScheduler workflow、schedule、task、log 和受控操作 API executor | 变更操作必须有 token readiness 和用户确认 |
| `jira-intake` | `$jira-intake` | Jira/Rovo 输入归一化和本地需求工件 | 不默认回写 Jira，不执行 SQL |
| `sr-box-new` | `$sr-box-new` | legacy token-era / 日常查询兼容入口 | 开发验证优先交给 `$sr-box` |
| `sr_box` | `$sr-box` | production SR Box 查询、SSO 和 `testdb` 写保护入口 | 不用于本地 `127.0.0.1:4888` 调试 |
| `dw-dev` | `$dw-dev` | 数仓开发轻量编排、上下文优先级、参考资料附录和协作请求 | 不修改被调用组件，不默认审查/交付/Jira 写回 |
| `dw-knowledge-init` | `$dw-knowledge-init` | Warehouse Knowledge Pack 文档、manifest 和版本初始化 | 仅用于知识源维护 |
| `dw-modeling` | `$dw-modeling` | 数仓需求拆解、模型设计、知识缺口、重复资产和输出路由 | 不写最终 SQL package，不执行 SQL |
| `dw-sql-builder` | `$dw-sql-builder` | 数仓 SQL 编写、SQL 优化、正式上线版和 testdb SQL package | 不执行 SQL，不替代建模决策 |
| `dw-code-knowledge` | `$dw-code-knowledge` | 授权查看生产仓库 Git 代码、ETL SQL 和 workflow 脚本 | 不执行 SQL，不管理 Git source |
| `dw-knowledge` | `$dw-knowledge` | 数仓语义上下文、文档知识、query spec 和补问材料 | 不执行 SQL，不臆造口径 |

## Selection

| 需求 | 首选 |
|---|---|
| 从 Jira/Rovo 开始整理需求 | `$jira-intake` |
| 做数仓开发编排、上下文附录、建模/SQL/SR/DS 协作请求 | `$dw-dev` |
| 做模型设计、需求拆解、缺口和重复资产判断 | `$dw-modeling` |
| 根据已确认建模方案写 SQL、优化 SQL 或生成 SQL package | `$dw-sql-builder` |
| 做知识上下文和 query spec | `$dw-knowledge` |
| 查看 ETL SQL、workflow 脚本或代码出处 | `$dw-code-knowledge` |
| 执行 `testdb` 验证或 production 只读检查 | `$sr-box` |
| 日常兼容查询 | `$sr-box-new` |
| 查 DS 调度、上线状态、最新实例、任务日志路径 | `$ds-schedule-manager` |
| 执行 DS API 查询或受控变更 | `$ds-scheduler` |

## Validation

```bash
python3 /Users/admin/.codex/skills/.system/skill-creator/scripts/quick_validate.py /Users/admin/Documents/sr_skills/sr-dev/skills/<skill-name>
```
