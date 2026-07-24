import { apiGet, apiPost } from "../api.js";
import { state } from "../state.js";
import { escapeHtml } from "../view-utils.js";

const STATUS_LABELS = {
  confirmed_anomaly: "确认异常",
  false_positive: "误判转正常",
  data_quality_issue: "数据质量问题",
  unverified: "证据不足",
};

export function renderAnomalyVerifier(root) {
  const status = state.anomalyVerifierStatus || {};
  const result = state.anomalyVerifierResult;
  const runStatus = state.anomalyVerifierRunStatus;
  const evaluation = status.evaluation?.summary || {};
  const lastVerification = result?.verification || status.lastResult?.verification || {};
  const ready = status.enabled && status.configured;

  root.innerHTML = `
    <div class="page-header batch-hero agent-hero">
      <div>
        <div class="agent-eyebrow">DATABASE-BACKED VERIFICATION</div>
        <h1 class="page-title">异常复核 Agent</h1>
        <p class="page-note">在波动规则和告警通知之间，用下游数据库证据复核异常；只有高置信度误判才会标为正常。</p>
      </div>
      <div class="hero-stats agent-hero-stats" aria-label="Agent 状态概览">
        ${statCard("运行状态", ready ? "已就绪" : status.enabled ? "待配置" : "未启用", ready ? "ok" : "warn")}
        ${statCard("血缘计划", status.planCount ?? "-", status.planCount > 0 ? "ok" : "warn")}
        ${statCard("推理模型", status.llm?.model || "qwen3.6-plus")}
        ${statCard("误判基线", evaluation.falsePositives ?? "-")}
      </div>
    </div>

    ${renderReadiness(status)}
    ${renderRunStatus(runStatus)}

    <div class="agent-layout">
      <section class="panel agent-control-panel">
        <div class="detail-header compact-header">
          <div>
            <h2 class="panel-title">运行一次复核</h2>
            <p class="muted">读取最近一次 Metabase 巡检结果，匹配血缘计划并执行 SR Box 只读 SQL。</p>
          </div>
          <button id="agent-run" class="primary" ${runStatus?.type === "loading" ? "disabled" : ""}>
            ${runStatus?.type === "loading" ? "复核中…" : "复核最近异常"}
          </button>
        </div>
        <label class="agent-force-option">
          <input id="agent-force" type="checkbox" />
          <span>
            <strong>强制执行</strong>
            <small>即使正式开关关闭也运行；无匹配血缘时仍会保留原异常。</small>
          </span>
        </label>
        <div class="agent-pipeline">
          ${pipelineStep("01", "接收候选", "读取波动、缺数及盘中异常，保留原始触发证据。")}
          ${pipelineStep("02", "下游重算", "按国家和卡片匹配血缘计划，经 SR Box 执行只读查询。")}
          ${pipelineStep("03", "确定性裁决", "数据库结论决定最终状态，Qwen 只负责解释与调查建议。")}
        </div>
      </section>

      <section class="panel agent-config-panel">
        <h2 class="panel-title">当前配置</h2>
        <dl class="agent-config-list">
          ${configRow("Agent 开关", status.enabled ? "已开启" : "已关闭")}
          ${configRow("已启用计划", `${status.planCount || 0} 个`)}
          ${configRow("单次上限", `${status.maxCandidates || 20} 个候选`)}
          ${configRow("LLM", status.llm?.enabled ? "已开启" : "已关闭")}
          ${configRow("模型", status.llm?.model || "qwen3.6-plus")}
          ${configRow("Key 环境变量", status.llm?.apiKeyEnv || "DASHSCOPE_API_KEY")}
        </dl>
        <p class="agent-config-hint">正式配置文件不会展示 API Key；未验证和低置信度结果始终保留为异常。</p>
      </section>
    </div>

    ${renderEvaluation(status.evaluation)}
    ${renderVerificationResult(result, lastVerification)}
  `;

  root.querySelector("#agent-run")?.addEventListener("click", () => {
    const force = root.querySelector("#agent-force")?.checked === true;
    void runVerification(root, force);
  });

  if (!state.anomalyVerifierLoaded) {
    void loadStatus(root);
  }
}

async function loadStatus(root) {
  state.anomalyVerifierLoaded = true;
  try {
    state.anomalyVerifierStatus = await apiGet("/api/anomaly-verifier/status");
  } catch (error) {
    state.anomalyVerifierRunStatus = {
      type: "error",
      title: "Agent 状态读取失败",
      detail: error.message,
    };
  }
  renderAnomalyVerifier(root);
}

async function runVerification(root, force) {
  state.anomalyVerifierRunStatus = {
    type: "loading",
    title: "正在复核最近一次异常",
    detail: "数据库查询可能需要一些时间，请不要重复提交。",
  };
  renderAnomalyVerifier(root);
  try {
    const result = await apiPost("/api/anomaly-verifier/verify", { force });
    state.anomalyVerifierResult = result;
    state.anomalyVerifierRunStatus = {
      type: "success",
      title: result.verification?.enabled ? "复核执行完成" : "Agent 尚未启用",
      detail: result.verification?.enabled
        ? `处理 ${result.verification.candidateCount || 0} 个候选，识别 ${result.verification.falsePositiveCount || 0} 个误判。`
        : "请启用正式配置，或勾选“强制执行”进行安全回放。",
    };
    state.anomalyVerifierStatus = await apiGet("/api/anomaly-verifier/status");
  } catch (error) {
    state.anomalyVerifierRunStatus = {
      type: "error",
      title: "复核执行失败",
      detail: error.payload?.errors?.join("\n") || error.message,
    };
  }
  renderAnomalyVerifier(root);
}

