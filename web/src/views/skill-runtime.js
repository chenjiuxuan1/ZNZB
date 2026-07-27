import { apiGet, apiPost } from "../api.js";
import { state } from "../state.js";
import { escapeHtml } from "../view-utils.js";

const COUNTRY_LABELS = {
  cn: "中国 CN",
  id: "印尼 ID",
  th: "泰国 TH",
  mx: "墨西哥 MX",
  ph: "菲律宾 PH",
  pk: "巴基斯坦 PK",
};

export function renderSkillRuntime(root) {
  const status = state.skillRuntimeStatus || {};
  const bundle = status.fullBundle || {};
  const srBox = status.srBox || {};
  const sso = srBox.sso || {};
  const runStatus = state.skillRuntimeRunStatus;
  const result = state.skillRuntimeResult;
  const busy = runStatus?.type === "loading";

  root.innerHTML = `
    <div class="page-header batch-hero skill-hero">
      <div>
        <div class="agent-eyebrow">BUNDLED SKILL RUNTIME</div>
        <h1 class="page-title">Skill 运行中心</h1>
        <p class="page-note">全量数仓 Skill 已随值班系统部署；SR Box 通过生产网关执行受控只读查询，并为异常复核 Agent 提供数据库证据。</p>
      </div>
      <div class="hero-stats skill-hero-stats">
        ${statCard("运行时", status.available ? "已安装" : "不可用", status.available ? "ok" : "warn")}
        ${statCard("Skill", bundle.skillCount ?? "-")}
        ${statCard("Skill Pack", bundle.packCount ?? "-")}
        ${statCard("SR Box SSO", sso.valid ? "已登录" : "未登录", sso.valid ? "ok" : "warn")}
      </div>
    </div>

    ${renderRunStatus(runStatus)}

    <div class="skill-grid">
      <section class="panel skill-bundle-panel">
        <div class="detail-header compact-header">
          <div>
            <h2 class="panel-title">全量 Skills</h2>
            <p class="muted">来自全量 Skill ZIP，保留建模、知识、SQL、SR 和 DS 能力定义。</p>
          </div>
          <button id="skill-refresh" ${busy ? "disabled" : ""}>刷新状态</button>
        </div>
        <div class="skill-chip-list">
          ${(bundle.skills || []).map((name) => `<span>${escapeHtml(name)}</span>`).join("") || `<span class="is-empty">尚未发现 Skill</span>`}
        </div>
        <h3 class="skill-subtitle">已注册 Skill Pack</h3>
        <div class="skill-chip-list is-pack">
          ${(bundle.packs || []).map((name) => `<span>${escapeHtml(name)}</span>`).join("") || `<span class="is-empty">尚未发现 Pack</span>`}
        </div>
      </section>

      <section class="panel skill-sr-panel">
        <div class="detail-header compact-header">
          <div>
            <h2 class="panel-title">SR Box 生产执行器</h2>
            <p class="muted">${escapeHtml(srBox.baseUrl || "https://data-map-dev.kuainiu.io")}</p>
          </div>
          <span class="badge ${srBox.available ? "ok" : "danger"}">${srBox.available ? "脚本可用" : "脚本缺失"}</span>
        </div>
        <dl class="agent-config-list">
          ${configRow("执行模式", "只读 SQL")}
          ${configRow("SSO 状态", sso.valid ? "有效" : "未就绪")}
          ${configRow("登录用户", sso.user?.email || sso.user?.displayName || "-")}
          ${configRow("会话来源", sso.source || "none")}
          ${configRow("支持国家", (srBox.supportedCountries || []).join(" / ") || "-")}
        </dl>
        ${sso.valid ? "" : `
          <div class="skill-login-hint">
            <strong>需要先在部署主机完成一次 SSO</strong>
            <code>python3 runtime/skills/standalone/sr_box/scripts/sr_gateway_client.py sso login</code>
          </div>
        `}
      </section>
    </div>

    <section class="panel skill-actions-panel">
      <div class="detail-header compact-header">
        <div>
          <h2 class="panel-title">运行 SR Box 能力</h2>
          <p class="muted">健康检查无需登录；目录、权限和 SQL 查询需要有效的生产 SSO 会话。</p>
        </div>
      </div>
      <div class="skill-actions">
        ${actionButton("health", "网关健康", false, busy)}
        ${actionButton("sso-status", "SSO 状态", false, busy)}
        ${actionButton("whoami", "当前用户", !sso.valid, busy)}
        ${actionButton("permissions", "权限检查", !sso.valid, busy)}
        ${actionButton("catalog", "数据目录", !sso.valid, busy)}
      </div>

      <div class="skill-query-grid">
        <label>
          <span>国家路由</span>
          <select id="skill-country">
            ${Object.entries(COUNTRY_LABELS).map(([code, label]) => `
              <option value="${code}" ${state.skillRuntimeCountry === code ? "selected" : ""}>${escapeHtml(label)}</option>
            `).join("")}
          </select>
        </label>
        <label class="skill-sql-field">
          <span>只读 SQL</span>
          <textarea id="skill-sql" rows="5" spellcheck="false">${escapeHtml(state.skillRuntimeSql || "SELECT 1 AS ok")}</textarea>
        </label>
        <button id="skill-execute" class="primary" ${!sso.valid || busy ? "disabled" : ""}>
          ${busy ? "执行中…" : "执行只读查询"}
        </button>
      </div>
    </section>

    ${renderResult(result)}
  `;

  root.querySelector("#skill-refresh")?.addEventListener("click", () => void loadStatus(root, true));
  root.querySelectorAll("[data-skill-action]").forEach((button) => {
    button.addEventListener("click", () => void runAction(root, button.dataset.skillAction));
  });
  root.querySelector("#skill-country")?.addEventListener("change", (event) => {
    state.skillRuntimeCountry = event.target.value;
  });
  root.querySelector("#skill-sql")?.addEventListener("input", (event) => {
    state.skillRuntimeSql = event.target.value;
  });
  root.querySelector("#skill-execute")?.addEventListener("click", () => {
    void runAction(root, "execute", {
      country: root.querySelector("#skill-country")?.value || "cn",
      sql: root.querySelector("#skill-sql")?.value || "",
    });
  });

  if (!state.skillRuntimeLoaded) {
    void loadStatus(root);
  }
}

