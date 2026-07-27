# 数仓知识库 使用说明

> 作者：owenzhang
> 模块 ID：`dw-knowledge`
> 展示名称：`数仓知识库`

`dw-knowledge` 用于把 DW Dev 需求转成可审查的语义上下文、reference context、远程文档知识上下文、query spec 或 clarification。它只处理文档、知识库和语义上下文，不提供代码查看能力。

当前模块是生产版，默认读取 `https://data-map-dev.kuainiu.io`。本地 `127.0.0.1:4888` 开发调试使用 `$dw-knowledge-dev`。

## 能力

- 架构与调用关系说明见 [ARCHITECTURE.md](ARCHITECTURE.md)。
- 从 semantic-layer 匹配指标、别名、canonical table。
- 从 references/domains 补充领域说明。
- 读取 SR Box 文档管理中的 Git-backed 知识库目录、版本、搜索结果和文件正文。
- 调用封装知识库检索相似/语义参考知识。
- 输出 `04-context.md`、query spec 或 `02-clarification.md`。
- 用户需要查看 ETL SQL、workflow、代码逻辑或代码出处时，协调 `$dw-code-knowledge`；如果未安装，提示：`没有查看代码权限：未安装 dw-code-knowledge，无法查询数仓代码库。`

## Helper

```bash
python3 skills/dw-knowledge/scripts/build_context.py \
  tickets/DATA-2048/01-requirement.yaml \
  --context-output tickets/DATA-2048/04-context.md \
  --query-spec-output tickets/DATA-2048/query-spec.yaml \
  --clarification-output tickets/DATA-2048/02-clarification.md

python3 skills/dw-knowledge/scripts/fetch_remote_knowledge.py \
  --profile prod \
  --operation git-search \
  --query "fox DWB 宽表" \
  --domain fox

python3 skills/dw-knowledge/scripts/fetch_remote_knowledge.py \
  --profile prod \
  --operation knowledge-search \
  --query "放款统计" \
  --country cn \
  --category report \
  --top-k 5
```

## 边界

- 不执行 SQL。
- 不查看代码；代码查看必须走 `$dw-code-knowledge`。
- 不直接读取 Git 工作区或 SR Box 物化目录。
- 不修改知识源配置、pull、refresh 或 activate；这些属于受控知识源管理入口。
- 不发送 Jira、邮件、群消息或报表。
