const freezeItems = (items) => Object.freeze(items.map((item) => Object.freeze(item)));

export const ALERT_LIFECYCLE_SECTIONS = freezeItems([
  {
    id: "overview",
    label: "总览",
    path: "/alerts/overview",
    description: "当前风险、严重告警、通知失败和待处理事项",
  },
  {
    id: "events",
    label: "事件",
    path: "/alerts/events",
    description: "活跃告警、历史告警、DS 失败与自动修复记录",
  },
  {
    id: "rules",
    label: "规则",
    path: "/alerts/rules",
    description: "夜莺规则、n8n 告警链路和自定义告警条目",
  },
  {
    id: "notifications",
    label: "通知",
    path: "/alerts/notifications",
    description: "渠道、接收人、路由和送达记录",
  },
  {
    id: "operations",
    label: "运维",
    path: "/alerts/operations",
    description: "连接状态、测试、发布记录和审计日志",
  },
]);

const LEGACY_CAPABILITIES = Object.freeze({
  overview: freezeItems([
    { id: "realtime-risk", label: "实时风险总览", href: "/alerts/overview" },
  ]),
  events: freezeItems([
    { id: "alert-history", label: "历史告警", href: "/alerts/events" },
    { id: "ds-failure-records", label: "DS 失败与修复记录", href: "/ds-failure-logs" },
    { id: "multi-country-results", label: "多国家检查结果", href: "/alert-registry" },
  ]),
  rules: freezeItems([
    { id: "nightingale-rules", label: "夜莺规则", href: "/alerts/rules" },
    { id: "n8n-alert-flows", label: "n8n 告警链路", href: "/rules" },
    { id: "custom-alert-registry", label: "自定义告警条目", href: "/alert-registry" },
    { id: "ds-schedules", label: "DS 监控调度", href: "/ds-scheduler" },
  ]),
  notifications: freezeItems([
    { id: "notification-inventory", label: "通知配置与送达记录", href: "/alerts/notifications" },
    { id: "notification-preview", label: "通知预览", href: "/notify-preview" },
  ]),
  operations: freezeItems([
    { id: "connection-health", label: "连接状态", href: "/alert-registry" },
    { id: "rule-sandbox", label: "规则沙盒与测试", href: "/sandbox" },
    { id: "script-preview", label: "脚本预览", href: "/alert-registry" },
    { id: "release-commit", label: "提交与发布", href: "/alert-registry" },
    { id: "audit-log", label: "检查与发布记录", href: "/alert-registry" },
  ]),
});

const SECTION_IDS = new Set(ALERT_LIFECYCLE_SECTIONS.map((section) => section.id));

export function normalizeAlertLifecycleSection(value) {
  return SECTION_IDS.has(value) ? value : "overview";
}

export function lifecycleSectionForPath(path = "") {
  const pathname = String(path).split(/[?#]/, 1)[0].replace(/\/+$/, "");
  const [, root, section] = pathname.split("/");
  if (root !== "alerts") return "overview";
  return normalizeAlertLifecycleSection(section || "overview");
}

export function legacyCapabilitiesForSection(section) {
  return LEGACY_CAPABILITIES[normalizeAlertLifecycleSection(section)];
}
