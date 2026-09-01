/**
 * 告警脚本模板引擎。
 *
 * 把注册表条目的「校验语句 SQL 块」(sqlBlocks) 注入脚本模板，合成完整 Python
 * 告警脚本，并支持：
 *   1. previewUpdate  — 渲染脚本 + 与当前仓库脚本 diff（不改动任何文件）
 *   2. applyUpdate    — 渲染 → 写入本地仓库文件 → git commit+push → SSH base64 部署到目标机
 *
 * 模板位置：config/alert-templates/<templateName>.py.tmpl
 * 模板内用 {{BLOCK_NAME}} 占位，对应条目 sqlBlocks 里的键（如 FIN_UNION_SELECT）。
 */
import path from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { deepMapStrings, loadEnvFile, readJsonFile } from "./utils.mjs";

const ENV_PATTERN = /\$\{([A-Z0-9_]+)\}/g;

function resolveEnv(value) {
  if (typeof value !== "string") return value;
  return value.replace(ENV_PATTERN, (_, key) => process.env[key] ?? "");
}

function runCmd(cmd, args, { cwd, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error?.code ?? 0,
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
        error: error ? String(error.message || error) : "",
      });
    });
  });
}

/** 渲染脚本：模板 + sqlBlocks 注入。返回完整脚本字符串。 */
function renderScript(templateContent, sqlBlocks) {
  const blocks = sqlBlocks && typeof sqlBlocks === "object" ? sqlBlocks : {};
  // 值内部的单花括号变量（如 {MONITOR_TABLE}）引用其他 sqlBlocks 键，先展开
  const expandValue = (raw) => {
    let v = String(raw ?? "");
    for (const [k, val] of Object.entries(blocks)) {
      if (v.includes(`{${k}}`)) {
        v = v.split(`{${k}}`).join(String(val ?? ""));
      }
    }
    return v;
  };
  let rendered = templateContent;
  const missing = [];
  for (const key of Object.keys(blocks)) {
    if (!rendered.includes(`{{${key}}}`)) {
      // 模板里没有该占位符：跳过（可能是模板不含此块）
      continue;
    }
    const value = expandValue(blocks[key]).trimEnd();
    rendered = rendered.replace(`{{${key}}}`, value);
  }
  // 检查是否还有未填充的占位符
  const left = rendered.match(/\{\{([A-Z0-9_]+)\}\}/g) || [];
  for (const ph of left) {
    const key = ph.slice(2, -2);
    if (!missing.includes(key)) missing.push(key);
  }
  return { content: rendered, missing };
}

function diffLines(a, b) {
  const al = String(a || "").split("\n");
  const bl = String(b || "").split("\n");
  // 简单前缀对齐统计：返回变更行数 + 一个 5 行摘要
  let added = 0;
  let removed = 0;
  let i = 0;
  const min = Math.min(al.length, bl.length);
  for (; i < min; i += 1) {
    if (al[i] !== bl[i]) {
      added += 1;
      removed += 1;
    }
  }
  added += Math.max(0, bl.length - min);
  removed += Math.max(0, al.length - min);
  return { added, removed, oldLines: al.length, newLines: bl.length };
}

export function createAlertScriptTemplate({ rootDir = process.cwd() } = {}) {
  const resolve = (name) => path.join(rootDir, name);

  /** 读取条目的模板文件。 */
  async function loadTemplate(templateName) {
    const file = resolve(`config/alert-templates/${templateName}.py.tmpl`);
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        throw Object.assign(new Error(`模板不存在：${templateName}（config/alert-templates/${templateName}.py.tmpl）`), { statusCode: 404 });
      }
      throw error;
    }
  }

  /** 预览：渲染脚本 + 与仓库当前脚本 diff。不改动文件。 */
  async function previewUpdate(entry) {
    const templateName = entry.templateName;
    if (!templateName) {
      throw Object.assign(new Error("条目未配置 templateName"), { statusCode: 400 });
    }
    const templateContent = await loadTemplate(templateName);
    const { content, missing } = renderScript(templateContent, entry.sqlBlocks);
    if (missing.length) {
      return {
        ok: false,
        missing,
        rendered: content,
        note: `模板存在未填充的占位符：${missing.join(", ")}`,
      };
    }
    // 与仓库当前脚本对比
    let current = "";
    let currentExists = false;
    let repoPath = "";
    if (entry.repoDir && entry.scriptPath) {
      repoPath = path.join(entry.repoDir, entry.scriptPath);
      try {
        current = await readFile(repoPath, "utf8");
        currentExists = true;
      } catch {
        current = "";
      }
    }
    const diff = diffLines(current, content);
    return {
      ok: true,
      rendered: content,
      currentExists,
      repoPath,
      diff,
      length: content.length,
      note: currentExists ? "脚本将覆盖仓库中现有文件" : "仓库中不存在该脚本文件（将新建）",
    };
  }

  /** 全链路：渲染 → 写仓库 → git commit+push → SSH 部署到目标机。 */
  async function applyUpdate(entry, { commitMessage } = {}) {
    const preview = await previewUpdate(entry);
    if (!preview.ok) {
      throw Object.assign(new Error(`脚本渲染不完整：${preview.note}`), { statusCode: 400 });
    }
    const content = preview.rendered;

    // 1. 写入本地仓库文件
    let repoFile = "";
    let gitResult = null;
    if (entry.repoDir && entry.scriptPath) {
      repoFile = path.join(entry.repoDir, entry.scriptPath);
      await mkdir(path.dirname(repoFile), { recursive: true });
      await writeFile(repoFile, content, "utf8");
      // 2. git commit + push
      const msg = commitMessage || `update(alert): 更新 ${entry.name} 校验语句`;
      const messages = [];
      gitResult = await runCmd("git", ["add", entry.scriptPath], { cwd: entry.repoDir });
      messages.push(`git add: ${gitResult.ok ? "ok" : gitResult.stderr || gitResult.error}`);
      if (gitResult.ok) {
        const commit = await runCmd("git", ["commit", "-m", msg], { cwd: entry.repoDir });
        messages.push(commit.ok ? "已提交" : `提交：${commit.stderr || commit.error}`);
        const push = await runCmd("git", ["push"], { cwd: entry.repoDir });
        messages.push(push.ok ? "已推送到远端" : `推送：${push.stderr || push.error}`);
        gitResult = { ok: push.ok && commit.ok, code: push.code, stdout: push.stdout, stderr: push.stderr };
      }
    }

    // 3. SSH 部署到目标机（base64）
    let deployResult = null;
    if (entry.runVia === "ssh" && entry.remoteScriptPath) {
      const b64 = Buffer.from(content, "utf8").toString("base64");
      const writeCmd = `printf '%s' '${b64}' | base64 -d > ${entry.remoteScriptPath}`;
      const args = [];
      if (entry.sshPort) args.push("-p", String(entry.sshPort));
      args.push("-o", "StrictHostKeyChecking=no");
      args.push(entry.sshHost);
      args.push(writeCmd);
      deployResult = await runCmd("ssh", args, { timeoutMs: 90_000 });
    }

    return {
      ok: true,
      length: content.length,
      repoFile,
      git: gitResult ? { ok: gitResult.ok, stdout: gitResult.stdout, stderr: gitResult.stderr } : null,
      deploy: deployResult ? { ok: deployResult.ok, stdout: deployResult.stdout, stderr: deployResult.stderr } : null,
    };
  }

  return { renderScript, previewUpdate, applyUpdate, loadTemplate };
}
