# Multi-Country Alert Detail, SQL Editing, and Phone Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore stable per-country alert details, add country-scoped SQL editing, and guarantee one auditable phone delivery attempt for every real broadcast.

**Architecture:** Keep the existing alert registry page and hash router. Normalize multi-country results at the registry boundary, expose a single-run detail endpoint and country-scoped SQL endpoints, then let the page resolve `runId/country` deep links. Route check-result callbacks through an idempotent ingestion method that persists phone delivery state before and after using the existing voice caller.

**Tech Stack:** Node.js ESM, built-in `node:test`, vanilla browser JavaScript, CSS, JSON persistence, n8n REST API.

---

### Task 1: Isolate each country in aggregated history

**Files:**
- Modify: `src/alert-registry.mjs`
- Test: `test/alert-registry.test.mjs`

- [ ] **Step 1: Write the failing history-isolation test**

Create two `mc_*` entries and append one run containing China and Indonesia. Assert `listAllHistory()` returns one scoped record per country and that `mc_cn.countries` contains only `cn` while `mc_id.countries` contains only `id`.

```js
assert.deepEqual(byEntry.mc_cn.countries.map((item) => item.code), ["cn"]);
assert.deepEqual(byEntry.mc_id.countries.map((item) => item.code), ["id"]);
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `node --test test/alert-registry.test.mjs`

Expected: failure because each aggregated record currently retains the full `countries` array.

- [ ] **Step 3: Scope records in `listAllHistory`**

For `mc_*`, find the matching country result and push a copy with exactly one country:

```js
const countryResult = (r.countries || []).find(
  (item) => String(item.code || "").toLowerCase() === code
);
if (!countryResult) continue;
all.push({ entryId: entry.id, entryName: entry.name, country: code.toUpperCase(), ...r, countries: [countryResult] });
```

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run: `node --test test/alert-registry.test.mjs`

- [ ] **Step 5: Commit**

```bash
git add src/alert-registry.mjs test/alert-registry.test.mjs
git commit -m "fix: isolate multi-country alert history"
```

### Task 2: Add stable run-and-country detail lookup

**Files:**
- Modify: `src/alert-registry.mjs`
- Modify: `src/server.mjs`
- Test: `test/alert-registry.test.mjs`
- Test: `test/server-static.test.mjs`

- [ ] **Step 1: Write failing detail lookup tests**

Assert a valid lookup returns only the requested country and an unknown run returns `null`:

```js
const detail = await registry.getCheckResultDetail("run-1", "id");
assert.equal(detail.id, "run-1");
assert.deepEqual(detail.countries.map((item) => item.code), ["id"]);
assert.equal(await registry.getCheckResultDetail("missing", "id"), null);
```

Add a source assertion for `GET /api/multi-country/check-results/:runId/:country` so routing stays ahead of the collection route.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `node --test test/alert-registry.test.mjs test/server-static.test.mjs`

- [ ] **Step 3: Implement lookup and route**

Validate country against `MC_COUNTRIES`, locate a run by exact ID or a unique ID prefix, and return `{...run, countries:[countryResult], detailKey}`. Throw HTTP 400 for an invalid country and return HTTP 404 from the server for a missing run.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run: `node --test test/alert-registry.test.mjs test/server-static.test.mjs`

- [ ] **Step 5: Commit**

```bash
git add src/alert-registry.mjs src/server.mjs test/alert-registry.test.mjs test/server-static.test.mjs
git commit -m "feat: expose scoped alert run details"
```

### Task 3: Restore deep-linked details in the browser

**Files:**
- Modify: `web/src/views/alert-registry.js`
- Modify: `web/src/styles.css`
- Test: `test/alert-registry-view.test.mjs`

- [ ] **Step 1: Write failing view-source tests**

Assert the view reads `state.routeQuery.runId/country`, generates an encoded detail hash, marks a target card, adds `open` to the matching `<details>`, and renders explicit missing-SQL/missing-detail messages.

```js
assert.match(source, /state\.routeQuery\?\.runId/);
assert.match(source, /data-detail-run=/);
assert.match(source, /该历史记录未保存本次校验 SQL/);
assert.match(source, /只保存了异常数量，未保存具体差异/);
```

- [ ] **Step 2: Run the view test and confirm RED**

Run: `node --test test/alert-registry-view.test.mjs`

- [ ] **Step 3: Implement deep-link rendering**

Import `state`, normalize only the six supported country codes, apply `mc_<country>` filtering, switch `days` to `0` when necessary, and compute the page containing the target record. Render:

```html
<article class="mc-run mc-run-target" data-detail-run="..." data-detail-country="...">
  <button class="mc-copy-detail-link">复制详情链接</button>
  <details class="mc-detail" open>...</details>
