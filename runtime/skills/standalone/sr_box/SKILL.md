---
name: sr-box
description: Use when querying or inspecting production Fuxi StarRocks/SR sandboxes through data-map-dev.kuainiu.io, including country-routed SQL, datasource SQL, catalog, guardrails, SSO session, Hive permission, release smoke, and access-log tasks that require hard testdb-only write protection.
---

# 数据查询 / SR Box Production

Use this skill for production data queries through the Java V2 gateway:

```text
https://data-map-dev.kuainiu.io
```

Do not use this skill for local `127.0.0.1:4888` testing. Use `$data-query-dev / 数据查询开发` for local gateway development and SSO popup checks.

This is the current production data-query entry. `$sr-box-new` is a legacy token-era alias and should not be selected for new data-map-dev SSO queries. `$data-query-dev / 数据查询开发` remains the local 4888 companion.

## Guardrails

- Read-only SQL may query any database: `SELECT`, `WITH`, `SHOW`, `DESC`, `DESCRIBE`, `EXPLAIN`.
- Any mutating SQL must explicitly target `testdb.<table>`.
- Block unqualified writes such as `INSERT INTO table`, `CREATE TABLE table`, `UPDATE table`, or writes to business databases.
- Always run SQL through `scripts/sr_gateway_client.py`; it validates write safety locally before calling the gateway.
- Supported production country routes: `cn`, `th`, `mx`, `ph`, `pk`, `id`.
- Catalog authorization is DB-level. `catalog.db.table` and `SHOW TABLES FROM catalog.db` check `catalog.db`; `ALL CATALOGS` or `*` allows read-only access to all catalog DBs.
- `hive` is treated as a catalog. Hive reads pass when the account has `allowedHiveDatabases`, `hive.<db>` in catalog DB permissions, or `*`.
- Read-only metadata and audit DBs are open to all SSO accounts: `information_schema`, `_statistics_`, `sys`, `starrocks_audit_db__`, `_starrocks_audit_db_`, and `starrocks_audit*` / `_starrocks_audit*` prefixes, including `hive.information_schema`, `hive.sys`, and `hive.starrocks_audit_db__`.
- `testdb` read and write are open to all SSO accounts through this gateway, but write guardrails still require explicit `testdb.<table>` targets.

## Quick Start

Run production health and permission checks:

```bash
python3 scripts/sr_gateway_client.py health
python3 scripts/sr_gateway_client.py sso status
```

Most commands that need an SSO session auto-start production browser login when no valid
session exists, then continue after authorization:

```bash
python3 scripts/sr_gateway_client.py permissions
python3 scripts/sr_gateway_client.py sso whoami
python3 scripts/sr_gateway_client.py execute --country cn --sql "SELECT 1 AS ok"
```

You can also start login explicitly. By default this uses the production gateway browser
flow and does not require a local Kylith auth-service:

```bash
python3 scripts/sr_gateway_client.py sso login
```

If the command fails with `redirect_uri 未在 OAuth Client 预注册`, the production Kylith client is missing this callback:

```text
https://data-map-dev.kuainiu.io/api/rust/v1/sr-sandboxes/auth/callback
```

Register that callback in Kylith before asking a new machine to log in through this skill. As a temporary compatibility path, a developer who already runs the local Kylith auth-service can use:

```bash
FUXI_GATEWAY_SSO_AUTH_MODE=local-token python3 scripts/sr_gateway_client.py sso login
```

If a stale `local-token` environment points to a missing `127.0.0.1:8787` auth-service,
production login falls back to the gateway browser flow automatically.

Production session state is isolated from local development:

- Session path: `~/.config/sr-skills/session-data-map-dev.json`
- Login-attempt path: `~/.config/sr-skills/login-data-map-dev.json`
- Override with `SR_SKILLS_SESSION_FILE` or `SR_SKILLS_LOGIN_ATTEMPT_FILE` only for a one-off run.
- An SSO session is cleared after 1 hour of inactivity and must be re-authorized on the next query.

Check the current SSO user and permissions:

```bash
python3 scripts/sr_gateway_client.py sso whoami
python3 scripts/sr_gateway_client.py permissions
```

Run a country-routed query:

```bash
python3 scripts/sr_gateway_client.py execute \
  --country cn \
  --sql "SHOW TABLES FROM testdb" \
  --page-size 100
```

Run a datasource query only for diagnostics or explicit datasource tasks:

```bash
python3 scripts/sr_gateway_client.py datasource-execute \
  --datasource sr_cn_local \
  --sql "SELECT * FROM testdb.sr_box LIMIT 10"
```

Fetch logs:

```bash
python3 scripts/sr_gateway_client.py logs \
  --country cn \
  --log-type query \
  --identity admin \
  --page-size 50
```

## Configuration

The script defaults to production:

- `FUXI_BASE_URL`: default `https://data-map-dev.kuainiu.io`
- `SR_SKILLS_SESSION_FILE`: default `~/.config/sr-skills/session-data-map-dev.json`
- `SR_SKILLS_LOGIN_ATTEMPT_FILE`: default `~/.config/sr-skills/login-data-map-dev.json`
- `FUXI_GATEWAY_SSO_LOGIN_TIMEOUT_SECONDS`: default `60`
- `FUXI_GATEWAY_SSO_AUTH_MODE`: default `gateway-browser`; set `local-token` only when intentionally using a local Kylith auth-service on `127.0.0.1:8787`. If that local service is unavailable, production login falls back to `gateway-browser`.
- `SR_SKILLS_SESSION_IDLE_TIMEOUT_SECONDS`: default `3600`
- `FUXI_GATEWAY_SSO_INITIALIZATION_RETRIES`: default `5`
- `FUXI_GATEWAY_SSO_INITIALIZATION_WAIT_SECONDS`: default `5`
- Auth policy: production queries are SSO-only. The CLI does not expose token commands or `--token`; `FUXI_API_TOKEN` and old shared-token files are ignored by query commands.

