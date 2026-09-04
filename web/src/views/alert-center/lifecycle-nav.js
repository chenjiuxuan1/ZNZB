import {
  ALERT_LIFECYCLE_SECTIONS,
  legacyCapabilitiesForSection,
  normalizeAlertLifecycleSection,
} from "./lifecycle-model.js";

export function renderLifecycleNavigation(currentSection) {
  const current = normalizeAlertLifecycleSection(currentSection);
  return `
    <nav class="alert-lifecycle-nav" aria-label="告警生命周期">
      ${ALERT_LIFECYCLE_SECTIONS.map((section, index) => `
        <a class="alert-lifecycle-nav__item ${section.id === current ? "is-active" : ""}"
          href="#${section.path}" ${section.id === current ? 'aria-current="page"' : ""}>
          <span class="alert-lifecycle-nav__step" aria-hidden="true">${index + 1}</span>
          <span>
            <strong>${section.label}</strong>
            <small>${section.description}</small>
          </span>
        </a>
      `).join("")}
    </nav>
  `;
}

export function renderLifecycleBridge(currentSection) {
  const current = normalizeAlertLifecycleSection(currentSection);
  const section = ALERT_LIFECYCLE_SECTIONS.find((item) => item.id === current);
  const capabilities = legacyCapabilitiesForSection(current);
  if (current === "overview") return "";

  return `
    <aside class="alert-lifecycle-bridge" aria-labelledby="alert-lifecycle-bridge-title">
      <div>
        <span class="alert-lifecycle-bridge__eyebrow">${section.label}工作区</span>
        <h2 id="alert-lifecycle-bridge-title">现有能力已按生命周期归位</h2>
        <p>${section.description}。第一阶段继续复用成熟页面和生产接口。</p>
      </div>
      <div class="alert-lifecycle-bridge__links" aria-label="${section.label}相关能力">
        ${capabilities.map((item) => `
          <a href="#${item.href}">${item.label}<span aria-hidden="true">→</span></a>
        `).join("")}
      </div>
    </aside>
  `;
}
