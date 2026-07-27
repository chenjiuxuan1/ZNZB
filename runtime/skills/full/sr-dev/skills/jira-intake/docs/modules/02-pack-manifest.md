# 模块：jira-intake-pack

> 名称：`jira-intake-pack`
> 文件：`jira-intake/pack.yaml`
> 展示名称：`Jira 入口`

## 1. 用途

`pack.yaml` 是 `jira-intake` 的机器可读模块说明。它告诉 `$dw-dev` 和当前 skill pack：

- 模块 ID 是 `jira-intake`。
- 用户看到的中文名称是 `Jira 入口`。
- 模块类别是 `intake`。
- 模块可在默认 Rovo/local-file 模式下独立使用。
- 模块也可以通过 `$dw-dev -> jira-intake` 被编排。
- 对主 Agent 的影响是 `artifact-contract-only`。
- REST API token 只属于 fallback 配置，不是默认安装必需条件。
- 模块可输出 `数据平台Jira工单分类`（`customfield_11541`）保留/推断结果，供受控 Jira create/edit plan 使用。

## 2. 使用方式

这个文件不直接执行。它被索引、展示或安装流程读取，用于生成模块卡片、能力说明和边界说明。

典型读取者：

- `$dw-dev` 入口说明页。
- Skill pack 安装或发现逻辑。
- 架构控制面里的模块边界审查。

## 3. 能力声明

`provides` 当前声明：

- `jira-issue-fetch`
- `jira-rovo-normalization`
- `jira-search-stats`
- `jira-issue-classification`
- `jira-category-inference`
- `jira-status-read`
- `jira-transition-read`
- `jira-transition-audit`
- `jira-rovo-operation-audit`
- `jira-operation-plan`
- `jira-rest-fallback`

`does_not_provide` 当前声明：

- `sql-execution`
- `automatic-jira-writeback`
- `required-rest-token-default`
- `production-warehouse-change`

## 4. 维护规则

如果新增真实能力，先更新运行时代码和测试，再更新 `provides`。

如果新增或放开写回能力，必须同步更新：

- `jira-intake/SKILL.md`
- `jira-intake/docs/README.md`
- `jira-intake/references/jira-api-contract.md`
- 架构控制面的 Jira 和对外交付边界

不得只改 `pack.yaml` 就宣称能力完成。
