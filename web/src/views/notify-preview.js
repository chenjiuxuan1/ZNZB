import { apiPost } from "../api.js";
import { state } from "../state.js";
import { escapeHtml, json, ruleTypeLabel } from "../view-utils.js";

const ANOMALY_TYPES = [
  "requiredDatePresent",
  "completeDayChange",
  "intradayProgress",
  "intradayTimePointCompleteness",
  "intradayTimePointChange",
  "noData",
  "queryError",
];

export function renderNotifyPreview(root) {
  const draft = getDraft();
  root.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">通知预览</h1>
        <p class="page-note">编辑巡检摘要和异常明细，生成 TV 文案预览；填写 TV bot_id 后可发送一条测试消息。</p>
      </div>
      <div class="button-group">
        <button id="load-real-preview">使用最近巡检结果</button>
        <button class="primary" id="build-preview">生成预览</button>
      </div>
    </div>
    ${draft.sourceLabel ? `<div class="notice"><strong>${escapeHtml(draft.sourceLabel)}</strong><span>已把最近一次规则试跑结果转换为通知预览草稿。你可以继续编辑左侧明细，再生成 TV 文案或测试发送。</span></div>` : ""}
    <div class="notify-layout">
      <section class="panel">
        <h2 class="panel-title">巡检摘要</h2>
        <div class="form-grid">
          ${field("checkedAt", "巡检时间", draft.checkedAt)}
          ${field("checkedCardCount", "检查卡片数", draft.checkedCardCount)}
          ${field("dataQualityAnomalyCount", "数据质量异常数", draft.dataQualityAnomalyCount)}
          ${field("maxAnomalies", "单国家最多展示卡片组", draft.maxAnomalies)}
          ${field("botId", "TV bot_id", draft.botId)}
        </div>
        <p class="muted">测试发送会使用本地 <code>alerts.webhookUrl</code> 配置，只把预览文案发送到你填写的 TV bot_id。</p>
        <div class="detail-header compact-header">
          <h2 class="panel-title">异常明细</h2>
          <button id="add-anomaly">新增异常</button>
        </div>
        <div class="anomaly-editor">
          ${draft.anomalies.map((anomaly, index) => renderAnomalyEditor(anomaly, index)).join("")}
        </div>
        <details class="advanced compact">
          <summary>高级：查看本次预览 result JSON</summary>
          <pre class="code">${escapeHtml(json(buildResultFromDraft(draft)))}</pre>
        </details>
      </section>
      <section class="panel">
        <div class="detail-header compact-header">
          <h2 class="panel-title">TV 文案预览</h2>
          <button id="send-tv-test">测试发送到 TV</button>
        </div>
        <p id="notify-test-status" class="muted"></p>
        <div id="preview-body">
          ${state.notifyError ? `<p class="error">${escapeHtml(state.notifyError)}</p>` : ""}
          ${state.notifyPreview ? renderMessages(state.notifyPreview.messages || []) : `<p class="muted">填写左侧内容后点击“生成预览”。</p>`}
        </div>
      </section>
    </div>
  `;

  bindDraftInputs(root, draft);
  root.querySelector("#add-anomaly").addEventListener("click", () => {
    updateDraftFromDom(root, draft);
    draft.anomalies.push(defaultAnomaly());
    state.notifyPreview = null;
    renderNotifyPreview(root);
  });
  root.querySelectorAll("[data-remove-anomaly]").forEach((button) => {
    button.addEventListener("click", () => {
      updateDraftFromDom(root, draft);
      draft.anomalies.splice(Number(button.dataset.removeAnomaly), 1);
      state.notifyPreview = null;
      renderNotifyPreview(root);
    });
  });
  root.querySelector("#build-preview").addEventListener("click", async () => {
    try {
      updateDraftFromDom(root, draft);
      state.notifyError = "";
      state.notifyPreview = await apiPost("/api/notify-preview", {
        result: buildResultFromDraft(draft),
        options: { maxAnomalies: Number(draft.maxAnomalies || 50) },
      });
    } catch (error) {
      state.notifyPreview = null;
      state.notifyError = error.payload?.errors?.join("\n") || error.message;
    }
    renderNotifyPreview(root);
  });
  root.querySelector("#load-real-preview").addEventListener("click", async () => {
    try {
      state.notifyError = "";
      state.notifyPreview = await apiPost("/api/notify-preview", {});
    } catch (error) {
      state.notifyPreview = null;
      state.notifyError = error.payload?.errors?.join("\n") || error.message;
    }
    renderNotifyPreview(root);
  });
  root.querySelector("#send-tv-test").addEventListener("click", async () => {
    updateDraftFromDom(root, draft);
    const status = root.querySelector("#notify-test-status");
    try {
      const message = firstPreviewMessage();
      const result = await apiPost("/api/notify-test", {
        botId: draft.botId,
        message,
        title: "值班平台测试发送",
      });
      status.className = result.sent ? "success" : "error";
      status.textContent = result.sent
        ? `测试消息已发送到 TV bot_id：${result.botId}`
        : `未发送：${result.reason || "webhook 未配置或发送失败"}`;
    } catch (error) {
      status.className = "error";
      status.textContent = error.payload?.errors?.join("\n") || error.message;
    }
  });
}

function getDraft() {
  if (state.notifyDraft) {
    return state.notifyDraft;
  }
  const summary = state.summary?.lastResult || {};
  state.notifyDraft = {
    checkedAt: summary.checkedAt || new Date().toISOString(),
    checkedCardCount: summary.checkedCardCount || 0,
    dataQualityAnomalyCount: summary.dataQualityAnomalyCount || 0,
    maxAnomalies: 50,
    botId: state.rulesConfig?.alerts?.botId && state.rulesConfig.alerts.botId !== "<hidden>"
      ? state.rulesConfig.alerts.botId
      : "",
    anomalies: [defaultAnomaly()],
  };
  return state.notifyDraft;
}

function defaultAnomaly() {
  const firstCountry = state.countries?.countries?.[0] || {};
  return {
    countryCode: firstCountry.code || "INE",
    countryName: firstCountry.name || "印尼",
    dashboardTitle: "OKR",
    cardTitle: "规模",
    type: "requiredDatePresent",
    message: "统计日期缺少应更新日期",
    dashboardUrl: "",
  };
}

function renderAnomalyEditor(anomaly, index) {
  return `
    <article class="anomaly-card" data-anomaly-index="${index}">
      <div class="entity-card-header">
        <div>
          <h3>异常 ${index + 1}</h3>
          <p>${escapeHtml(ruleTypeLabel(anomaly.type))}</p>
        </div>
        <button data-remove-anomaly="${index}">删除</button>
      </div>
      <div class="form-grid">
        ${field("countryCode", "国家代码", anomaly.countryCode, index)}
        ${field("countryName", "国家名称", anomaly.countryName, index)}
        ${field("dashboardTitle", "看板", anomaly.dashboardTitle, index)}
        ${field("cardTitle", "卡片", anomaly.cardTitle, index)}
      </div>
      <div class="field">
        <label>异常类型</label>
        <select data-draft-field="type" data-anomaly-field="type">
          ${ANOMALY_TYPES.map((type) => `<option value="${type}" ${type === anomaly.type ? "selected" : ""}>${escapeHtml(ruleTypeLabel(type))}</option>`).join("")}
        </select>
      </div>
      <div class="field">
        <label>异常消息</label>
        <textarea data-draft-field="message" data-anomaly-field="message" class="small-editor">${escapeHtml(anomaly.message || "")}</textarea>
      </div>
      <div class="field">
        <label>看板链接</label>
        <input data-draft-field="dashboardUrl" data-anomaly-field="dashboardUrl" value="${escapeHtml(anomaly.dashboardUrl || "")}" placeholder="可选">
      </div>
    </article>
  `;
}

function field(key, label, value, anomalyIndex = null) {
  const anomalyAttrs = anomalyIndex === null
    ? `data-summary-field="${key}"`
    : `data-draft-field="${key}" data-anomaly-field="${key}"`;
  return `
    <div class="field">
      <label>${label}</label>
      <input ${anomalyAttrs} value="${escapeHtml(value ?? "")}">
    </div>
  `;
}

function bindDraftInputs(root, draft) {
  root.querySelectorAll("[data-summary-field]").forEach((input) => {
    input.addEventListener("input", () => {
      draft[input.dataset.summaryField] = input.value;
    });
  });
}

function updateDraftFromDom(root, draft) {
  root.querySelectorAll("[data-summary-field]").forEach((input) => {
    draft[input.dataset.summaryField] = input.value;
  });
  root.querySelectorAll("[data-anomaly-index]").forEach((card) => {
    const anomaly = draft.anomalies[Number(card.dataset.anomalyIndex)] || {};
    card.querySelectorAll("[data-anomaly-field]").forEach((input) => {
      anomaly[input.dataset.anomalyField] = input.value;
    });
  });
}

function buildResultFromDraft(draft) {
  const anomalies = draft.anomalies.filter((anomaly) => {
    return anomaly.countryCode || anomaly.countryName || anomaly.dashboardTitle || anomaly.cardTitle || anomaly.message;
  });
  return {
    checkedAt: draft.checkedAt,
    checkedCardCount: Number(draft.checkedCardCount || 0),
    anomalyCount: anomalies.length,
    anomalies,
    dataQuality: {
      countries: Number(draft.dataQualityAnomalyCount || 0) > 0
        ? [{
            countryCode: "ALL",
            countryName: "全部国家",
            status: "ok",
            currentAnomalyCount: Number(draft.dataQualityAnomalyCount || 0),
          }]
        : [],
    },
    previewOptions: {
      maxAnomalies: Number(draft.maxAnomalies || 50),
    },
  };
}

function firstPreviewMessage() {
  const messages = state.notifyPreview?.messages || [];
  if (messages[0]?.body) {
    return messages[0].body;
  }
  throw new Error("请先点击“生成预览”，再测试发送。");
}

function renderMessages(messages) {
  return messages.map((message, index) => `
    <article class="message-card">
      <div class="detail-header compact-header">
        <h3>${index + 1}. ${escapeHtml(message.title || "通知")}</h3>
        <span class="badge ${message.anomalyCount ? "danger" : "ok"}">${message.anomalyCount || 0} 条</span>
      </div>
      <textarea class="message-preview" readonly>${message.body || ""}</textarea>
    </article>
  `).join("");
}
