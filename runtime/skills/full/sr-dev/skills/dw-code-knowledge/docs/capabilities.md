# 数仓代码库能力文档

维护人：owenzhang

## 默认环境

| 项 | 值 |
|---|---|
| Skill | `$dw-code-knowledge` |
| 展示名 | 数仓代码库 |
| 网关 | `https://data-map-dev.kuainiu.io` |
| 登录 | 复用 `$sr-box` SSO session |
| Session 文件 | `~/.config/sr-skills/session-data-map-dev.json` |

## 能力

| 能力 | API |
|---|---|
| 代码搜索 | `GET /api/code/search?q=<query>` |
| 代码文件读取 | `GET /api/code/files?path=<code-source-relative-path>` |

## Helper 命令

```bash
python3 skills/dw-code-knowledge/scripts/fetch_remote_knowledge.py --profile prod --operation code-search --query "dwb_fox_mission_recovery_d"
python3 skills/dw-code-knowledge/scripts/fetch_remote_knowledge.py --profile prod --operation code-file --path "th/dwb_fox_mission_recovery_d.sql"
```

## 边界

- 不执行 SQL。
- 不管理 Git source，不 pull，不 refresh，不 activate。
- 不读取文档知识库。
- 不绕过权限读取本地 Git 工作区。
