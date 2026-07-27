# 数仓代码库 使用说明

> 作者：owenzhang
> 模块 ID：`dw-code-knowledge`
> 展示名称：`数仓代码库`

`dw-code-knowledge` 是单独授权的代码查看 skill，用于通过生产 SR Box 只读代码 API 查询 ETL SQL、workflow 脚本、表构建逻辑和代码出处。

## API

架构与调用关系说明见 [ARCHITECTURE.md](ARCHITECTURE.md)。

```text
GET /api/code/search?q=<query>
GET /api/code/files?path=<code-source-relative-path>
```

## Helper

```bash
python3 skills/dw-code-knowledge/scripts/fetch_remote_knowledge.py \
  --profile prod \
  --operation code-search \
  --query "dwb_fox_mission_recovery_d"

python3 skills/dw-code-knowledge/scripts/fetch_remote_knowledge.py \
  --profile prod \
  --operation code-file \
  --path "th/dwb_fox_mission_recovery_d.sql"
```

## 边界

- 不执行 SQL。
- 不管理 Git source，不 pull，不 refresh，不 activate。
- 不读取文档知识库；文档和语义上下文使用 `$dw-knowledge`。
- 不绕过权限读取本地 Git 工作区。
