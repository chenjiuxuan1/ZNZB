# DS 调度 Skills 快速上手使用文档

开发人员：陈江川

更新时间：2026-06-25

本文面向使用者和 Codex 操作者，只说明 DS 调度 skill 的安装方式、n8n 中转链路、token 使用要求、常用动作和典型使用场景。更底层的接口字段、payload 结构和示例命令，请结合仓库中的 [README.md](/Users/jiangchuanchen/Desktop/codex使用/ds-skill-n8n/README.md)、[REFERENCE.md](/Users/jiangchuanchen/Desktop/codex使用/ds-skill-n8n/REFERENCE.md)、[EXAMPLES.md](/Users/jiangchuanchen/Desktop/codex使用/ds-skill-n8n/EXAMPLES.md) 一起使用。

## 1. Skills 套件概览

当前维护仓库：

`/Users/jiangchuanchen/Desktop/codex使用/ds-skill-n8n`

这个 skill 的核心目标不是“直接从 Codex 连 DolphinScheduler”，而是把用户的调度操作意图转换为标准 webhook 请求，再通过 n8n 分发到各国跳板机上的 `ds-scheduler-gateway` 执行。

当前适配国家：

- `cn` 中国
- `ine` 印尼
- `mx` 墨西哥
- `ph` 菲律宾
- `pk` 巴基斯坦
- `th` 泰国

推荐理解：

- 让 Codex 发起标准请求：使用 `ds-skill-n8n`
- 让 n8n 做参数校验、按国家分流：使用 `n8n/request_normalizer.js` 等模板
- 让各国家真正执行 DS API：使用跳板机上的 `/root/ds-scheduler-gateway`

## 2. 这套 skill 能做什么

当前已经支持的核心动作：

| 动作 | 主要用途 |
|---|---|
| `list_projects` | 查项目 |
| `list_workflows` | 查工作流列表 |
| `create_workflow` | 在项目下创建空 workflow |
| `get_workflow` | 查某个工作流详情 |
| `online_workflow` | 工作流上线 |
| `offline_workflow` | 工作流下线 |
| `trigger_workflow` | 手动触发工作流 |
| `list_instances` | 查工作流实例列表 |
| `get_instance` | 查单个实例详情 |
| `list_task_instances` | 查某次工作流实例下的任务实例明细 |
| `get_task_log` | 拉取具体任务实例运行日志 |
| `retry_instance` | 重跑失败实例 |
| `dump_workflow_graph` | 导出 DAG 结构 |
| `append_task` | 通用追加任务 |
| `append_sql_task` | 追加 SQL 任务 |
| `append_shell_task` | 追加 SHELL 任务 |
| `update_task` | 通用修改已有任务 |
| `update_sql_task` | 修改已有 SQL 任务内容 |
| `update_shell_task` | 修改已有 SHELL 任务脚本内容 |
| `disable_task` | 下线已有任务但不删除节点 |
| `disable_tasks_except` | 保留白名单，其余任务批量下线 |
| `delete_task` | 删除已有任务 |

明确禁止：

- 删除项目
- 删除工作流

当前“删除”能力仅限删除任务节点。
典型使用场景：

- 查询某个国家“数仓-工作流”项目里有哪些上线工作流
- 查询最近一小时失败的工作流实例
- 查询某次实例里到底哪个任务失败了
- 拉取失败任务的运行日志
- 对失败实例执行重跑
- 在空项目里先创建一个空 workflow
- 在某个工作流里新增一个 SQL 或 SHELL 节点
- 给任务补自定义参数和资源列表
- 修改已有 SHELL 任务脚本内容
- 删除一个误加的任务节点
- 导出工作流 DAG，确认节点顺序、坐标和上下游关系

## 3. 正式执行链路

当前正式链路如下：

