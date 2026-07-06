import { apiPost } from "../api.js";
import { state } from "../state.js";

export function renderNotifyPreview(root) {
  root.innerHTML = `
    <div class="page-header">
      <div>
        <h1 class="page-title">通知预览</h1>
        <p class="page-note">基于本地巡检结果生成 TV 文案，不发送 webhook。</p>
      </div>
      <button class="primary" id="load-preview">生成预览</button>
    </div>
    <div id="preview-body">
      ${state.notifyPreview ? renderMessages(state.notifyPreview.messages || []) : `<p class="muted">点击生成预览。</p>`}
    </div>
  `;
  root.querySelector("#load-preview").addEventListener("click", async () => {
    state.notifyPreview = await apiPost("/api/notify-preview", {});
    renderNotifyPreview(root);
  });
}

function renderMessages(messages) {
  return messages.map((message, index) => `
    <section class="panel" style="margin-bottom:14px">
      <h2 class="panel-title">${index + 1}. ${message.title || "通知"}</h2>
      <textarea class="message-preview" readonly>${message.body || ""}</textarea>
    </section>
  `).join("");
}
