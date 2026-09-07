# 告警注册控制台视觉与安全优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 保留现有接口和业务行为，将告警注册整页优化为紧凑清晰的运维控制台，并修复可低风险闭环的敏感凭据泄露。

**Architecture:** 继续使用原生 JavaScript 模板和全局样式表；web/src/views/alert-registry.js 只调整语义分组、标签关联和状态呈现，web/src/styles.css 使用页面作用域统一视觉。服务端增加电话配置公开 DTO，内部拨号仍读取真实凭据，但 API 响应只返回掩码和配置状态。

**Tech Stack:** Node.js ESM、原生 HTML/CSS/JavaScript、node:test、npm audit、本地 HTTP 平台。

---

## 文件结构

- web/src/views/alert-registry.js：页面 DOM、配置面板和事件绑定。
- web/src/styles.css：视觉令牌、布局、状态和响应式规则。
- src/alert-registry.mjs：电话配置内部读取与公开响应转换。
- test/alert-registry-view.test.mjs：页面结构和样式回归测试。
- test/alert-registry.test.mjs：凭据脱敏回归测试。
- docs/security/2026-09-07-alert-registry-security-review.md：安全审计报告。

### Task 1: 安全同步远端最新代码

**Files:**
- Preserve: src/server.mjs
- Preserve: web/src/app.js
- Preserve: src/data-governance.mjs
- Preserve: web/src/views/data-governance.js

- [ ] **Step 1: 记录状态并导出恢复补丁**

~~~bash
git status --short --branch
git diff --binary > /tmp/znzb-before-ui-refresh.patch
git ls-files --others --exclude-standard > /tmp/znzb-before-ui-refresh-untracked.txt
~~~

Expected: 补丁非空，未跟踪清单包含现有数据治理文件和 .claude/。

- [ ] **Step 2: 暂存工作区并变基到远端**

~~~bash
git stash push --include-untracked -m "codex-preserve-before-alert-registry-refresh"
git rebase origin/codex-show-scanned-dashboards
git stash pop
~~~

Expected: 远端最新提交已纳入，设计与计划提交仍存在，原未提交文件恢复。冲突只合并远端路由与本地数据治理入口，无法判断时停止。

### Task 2: 用失败测试锁定页面结构

**Files:**
- Create: test/alert-registry-view.test.mjs

- [ ] **Step 1: 写失败测试**

~~~js
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const viewUrl = new URL("../web/src/views/alert-registry.js", import.meta.url);
const cssUrl = new URL("../web/src/styles.css", import.meta.url);