function renderReadiness(status) {
  if (status.enabled && status.configured) {
    return `
      <div class="agent-readiness is-ready">
        <span class="agent-readiness-icon">✓</span>
        <div><strong>Agent 已就绪</strong><p>复核开关和血缘计划均已配置，可对最近巡检结果执行二次验证。</p></div>
      </div>
    `;
  }
  const reason = status.enabled
    ? "Agent 已开启，但还没有启用的数据库血缘计划。"
    : "正式复核开关尚未开启，当前批量巡检不会自动过滤误判。";
  return `
    <div class="agent-readiness">
      <span class="agent-readiness-icon">!</span>
      <div><strong>还需要完成配置</strong><p>${escapeHtml(reason)}可先使用强制回放检查候选覆盖情况。</p></div>
    </div>
  `;
}

function renderRunStatus(status) {
  if (!status) return "";
  return `
    <div class="sandbox-status ${escapeHtml(status.type)} agent-run-status">
      <strong>${escapeHtml(status.title)}</strong>
      <span>${escapeHtml(status.detail || "")}</span>
    </div>
  `;
}

function renderEvaluation(evaluation) {
  if (!evaluation?.summary) return "";
  const summary = evaluation.summary;
  return `
    <section class="panel agent-evaluation">
      <div class="detail-header compact-header">
        <div>
          <h2 class="panel-title">历史评测基线</h2>
          <p class="muted">使用五国下游表重算形成的 ground truth，用于衡量 Agent 是否真正识别误判。</p>
        </div>
        <span class="badge ok">${escapeHtml(formatTime(evaluation.evaluatedAt))}</span>
      </div>
      <div class="auto-summary agent-summary-grid">
        ${summaryItem("原始告警", summary.rawAlerts)}
        ${summaryItem("语义事件", summary.semanticAlerts)}
        ${summaryItem("重复展示", summary.duplicateAlerts)}
        ${summaryItem("确认误判", summary.falsePositives)}
        ${summaryItem("逾期已复核", summary.overdueVerified)}
        ${summaryItem("转化已复核", summary.conversionVerified)}
      </div>
      <div class="agent-country-bar">
        ${Object.entries(summary.falsePositivesByCountry || {}).map(([country, count]) => `
          <span><strong>${escapeHtml(country)}</strong>${escapeHtml(count)} 个误判</span>
        `).join("")}
      </div>
    </section>
  `;
}

function renderVerificationResult(result, verification) {
  if (!verification?.enabled && !result) {
    return `
      <section class="panel agent-empty-result">
        <div class="agent-empty-orb">智</div>
        <div>
          <h2>等待第一次复核</h2>
          <p>运行后会在这里展示确认异常、误判转正常、数据质量问题和证据不足的明细。</p>
        </div>
      </section>
    `;
  }
  const records = verification?.records || [];
  return `
    <section class="panel agent-result-panel">
      <div class="detail-header compact-header">
        <div>
          <h2 class="panel-title">复核结果</h2>
          <p class="muted">最近巡检：${escapeHtml(formatTime(result?.checkedAt || verification?.checkedAt))}</p>
        </div>
        <span class="badge ${verification?.status === "completed" ? "ok" : "warn"}">${escapeHtml(verification?.status || "disabled")}</span>
      </div>
      <div class="auto-summary agent-summary-grid">
        ${summaryItem("候选", verification?.candidateCount || 0)}
        ${summaryItem("确认异常", verification?.confirmedCount || 0)}
        ${summaryItem("误判转正常", verification?.falsePositiveCount || 0)}
        ${summaryItem("数据质量", verification?.dataQualityIssueCount || 0)}
        ${summaryItem("证据不足", verification?.unverifiedCount || 0)}
      </div>
      ${records.length ? renderRecords(records) : `<p class="muted agent-no-records">当前没有可展示的复核记录。</p>`}
    </section>
  `;
}

function renderRecords(records) {
  return `
    <div class="table-wrap agent-records">
      <table>
        <thead><tr><th>状态</th><th>计划</th><th>原因</th><th>置信度</th><th>血缘</th></tr></thead>
        <tbody>
          ${records.slice(0, 100).map((record) => `
            <tr>
              <td><span class="badge ${statusBadge(record.status)}">${escapeHtml(STATUS_LABELS[record.status] || record.status)}</span></td>
              <td><code>${escapeHtml(record.planId || "-")}</code></td>
              <td>${escapeHtml(record.reason || "-")}</td>
              <td>${escapeHtml(formatConfidence(record.confidence))}</td>
              <td>${escapeHtml((record.sourceTables || []).join(", ") || "-")}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
      ${records.length > 100 ? `<p class="muted">仅展示前 100 条，共 ${escapeHtml(records.length)} 条。</p>` : ""}
    </div>
  `;
}

function statCard(label, value, tone = "") {
  return `<article class="${tone ? `is-${tone}` : ""}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`;
}

function summaryItem(label, value) {
  return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value ?? "-")}</strong></div>`;
}

function pipelineStep(number, title, detail) {
  return `<article><span>${number}</span><div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(detail)}</p></div></article>`;
}

function configRow(label, value) {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

function statusBadge(status) {
  if (status === "confirmed_anomaly") return "danger";
  if (status === "false_positive") return "ok";
  return "warn";
}

function formatConfidence(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${Math.round(number * 100)}%` : "-";
}

function formatTime(value) {
  if (!value) return "暂无";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", { hour12: false });
}