async function loadStatus(root, force = false) {
  if (state.skillRuntimeLoaded && !force) return;
  state.skillRuntimeLoaded = true;
  if (force) {
    state.skillRuntimeRunStatus = {
      type: "loading",
      title: "正在刷新 Skill 运行时",
      detail: "检查本地 Skill 套件和 SR Box SSO 状态。",
    };
    renderSkillRuntime(root);
  }
  try {
    state.skillRuntimeStatus = await apiGet("/api/skills/runtime/status");
    if (force) {
      state.skillRuntimeRunStatus = {
        type: "success",
        title: "Skill 状态已刷新",
        detail: `发现 ${state.skillRuntimeStatus.fullBundle?.skillCount || 0} 个 Skill。`,
      };
    }
  } catch (error) {
    state.skillRuntimeRunStatus = {
      type: "error",
      title: "Skill 状态读取失败",
      detail: error.message,
    };
  }
  renderSkillRuntime(root);
}

async function runAction(root, action, payload = {}) {
  state.skillRuntimeRunStatus = {
    type: "loading",
    title: `正在运行 ${action}`,
    detail: action === "execute" ? "查询通过 SR Box 只读保护执行。" : "正在等待运行结果。",
  };
  renderSkillRuntime(root);
  try {
    state.skillRuntimeResult = await apiPost("/api/skills/sr-box/run", { action, ...payload });
    state.skillRuntimeRunStatus = {
      type: "success",
      title: `${action} 执行完成`,
      detail: "结果已在下方展示，敏感凭据已自动隐藏。",
    };
    state.skillRuntimeStatus = await apiGet("/api/skills/runtime/status");
  } catch (error) {
    state.skillRuntimeRunStatus = {
      type: "error",
      title: `${action} 执行失败`,
      detail: error.payload?.errors?.join("\n") || error.message,
    };
  }
  renderSkillRuntime(root);
}

function renderResult(result) {
  if (!result) {
    return `
      <section class="panel skill-empty-result">
        <div class="agent-empty-orb">技</div>
        <div><h2>等待运行</h2><p>执行健康检查、权限检查或只读 SQL 后，结果会显示在这里。</p></div>
      </section>
    `;
  }
  return `
    <section class="panel skill-result-panel">
      <div class="detail-header compact-header">
        <div><h2 class="panel-title">最近运行结果</h2><p class="muted">${escapeHtml(formatTime(result.executedAt))}</p></div>
        <span class="badge ${result.ok ? "ok" : "danger"}">${result.ok ? "成功" : "失败"}</span>
      </div>
      <pre>${escapeHtml(JSON.stringify(result.result, null, 2))}</pre>
    </section>
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

function actionButton(action, label, disabled, busy) {
  return `<button data-skill-action="${action}" ${disabled || busy ? "disabled" : ""}>${escapeHtml(label)}</button>`;
}

function statCard(label, value, tone = "") {
  return `<article class="${tone ? `is-${tone}` : ""}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`;
}

function configRow(label, value) {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}

function formatTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN");
}
