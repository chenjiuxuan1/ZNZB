# DS 网关用户权限与管控

值班平台「DS网关使用统计」页（`#/ds-scheduler-usage`）新增「**用户权限与管控**」区块，
用于对 `ds-scheduler-router` 网关的每个用户做权限与频率管控：

- **不允许大量新建/删除**：按小时/日限额拦截 `create_workflow`、`delete_task`、
  `disable_task` 等大批量操作；
- **删除动作只对个别用户开放**：`delete` 类动作默认被角色限制，只有显式开放
  「允许删除类操作」的用户（通常为管理员）可以执行；
- **可配置用户权限**：按用户名配置角色、动作黑名单/白名单、独立限额；
- **对每一个用户有管理能力**：封锁/解封、移除显式配置、查看违规记录、模拟校验。

管控分两层：

1. **平台层（本仓库）**：负责配置、管理界面、违规检测、生成网关策略。
2. **网关层（ds-scheduler-gateway 仓库）**：真正在每次请求执行前校验并拦截。

---

## 一、整体流程

```
Codex / 值班平台 → n8n ds-scheduler-router → SSH 各国机器 → ds_scheduler_entry.py
                                                        │
                                            gateway/access.py 校验
                                            （权限 + 限额，读 config/access_policy.json）
                                                        │
                                            通过则执行 DS 动作，写入审计表
```

- 值班平台在页面上配置用户/限额 → `config/ds-scheduler-access-policy.json`
- 「下发策略」生成 `config/ds-scheduler-access-gateway.json`（token 维度）
- 通过 `scripts/publish-ds-access-policy.mjs` 复制到各国机器
  `config/access_policy.json`，网关即开始按新策略拦截。

> 注意：网关策略按 **Token** 匹配，平台策略按 **用户名** 配置。下发时平台会把
> 用户名策略 + token 映射展开成 token 维度策略，因此「绑定 Token」要尽量齐全
> （可从 token 映射自动发现）。未绑定任何 Token 的用户，其策略在网关层无法命中，
> 只能靠 `enforceUnknown` 兜底（未知 Token 仅只读）。

---

## 二、角色与动作分类

动作分为四类（平台与网关保持一致）：

| 分类 | 包含动作 |
| --- | --- |
| `read` | list/resolve/get/search/view/dump/check 等所有只读动作 |
| `write` | create_workflow / create_schedule / update_* / append_* / batch_update_schedule_alerts |
| `control` | online/offline_* / trigger_workflow / retry_instance / stop_instance / force_fail_instance |
| `delete` | delete_task / disable_task / disable_tasks_except |

角色默认拥有的动作类：

| 角色 | 允许的动作类 |
| --- | --- |
| `readonly` | read |
| `operator`（运维） | read + write |
| `power`（高级） | read + write + control |
| `admin`（管理员） | read + write + control + delete |

在用户级别还可以：
- `deleteAllowed`：即使角色不含 `delete`，勾选后也允许删除类动作（**删除白名单**）；
- `deniedActions`：动作黑名单，命中的动作一律拒绝；
- `allowedActions`：动作白名单，一旦设置，只允许列出的动作。

判定优先级：用户被禁用 → 黑名单 → 白名单 → 角色/删除开关 → 限额。

---

## 三、限额（防大量新建/删除）

全局与每个用户都可以设置以下限额（超出即拦截）：

| 限额 | 含义 |
| --- | --- |
| `maxActionsPerHour` / `maxActionsPerDay` | 每小时 / 每日总操作数 |
| `maxCreatesPerHour` / `maxCreatesPerDay` | 每小时 / 每日新建数（create_workflow、create_schedule、append_*） |
| `maxDeletesPerDay` | 每日删除/禁用数（delete_task、disable_task、disable_tasks_except） |
| `maxTriggersPerHour` | 每小时触发数（trigger_workflow、retry_instance） |

默认值见 `src/ds-scheduler-access.mjs` 的 `DEFAULT_LIMITS`。

网关侧用 `config/access_state.json` 持久化滚动计数（默认按**北京时间 UTC+8** 的小时/日窗口，
与审计时间/平台预览一致；可用环境变量 `DS_ACCESS_TZ_OFFSET` 覆盖，单位为秒），
计数读取-判断-写入全程持有文件锁（`config/access_state.json.lock`），
避免并发请求绕过限额。

---

## 四、配置文件

### 平台策略 `config/ds-scheduler-access-policy.json`

由页面管理，文件已 gitignore；示例见 `config/ds-scheduler-access-policy.example.json`。

