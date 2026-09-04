# Alert Center Routing and Operations Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct the n8n lifecycle route and replace the placeholder operations page with a functional, safe, auditable operations workspace.

**Architecture:** Keep the existing alert-center API and registry business logic, but add a focused operations view module and a small persistent script-audit capability to the registry. Route focus is represented as query metadata, while preview and publish remain explicit user actions using the current backend operations.

**Tech Stack:** Browser-native ES modules, server-rendered HTML strings, Node.js HTTP API, JSON persistence, `node:test`.

---

## File structure

- Modify `web/src/views/alert-center/lifecycle-model.js`: correct capability ownership and add focus metadata.
- Modify `web/src/views/alert-center/lifecycle-nav.js`: render capability metadata and operation anchors accurately.
- Modify `web/src/views/alert-center.js`: dispatch rules focus and delegate operations rendering.
- Create `web/src/views/alert-center/operations.js`: own operations data loading, pure renderers, preview/publish guards, and event binding.
- Modify `web/src/styles.css`: focus highlight and responsive operations layout.
- Modify `src/alert-registry.mjs`: persist sanitized script preview/publish audit entries.
- Modify `src/server.mjs`: expose script audit read API.
- Modify `test/alert-center-lifecycle-view.test.mjs`: cover corrected routes, focus target, and operations workspace source contract.
- Modify `test/alert-registry.test.mjs`: cover audit persistence, ordering, and secret/output redaction.
- Modify `test/server-startup.test.mjs`: cover the new API route.
- Modify `web/src/app.js`: bump alert-center cache key.

### Task 1: Correct n8n ownership and focused rule navigation

**Files:**
- Modify: `web/src/views/alert-center/lifecycle-model.js`
- Modify: `web/src/views/alert-center/lifecycle-nav.js`
- Modify: `web/src/views/alert-center.js`
- Test: `test/alert-center-lifecycle-view.test.mjs`

- [ ] **Step 1: Write failing route and focus tests**

Add assertions that the n8n capability is exactly `#/alerts/rules?focus=n8n-workflows`, that no n8n capability targets `#/rules`, and that the rules view contains an `id="ac-n8n-workflows"` focus target plus the focus helper call.

```js
test("n8n lifecycle capability focuses the n8n rules workspace", () => {
  const item = legacyCapabilitiesForSection("rules")
    .find((candidate) => candidate.id === "n8n-alert-flows");
  assert.equal(item.href, "/alerts/rules?focus=n8n-workflows");
  assert.doesNotMatch(renderLifecycleBridge("rules"), /n8n 告警链路[^]*href="#\/rules"/);
});

test("rules workspace exposes a focusable n8n workflow section", () => {
  const source = fs.readFileSync(new URL("../web/src/views/alert-center.js", import.meta.url), "utf8");
  assert.match(source, /id="ac-n8n-workflows"/);
  assert.match(source, /focusLifecycleTarget\(body, readLifecycleFocus\(\)\)/);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test test/alert-center-lifecycle-view.test.mjs`

Expected: FAIL because the n8n capability still points to `/rules` and no focus target exists.

- [ ] **Step 3: Implement focused navigation**

Change the model entry to:

```js
{ id: "n8n-alert-flows", label: "n8n 告警链路", href: "/alerts/rules?focus=n8n-workflows" }
```

Give the n8n section `id="ac-n8n-workflows"`, parse the hash query with `URLSearchParams`, and after `loadConfigTab` binds its data call:

