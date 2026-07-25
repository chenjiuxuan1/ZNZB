# Multi-project DS and Hourly Dashboard Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 支持六国 DS 多项目扫描，并让“每小时监控”看板可被正确命名、发现和巡检。

**Architecture:** DS 配置以兼容旧字段的项目明细模型保存，扫描器按项目执行并按国家聚合。Inventory 继续复用既有 Metabase 发现流程，新增批量编排 API 和页面入口。

**Tech Stack:** Node.js ES modules, 原生 Web UI, `node:test`

---

### Task 1: DS 多项目配置和扫描

**Files:**
- Modify: `src/ds-scheduler-monitor.mjs`
- Modify: `src/platform-api.mjs`
- Modify: `web/src/views/ds-scheduler.js`
- Test: `test/ds-scheduler-monitor.test.mjs`
- Test: `test/platform-api.test.mjs`

- [x] 写入失败测试，覆盖分隔符解析、去重、逐项目匹配和聚合扫描。
- [x] 运行目标测试并确认因仅支持单项目而失败。
- [x] 增加项目名称解析及兼容配置模型。
- [x] 按项目执行检查，合并工作流与统计，并保留项目级错误。
- [x] 更新 API 状态与页面提示，展示每个项目的匹配状态。
- [x] 运行目标测试确认通过。

### Task 2: 统一每小时看板名称与规则

**Files:**
- Modify: `config/discovered-panels*.json`
- Modify: `config/public-monitor.config.json`
- Modify: `web/src/views/inventory.js`
- Test: `test/platform-api.test.mjs`

- [x] 写入失败测试，要求六国来源标题与规则均为“每小时监控”。
- [x] 运行测试确认旧标题导致失败。
- [x] 更新六国来源、规则和前端识别逻辑。
- [x] 运行测试确认通过。

### Task 3: 六国批量发现与错误反馈

**Files:**
- Modify: `src/platform-api.mjs`
- Modify: `src/server.mjs`
- Modify: `web/src/views/inventory.js`
- Test: `test/platform-api.test.mjs`

- [x] 写入失败测试，覆盖六国批量发现及单国失败隔离。
- [x] 运行测试确认批量方法尚不存在。
- [x] 新增批量发现 API，逐国复用单国发现并汇总结果。
- [x] 增加页面按钮、执行状态和逐国反馈。
- [x] 运行目标测试和完整测试套件。

### Task 4: 验证与提交

**Files:**
- Modify: `docs/superpowers/plans/2026-07-25-multi-project-hourly-discovery.md`

- [x] 运行完整测试并确认无回归。
- [x] 检查页面按钮、状态文案及现有响应式布局约束。
- [x] 检查 diff，提交代码并提供服务器更新命令。