```jsonc
{
  "version": 1,
  "updatedAt": "…",
  "enforcement": true,          // 是否真正拦截（false 只保存配置不拦截）
  "defaultRole": "operator",    // 未显式配置用户的默认角色
  "enforceUnknown": true,       // 未知 Token 是否仅只读
  "globalLimits": { "maxCreatesPerHour": 10, /* … */ },
  "users": {
    "jiangchuanchen": {
      "username": "jiangchuanchen",
      "tokens": ["289e723f…"],  // 绑定的 Token
      "role": "admin",
      "enabled": true,
      "deleteAllowed": true,
      "allowedActions": null,   // null = 按角色
      "deniedActions": [],
      "limits": null            // null = 用全局
    }
  }
}
```

### 网关策略 `config/ds-scheduler-access-gateway.json`

「下发策略」生成（token 维度），字段与网关 `gateway/access.py` 对应：

```jsonc
{
  "version": 1,
  "enforce": true,
  "generatedAt": "…",
  "defaultRole": "operator",
  "enforceUnknown": true,
  "globalLimits": { … },
  "tokens": {
    "<token>": { "user": "…", "role": "…", "enabled": true,
                 "allowedActions": null, "deniedActions": [], "deleteAllowed": false, "limits": {} }
  }
}
```

---

## 五、接口

- `GET /api/ds-scheduler/access`：策略 + 用户列表 + 违规 + 网关策略预览 + 元信息
- `PUT /api/ds-scheduler/access/policy`：保存全局策略
- `PUT /api/ds-scheduler/access/users/:username`：新增/更新用户
- `DELETE /api/ds-scheduler/access/users/:username`：移除用户显式配置
- `POST /api/ds-scheduler/access/evaluate`：模拟校验（用户名/token + 动作 + 国家）
- `GET /api/ds-scheduler/access/violations`：违规记录
- `POST /api/ds-scheduler/access/publish`：生成并落盘网关策略

---

## 六、前端

在 `web/src/views/ds-scheduler-usage.js` 的「DS网关使用统计」页内新增：

- **全局策略**：强制拦截开关、未知 Token 只读开关、默认角色、全局限额；
- **用户列表**：每个用户可展开配置角色 / 启用 / 删除权限 / 动作黑名单 / 独立限额 /
  备注，并可编辑**绑定 Token**（逗号/空格分隔；留空=沿用已有绑定，填写=整体替换），
  支持封锁 / 解封 / 移除配置 / 新增用户；
- **模拟校验**：输入用户名或 Token + 动作，立即看到放行/拦截结果；
- **违规记录**：最近 7 天任一小时/当日窗口超限的用户，可一键封锁；
- **下发策略**：生成网关策略并提示部署方式；若某已配置用户未绑定任何 Token，
  会给出「权限无法在网关生效」的警告（可补绑定 Token 后重新下发）。

相关样式在 `web/src/styles.css` 的 `dsu-` 前缀下。

---

## 七、部署到网关（重要）

网关改动需要部署到 6 国机器才能真正拦截：

1. **网关代码上线**：把 `ds-scheduler-gateway` 的 `main` 分支推到
   `gateway-github`（`github.com/chenjiuxuan1/ds-scheduler-gateway.git`），
   然后在 n8n 运行各国「代码拉取」节点（或手动执行相同的 git reset 命令）。
   新增的 `gateway/access.py` 与 `gateway/main.py` 改动会随之上线。
2. **下发策略**：在页面点「下发策略」生成本地文件后，执行：
   ```bash
   node scripts/publish-ds-access-policy.mjs --dry-run     # 先看下发计划
   node scripts/publish-ds-access-policy.mjs               # 下发到所有国家机器
   node scripts/publish-ds-access-policy.mjs --countries cn,th
   ```
   脚本把 `config/access_policy.json` 写到各国
   `/root/ds-scheduler-gateway/config/access_policy.json`。
3. 验证：在页面「模拟校验」里试一个应被拦截的用户+动作；或直接调用网关接口，
   应返回 `error.code = ACCESS_*`（`ACCESS_DENIED` / `ACCESS_LIMIT_EXCEEDED` 等）。

> 兜底：如误配需要紧急放行，可在目标机器设环境变量 `DS_ACCESS_DISABLE=1`
> 再执行网关命令，或在策略里把 `enforce` 设为 `false` 后重新下发。

`config/access_policy.json` 与 `config/access_state.json` 已在网关仓库
`.gitignore` 中，`git clean -fd` 不会误删（避免 n8n 代码拉取时清掉运行时策略）。

---

## 八、测试

```bash
# 平台侧
node --test test/ds-scheduler-access.test.mjs

# 网关侧
cd <ds-scheduler-gateway> && python3 -m unittest tests.test_access -v
```