```js
function focusLifecycleTarget(body, focus) {
  if (!focus) return;
  const target = body.querySelector(`#ac-${CSS.escape(focus)}`);
  if (!target) return;
  target.classList.add("is-focused");
  target.scrollIntoView({ behavior: "smooth", block: "start" });
  target.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: true });
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --test test/alert-center-lifecycle-view.test.mjs`

Expected: all lifecycle tests pass.

- [ ] **Step 5: Commit**

```bash
git add test/alert-center-lifecycle-view.test.mjs web/src/views/alert-center/lifecycle-model.js web/src/views/alert-center/lifecycle-nav.js web/src/views/alert-center.js
git commit -m "fix(alerts): route n8n workflows to rules workspace"
```

### Task 2: Add persistent sanitized script-operation audit

**Files:**
- Modify: `src/alert-registry.mjs`
- Modify: `src/server.mjs`
- Test: `test/alert-registry.test.mjs`
- Test: `test/server-startup.test.mjs`

- [ ] **Step 1: Write failing audit tests**

Add registry tests that append out-of-order preview and publish records, then assert newest-first order and absence of `stdout`, `stderr`, rendered script, tokens, and command content.

```js
test("script audit persists newest-first sanitized operation summaries", async (t) => {
  const { registry } = await tmpRegistry(t);
  await registry.appendScriptAudit({
    entryId: "safe", entryName: "Safe", action: "publish",
    startedAt: "2026-09-04T01:00:00.000Z", finishedAt: "2026-09-04T01:00:02.000Z",
    status: "partial", git: { ok: true, stdout: "TOKEN=secret" },
    deploy: { ok: false, stderr: "password=secret" },
  });
  await registry.appendScriptAudit({
    entryId: "safe", entryName: "Safe", action: "preview",
    startedAt: "2026-09-04T02:00:00.000Z", status: "success",
    diff: { added: 2, removed: 1 }, rendered: "secret script",
  });
  const audit = await registry.listScriptAudit();
  assert.deepEqual(audit.map((item) => item.action), ["preview", "publish"]);
  assert.equal(audit[0].diff.added, 2);
  assert.doesNotMatch(JSON.stringify(audit), /TOKEN|password|secret script/);
});
```

Add a server source assertion for `GET /api/alert-registry/script-audit`.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test test/alert-registry.test.mjs test/server-startup.test.mjs`

Expected: FAIL because the audit methods and route do not exist.

- [ ] **Step 3: Implement audit persistence and action wrapping**

Use `config/alert-script-audit.json`, retain 200 records, and only persist an allow-listed summary:

```js
function normalizeScriptAudit(record = {}) {
  return {
    id: String(record.id || randomUUID()),
    entryId: String(record.entryId || ""),
    entryName: String(record.entryName || ""),
    action: record.action === "publish" ? "publish" : "preview",
    startedAt: String(record.startedAt || new Date().toISOString()),
    finishedAt: String(record.finishedAt || record.startedAt || new Date().toISOString()),
    status: ["success", "partial", "failed"].includes(record.status) ? record.status : "failed",
    diff: record.diff ? {
      added: Number(record.diff.added || 0),
      removed: Number(record.diff.removed || 0),
    } : null,
    git: record.git ? { ok: Boolean(record.git.ok) } : null,
    deploy: record.deploy ? { ok: Boolean(record.deploy.ok) } : null,
    error: String(record.error || "").slice(0, 500),
  };
}
```