```text
用户
  -> Codex
  -> ds-skill-n8n
  -> n8n Webhook
  -> 解析并标准化请求
  -> If(valid)
  -> 按国家分流
  -> Execute Command
  -> SSH 到国家跳板机
  -> /root/ds-scheduler-gateway/scripts/ds_scheduler_entry.py
  -> DolphinScheduler 3.4 API
  -> 内容解析
  -> Respond to Webhook
```

请注意：

- skill 本身不直接访问 DS API
- n8n 只做中转和路由
- 真正调用 DS 的是各国家跳板机上的 `ds-scheduler-gateway`

## 4. 安装到 Codex

如果是普通使用者，推荐让维护者提供 zip 包，例如：

`ds-skill-n8n.zip`

使用者拿到 zip 后，可以直接让 Codex 帮忙安装。推荐对 Codex 说：

```text
请安装这个 DS 调度 skills 包：/Users/xxx/Downloads/ds-skill-n8n.zip
安装到 ~/.codex/skills，安装完成后确认可以看到 ds-scheduler skill。
```

Codex 安装时建议做的事情：

1. 解压 zip 到临时目录
2. 找到 skill 根目录
3. 确认其中包含：
   - `SKILL.md`
   - `README.md`
   - `REFERENCE.md`
   - `EXAMPLES.md`
   - `scripts/build_ds_webhook_payload.py`
   - `n8n/`
4. 创建 skills 目录：

```bash
mkdir -p ~/.codex/skills
```

5. 将 skill 复制到 `~/.codex/skills/`

如果是在维护者机器上开发或调试，也可以用源码目录直接联调。

## 5. token 使用要求

这是这套 skill 最重要的约束。

### 5.1 token 必须由用户自己提供

`ds_token` 必须由最终调用人自己提供，不能默认复用别人的 token。

原因很简单：

- token 决定用户能看到哪些项目
- token 决定用户能操作哪些工作流
- token 决定用户能不能上线、下线、触发、删除、重跑

### 5.2 skill 和 n8n 不应内置共享 token

不建议在以下位置写死真实 token：

- `SKILL.md`
- `README.md`
- `EXAMPLES.md`
- n8n Execute Command 节点
- 各类示例 curl

示例里的 token 一律应写成：

`YOUR_DS_TOKEN`

### 5.3 如果用户没给 token，Codex 应该怎么做

如果用户只说：

- “帮我查一下墨西哥有哪些上线工作流”
- “帮我把这个工作流上线”
- “帮我重跑失败实例”

但没有给 token，Codex 应先提醒用户：

```text
请提供你自己的 DS token，我会按你的权限范围操作。
```

## 6. n8n 推荐拓扑

推荐的 n8n 结构：

```text
Webhook
  -> 解析并标准化请求
  -> If(valid)
    -> false -> 构造请求错误响应
    -> true  -> 按国家分流
             -> 中国 Execute Command
             -> 菲律宾 Execute Command
             -> 印尼 Execute Command
             -> 墨西哥 Execute Command
             -> 泰国 Execute Command
             -> 巴基斯坦 Execute Command
             -> 内容解析
             -> Respond to Webhook
```

推荐直接复用：

- `n8n/request_normalizer.js`
- `n8n/error_response.js`
- `n8n/parse_command_output.js`

各国家节点统一执行模式如下：

```bash
ssh -p 36000 root@10.20.47.14 "cd /root/ds-scheduler-gateway && python3 scripts/ds_scheduler_entry.py --country cn --action '{{$json.action}}' --ds-token '{{$json.ds_token}}' --request-id '{{$json.request_id}}' --payload-b64 '{{$json.payload_b64}}'"
```

实际使用时每个国家只替换：

- SSH 地址
- `--country`

补充：

- `/root/ds-scheduler-gateway` 的代码更新节点不要再用 `git pull origin main`
- 这套仓库里 `origin` 可能仍是旧 `scaffold`
- 统一改用：
  - `git pull gateway-github main`
  - 或 `git pull internal main`

## 7. 常见操作示例

### 7.1 查询某国家项目