</article>
```

After rendering, call `scrollIntoView({block:"start"})` once. Copy links as `${location.origin}${location.pathname}#/alert-registry?runId=...&country=...`.

- [ ] **Step 4: Add detail-state styling**

Add a visible focus ring/background for `.mc-run-target`, style the detail-link button, and keep the table horizontally scrollable on narrow screens.

- [ ] **Step 5: Run focused test and confirm GREEN**

Run: `node --test test/alert-registry-view.test.mjs`

- [ ] **Step 6: Commit**

```bash
git add web/src/views/alert-registry.js web/src/styles.css test/alert-registry-view.test.mjs
git commit -m "fix: open exact multi-country alert details"
```

### Task 4: Replace the six-country SQL editor with a country-scoped API

**Files:**
- Modify: `src/alert-registry.mjs`
- Modify: `src/server.mjs`
- Modify: `web/src/views/alert-registry.js`
- Test: `test/alert-registry.test.mjs`
- Test: `test/alert-registry-view.test.mjs`

- [ ] **Step 1: Write failing SQL parsing and validation tests**

Inject a fake n8n fetch implementation. Cover different whitespace, quote style, field ordering, updating only `id`, retaining all other SQL values, invalid country, empty SQL, multiple statements, and write keywords.

```js
await assert.rejects(() => registry.setMcSql("id", {sql:"delete from x"}), /只允许只读 SELECT/);
assert.equal(updated.cn, original.cn);
assert.equal(updated.id, "select check_item, mismatch_cnt from id_check");
```

- [ ] **Step 2: Run tests and confirm RED**

Run: `node --test test/alert-registry.test.mjs test/alert-registry-view.test.mjs`

- [ ] **Step 3: Implement country-scoped methods**

Expose `getMcSql(country)` and `setMcSql(country, {sql})`. Validate with a dedicated `assertReadOnlyMcSql` that requires one `SELECT`/`WITH` statement, rejects `;` followed by content, and rejects `INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE/CREATE/GRANT/REVOKE/CALL/INTO OUTFILE`. Parse the countries array from the n8n Code node with a formatting-tolerant object-property matcher and replace only the captured SQL literal.

- [ ] **Step 4: Add country-scoped routes**

```text
GET /api/multi-country/sql/:country
PUT /api/multi-country/sql/:country
```

Keep the old collection GET temporarily for compatibility, but remove the all-country PUT path from the UI.

- [ ] **Step 5: Update the capability editor**

Only call `loadEntrySqlPanel` when `id` matches `^mc_(cn|id|mx|th|ph|pk)$`. Render one textarea and save only that country. Non-multi-country rows do not render the SQL section.

- [ ] **Step 6: Run focused tests and confirm GREEN**

Run: `node --test test/alert-registry.test.mjs test/alert-registry-view.test.mjs`

- [ ] **Step 7: Commit**

```bash
git add src/alert-registry.mjs src/server.mjs web/src/views/alert-registry.js test/alert-registry.test.mjs test/alert-registry-view.test.mjs
git commit -m "feat: edit validation SQL per country"
```

### Task 5: Guarantee idempotent phone delivery for broadcasts

**Files:**
- Modify: `src/alert-registry.mjs`
- Modify: `src/server.mjs`
- Test: `test/mc-two-round.test.mjs`
- Test: `test/server-static.test.mjs`

- [ ] **Step 1: Write failing delivery tests**

