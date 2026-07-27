# 数据查询 / SR Box Production Usage

## Default Environment

`sr-box` defaults to:

```bash
export FUXI_BASE_URL=https://data-map-dev.kuainiu.io
```

Do not point this skill at `127.0.0.1:4888`. Use `$data-query-dev / 数据查询开发` for local gateway testing.

Production state files:

- SSO session: `~/.config/sr-skills/session-data-map-dev.json`
- Login attempt: `~/.config/sr-skills/login-data-map-dev.json`

## Common Commands

Most production commands auto-start browser login when no valid SSO session exists,
then continue after Kylith authorization:

```bash
python3 scripts/sr_gateway_client.py permissions
python3 scripts/sr_gateway_client.py sso whoami
python3 scripts/sr_gateway_client.py execute --country cn --sql "SELECT 1 AS ok"
```

You can also start production SSO login explicitly and save a session:

```bash
python3 scripts/sr_gateway_client.py sso login
```

Manual browser verification:

```bash
python3 scripts/sr_gateway_client.py sso login --no-open
```

Open the printed URL, finish Kylith authorization, then wait for the CLI to save the session.

The default production login is the gateway browser flow. It should not require a local
`127.0.0.1:8787` Kylith auth-service on a freshly installed machine. If Kylith rejects the
login with `redirect_uri 未在 OAuth Client 预注册`, register this callback in the Kylith OAuth
Client and rerun login:

```text
https://data-map-dev.kuainiu.io/api/rust/v1/sr-sandboxes/auth/callback
```

Local auth-service token approval is only a temporary compatibility mode:

```bash
FUXI_GATEWAY_SSO_AUTH_MODE=local-token python3 scripts/sr_gateway_client.py sso login
```

If `local-token` is left in the environment but `127.0.0.1:8787` is not running,
production login falls back to the gateway browser flow automatically. To force the
normal production path:

```bash
unset FUXI_GATEWAY_SSO_AUTH_MODE
unset FUXI_GATEWAY_SSO_USE_LOCAL_AUTH_SERVICE
```

Check the saved production SSO session:

```bash
python3 scripts/sr_gateway_client.py sso status
python3 scripts/sr_gateway_client.py sso whoami
```

Log out and clear the saved production session:

```bash
python3 scripts/sr_gateway_client.py sso logout
```

Fetch gateway capability:

```bash
python3 scripts/sr_gateway_client.py health
python3 scripts/sr_gateway_client.py catalog
python3 scripts/sr_gateway_client.py guardrails
python3 scripts/sr_gateway_client.py permissions
```

Run a country query:

```bash
python3 scripts/sr_gateway_client.py execute \
  --country cn \
  --sql "SELECT * FROM testdb.sr_box LIMIT 10"
```

Run a datasource query for diagnostics:

```bash
python3 scripts/sr_gateway_client.py datasource-execute \
  --datasource sr_cn_local \
  --sql "SELECT * FROM testdb.sr_box LIMIT 10"
```

Validate Hive authorization through the formal SR route:

```bash
python3 scripts/sr_gateway_client.py execute \
  --country mx \
  --sql "SHOW TABLES FROM hive.dwd"

python3 scripts/sr_gateway_client.py execute \
  --country mx \
  --sql "SELECT * FROM hive.dwd.<table_from_show_tables> LIMIT 10"

python3 scripts/sr_gateway_client.py execute \
  --country mx \
  --sql "SELECT * FROM hive.ods.<disallowed_or_unknown_table> LIMIT 1"
```

`SHOW TABLES FROM hive.<db>` is the table-discovery path. Use a returned table name for the positive `SELECT` probe.

Run a safe write validation:

```bash
python3 scripts/sr_gateway_client.py execute \
  --country cn \
  --sql-mode update \
  --sql "CREATE TABLE testdb.sr_box_probe AS SELECT 1 AS id"
```

The same command rejects unsafe SQL:

```bash
python3 scripts/sr_gateway_client.py execute \
  --country cn \
  --sql-mode update \
  --sql "CREATE TABLE prod.sr_box_probe AS SELECT 1 AS id"
```

Fetch logs:

```bash
python3 scripts/sr_gateway_client.py logs \
  --country cn \
  --log-type query \
  --identity admin \
  --page-size 50
```

## Auth Precedence

For query commands:

1. valid production SSO session from `session-data-map-dev.json`
2. production SSO login against `https://data-map-dev.kuainiu.io`

The production CLI is SSO-only. It does not expose token commands or `--token`, and it
ignores `FUXI_API_TOKEN` and old shared-token files for query commands.

If the gateway returns `SSO_ACCOUNT_INITIALIZING`, the CLI keeps the same SSO session,
waits, and retries automatically. Tune with:

```bash
export FUXI_GATEWAY_SSO_INITIALIZATION_RETRIES=5
export FUXI_GATEWAY_SSO_INITIALIZATION_WAIT_SECONDS=5
```

## Output Handling

All commands return JSON. When reporting results, include:

- whether `success` is true
- `traceId` and `message`
- row count and representative rows
- failure `errorType` and `message`
- query/log duration fields when present
- token-permission datasource, DB, Hive, SQL type, write, and limit summaries
- `_client.permissionSummary.allowHiveRead` and `_client.permissionSummary.allowedHiveDatabases` when Hive access matters
