import { apiPost } from "../api.js";
import { state } from "../state.js";
import { escapeHtml } from "../view-utils.js";

export function renderQualityRuleGeneration(root) {
  const result = state.qualityRuleGenerationResult;
  root.innerHTML = `
    <div class="page-header batch-hero">
      <div>
        <h1 class="page-title">智能告警生成</h1>
        <p class="page-note">读取 Google 确认表，按国家查看哪些表需要自动生成校验 SQL、哪些已标记上线，以及生成出的 src_sql / dest_sql。</p>
      </div>
      ${renderHeroStats(result)}
    </div>

    <section class="panel quality-rule-panel">
      <div class="detail-header compact-header">
        <div>
          <h2 class="panel-title">确认表看板</h2>
          <p class="muted">当前写入位置为 Google Sheet。真实生成仍建议由 n8n/远端 <code>quality-rule-automation-shared</code> 执行，平台负责集中查看和后续触发。</p>
        </div>
        <div class="wattrel-button-row">
          <button id="quality-rule-new-row" class="secondary">新增记录</button>
          <button id="quality-rule-load-mock" class="secondary">加载模拟数据</button>
          <button id="quality-rule-refresh-sheet" class="primary">读取 Google 表</button>
        </div>
      </div>
      ${renderStatus()}
      ${renderEditor()}
      ${result ? renderResult(result) : renderGuide()}
    </section>
  `;

  root.querySelector("#quality-rule-new-row")?.addEventListener("click", () => {
    state.qualityRuleGenerationEditor = {
      open: true,
      row: emptyEditorRow(),
      status: null,
    };
    renderQualityRuleGeneration(root);
    root.querySelector("#quality-rule-editor")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  root.querySelector("#quality-rule-load-mock")?.addEventListener("click", () => {
    void loadQualityRuleGeneration(root, "mock");
  });
  root.querySelector("#quality-rule-refresh-sheet")?.addEventListener("click", () => {
    void loadQualityRuleGeneration(root, "real");
  });
  root.querySelectorAll("[data-quality-country]").forEach((button) => {
    button.addEventListener("click", () => {
      state.qualityRuleGenerationCountry = button.getAttribute("data-quality-country") || "";
      renderQualityRuleGeneration(root);
      root.querySelector("#quality-rule-country-detail")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
  root.querySelectorAll("[data-quality-edit-row]").forEach((button) => {
    button.addEventListener("click", () => {
      const row = findRow(button.getAttribute("data-quality-edit-row"));
      state.qualityRuleGenerationEditor = {
        open: true,
        row: { ...emptyEditorRow(), ...(row || {}) },
        status: null,
      };
      renderQualityRuleGeneration(root);
      root.querySelector("#quality-rule-editor")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
  root.querySelector("#quality-rule-cancel-edit")?.addEventListener("click", () => {
    state.qualityRuleGenerationEditor = { open: false, row: null, status: null };
    renderQualityRuleGeneration(root);
  });
  root.querySelector("#quality-rule-editor-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitQualityRuleEditor(root, event.currentTarget);
  });

  if (!state.qualityRuleGenerationLoaded && state.qualityRuleGenerationStatus?.type !== "loading") {
    void loadQualityRuleGeneration(root, "mock");
  }
}

async function loadQualityRuleGeneration(root, mode) {
  state.qualityRuleGenerationStatus = {
    type: "loading",
    title: mode === "mock" ? "正在加载模拟确认表" : "正在读取 Google 确认表",
    detail: mode === "mock" ? "模拟数据只用于页面效果预览。" : "如果表格未开放 CSV 访问或网络不可达，会显示错误详情。",
  };
  renderQualityRuleGeneration(root);
  try {
    const result = await apiPost("/api/quality-rule-generation/sheet", { mode });
    state.qualityRuleGenerationResult = result;
    state.qualityRuleGenerationLoaded = true;
    ensureSelectedCountry(result);
    state.qualityRuleGenerationStatus = {
      type: "success",
      title: result.source === "mock" ? "已加载模拟数据" : "已读取 Google 确认表",
      detail: `共 ${result.rowCount || 0} 行，涉及 ${result.summary?.countryCount || 0} 个国家，${result.summary?.autoGenerateCount || 0} 条待自动生成。`,
    };
  } catch (error) {
    state.qualityRuleGenerationStatus = {
      type: "error",
      title: "确认表读取失败",
      detail: error.payload?.errors?.join("\n") || error.message,
    };
  }
  renderQualityRuleGeneration(root);
}

async function submitQualityRuleEditor(root, form) {
  const row = Object.fromEntries(new FormData(form).entries());
  state.qualityRuleGenerationEditor = {
    open: true,
    row,
    status: {
      type: "loading",
      title: "正在提交到写入通道",
      detail: "后端会调用配置的 writeWebhookUrl，由 n8n 或 Apps Script 写入 Google 表格。",
    },
  };
  renderQualityRuleGeneration(root);
  try {
    const result = await apiPost("/api/quality-rule-generation/submit", { row });
    state.qualityRuleGenerationEditor = {
      open: false,
      row: null,
      status: {
        type: "success",
        title: "提交成功",
        detail: `已提交 ${result.row?.country || ""} / ${result.row?.database || ""}.${result.row?.table || ""}，正在刷新确认表。`,
      },
    };
    await loadQualityRuleGeneration(root, "real");
  } catch (error) {
    state.qualityRuleGenerationEditor = {
      open: true,
      row,
      status: {
        type: "error",
        title: "提交失败",
        detail: error.payload?.errors?.join("\n") || error.message,
      },
    };
    renderQualityRuleGeneration(root);
  }
}

function renderHeroStats(result) {
  const summary = result?.summary || {};
  return `
    <div class="hero-stats" aria-label="智能告警生成概览">
      ${statCard("表单行数", result?.rowCount ?? "-")}
      ${statCard("国家", summary.countryCount ?? "-")}
      ${statCard("待自动生成", summary.autoGenerateCount ?? "-")}
      ${statCard("已标记上线", summary.needApplyCount ?? "-")}
      ${statCard("已有 SQL", summary.generatedSqlCount ?? "-")}
    </div>
  `;
}

function renderStatus() {
  const status = state.qualityRuleGenerationStatus;
  if (!status) {
    return "";
  }
  return `
    <div class="sandbox-status ${escapeHtml(status.type)}">
      <strong>${escapeHtml(status.title)}</strong>
      <span>${escapeHtml(status.detail || "")}</span>
    </div>
  `;
}

function renderGuide() {
  return `
    <div class="wattrel-guide-grid">
      <article>
        <strong>1. 读取确认表</strong>
        <span>从 Google Sheet 读取国家、数据库、表名、是否自动生成、是否上线、src_sql 和 dest_sql。</span>
      </article>
      <article>
        <strong>2. 按国家查看</strong>
        <span>每个国家都会展示待生成数量、上线数量和具体表级 SQL 明细。</span>
      </article>
      <article>
        <strong>3. 后续接生成</strong>
        <span>下一步可以接 n8n webhook 或 SSH 远端项目，触发单表智能生成。</span>
      </article>
    </div>
  `;
}

function renderEditor() {
  const editor = state.qualityRuleGenerationEditor;
  if (!editor?.open) {
    return "";
  }
  const row = { ...emptyEditorRow(), ...(editor.row || {}) };
  return `
    <section id="quality-rule-editor" class="quality-editor-panel">
      <div class="detail-header compact-header">
        <div>
          <h2 class="panel-title">${row.sheetRowNumber ? "编辑确认表记录" : "新增确认表记录"}</h2>
          <p class="muted">保存会提交到后端配置的写入 webhook；平台不直接保存 Google 凭证。</p>
        </div>
        <button id="quality-rule-cancel-edit" class="secondary" type="button">收起</button>
      </div>
      ${renderEditorStatus(editor.status)}
      <form id="quality-rule-editor-form" class="quality-editor-form">
        <input type="hidden" name="sheetRowNumber" value="${escapeHtml(row.sheetRowNumber || "")}" />
        ${inputField("国家", "countryRaw", row.countryRaw || row.country, "例如 CN / 中国 / PH")}
        ${inputField("数据库", "database", row.database, "例如 dwd_sec")}
        ${inputField("表名", "table", row.table, "例如 dwd_cst_pay_cost_detail")}
        ${inputField("唯一键", "candidateKey", row.candidateKey, "例如 dwd_sec::table::cnt")}
        ${selectField("是否需要自动生成", "autoGenerate", row.autoGenerate)}
        ${selectField("是否上线", "needApply", row.needApply)}
        ${inputField("校验字段", "metricField", row.metricField, "可选")}
        ${inputField("操作人", "operator", row.operator, "可选")}
        ${textareaField("src_sql", "srcSql", row.srcSql)}
        ${textareaField("dest_sql", "destSql", row.destSql)}
        ${textareaField("人工确认/备注", "humanCheck", row.humanCheck || row.notes)}
        <label class="quality-editor-field quality-editor-field-full">
          <span>补充备注</span>
          <input name="notes" value="${escapeHtml(row.notes || "")}" placeholder="可选：生成背景、暂不上线原因等" />
        </label>
        <div class="quality-editor-actions">
          <button class="primary" type="submit">保存到 Google 表格</button>
          <span class="muted">未配置 <code>writeWebhookUrl</code> 时会阻止提交，并提示配置方式。</span>
        </div>
      </form>
    </section>
  `;
}

function renderEditorStatus(status) {
  if (!status) {
    return "";
  }
  return `
    <div class="sandbox-status ${escapeHtml(status.type)}">
      <strong>${escapeHtml(status.title)}</strong>
      <span>${escapeHtml(status.detail || "")}</span>
    </div>
  `;
}

function renderResult(result) {
  return `
    <div class="auto-summary">
      ${summaryItem("表单行数", result.rowCount || 0)}
      ${summaryItem("涉及国家", result.summary?.countryCount || 0)}
      ${summaryItem("待自动生成", result.summary?.autoGenerateCount || 0)}
      ${summaryItem("已标记上线", result.summary?.needApplyCount || 0)}
    </div>
    ${renderCountryGrid(result)}
    ${renderCountryDetail(result)}
  `;
}

function renderCountryGrid(result) {
  const countries = result.countries || [];
  if (!countries.length) {
    return `<p class="muted">确认表暂无可展示数据。</p>`;
  }
  return `
    <section class="sub-panel">
      <div class="detail-header compact-header">
        <div>
          <h2 class="panel-title">各国生成情况</h2>
          <p class="muted">点击国家卡片查看具体表、唯一键和 SQL。</p>
        </div>
      </div>
      <div class="quality-country-grid">
        ${countries.map((country) => {
          const selected = country.country === state.qualityRuleGenerationCountry;
          return `
            <button type="button" class="quality-country-card ${selected ? "is-selected" : ""}" data-quality-country="${escapeHtml(country.country)}">
              <strong>${escapeHtml(displayCountry(country.country, country.countryRaw))}</strong>
              <span>${escapeHtml(country.rowCount)} 行，${escapeHtml(country.tableCount)} 张表</span>
              <div>
                <em>待生成 ${escapeHtml(country.autoGenerateCount)}</em>
                <em>上线 ${escapeHtml(country.needApplyCount)}</em>
                <em>已有 SQL ${escapeHtml(country.generatedSqlCount)}</em>
              </div>
            </button>
          `;
        }).join("")}
      </div>
    </section>
  `;
}

function renderCountryDetail(result) {
  const country = selectedCountry(result);
  if (!country) {
    return "";
  }
  return `
    <section id="quality-rule-country-detail" class="sub-panel">
      <div class="detail-header compact-header">
        <div>
          <h2 class="panel-title">${escapeHtml(displayCountry(country.country, country.countryRaw))} 表级明细</h2>
          <p class="muted">展示确认表里的生成状态、唯一键、源端 SQL 和目标 SQL。</p>
        </div>
      </div>
      <div class="quality-rule-table-list">
        ${country.rows.map((row) => renderRuleRow(row)).join("")}
      </div>
    </section>
  `;
}

function renderRuleRow(row) {
  return `
    <article class="quality-rule-row-card">
      <div class="quality-rule-row-head">
        <div>
          <strong>${escapeHtml(row.database || "-")}.${escapeHtml(row.table || "-")}</strong>
          <span>唯一键：${escapeHtml(row.candidateKey || "-")}</span>
        </div>
        <div>
          ${pill(isTruthyFlag(row.autoGenerate) ? "需要生成" : "不生成", isTruthyFlag(row.autoGenerate) ? "warning" : "neutral")}
          ${pill(isTruthyFlag(row.needApply) ? "已标记上线" : "未上线", isTruthyFlag(row.needApply) ? "success" : "neutral")}
          <button class="mini-action" type="button" data-quality-edit-row="${escapeHtml(row.id || "")}">复制编辑</button>
        </div>
      </div>
      <div class="quality-rule-row-meta">
        ${field("提交时间", row.submittedAt || "-")}
        ${field("校验字段", row.metricField || "-")}
        ${field("操作人", row.operator || "-")}
        ${field("备注", row.notes || "-")}
      </div>
      ${renderSqlDetail("src_sql", row.srcSql)}
      ${renderSqlDetail("dest_sql", row.destSql)}
      ${row.humanCheck ? renderSqlDetail("human_check", row.humanCheck) : ""}
    </article>
  `;
}

function inputField(label, name, value, placeholder = "") {
  return `
    <label class="quality-editor-field">
      <span>${escapeHtml(label)}</span>
      <input name="${escapeHtml(name)}" value="${escapeHtml(value || "")}" placeholder="${escapeHtml(placeholder)}" />
    </label>
  `;
}

function selectField(label, name, value) {
  const current = String(value || "");
  return `
    <label class="quality-editor-field">
      <span>${escapeHtml(label)}</span>
      <select name="${escapeHtml(name)}">
        ${option("", "未填写", current)}
        ${option("是", "是", current)}
        ${option("否", "否", current)}
      </select>
    </label>
  `;
}

function option(value, label, current) {
  const selected = String(current) === String(value) || (value === "是" && isTruthyFlag(current));
  return `<option value="${escapeHtml(value)}" ${selected ? "selected" : ""}>${escapeHtml(label)}</option>`;
}

function textareaField(label, name, value) {
  return `
    <label class="quality-editor-field quality-editor-field-full">
      <span>${escapeHtml(label)}</span>
      <textarea name="${escapeHtml(name)}" rows="4" spellcheck="false">${escapeHtml(value || "")}</textarea>
    </label>
  `;
}

function renderSqlDetail(label, value) {
  if (!value) {
    return "";
  }
  return `
    <details class="wattrel-sql-detail">
      <summary>${escapeHtml(label)}</summary>
      <pre>${escapeHtml(value)}</pre>
    </details>
  `;
}

function field(label, value) {
  return `
    <div>
      <span>${escapeHtml(label)}</span>
      <strong title="${escapeHtml(value)}">${escapeHtml(value)}</strong>
    </div>
  `;
}

function pill(text, tone) {
  return `<span class="pill ${escapeHtml(tone)}">${escapeHtml(text)}</span>`;
}

function statCard(label, value) {
  return `
    <article>
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </article>
  `;
}

function summaryItem(label, value) {
  return `
    <div class="info-item">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value ?? "-")}</strong>
    </div>
  `;
}

function ensureSelectedCountry(result = {}) {
  const countries = result.countries || [];
  if (!countries.find((country) => country.country === state.qualityRuleGenerationCountry)) {
    state.qualityRuleGenerationCountry = countries[0]?.country || "";
  }
}

function findRow(id) {
  return (state.qualityRuleGenerationResult?.rows || []).find((row) => String(row.id) === String(id)) || null;
}

function emptyEditorRow() {
  return {
    sheetRowNumber: "",
    countryRaw: "",
    country: "",
    database: "",
    table: "",
    autoGenerate: "是",
    needApply: "",
    metricField: "",
    candidateKey: "",
    srcSql: "",
    destSql: "",
    humanCheck: "",
    operator: "",
    notes: "",
  };
}

function selectedCountry(result = {}) {
  const countries = result.countries || [];
  return countries.find((country) => country.country === state.qualityRuleGenerationCountry) || countries[0] || null;
}

function displayCountry(country, raw) {
  const names = {
    CN: "中国 / CN",
    INE: "印尼 / INE",
    PH: "菲律宾 / PH",
    TH: "泰国 / TH",
    PK: "巴基斯坦 / PK",
    MX: "墨西哥 / MX",
  };
  return names[country] || [raw, country].filter(Boolean).join(" / ") || "未归属";
}

function isTruthyFlag(value) {
  return ["1", "true", "yes", "y", "是", "需要", "上线"].includes(String(value || "").trim().toLowerCase());
}