test("alert registry uses a scoped operations console shell", async () => {
  const source = await fs.readFile(viewUrl, "utf8");
  assert.match(source, /class="page-header ar-console-header"/);
  assert.match(source, /class="panel ar-console-section/);
  assert.match(source, /class="ar-console-section-head"/);
});

test("message template keeps enablement and save action together", async () => {
  const source = await fs.readFile(viewUrl, "utf8");
  assert.match(source, /class="mc-message-toolbar"/);
  assert.match(source, /for="ar-msg-enabled"/);
  assert.match(source, /class="mc-message-actions"/);
  assert.match(source, /aria-live="polite"/);
});

test("styles include desktop grid and narrow fallback", async () => {
  const css = await fs.readFile(cssUrl, "utf8");
  assert.match(css, /--ar-control-height:/);
  assert.match(css, /\.mc-form-row\s*\{/);
  assert.match(css, /@media \(max-width: 760px\)/);
});
~~~

- [ ] **Step 2: 运行并确认失败**

Run: node --test test/alert-registry-view.test.mjs

Expected: FAIL，缺少 ar-console-header 或 mc-message-toolbar。

- [ ] **Step 3: 提交测试**

~~~bash
git add test/alert-registry-view.test.mjs
git commit -m "test: define alert registry console layout"
~~~

### Task 3: 重构页面结构与可访问性

**Files:**
- Modify: web/src/views/alert-registry.js
- Test: test/alert-registry-view.test.mjs

- [ ] **Step 1: 增加页面和区域作用域**

~~~html
<div class="page-header ar-console-header">
  <div class="ar-console-heading">
    <span class="ar-console-eyebrow">ALERT OPERATIONS</span>
    <h1 class="page-title">告警注册</h1>
    <p class="page-note">统一管理告警条目、通知策略与运行结果。</p>
  </div>
  <div class="header-actions ar-console-header-actions">
    <button class="secondary" id="ar-refresh">刷新</button>
    <button class="primary" id="ar-new">+ 新增告警</button>
  </div>
</div>
<section class="panel ar-console-section">
  <div class="ar-console-section-head">
    <div><h2>告警条目</h2><p>配置来源、触发方式与执行状态。</p></div>
  </div>
  <div id="ar-list"></div>
</section>
~~~

- [ ] **Step 2: 用字段网格替换松散 flex 行**

~~~html
<div class="mc-form-row mc-form-row--template">
  <label class="mc-form-label" for="ar-msg-template">异常消息模板</label>
  <div class="mc-form-control">
    <textarea id="ar-msg-template" class="mc-msg-tpl" rows="6">${escapeHtml(tpl)}</textarea>
    <span class="mc-form-help">告警发生时发送到群的正文。</span>
  </div>
</div>
~~~

通知、语音和调度配置采用同一 mc-form-row 结构，删除 style="flex:1" 等行内布局。

- [ ] **Step 3: 重组模板操作栏**

~~~html
<div class="mc-message-toolbar">
  <label class="mc-switch" for="ar-msg-enabled">
    <input type="checkbox" id="ar-msg-enabled" />
    <span class="mc-switch-track" aria-hidden="true"></span>
    <span><strong>启用消息模板</strong><small>关闭后保留内容但不发送</small></span>
  </label>
  <div class="mc-message-actions">
    <span class="mc-schedule-status" id="ar-msg-status" aria-live="polite"></span>
    <button class="primary mc-save-button" id="ar-msg-save">保存消息模板</button>
  </div>
</div>
~~~

- [ ] **Step 4: 统一异步状态**

保存时设置 disabled、aria-busy="true" 和“保存中…”，完成后恢复按钮并保留成功或错误文字，不再用定时器立即清空结果。

- [ ] **Step 5: 运行测试并提交**

~~~bash
node --test test/alert-registry-view.test.mjs
git add web/src/views/alert-registry.js test/alert-registry-view.test.mjs
git commit -m "refactor: organize alert registry controls"
~~~

Expected: 页面结构断言 PASS。

### Task 4: 建立运维控制台视觉系统

**Files:**
- Modify: web/src/styles.css
- Test: test/alert-registry-view.test.mjs

- [ ] **Step 1: 添加令牌和单层面板**

~~~css
.ar-console-header, .ar-console-section {
  --ar-accent: #2563eb;
  --ar-ink: #172033;
  --ar-muted: #667085;
  --ar-line: #dfe5ee;
  --ar-soft: #f7f9fc;
  --ar-control-height: 36px;
}
.ar-console-section {
  border: 1px solid var(--ar-line);
  border-radius: 12px;
  box-shadow: 0 1px 2px rgb(16 24 40 / 0.04);
  overflow: hidden;
}
~~~

- [ ] **Step 2: 添加字段网格、操作栏和焦点态**

~~~css
.mc-form-row {
  display: grid;
  grid-template-columns: minmax(132px, 180px) minmax(0, 1fr);
  gap: 16px;
  align-items: start;
  padding: 14px 16px;
  border-top: 1px solid var(--ar-line, #dfe5ee);
}
.mc-message-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 14px 16px;
  border-top: 1px solid var(--ar-line, #dfe5ee);
  background: #fbfcfe;
}
.mc-message-actions { display: flex; align-items: center; gap: 12px; }
.ar-console-section :is(input, select, textarea, button):focus-visible {
  outline: 3px solid rgb(37 99 235 / 0.18);
  outline-offset: 1px;
  border-color: #2563eb;
}
~~~

- [ ] **Step 3: 添加窄屏布局**

~~~css
@media (max-width: 760px) {
  .ar-console-header, .mc-message-toolbar, .mc-message-actions {
    align-items: stretch;
    flex-direction: column;
  }
  .mc-form-row { grid-template-columns: 1fr; gap: 6px; }
  .mc-message-actions .mc-save-button { width: 100%; }
  .mc-notify-row { display: grid; grid-template-columns: 1fr; }
}
~~~

- [ ] **Step 4: 验证并提交**

~~~bash
node --test test/alert-registry-view.test.mjs
git diff --check -- web/src/styles.css web/src/views/alert-registry.js
git add web/src/styles.css web/src/views/alert-registry.js test/alert-registry-view.test.mjs
git commit -m "feat: refresh alert registry console UI"
~~~

Expected: tests PASS，git diff --check 无输出。

### Task 5: 修复电话凭据 API 泄露

**Files:**
- Modify: src/alert-registry.mjs
- Modify: web/src/views/alert-registry.js
- Modify: test/alert-registry.test.mjs

- [ ] **Step 1: 写失败测试**

~~~js
test("entry voice responses never expose raw cloud credentials", async (t) => {
  const { registry } = await tmpRegistry(t);
  process.env.ALIBABA_VOICE_ACCESS_KEY_ID = "LTAI-raw-access-key";
  process.env.ALIBABA_VOICE_ACCESS_KEY_SECRET = "raw-super-secret-value";
  t.after(() => {
    delete process.env.ALIBABA_VOICE_ACCESS_KEY_ID;
    delete process.env.ALIBABA_VOICE_ACCESS_KEY_SECRET;
  });
  const voice = await registry.getEntryVoice("mc_cn");
  assert.equal("accessKeySecret" in voice, false);
  assert.equal("accessKeyId" in voice, false);
  assert.match(voice.accessKeyIdMasked, /\*\*\*\*/);
  assert.doesNotMatch(JSON.stringify(voice), /raw-super-secret-value|LTAI-raw-access-key/);
});
~~~

- [ ] **Step 2: 运行并确认泄露**

Run: node --test --test-name-pattern="never expose raw cloud credentials" test/alert-registry.test.mjs

Expected: FAIL，响应包含原始 accessKeyId 或 accessKeySecret。

- [ ] **Step 3: 增加公开 DTO**

~~~js
function toPublicVoiceConfig(voice = {}) {
  const accessKeyId = resolveEnv(voice.accessKeyId);
  const accessKeySecret = resolveEnv(voice.accessKeySecret);
  return {
    enabled: voice.enabled !== false,
    calledShowNumberMasked: maskSecret(voice.calledShowNumber),
    ttsCode: String(voice.ttsCode || ""),
    nameTemplate: String(voice.nameTemplate || ""),
    systemTemplate: String(voice.systemTemplate || ""),
    accessKeyIdMasked: maskSecret(accessKeyId),
    accessKeySecretMasked: maskSecret(accessKeySecret),
    credentialsConfigured: Boolean(accessKeyId && accessKeySecret),
    usesGlobal: Boolean(voice.usesGlobal),
  };
}
~~~

内部拨号使用私有原始配置函数；getEntryVoice、setEntryVoice 和多国语音读取的 API 返回路径调用 toPublicVoiceConfig。前端只使用掩码字段，不把掩码写回。

- [ ] **Step 4: 运行测试并提交**

~~~bash
node --test test/alert-registry.test.mjs test/alert-script-template.test.mjs
git add src/alert-registry.mjs web/src/views/alert-registry.js test/alert-registry.test.mjs
git commit -m "fix: redact alert voice credentials"
~~~

Expected: tests PASS，序列化响应不含原始凭据。

### Task 6: 完成安全审计报告

**Files:**
- Create: docs/security/2026-09-07-alert-registry-security-review.md

- [ ] **Step 1: 运行依赖和敏感信息检查**

~~~bash
npm audit --json
git grep -n -E "(AccessKeySecret|api[_-]?key|Bearer |password=|spawn\(|innerHTML)" -- src web config ":!config/*.json"
~~~

Expected: 区分运行时引用、已转义 DOM 和真实风险。

- [ ] **Step 2: 审查危险接口**

检查 POST /api/alert-registry/test-command、POST /api/alert-registry/:id/apply-script、POST /api/alert-registry/:id/phone 以及增删改接口的认证、来源限制和审计。记录默认监听 127.0.0.1 的缓解作用及通过 HOST=0.0.0.0 或反向代理暴露后的风险。

- [ ] **Step 3: 审查 XSS、SSRF、路径和命令输入**

确认接口字段进入 innerHTML 前经过 escapeHtml，ID 进入 URL 使用 encodeURIComponent，选择器使用 CSS.escape；检查 n8n 基址、webhook、SSH 主机、脚本路径和命令参数边界。

- [ ] **Step 4: 写报告并提交**

报告逐项写明严重性、位置、证据、利用前提、影响、修复状态和建议。任意命令执行管理接口与认证缺失列为高风险架构项，不擅自引入可能破坏部署的认证协议。

~~~bash
git add docs/security/2026-09-07-alert-registry-security-review.md
git commit -m "docs: audit alert registry security risks"
~~~

### Task 7: 全量验证与页面验收

**Files:**
- Modify: web/src/app.js（仅缓存版本号）

- [ ] **Step 1: 更新缓存版本**

~~~js
import { renderAlertRegistry } from "./views/alert-registry.js?v=20260907-console-v1";
~~~

- [ ] **Step 2: 运行全量测试**

Run: npm test

Expected: all tests PASS；既有失败必须在变更前远端提交复现并记录。

- [ ] **Step 3: 启动并验收页面**

~~~bash
PORT=8787 HOST=127.0.0.1 npm run platform
~~~

打开 http://127.0.0.1:8787/#/alert-registry。桌面检查层级、对齐、变量换行、模板留白与操作栏；窄屏检查单列、无横向溢出和按钮触控区域；交互检查保存中、成功、失败、禁用和键盘焦点。

- [ ] **Step 4: 检查差异与归属**

~~~bash
git diff --check
git status --short
git log --oneline -8
~~~

Expected: 无空白错误；.claude/、数据治理文件和用户补丁保持原归属。

- [ ] **Step 5: 提交缓存版本与最终修正**

~~~bash
git add web/src/app.js web/src/views/alert-registry.js web/src/styles.css src/alert-registry.mjs test/alert-registry-view.test.mjs test/alert-registry.test.mjs
git commit -m "chore: finalize alert registry console refresh"
~~~

仅在有尚未提交的本任务文件时执行；不得使用 git add .。
