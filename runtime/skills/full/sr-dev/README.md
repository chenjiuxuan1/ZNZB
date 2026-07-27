# SR Dev Skills

`sr-dev/` 是本仓库当前精简后的 SR / WS skill 发布包。所有可维护 skill 位于 `sr-dev/skills/`；pack 配置位于 `sr-dev/skill-packs/`，并且只引用当前目录真实存在的 skill。

## Package Layout

```text
sr-dev/
├── skills/
└── skill-packs/
```

## Skill Groups

| 分组 | Skills |
|---|---|
| 数仓开发编排 | `dw-dev`, `dw-modeling`, `dw-sql-builder` |
| 知识与代码上下文 | `dw-knowledge`, `dw-code-knowledge`, `dw-knowledge-init` |
| SR 查询与执行验证 | `sr_box` |
| DS 调度 | `ds-schedule-manager`, `ds-scheduler` |
| Jira 输入 | `jira-intake` |

## Naming

- 新的数仓开发链统一使用 `dw-*` 命名。
- 旧数仓开发链已统一改为 `dw-*` 命名。
- `sr_box` 目录的 skill 名仍是 `$sr-box`，用于兼容现有生产查询入口。

## Install

Use the shared installer with absolute source paths:

```bash
/Users/admin/Documents/Codex/SKills/scripts/install_skill.sh /Users/admin/Documents/sr_skills/sr-dev/skills/dw-dev
/Users/admin/Documents/Codex/SKills/scripts/install_skill.sh /Users/admin/Documents/sr_skills/sr-dev/skills/dw-modeling
/Users/admin/Documents/Codex/SKills/scripts/install_skill.sh /Users/admin/Documents/sr_skills/sr-dev/skills/dw-sql-builder
/Users/admin/Documents/Codex/SKills/scripts/install_skill.sh /Users/admin/Documents/sr_skills/sr-dev/skills/dw-knowledge
/Users/admin/Documents/Codex/SKills/scripts/install_skill.sh /Users/admin/Documents/sr_skills/sr-dev/skills/dw-code-knowledge
/Users/admin/Documents/Codex/SKills/scripts/install_skill.sh /Users/admin/Documents/sr_skills/sr-dev/skills/sr_box
/Users/admin/Documents/Codex/SKills/scripts/install_skill.sh /Users/admin/Documents/sr_skills/sr-dev/skills/ds-scheduler
```

Run basic validation before installing a changed skill:

```bash
python3 /Users/admin/.codex/skills/.system/skill-creator/scripts/quick_validate.py /Users/admin/Documents/sr_skills/sr-dev/skills/<skill-name>
```
