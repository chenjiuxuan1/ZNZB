import { ALERT_LIFECYCLE_SECTIONS } from "./lifecycle-model.js";

export function renderLegacyMigrationBanner(targetSection) {
  const section = ALERT_LIFECYCLE_SECTIONS.find((item) => item.id === targetSection);
  if (!section) return "";

  return `
    <aside class="alert-legacy-migration" aria-label="告警中心入口提示">
      <div>
        <strong>此功能继续可用</strong>
        <span>新的主要入口位于告警中心「${section.label}」，当前页面在迁移验证期间完整保留。</span>
      </div>
      <a href="#${section.path}">前往${section.label}<span aria-hidden="true">→</span></a>
    </aside>
  `;
}