Wrap `previewScript` and `applyScript` in `try/catch`, append success/failure summaries, then rethrow failures. Determine publish status as `partial` when Git or deployment is present and unsuccessful. Expose `listScriptAudit` and add the GET route before generic registry routes.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `node --test test/alert-registry.test.mjs test/server-startup.test.mjs`

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/alert-registry.mjs src/server.mjs test/alert-registry.test.mjs test/server-startup.test.mjs
git commit -m "feat(alerts): audit script preview and publish operations"
```

### Task 3: Build the native operations workspace

**Files:**
- Create: `web/src/views/alert-center/operations.js`
- Modify: `web/src/views/alert-center.js`
- Modify: `web/src/views/alert-center/lifecycle-model.js`
- Modify: `web/src/views/alert-center/lifecycle-nav.js`
- Modify: `web/src/styles.css`
- Test: `test/alert-center-lifecycle-view.test.mjs`

- [ ] **Step 1: Write failing operations workspace tests**

Assert that the operations module exports a renderer, loads all four endpoints independently, renders four named regions, renders health states, filters script-capable entries, and requires preview state before publish.

```js
test("operations workspace owns health test release and audit regions", () => {
  const source = fs.readFileSync(new URL("../web/src/views/alert-center/operations.js", import.meta.url), "utf8");
  for (const endpoint of [
    "/api/alerts/health", "/api/alert-registry",
    "/api/alert-registry/history", "/api/alert-registry/script-audit",
  ]) assert.match(source, new RegExp(endpoint.replaceAll("/", "\\/")));
  for (const title of ["连接状态", "测试与验证", "脚本与发布", "运维记录"]) {
    assert.match(source, new RegExp(title));
  }
  assert.match(source, /previewedEntryId/);
  assert.match(source, /confirm\(/);
});
```

- [ ] **Step 2: Run lifecycle test and verify RED**

Run: `node --test test/alert-center-lifecycle-view.test.mjs`

Expected: FAIL because `operations.js` does not exist.

- [ ] **Step 3: Implement operations module**

Export `loadOperationsWorkspace(root, body, refreshTime)`. Render stable containers first, then load these independently with `Promise.allSettled`:

```js
const requests = [
  apiGet("/api/alerts/health"),
  apiGet("/api/alert-registry"),
  apiGet("/api/alert-registry/history"),
  apiGet("/api/alert-registry/script-audit"),
];
```

The health renderer maps `ok`, `not-configured`, and `error:` to success, warning, and error cards. The test region contains explicit links to `#/sandbox` and `#/alert-registry?focus=dry-run`. The release region filters entries using `templateName || scriptPath`, supports a read-only preview request, and only enables publish when `state.previewedEntryId === selectedId`. Publish calls `confirm()` with the selected entry name and impact, then POSTs `apply-script`; refresh audit afterward. The audit region renders script operations separately from execution records.

Replace the operations placeholder branch with:

```js
await loadOperationsWorkspace(root, body, refreshTime);
```

Remove misleading operation links from the lifecycle bridge; keep only accurate supplemental destinations.

- [ ] **Step 4: Add responsive and state styles**

Add `.ac-ops-grid`, `.ac-source-health`, `.ac-ops-card`, `.ac-ops-audit`, `.is-focused`, focus-visible styles, and a single-column layout below 900px. Use existing semantic colors and table styles.

- [ ] **Step 5: Run lifecycle tests and verify GREEN**

Run: `node --test test/alert-center-lifecycle-view.test.mjs`

Expected: all lifecycle tests pass.

- [ ] **Step 6: Commit**

```bash
git add web/src/views/alert-center/operations.js web/src/views/alert-center.js web/src/views/alert-center/lifecycle-model.js web/src/views/alert-center/lifecycle-nav.js web/src/styles.css test/alert-center-lifecycle-view.test.mjs
git commit -m "feat(alerts): add native operations workspace"
```

### Task 4: Cache bust, regression test, and browser QA

**Files:**
- Modify: `web/src/app.js`
- Modify: `test/alert-center-cache-bust.regression-1.test.mjs`

- [ ] **Step 1: Write the failing cache-key test**

Require the new version token:

```js
assert.match(appSource, /alert-center\.js\?v=20260904-alert-operations-v2/);
```

- [ ] **Step 2: Run the cache test and verify RED**

Run: `node --test test/alert-center-cache-bust.regression-1.test.mjs`

Expected: FAIL while app.js still imports lifecycle v1.

- [ ] **Step 3: Bump the import cache key**

```js
import { renderAlertCenter } from "./views/alert-center.js?v=20260904-alert-operations-v2";
```

- [ ] **Step 4: Run focused and full regression suites**

Run:

```bash
node --test test/alert-center-lifecycle-view.test.mjs test/alert-center-cache-bust.regression-1.test.mjs test/alert-registry.test.mjs test/server-startup.test.mjs
npm test
```

Expected: 0 failures.

- [ ] **Step 5: Run browser QA**

Start a temporary local server on an unused port, then verify:

- `#/alerts/rules?focus=n8n-workflows` remains in the alert rules page and visibly focuses n8n.
- `#/alerts/operations` renders all four regions.
- One failed health source does not hide the other.
- Preview does not mutate an entry and publish remains disabled until preview.
- Desktop and narrow viewport have no horizontal page overflow.
- Console has no uncaught errors.

- [ ] **Step 6: Commit**

```bash
git add web/src/app.js test/alert-center-cache-bust.regression-1.test.mjs
git commit -m "fix(alerts): refresh operations workspace assets"
```

### Task 5: Final review and integration

**Files:**
- Review all changed files.

- [ ] **Step 1: Inspect the final diff**

Run: `git diff origin/codex-show-scanned-dashboards...HEAD --check && git diff --stat origin/codex-show-scanned-dashboards...HEAD`

Expected: no whitespace errors; changes limited to the approved scope.

- [ ] **Step 2: Verify the branch is clean**

Run: `git status --short`

Expected: no output.

- [ ] **Step 3: Push and merge after verification**

Push `codex/alert-center-lifecycle-routing-fix`, merge it into `codex-show-scanned-dashboards` without force-pushing, then verify the remote target contains the merge commit.
