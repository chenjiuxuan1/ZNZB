# DS Gateway Usage Page Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 DS 网关使用统计页改造成层级清晰、密度适中、可搜索筛选并支持窄屏使用的管理工作台。

**Architecture:** 保留现有 API 和数据模型，在 `ds-scheduler-usage.js` 内增加无副作用的用户筛选与分页辅助函数，并用现有渲染函数重组页面语义结构。视觉优化集中在 `styles.css` 的 `dsu-*` 作用域内，避免影响其他页面。

**Tech Stack:** 原生 ES Modules、原生 DOM、HTML/CSS、Node.js `node:test`

---

## 文件结构

- 修改 `web/src/views/ds-scheduler-usage.js`：页面结构、用户搜索/状态筛选、单一分页区和更明确的操作语义。
- 修改 `web/src/styles.css`：DS 使用统计页面的宽度、层级、间距、表格、表单、危险操作与响应式样式。
- 修改 `web/src/app.js`：更新视图模块缓存版本，确保浏览器加载新版页面。
- 修改 `test/ds-scheduler-usage-view.test.mjs`：覆盖用户筛选、Token 搜索、状态筛选、分页范围和空结果。

### Task 1: 用户筛选与分页行为

**Files:**
- Modify: `test/ds-scheduler-usage-view.test.mjs`
- Modify: `web/src/views/ds-scheduler-usage.js`

- [ ] **Step 1: 写失败测试**

在测试中导入 `filterAccessUsers` 和 `paginateAccessUsers`，构造已配置、默认角色、正常、超限与封锁用户，断言用户名和 Token 模糊搜索、状态过滤、页码钳制及空结果。

```js
test("access user filtering matches username, token and status", () => {
  const users = [
    { username: "alice", tokens: ["TOK-ALICE"], configured: true, status: "ok" },
    { username: "bob", tokens: ["TOK-BOB"], configured: false, status: "blocked" },
  ];
  assert.deepEqual(filterAccessUsers(users, "alice", "all").map((u) => u.username), ["alice"]);
  assert.deepEqual(filterAccessUsers(users, "tok-bob", "all").map((u) => u.username), ["bob"]);
  assert.deepEqual(filterAccessUsers(users, "", "configured").map((u) => u.username), ["alice"]);
  assert.deepEqual(filterAccessUsers(users, "", "blocked").map((u) => u.username), ["bob"]);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `node --test test/ds-scheduler-usage-view.test.mjs`

Expected: FAIL，提示模块未导出 `filterAccessUsers` 或 `paginateAccessUsers`。

- [ ] **Step 3: 实现最小纯函数**

在视图模块中导出两个纯函数：筛选函数统一使用小写文本匹配用户名和 Token，并识别 `configured`、`default`、`ok`、`limited`、`blocked`；分页函数返回钳制后的 `page`、`totalPages`、`start`、`end` 和 `items`。

- [ ] **Step 4: 运行测试并确认通过**

Run: `node --test test/ds-scheduler-usage-view.test.mjs`

Expected: PASS，新增和既有视图测试全部通过。

### Task 2: 页面结构与用户工作流

**Files:**
- Modify: `web/src/views/ds-scheduler-usage.js`
- Modify: `web/src/app.js`

- [ ] **Step 1: 重组页面头部和主区块**

将页面包裹在 `dsu-page` 中；头部使用 `dsu-page-hero`、简短说明、来源和更新时间；把核心指标放入独立的 `dsu-overview-stats`。为使用统计和权限管控增加 `dsu-section-heading`，确保扫描标题即可理解页面。

- [ ] **Step 2: 加入用户搜索与状态筛选**

新增模块状态 `accessUsersQuery` 和 `accessUsersStatus`。在用户列表标题下渲染搜索框与状态选择框，使用 Task 1 的纯函数过滤后再分页；搜索或状态变化时将页码重置为 0 并重新绘制。

- [ ] **Step 3: 收敛分页与危险操作**

删除用户列表顶部的重复分页，只在列表底部保留一次；无匹配结果时展示带清除筛选按钮的空状态。为封锁和移除配置按钮增加 `danger`/`quiet-danger` 类，并阻止 summary 内按钮点击意外切换展开状态。

- [ ] **Step 4: 精简说明和下发区**

缩短全局策略、违规记录、用户列表和策略下发的长说明；保留必要的状态和下一步。将“生成网关策略”改为更具体的“生成并保存策略文件”。

- [ ] **Step 5: 更新模块缓存版本**

把 `web/src/app.js` 中 `ds-scheduler-usage.js` 的查询版本更新为 `20260828-workspace-v1`。

### Task 3: 视觉系统与响应式布局

**Files:**
- Modify: `web/src/styles.css`

- [ ] **Step 1: 建立页面级布局变量**

为 `dsu-page` 设置合理最大宽度、自动居中和局部颜色/间距变量；重设头部、指标区与区块标题，使首屏层级明确并避免 4K 全宽拉伸。

- [ ] **Step 2: 优化统计和表格密度**

统一国家卡片、工具栏、KPI、Token 标签和表格行高；数值列使用 `font-variant-numeric: tabular-nums`；表格只在自身容器横向滚动。

- [ ] **Step 3: 优化权限编辑区域**

把策略卡片改为平静的工作区层级，调整 checkbox 尺寸、表单标签、用户摘要行、展开编辑区、动作黑名单和限额网格；危险按钮使用红色边框与清晰 hover/focus 状态。

- [ ] **Step 4: 增加响应式规则**

在 1100px、760px 和 560px 下分别收敛双栏、工具栏、用户摘要、编辑表单和按钮布局；保证 375px 宽度没有页面级横向滚动，主要触控按钮高度不低于 40px。

### Task 4: 自动化与视觉验收

**Files:**
- Verify: `test/*.test.mjs`
- Verify: rendered `/ds-scheduler-usage` page

- [ ] **Step 1: 运行目标测试**

Run: `node --test test/ds-scheduler-usage-view.test.mjs test/ds-scheduler-usage.test.mjs test/ds-scheduler-access.test.mjs`

Expected: PASS，0 failures。

- [ ] **Step 2: 运行完整测试集**

Run: `npm test`

Expected: PASS，0 failures。

- [ ] **Step 3: 启动本地平台并截图**

Run: `npm run platform`

打开 `/ds-scheduler-usage`，记录桌面首屏、用户展开态，以及 1440px、768px、375px 三种宽度截图。

- [ ] **Step 4: 检查页面质量**

确认无页面级横向滚动、控制台无新增错误、搜索/筛选/分页可用、危险操作可辨识、展开编辑区字段未丢失。

- [ ] **Step 5: 检查变更边界**

Run: `git diff --check && git status --short && git diff -- web/src/views/ds-scheduler-usage.js web/src/styles.css web/src/app.js test/ds-scheduler-usage-view.test.mjs`

Expected: 无空白错误；只包含计划内文件和用户原有未跟踪文件。