Legacy endpoint note:

- `https://sr-box.kuainiu.io` is the old 4888 entry. Do not use it from this skill unless the user explicitly asks to inspect the legacy service.
- `http://127.0.0.1:4888` belongs to `$data-query-dev / 数据查询开发`.

## Workflow

1. For release or connectivity checks, run `health` first.
2. For schema or route discovery, run `catalog`.
3. For policy discovery, run `guardrails` and `permissions`.
4. For official SR route, SSO account permission, Hive whitelist, and audit validation, prefer `execute --country <country>`.
5. Use `datasource-execute` only for datasource-level diagnostics.
6. For writes, rewrite every target to `testdb.<table>` before execution.
7. For troubleshooting, run `logs` with `--country`, `--identity`, `--event-type`, `--success`, `--request-path`, `--sql-text`, `--from`, or `--to`.

## Hive Validation

For Hive permission validation, use the current SSO account permission result.

1. Run `permissions` and inspect `_client.permissionSummary.allowHiveRead` plus `_client.permissionSummary.allowedHiveDatabases`.
2. Also inspect `_client.permissionSummary.allowedDatabases`; `hive.<db>` and `*` are valid catalog permissions even when older Hive-specific fields are absent.
3. If `allowedHiveDatabases=["*"]` or `allowedDatabases` contains `*`, treat Hive DB access as unrestricted.
4. Use `execute --country <country>` for the formal SR permission result.
5. `SHOW TABLES FROM hive.<db>` is valid for table discovery. After choosing one returned table, validate data access with `SELECT * FROM hive.<db>.<table> LIMIT 10`.
6. System metadata probes such as `SELECT * FROM hive.information_schema.tables LIMIT 1` should not be blocked by the gateway, but the underlying SR engine can still reject unsupported objects.

## Release Validation

Use this checklist after a gateway release or SSO-policy repair:

1. `/actuator/health` returns `{"status":"UP"}`.
2. Run `sso status`, `catalog`, `guardrails`, and `permissions`.
3. Run `SELECT 1 AS ok` for `cn`, `th`, `mx`, `ph`, `pk`, and `id`.
4. Validate `SHOW TABLES FROM hive.<db>` and one `SELECT * FROM hive.<db>.<table> LIMIT 10` success case when the SSO account has Hive or catalog permission.
5. Validate read-only system DB allowlisting with `information_schema`, `_statistics_`, `sys`, and an audit DB query where the target route supports the object.
6. Validate write permission only with a short-lived `testdb.<temporary_table>`, then clean it up.

Example six-country smoke:

```bash
for c in cn th mx ph pk id; do
  python3 scripts/sr_gateway_client.py execute \
    --country "$c" \
    --sql "SELECT 1 AS ok" \
    --page-size 1 \
    --timeout-sec 30
done
```

## Failure Patterns

- `pk` returns `Warehouse etl_warehouse not exist`: the gateway likely did not set `session-warehouse=default_warehouse` for `sr_pk_local`; fix/deploy the server, then rerun `pk SELECT 1 AS ok`.
- SSO query returns 401 or says the session is revoked: run `sso logout`, then run the query again so the skill performs a fresh SSO login.
- SSO query returns `SSO_ACCOUNT_INITIALIZING`: keep the same SSO session and retry. The client already waits and retries automatically using `FUXI_GATEWAY_SSO_INITIALIZATION_RETRIES` and `FUXI_GATEWAY_SSO_INITIALIZATION_WAIT_SECONDS`.
- SSO login fails with `redirect_uri 未在 OAuth Client 预注册`: add `https://data-map-dev.kuainiu.io/api/rust/v1/sr-sandboxes/auth/callback` to the Kylith OAuth Client allowed redirect URLs, then rerun `sso login`.
- SSO login prints `127.0.0.1:8787` or mentions local auth-service: unset `FUXI_GATEWAY_SSO_AUTH_MODE` and `FUXI_GATEWAY_SSO_USE_LOCAL_AUTH_SERVICE` unless intentionally testing local-token compatibility.
- `SELECT 1` passes but write validation fails: distinguish SSO account policy from local guardrails. The client permits writes only when every target is explicitly qualified as `testdb.<table>`.
- `SHOW TABLES FROM hive.<db>` returns `Token 无权访问目标 DB: hive`: the server is not on the parser fix or has a SQL guard regression; redeploy V2 and rerun the release smoke.
- `datasource-execute` can read Hive while `execute --country` is rejected: treat `execute --country` as the formal Hive permission result.

## References

- Read `references/api-reference.md` when endpoint payloads, paths, auth, or response shapes are needed.
- Read `references/usage.md` when showing examples.
- Read `references/architecture.md` when explaining the production gateway architecture or Codex call chain.
- For local SSO/session development, use `$data-query-dev / 数据查询开发` instead of this skill.
