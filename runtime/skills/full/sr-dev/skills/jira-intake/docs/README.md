# Jira Intake 使用说明

> 作者：owenzhang
> 模块 ID：`jira-intake`
> 展示名称：`Jira 入口`
> OpenAI Agent 名称：`Jira Intake`

## 1. 定位

`jira-intake` 是 `$dw-dev` 的 Jira 本地入口适配器，用于把 Atlassian Rovo 或 Jira REST 保存下来的 issue、评论、状态、流转和搜索结果整理成本地任务工作区产物。

推荐架构是 Rovo-first：

```text
@atlassian-rovo
  -> 读取 Jira / 执行用户已确认的 Jira 操作
  -> 保存或提供 JSON / 操作结果
  -> jira-intake 统计、分类、格式化、生成 artifact、记录 audit
  -> dw-dev parse / plan / route
```

`jira-intake` 可以单独使用，也可以被 `$dw-dev` 通过标准 artifact 编排。它不执行 SQL，不调用 `$sr-box-new`，不修改生产数仓资产。REST API token 模式只是 Rovo 不可用或无法完成任务时的兜底路径。

## 2. 配置

默认 Jira 站点是：

```bash
https://kylith.atlassian.net
```

默认 transport 是 Rovo/local-file，不需要 Jira API token：

```bash
export JIRA_TRANSPORT="rovo"
```

可选默认上下文：

```bash
export JIRA_BASE_URL="https://kylith.atlassian.net"
export JIRA_DEFAULT_PROJECT="DATA"
export JIRA_DEFAULT_BOARD_ID="789"
```

首次使用可以初始化本地 profile。Rovo 模式不要求 email/token：

```bash
python3 jira-intake/scripts/jira_intake.py config init \
  --transport rovo
```

如果需要 REST fallback，再初始化 email/token：

```bash
python3 jira-intake/scripts/jira_intake.py config init \
  --transport rest \
  --email name@example.com \
  --api-token "***"
```

也可以直接传完整看板地址，脚本会推断 base url、project 和 board id：

```bash
python3 jira-intake/scripts/jira_intake.py config init \
  --transport rovo \
  --jira-url "https://kylith.atlassian.net/jira/software/c/projects/DATA/boards/789"
```

常用配置命令：

```bash
python3 jira-intake/scripts/jira_intake.py config check
python3 jira-intake/scripts/jira_intake.py config check --require-rest
python3 jira-intake/scripts/jira_intake.py config show
python3 jira-intake/scripts/jira_intake.py config profiles
python3 jira-intake/scripts/jira_intake.py config use kylith
```

安全要求：

- token 只能来自环境变量、本地密钥或 `~/.codex/jira-intake/config.yaml`。
- token 不得写入 repo、ticket、Markdown、日志或 eval case。
- 默认 Rovo/local-file 路径缺少 `JIRA_EMAIL` 或 `JIRA_API_TOKEN` 不应阻断。
- 只有 REST fallback 需要联网调用时，才要求 `JIRA_EMAIL` 和 `JIRA_API_TOKEN`。

## 3. Rovo-first 直接使用

对 Rovo 保存的 Jira search JSON 做管理统计：

```bash
python3 jira-intake/scripts/jira_intake.py stats \
  --input tickets/rovo-jira-search.json \
  --group-by status,assignee,ownership_prefix,jira_category,country,business_domain,request_type \
  --output tickets/jira-stats.json
```

对已保存的 Jira issue 或 search JSON 做本地分类：

```bash
python3 jira-intake/scripts/jira_intake.py classify \
  --input tickets/rovo-jira-search.json \
  --output tickets/jira-classified.json
```

从 Rovo/Jira issue JSON 生成本地入口文件：

```bash
python3 jira-intake/scripts/jira_intake.py workspace-from-file \
  --input tickets/rovo-issue.json \
  --issue-key DATA-2048 \
  --output-dir tickets/DATA-2048
```

产物：

```text
tickets/DATA-2048/
  00-state.yaml
  00-requirement.md
  01-requirement.yaml
  06-evidence/
    jira-issue.json
  10-decision-trace.yaml
  11-map-summary.yaml
```

Rovo 完成用户明确确认的 Jira 操作后，记录本地审计 evidence：

```bash
python3 jira-intake/scripts/jira_intake.py audit-operation \
  --source-transport atlassian-rovo \
  --operation transition \
  --issue-key DATA-2048 \
  --before-status "待评审" \
  --after-status "开发中" \
  --transition-id 31 \
  --transition-name "开始开发" \
  --output tickets/DATA-2048/06-evidence/jira-rovo-transition-audit.json
```

## 4. 标题归属分类

创建、整理或回填 Jira 需求时，标题必须带可扫描的归属分类前缀：

```text
【数仓Agent】 Jira 入口编排能力
【数据开发】 多国 ads_due_grant_stat 回刷验证
【数据需求】 墨西哥营销看板取数
【基础建设】 调度权限与元数据治理
【底表迭代】 贷后还款宽表字段补充
```

规则：