Create the registry with an injected `mcPhoneCaller`. Ingest a run broadcasting all six countries and assert one call per enabled country. Repeat the same run ID and assert no additional calls. Assert `repairTriggered` without `broadcast` never calls. Make one caller fail and assert the saved record contains a failed, redacted delivery result while ingestion still returns successfully.

```js
assert.deepEqual(calls.map((call) => call.countries[0].code).sort(), ["cn", "id", "mx", "ph", "pk", "th"]);
assert.equal(calls.length, 6);
assert.equal(retry.phoneDeliveries.every((item) => item.deduplicated), true);
```

- [ ] **Step 2: Run phone tests and confirm RED**

Run: `node --test test/mc-two-round.test.mjs test/server-static.test.mjs`

- [ ] **Step 3: Implement `ingestCheckResult`**

Add an optional `mcPhoneCaller` dependency to `createAlertRegistry`. Upsert by run ID, persist each target as `pending`, call either the injected function or `callMcPhone`, then persist a redacted delivery record:

```js
{ country, status: "succeeded" | "failed" | "skipped", attemptedAt, callCount, failedCount }
```

Use an in-memory `Map` keyed by `runId:country` plus persisted delivery state to prevent concurrent and retried callbacks from dialing twice.

- [ ] **Step 4: Route callbacks through ingestion**

Change only `POST /api/multi-country/check-results` to call `ingestCheckResult`; keep `appendCheckResult` available for storage-only tests and internal compatibility.

- [ ] **Step 5: Run focused tests and confirm GREEN**

Run: `node --test test/mc-two-round.test.mjs test/server-static.test.mjs`

- [ ] **Step 6: Commit**

```bash
git add src/alert-registry.mjs src/server.mjs test/mc-two-round.test.mjs test/server-static.test.mjs
git commit -m "feat: deliver one phone alert per broadcast"
```

### Task 6: Update the alert link contract and documentation

**Files:**
- Modify: `src/alert-registry.mjs`
- Modify: `docs/multi-country-alert.md`
- Test: `test/alert-registry.test.mjs`

- [ ] **Step 1: Write a failing link test**

Assert a stored broadcast result exposes a country-specific detail URL containing encoded `runId` and `country`, without changing existing user-supplied text.

- [ ] **Step 2: Run the test and confirm RED**

Run: `node --test test/alert-registry.test.mjs`

- [ ] **Step 3: Add detail links and update docs**

Store `detailLinks` per country using `ALERT_PLATFORM_URL`, falling back to `https://big-data-duty-management-platform.kuainiujinke.com`, and document the callback fields `sql`, `details`, `detailsTruncated`, the scoped SQL endpoints, and phone idempotency semantics. Remove the obsolete documentation item that says phone alerts are not implemented.

- [ ] **Step 4: Run focused test and confirm GREEN**

Run: `node --test test/alert-registry.test.mjs`

- [ ] **Step 5: Commit**

```bash
git add src/alert-registry.mjs docs/multi-country-alert.md test/alert-registry.test.mjs
git commit -m "docs: define multi-country detail callback contract"
```

### Task 7: Final verification and browser QA

**Files:**
- Modify only if a failing verification identifies a scoped defect.

- [ ] **Step 1: Run syntax and whitespace checks**

```bash
node --check src/alert-registry.mjs
node --check src/server.mjs
node --check web/src/views/alert-registry.js
git diff --check
```

- [ ] **Step 2: Run the complete test suite**

Run: `npm test`

Expected: all tests pass with zero failures.

- [ ] **Step 3: Run dependency audit**

Run: `npm audit --registry=https://registry.npmjs.org --audit-level=low`

- [ ] **Step 4: Browser QA**

Start the local platform and verify desktop and 390px layouts. Seed a temporary in-memory fixture through tests or a disposable local config, open a deep link, confirm it scrolls to and expands only the requested country, and confirm missing legacy details show explanatory messages.

- [ ] **Step 5: Verify commit and dirty-file isolation**

Compare `origin/codex-show-scanned-dashboards..HEAD`, ensure the feature commits contain only the planned files, and confirm `src/server.mjs`, `web/src/app.js`, `.claude/`, and data-governance files owned by the user remain preserved outside unrelated commits.
