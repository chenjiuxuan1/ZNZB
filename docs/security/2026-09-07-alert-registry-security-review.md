# 告警注册安全审计报告（2026-09-07）

## 结论

本次审计确认 2 项高风险架构问题、1 项已修复的高风险敏感信息泄露、1 项已修复的中风险 DOM XSS，以及 1 项中风险浏览器防护缺失。依赖审计未发现已知漏洞。

应用默认监听 127.0.0.1，这能降低远程攻击面，但不能替代认证。只要通过 HOST=0.0.0.0、容器端口映射或反向代理对其他用户开放，下述管理接口就必须被视为网络可达。

## 已修复

### [高] 电话语音读取接口泄露阿里云凭据

- 位置：src/alert-registry.mjs 的 getMcVoice 和 getEntryVoice。
- 原证据：getMcVoice 返回原始 accessKeyId；getEntryVoice 同时返回原始 accessKeyId 与 accessKeySecret。
- 利用前提：攻击者能访问 GET /api/multi-country/voice 或 GET /api/alert-registry/:id/voice。
- 影响：可获取云账号签名凭据并滥用语音服务；凭据权限过大时可能扩大影响。
- 修复：增加 toPublicVoiceConfig。公开响应只包含掩码、credentialsConfigured、模板和启用状态；内部拨号改用私有原始配置读取路径。前端不再回填 AccessKeyId。
- 验证：test/alert-registry.test.mjs 验证全局和条目接口的序列化结果均不包含原始凭据。
- 后续建议：轮换曾经配置过的 AccessKeyId/AccessKeySecret，并在云端把凭据权限收敛到语音调用所需的最小集合。

### [中] 历史记录字段可形成 DOM XSS

- 位置：web/src/views/alert-registry.js 的历史列表模板。
- 原证据：国家代码 c.code、运行 ID run.id 和无法解析时的时间值 ts 未经转义直接进入 innerHTML。
- 利用前提：攻击者能让恶意字符串进入告警回写数据或历史文件。
- 影响：打开告警注册页面的浏览器可能执行注入脚本。
- 修复：三个字段全部经 escapeHtml 处理。
- 验证：test/alert-registry-view.test.mjs 锁定这些输出点。

## 未修复的架构风险

### [高；网络暴露时可达严重级别] 管理接口无统一认证，可执行任意命令和外部副作用

- 位置：src/server.mjs 的告警注册路由；src/alert-registry.mjs 的 runTestByCommand；src/alert-script-template.mjs 的 applyUpdate。
- 证据：
  - POST /api/alert-registry/test-command 可把请求中的 command 交给 spawn，并启用 shell: true。
  - POST /api/alert-registry/:id/apply-script 可写文件、git commit、git push 并执行 SSH 部署。
  - POST /api/alert-registry/:id/phone 可触发真实电话。
  - 告警条目的新增、修改、删除和启停均未调用认证函数。
- 利用前提：攻击者能访问平台 HTTP 服务。默认只监听 127.0.0.1 时，需要本机代码执行、恶意网页配合本机访问条件或代理暴露；监听公网/内网地址时可直接远程利用。
- 影响：以平台进程权限执行命令、修改和推送代码、向目标机部署文件、触发付费电话、篡改或删除告警配置。
- 建议：
  1. 在反向代理和应用层同时加入身份认证，不允许只依赖网络位置。
  2. 为读、配置修改、命令测试、部署和电话拨打划分独立权限。
  3. 危险接口要求短期二次确认令牌，并记录操作者、目标、摘要和结果。
  4. 禁止通用 shell 字符串执行，改为服务端登记的命令模板与参数白名单。
  5. 未完成认证改造前，强制保持 HOST=127.0.0.1，禁止直接端口映射。

本次未直接加入认证协议，因为仓库没有统一登录和会话模型，擅自增加单一 Token 会改变现有部署及 n8n 调用契约。应作为独立安全项目实施。

### [高] 脚本路径和远程部署目标缺少边界约束

- 位置：src/alert-script-template.mjs 的 previewUpdate 与 applyUpdate。
- 证据：
  - repoDir 和 scriptPath 来自可编辑条目，path.join 后直接读写；scriptPath 可包含父目录片段。
  - remoteScriptPath 被直接拼接进远程 shell 命令的重定向目标。
  - sshHost 可由条目配置，并被传给 SSH 或 n8n SSH 执行通道。
- 利用前提：攻击者具备告警条目修改或 apply-script 调用能力。
- 影响：写入仓库目录外文件、向非预期主机部署、通过远程路径中的 shell 元字符注入命令。
- 建议：
  1. repoDir 只允许服务端配置的仓库根目录，不从页面接受任意绝对路径。
  2. scriptPath 必须为相对路径；使用 path.resolve 后验证结果仍位于仓库根目录内。
  3. remoteScriptPath 仅允许绝对 POSIX 路径和 [A-Za-z0-9._/-]，拒绝空白、引号、分号、管道和重定向符。
  4. sshHost 使用服务端目标白名单，不允许客户端选择任意地址。
  5. 部署前显示规范化后的最终路径和目标，并要求有审计的二次确认。

### [中] 缺少浏览器安全响应头和显式来源防护

- 位置：src/server.mjs 的 serveStatic、sendJson 和 sendText。
- 证据：响应只设置 Content-Type 与 Cache-Control，未设置 Content-Security-Policy、X-Content-Type-Options、frame-ancestors 或 X-Frame-Options、Referrer-Policy。
- 影响：一旦出现注入点，缺少 CSP 会放大后果；页面可被第三方站点嵌入，增加点击劫持风险。状态变更接口也没有 Origin/Referer 校验。
- 建议：统一增加安全头；状态变更接口在完成认证后加入 CSRF Token 或严格 SameSite 会话 Cookie，并校验 Origin。CSP 应先以 Report-Only 验证现有内联脚本/样式兼容性。

## DOM 与外部请求检查

- 告警名称、命令、负责人、模板、历史正文、SQL 和错误消息的主要 innerHTML 输出均使用 escapeHtml。
- 条目 ID 进入 API URL 时使用 encodeURIComponent，进入选择器时使用 CSS.escape。
- n8n 基址来自服务端环境变量，页面不能直接指定完整请求主机；但条目 webhookPath 可改变 n8n 路径，仍应做允许字符和长度校验。
- SSH 主机与命令可由条目配置，风险已并入无认证命令执行和目标白名单问题。
- JSON 请求体由共享读取函数限制大小，可缓解无界请求体内存占用。

## 依赖审计

- 默认 npm registry 指向 npmmirror，其 audit 端点返回 404 NOT_IMPLEMENTED，不能据此判断安全状态。
- 使用官方 npm registry 重新运行 npm audit --registry=https://registry.npmjs.org --json。
- 结果：0 critical、0 high、0 moderate、0 low。
- 当前生产依赖面很小，仍应在 CI 中固定使用支持 audit API 的 registry，并定期更新 playwright-core。

## 建议优先级

1. 立即轮换已暴露过的阿里云凭据。
2. 在任何网络暴露前封锁 test-command、apply-script 和 phone；完成统一认证、授权和审计。
3. 为 repoDir、scriptPath、remoteScriptPath 与 sshHost 建立服务端白名单。
4. 增加安全响应头、CSRF 防护和 CSP。
5. 在 CI 中持续运行测试、凭据扫描与官方依赖审计。