- 如果用户已经给出 `【归属】`，保持原值，不覆盖。
- 如果用户没有给出，按标题、描述、components 和 labels 自动归纳。
- 常用归属包括 `数仓Agent`、`数据开发`、`数据需求`、`基础建设`、`底表迭代`。
- 无法判断时兜底为 `【数据需求】`，避免 Jira 列表里出现无归属标题。

相关产物：

- `classify` / `stats` 输出 `classification.ownership_prefix` 和 `classification.title_with_ownership`。
- `workspace-from-file` 写入 `01-requirement.yaml` 的 `ownership_prefix` 和 `title_with_ownership`。
- `11-map-summary.yaml` 默认展示带归属的标题，方便 `$dw-dev` 和 Jira 列表统一扫描。

## 5. 数据平台 Jira 工单分类

项目 `DATA` 的 `数据平台Jira工单分类` 是 Jira cascading select 字段，字段 key 为 `customfield_11541`。创建需求或补充 issue 字段时必须同时尽量填写一级和二级类目；如果用户没有显式给出，就按需求实际场景从标题、描述、components、labels、国家和业务对象中推断。

字段写入形态：

```json
{
  "customfield_11541": {
    "value": "宽表建设",
    "child": {"value": "营销主题宽表"}
  }
}
```

枚举来源是 Google Sheet `jira 工单分类 / 类目表` 的 `A:B`：

```text
https://docs.google.com/spreadsheets/d/1_1jzg0wUko-2XnNgm8Ftvlqxjr1yt7AI0QvAnbFTexs/edit?gid=0#gid=0
```

当前枚举：

| 一级类目 | 二级类目 |
|---|---|
| 业务需求 | 报表迭代/新增；指标需求；业务取数；数据分析支持；数据产品支持 |
| 数据同步需求 | 新数据源接入；离线同步；实时同步；接口 / API 同步；第三方 SaaS 数据同步；同步链路改造 |
| 数据中台建设 | 数据集成；数据质量；数据地图；数据权限；实时数据资产；数据服务 / API；监控告警；安全生产；架构设计 |
| 宽表建设 | 用户主题宽表；订单主题宽表；商品主题宽表；营销主题宽表；财务主题宽表；经营分析宽表；风控主题宽表 |
| 数据治理 | 指标口径治理；数据标准；表 / 字段命名规范；数据质量治理；数据资产治理；权限治理；生命周期治理；成本治理；安全合规治理 |
| 运维与稳定性 | 数据延迟处理；数据异常排查；告警优化；SLA 保障；性能优化；容量 / 资源治理；ds 调度平台融合；安全生产；监控告警；superset 优化；jupyterhub on k8s |
| 技术债与优化 | 架构重构；老任务下线；公共逻辑复用；脚本规范化；存储优化；计算资源优化 |
| 临时支持 | 查数导数；问题排查 |

样例：

| Issue | 场景 | 分类 |
|---|---|---|
| `DATA-2402` | 菲律宾/墨西哥/泰国营销主题宽表优惠券逻辑处理 | `宽表建设 / 营销主题宽表` |
| `DATA-2405` | 中国高内存占用 DS 调度排查与治理 | `运维与稳定性 / 容量 / 资源治理` |

`classify`、`stats`、`workspace-from-file` 和 `01-requirement.yaml` 会输出 `classification.jira_category` / `jira_category`，包含 `field_key`、`primary`、`secondary`、`field_value`、`source` 和 `confidence`。真实 Jira edit/create 仍必须由用户明确确认，优先通过 `@atlassian-rovo` 执行。

## 6. Jira 标题简洁规则

创建 Jira 需求时，`summary` 只放“归属 + 简短能力/功能/动作名”，不要把过程、背景、截止时间、设计细节或验收说明塞进标题。

推荐格式：

```text
【归属】 能力名
【归属】 功能动作
【归属】 业务对象 + 变更动作
```

示例：

```text
好：【数仓Agent】 知识上下文能力
好：【数仓Agent】 Jira 入口编排能力
好：【数据开发】 贷后宽表字段补充
差：【数仓Agent】 知识上下文能力开发，参考 dw-dev，补充设计文档，7月20前完成
```

写入位置建议：

| 信息 | 放置位置 |
|---|---|
| 简短能力/功能名 | Jira `summary` |
| 背景、范围、核心功能 | Jira `description` |
| 使用说明、设计文档 | Jira 附件或文档链接 |
| 当前状态、风险、截止时间 | Jira `description`、字段或评论 |
| 测试明细、过程日志 | 本地 evidence，不默认上传 Jira |

## 7. 状态变更资料约束

状态变更不是单独的“改字段”动作。变更前先检查目标状态需要的资料是否完整；缺资料时，先准备本地 plan 或补充 Jira description/comment/attachments，再执行 transition。

| 目标状态 | 变更前至少应具备 |
|---|---|
| `处理中` / `开发中` | 简洁标题、背景、范围、负责人、截止时间（如已知）、下一步交付物 |
| `待评审` | 设计或使用说明、实现摘要、评审目标、必要 evidence 路径 |
| `已评审` | 评审结论、接受的文档或附件、剩余风险、后续处理建议 |
| `完成` | 交付摘要、验证证据、最终文档或 Jira comment 草稿、未解决边界 |

