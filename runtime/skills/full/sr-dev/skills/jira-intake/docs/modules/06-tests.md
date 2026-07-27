# 模块：jira-intake-tests

> 名称：`jira-intake-tests`
> 文件：`jira-intake/scripts/test_jira_intake.py`
> 测试命令：`python3 -m unittest jira-intake/scripts/test_jira_intake.py -v`

## 1. 用途

`jira-intake-tests` 覆盖 `jira-intake` 的本地转换、安全计划、Rovo 默认配置、Rovo/Jira payload 归一化、统计分类、transition 审计和 `$dw-dev` 主控 artifact 能力，不依赖真实 Jira 网络。

当前重点验证：

- Jira ADF 描述和评论能转为可读文本。
- issue 原始字段能映射为本地 record。
- `00-requirement.md` 包含 Jira 来源、key 和评论。
- `01-requirement.yaml` 保留 `source=jira` 和 `jira.issue_key`。
- `06-evidence/jira-issue.json` 能写入 evidence。
- `00-state.yaml`、`10-decision-trace.yaml`、`11-map-summary.yaml` 能写入主控可消费产物。
- mutation 类操作会生成 `requires_confirmation=true` 的本地 operation plan。
- Jira URL 能推导默认 base URL 和 profile。
- 本地 profile、环境变量和默认值按预期合并，缺少凭证时停止在网络调用前。
- 默认 `transport=rovo` 不要求 `JIRA_EMAIL` 或 `JIRA_API_TOKEN`。
- REST fallback 单独通过 `validate_rest_config` 要求 email/token。
- Rovo search payload 能归一化为 REST-like search 结构并用于统计。
- Rovo issue payload 能生成 DW Dev 工作区 artifact。
- Rovo 操作结果能生成不含 token 的 before/after audit evidence。
- 单个 Jira issue JSON 仍保持单 issue classify 输出形状，避免旧用法回归。
- 已有 `数据平台Jira工单分类` cascading field 会保留为 `jira_category.source=jira_field`。
- `DATA-2405` 这类 DS 高内存/资源治理需求会推断为 `运维与稳定性 / 容量 / 资源治理`。
- JQL 搜索结果能输出状态、负责人、优先级、组件、标签、标题归属、Jira 分类、国家、业务域和需求类型统计。
- issue 文本能进行国家、业务域和需求类型分类。
- transition 执行可记录 before/after snapshot、transition id/name 和确认标记。

## 2. 运行方式

```bash
python3 -m unittest jira-intake/scripts/test_jira_intake.py -v
```

## 3. 适合新增的测试

后续扩展 Jira API 能力时，优先新增这些测试：

- `add-comment` 缺少 `--confirm` 时拒绝执行。
- `transition` 缺少 `--confirm` 时拒绝执行。
- `workspace-from-file` 对多 issue 输入必须要求 `--issue-key`。
- `audit-operation` 输出不得包含 token、cookie 或 authorization 字段。
- JQL `max_results` 有默认上限。
- 401、403、404、429 错误能归类并保留 evidence。
- Jira Cloud 分页 `nextPageToken` 或 `startAt` 兼容策略。
- Rovo search `pageInfo.hasNextPage` 与 REST `isLast` 的边界转换。
- 不同项目自定义字段的分类 fallback。

## 4. 不覆盖的内容

当前测试不证明：

- 真实 Jira API 可访问。
- `@atlassian-rovo` 插件在当前会话可用。
- 用户账号具备 Jira 权限。
- 写回 Jira 已成功。
- `$dw-dev` 对真实需求的业务结论正确。
- SR 查询或生产数据正确性。

这些需要分别由 Jira smoke、`dw-dev` 流程测试和 `$sr-box` evidence 验证。