```text
帮我查看墨西哥里项目名包含“数仓-工作流”的项目。
```

### 7.2 查询某工作流详情

```text
帮我查看墨西哥 skill测试 这个工作流的详情。
```

### 7.3 查询失败实例

```text
帮我查墨西哥最近一小时失败的工作流实例。
```

### 7.4 重跑失败实例

```text
帮我重跑这个失败实例，保持原有工作流状态不变。
```

### 7.5 新增 SQL 任务

```text
在某个工作流里新增一个 SQL 节点，参考现有 SQL 任务，执行 select 2。
```

### 7.6 新增 SHELL 任务

```text
在墨西哥 skill测试 工作流里新增 dwd_ad_af_event，参考当前工作流其他任务。
```

### 7.7 删除任务

```text
把刚刚新增的 dwd_ad_af_event 删除掉。
```

### 7.8 批量精确下线任务

```text
把墨西哥数仓工作流里这批任务全部下线，但不要删除节点，保持工作流原来的上下线状态。
```

Codex 推荐固定动作：

1. 先查询这些任务所在工作流
2. 再逐条调用 `disable_task`
3. 对每条请求传：
   - `restore_original_state=true`
   - `auto_offline=true`

这类场景不要误用 `delete_task`。

### 7.9 白名单保留，其余批量下线

```text
保留这份白名单里的任务，其他任务全部下线。
```

这种场景更适合用 `disable_tasks_except`。

### 7.10 明确禁止的请求

下面这类请求应直接拒绝，不执行：

```text
帮我把这个项目删除掉。
帮我把这个工作流永久删除。
```
## 8. Codex 操作者的默认判断规则

如果是 Codex 操作者，建议按下面规则执行：

1. 先确认国家 `country`
2. 再确认用户是否给了自己的 `ds_token`
3. 再确认目标对象：
   - 项目
   - 工作流
   - 实例
   - 任务名
4. 先查再改
5. 对新增/删除/上线/下线/重跑这类动作，尽量保留原有状态

例如：

- 原工作流是 `ONLINE`，改完后应恢复到 `ONLINE`
- 原定时状态如果是 `OFFLINE`，改完后仍保持 `OFFLINE`
- 删除任务、新增任务时，尽量不要把节点堆叠在一起

## 9. 常见问题

### 9.1 为什么我能发请求，但查不到项目

优先检查：

- 传入的 `ds_token` 是否属于当前用户本人
- token 是否具备目标项目权限
- 国家是否选错

### 9.2 为什么 n8n 返回成功，但页面没变化

优先检查：

- `解析并标准化请求` 是否识别了当前 action
- 对应国家 Execute Command 节点是否真的执行了命令
- `内容解析` 是否还在使用旧版本脚本
- 页面是否需要刷新

### 9.3 为什么新增任务后状态和之前不一样

这类操作应尽量恢复原状态。当前建议遵循：

- 工作流之前是什么状态，改完后尽量恢复成什么状态
- 定时之前是什么状态，改完后也尽量恢复成什么状态

## 10. 推荐配套文档

配套建议一起看：

- [SKILL.md](/Users/jiangchuanchen/Desktop/codex使用/ds-skill-n8n/SKILL.md)
- [README.md](/Users/jiangchuanchen/Desktop/codex使用/ds-skill-n8n/README.md)
- [REFERENCE.md](/Users/jiangchuanchen/Desktop/codex使用/ds-skill-n8n/REFERENCE.md)
- [EXAMPLES.md](/Users/jiangchuanchen/Desktop/codex使用/ds-skill-n8n/EXAMPLES.md)
- [n8n/README.md](/Users/jiangchuanchen/Desktop/codex使用/ds-skill-n8n/n8n/README.md)

如果后续需要，我可以继续补第二版文档：

- 给普通业务使用者的简版 FAQ
- 给 Codex 操作者的标准提示词模板
- 给维护者的各国跳板机部署说明
- 给开发者的 gateway 扩展动作开发规范
