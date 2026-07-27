# Warehouse Agent Semantic Layer

> 作者：owenzhang
> 状态：P0 draft seeds
> 真相源：本目录 Git 文件

本目录实现 `$dw-knowledge / KNOW-01` 和 `KNOW-02` 的机器可读语义层。它负责定义和校验 metric、dimension、segment，不负责执行 SQL。

## 目录

```text
semantic-layer/
  manifest.yaml
  schemas/
  metrics/
  dimensions/
  segments/
  scripts/
```

- `manifest.yaml`：检索入口和实体索引。
- `schemas/`：JSON Schema Draft 2020-12 契约。
- `metrics/`、`dimensions/`、`segments/`：P0 YAML seeds。
- `scripts/validate_semantic_layer.py`：schema 和仓库一致性校验。

## 检索约定

检索顺序固定为：

1. 精确匹配稳定 ID。
2. 对 display name 和 aliases 做规范化精确匹配。
3. 使用 business domain 缩小候选范围。
4. 无唯一结果时返回 `semantic miss` 或 `ambiguity`。

规范化仅包含小写化、首尾空白清理，以及空格、`-`、`_` 的分隔符等价处理。不得通过模糊猜测选择表名。

## 安全边界

- 当前六个 seeds 全部是 `draft`。
- `canonical_table: unknown` 或 `canonical_assets` 以 `unresolved:` 开头时，禁止生成可执行 SQL。
- 即使有候选 canonical table，也必须核验 country、datasource、字段、单位和 freshness。
- 真实 SQL 执行仍固定走 `sr-executor -> sr-box-new -> SR Box`。
- 本目录不自动执行 Jira 回写、报表发送、生产 DDL/DML 或非 `testdb` 写入。

## 校验

安装依赖：

```bash
python3 -m pip install --user -r semantic-layer/requirements.txt
```

运行：

```bash
python3 semantic-layer/scripts/validate_semantic_layer.py
python3 -m unittest semantic-layer/scripts/test_validate_semantic_layer.py -v
```

校验覆盖：

- 专用 metric、dimension、segment schema；
- `contracts/semantic/semantic-entity.schema.json` 冻结共享契约；
- manifest 的 ID、路径、类型和登记完整性；
- metric 的 dimension、segment 引用；
- 实体 ID 与目录路径约定；
- `source.uri` 与真实文件路径一致性。
