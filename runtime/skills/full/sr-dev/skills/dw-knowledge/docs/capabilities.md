# 数仓知识库能力文档

维护人：owenzhang

## 默认环境

| 项 | 值 |
|---|---|
| Skill | `$dw-knowledge` |
| 展示名 | 数仓知识库 |
| 网关 | `https://data-map-dev.kuainiu.io` |
| 登录 | 复用 `$sr-box` SSO session |
| Session 文件 | `~/.config/sr-skills/session-data-map-dev.json` |
| 缓存根 | `<skills-root>/cache/dw-knowledge` |

## 能力优先级

| 优先级 | 能力 | 触发场景 | API |
|---|---|---|---|
| 1 | Git 文档知识 | 最新 fox、BOC、回款、分案、知识包目录、文件正文 | `GET /api/knowledge/*` |
| 2 | 封装知识库 | 相似知识、Dify、后续向量库、Git 文档未命中 | `POST /api/knowledge/search`、`/api/knowledge/dify/*` |
| 3 | 本地语义上下文 | 本地需求、semantic-layer、reference context 已足够 | `build_context.py` |

## 代码权限

`dw-knowledge` 不查看代码。用户要求 ETL SQL、workflow、代码逻辑或代码出处时，协调 `$dw-code-knowledge`；未安装时提示：`没有查看代码权限：未安装 dw-code-knowledge，无法查询数仓代码库。`

## Helper 命令

```bash
python3 skills/dw-knowledge/scripts/fetch_remote_knowledge.py --profile prod --domain fox --source-id starrocks
python3 skills/dw-knowledge/scripts/fetch_remote_knowledge.py --profile prod --operation git-search --query "fox DWB 宽表" --domain fox
python3 skills/dw-knowledge/scripts/fetch_remote_knowledge.py --profile prod --operation knowledge-search --query "放款统计" --country cn --category report --top-k 5
```

## 边界

- 不执行 SQL。
- 不查看代码。
- 不做 Git pull、分支切换、刷新、激活等管理动作。
- 不读取 Git 工作区或 SR Box 物化目录中的业务知识正文。
- 不提供删除能力，不代理删除接口。
- 不把业务知识写入具体 skill 目录。
