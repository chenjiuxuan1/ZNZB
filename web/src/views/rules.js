import { apiPut } from "../api.js";
import { state } from "../state.js";
import {
  describeRule,
  escapeHtml,
  json,
  ruleCards,
  ruleColumns,
  ruleDashboard,
  ruleScope,
  ruleTypeLabel,
} from "../view-utils.js";

export function renderRules(root, { reload }) {
  const config = state.rulesConfig || { rules: [] };
  const countries = state.countries?.countries || [];
  const rules = config.rules || [];
  const selectedIndex = Number(state.selected.ruleIndex || 0);
  const selectedRule = rules[selectedIndex] || rules[0] || {};

  root.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">规则配置</h1>
        <p class="page-note">每条规则会按国家、看板、卡片和字段匹配后运行。默认展示解释信息，完整 JSON 放在高级编辑区。</p>
      </div>
      <button class="primary" id="save-rules">保存高级 JSON</button>
    </div>
    <div class="notice">
      <strong>作用范围</strong>
      <span>未写 countryCode/countryCodes 的规则默认适用于全部国家；写了 exclude 的规则会排除指定国家或卡片；写了 countryCode/countryCodes 的规则只对这些国家生效。</span>
    </div>
    <div class="rules-layout">
      <section class="panel">
        <h2 class="panel-title">规则列表</h2>
        <div class="rule-list">
          ${rules.map((rule, index) => `
            <button class="rule-row ${index === selectedIndex ? "selected" : ""}" data-rule-index="${index}">
              <span class="rule-index">#${index + 1}</span>
              <span>
                <strong>${escapeHtml(ruleTypeLabel(rule.type))}</strong>
                <small>${escapeHtml(ruleScope(rule, countries))}</small>
              </span>
            </button>
          `).join("")}
        </div>
      </section>
      <section class="panel">
        ${renderRuleDetail(selectedRule, selectedIndex, countries)}
      </section>
    </div>
    <details class="advanced">
      <summary>高级：编辑完整 JSON</summary>
      <textarea id="rules-json" class="large-editor">${escapeHtml(json(config))}</textarea>
      <p class="muted">保存会做结构校验。密钥字段如果显示为 <code>&lt;hidden&gt;</code>，保存时会保留原值。</p>
    </details>
    <p id="rules-status" class="muted"></p>
  `;

  root.querySelectorAll("[data-rule-index]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selected.ruleIndex = Number(button.dataset.ruleIndex);
      renderRules(root, { reload });
    });
  });

  root.querySelector("#save-rules").addEventListener("click", async () => {
    const status = root.querySelector("#rules-status");
    try {
      const next = JSON.parse(root.querySelector("#rules-json").value);
      await apiPut("/api/rules", next);
      status.className = "success";
      status.textContent = "保存成功。";
      await reload();
    } catch (error) {
      status.className = "error";
      status.textContent = error.payload?.errors?.join("\n") || error.message;
    }
  });
}

function renderRuleDetail(rule, index, countries) {
  if (!rule?.type) {
    return `<p class="muted">暂无规则。</p>`;
  }
  return `
    <div class="detail-header">
      <div>
        <h2 class="panel-title">#${index + 1} ${escapeHtml(ruleTypeLabel(rule.type))}</h2>
        <p class="muted">${escapeHtml(describeRule(rule))}</p>
      </div>
      <span class="badge">${escapeHtml(rule.type)}</span>
    </div>
    <div class="info-grid">
      ${infoItem("适用国家", ruleScope(rule, countries))}
      ${infoItem("目标看板", ruleDashboard(rule))}
      ${infoItem("目标卡片", ruleCards(rule))}
      ${infoItem("检查字段", ruleColumns(rule))}
      ${infoItem("日期字段", rule.dateColumn || "按规则自动识别")}
      ${infoItem("时区", rule.timezone || "未指定")}
    </div>
    <h3 class="section-title">关键参数</h3>
    <div class="pill-list">
      ${renderParameterPills(rule)}
    </div>
    ${rule.context ? `<p class="context-note">${escapeHtml(rule.context)}</p>` : ""}
    ${rule.exclude?.length ? `
      <h3 class="section-title">排除条件</h3>
      <ul class="plain-list">
        ${rule.exclude.map((item) => `<li>${escapeHtml(ruleScope(item, countries))} ${escapeHtml(ruleCards(item))}</li>`).join("")}
      </ul>
    ` : ""}
    <details class="advanced compact">
      <summary>查看本规则 JSON</summary>
      <pre class="code">${escapeHtml(json(rule))}</pre>
    </details>
  `;
}

function infoItem(label, value) {
  return `
    <div class="info-item">
      <span>${label}</span>
      <strong>${escapeHtml(value || "-")}</strong>
    </div>
  `;
}

function renderParameterPills(rule) {
  const keys = [
    "requiredLagDays",
    "completeLagDays",
    "maxDropRate",
    "maxRiseRate",
    "maxAbsDelta",
    "maxAbsChangeRate",
    "minAbsDelta",
    "minPrevious",
    "maxAnomaliesPerCard",
    "allowedDelayMinutes",
  ];
  const pills = keys
    .filter((key) => rule[key] !== undefined)
    .map((key) => `<span class="pill">${escapeHtml(key)} = ${escapeHtml(rule[key])}</span>`);
  if (rule.parameters?.length) {
    pills.push(`<span class="pill">Metabase 参数 ${rule.parameters.length} 个</span>`);
  }
  return pills.join("") || `<span class="muted">没有额外阈值，按规则默认逻辑执行。</span>`;
}