执行规则：

- 优先使用 `@atlassian-rovo` 执行状态变更。
- `jira-intake` 负责检查资料、生成本地 operation plan、记录 before/after audit。
- 如果需要补充附件或评论，必须有用户明确确认；Rovo 无法上传附件时才使用 REST fallback。
- 不把测试明细、过程日志、临时草稿直接上传到 Jira；只上传设计文档、使用说明、交付摘要或必要证据。

## 8. REST fallback 使用

当 Rovo 无法读取或无法完成某个 Jira 动作时，才使用 REST fallback。

拉取单个 Jira issue，并生成本地入口文件：

```bash
python3 jira-intake/scripts/jira_intake.py fetch DATA-2048 \
  --include-comments \
  --output-dir tickets/DATA-2048
```

执行 JQL 查询，并保存原始结果：

```bash
python3 jira-intake/scripts/jira_intake.py search \
  --jql 'project = DATA AND statusCategory != Done ORDER BY updated DESC' \
  --max-results 50 \
  --output tickets/jira-search.json
```

执行 JQL 查询，并输出按状态、负责人、国家、业务域和需求类型等维度聚合的管理统计：

```bash
python3 jira-intake/scripts/jira_intake.py stats \
  --jql 'project = DATA AND statusCategory != Done ORDER BY updated DESC' \
  --max-results 50 \
  --group-by status,assignee,ownership_prefix,jira_category,country,business_domain,request_type \
  --output tickets/jira-stats.json
```

读取某个 issue 当前可用状态流转：

```bash
python3 jira-intake/scripts/jira_intake.py transitions DATA-2048 \
  --output tickets/DATA-2048/06-evidence/jira-transitions.json
```

## 9. 与 `$dw-dev` 交接

`jira-intake` 生成入口产物后，后续解析、补问和任务规划交给 `$dw-dev`：

交接边界：

- `jira-intake` 负责 Jira 输入归一化、统计分类、本地入口 artifact、操作计划和操作审计。
- `$dw-dev` 负责数仓开发任务的上下文整理、补问和下游协作请求。
- `$dw-knowledge` 负责后续知识上下文、query spec 和补问材料。
- 开发验证交给 `$sr-box`；日常查询按项目指引可使用 `$sr-box-new`。

## 10. 写回规则

默认只生成本地计划，不执行 Jira 写操作。Jira 写操作优先让 `@atlassian-rovo` 执行；`jira-intake` 负责生成 plan 和记录 audit。

只生成 Jira comment 写回计划：

```bash
python3 jira-intake/scripts/jira_intake.py comment-plan DATA-2048 \
  --body-file tickets/DATA-2048/09-jira-comment.md \
  --output tickets/DATA-2048/06-evidence/jira-comment-plan.json
```

只生成状态流转计划：

```bash
python3 jira-intake/scripts/jira_intake.py transition-plan DATA-2048 \
  --transition-id 31 \
  --output tickets/DATA-2048/06-evidence/jira-transition-plan.json
```

REST fallback 允许执行写操作的唯一方式是用户明确确认目标 issue 和正文后，再运行带 `--confirm` 的命令：

```bash
python3 jira-intake/scripts/jira_intake.py add-comment DATA-2048 \
  --body-file tickets/DATA-2048/09-jira-comment.md \
  --confirm
```

```bash
python3 jira-intake/scripts/jira_intake.py transition DATA-2048 \
  --transition-id 31 \
  --output tickets/DATA-2048/06-evidence/jira-transition-result.json \
  --confirm
```

没有 `--confirm` 时，写操作会拒绝执行。带 `--output` 的 REST 状态流转会先读取 issue、校验 transition 是否可用，执行后再次读取 issue，并把 before/after 状态写入本地 evidence。

## 11. 模块文档

| 模块名 | 文档 | 用途 |
|---|---|---|
| `jira-intake-skill` | `docs/modules/01-skill-entry.md` | Skill 入口、直接模式和 Agent 编排模式 |
| `jira-intake-pack` | `docs/modules/02-pack-manifest.md` | pack 元数据、能力声明和边界 |
| `jira-intake-openai-agent` | `docs/modules/03-openai-agent.md` | `agents/openai.yaml` 的名称和触发说明 |
| `jira-intake-cli` | `docs/modules/04-cli-runtime.md` | CLI 命令、输入输出和安全闸口 |
| `jira-intake-api-contract` | `docs/modules/05-api-contract.md` | Rovo-first transport、REST fallback endpoint、字段和写回约束 |
| `jira-intake-tests` | `docs/modules/06-tests.md` | 测试覆盖范围和运行方式 |

## 12. 验证

本模块最小验证命令：

```bash
python3 -m unittest jira-intake/scripts/test_jira_intake.py -v
```

文档变更后建议同时执行：

```bash
git diff --check -- jira-intake
```
