# Fuxi Gateway API Reference for 数据查询 / SR Box Production

Default gateway:

```text
https://data-map-dev.kuainiu.io
```

Use `Authorization: Bearer <token>` for sandbox APIs. The token can be a legacy API token or an SR Box SSO session token whose prefix is `srbs_`.

Responses follow:

```json
{
  "success": true,
  "traceId": "uuid",
  "timestamp": "2026-05-19T00:00:00Z",
  "message": "操作完成",
  "data": {}
}
```

Structured gateway failures also place machine-readable fields under `data`. SSO first-query permission initialization uses:

```json
{
  "success": false,
  "message": "SSO 账号权限正在初始化，请稍后重试",
  "data": {
    "status": 409,
    "error": "Conflict",
    "code": "SSO_ACCOUNT_INITIALIZING",
    "details": {
      "country": "th",
      "datasourceCode": "sr_th_local"
    }
  }
}
```

Clients should keep the same `srbs_...` session and retry after a short wait.

## SSO Session

Production SSO endpoints:

- `POST /api/rust/v1/sr-sandboxes/auth/login-sessions`
- `GET /api/rust/v1/sr-sandboxes/auth/login-sessions/{loginSessionId}`
- `GET /api/rust/v1/sr-sandboxes/auth/login`
- `GET /api/rust/v1/sr-sandboxes/auth/callback`
- `GET /api/rust/v1/sr-sandboxes/auth/me`
- `GET /api/rust/v1/sr-sandboxes/auth/account-permissions`
- `POST /api/rust/v1/sr-sandboxes/auth/logout`

Create a login session:

```bash
curl -X POST "https://data-map-dev.kuainiu.io/api/rust/v1/sr-sandboxes/auth/login-sessions?baseUrl=https://data-map-dev.kuainiu.io&clientType=codex-skill&skillName=sr-box"
```

The returned `loginUrl` opens:

```text
GET /api/rust/v1/sr-sandboxes/auth/login?login_session_id=ls_...&state=st_...
```

The production callback approves the login session with real Kylith `/userinfo`:

```text
GET /api/rust/v1/sr-sandboxes/auth/callback?code=...&state=st_...
```

Approved status includes:

```json
{
  "status": "APPROVED",
  "sessionToken": "srbs_...",
  "expiresAt": "2026-06-23T17:08:46Z",
  "user": {
    "email": "owenzhang@kn.group",
    "displayName": "Owen Zhang",
    "srUser": "'owenzhang'@'%'"
  }
}
```

The current SSO account can inspect cached snapshots with:

```text
GET /api/rust/v1/sr-sandboxes/auth/account-permissions
```

Admins can inspect all cached snapshots with:

```text
GET /api/admin/sso/account-permissions
```

## Country SR Sandbox

- `GET /api/rust/v1/sr-sandboxes/catalog`
- `GET /api/rust/v1/sr-sandboxes/guardrails`
- `GET /api/rust/v1/sr-sandboxes/token-permissions`
- `POST /api/rust/v1/sr-sandboxes/sql-executions`
- `GET /api/rust/v1/sr-sandboxes/logs`
- `POST /api/rust/v1/sr-sandboxes/interactions`

SQL execution payload:

```json
{
  "taskName": "sr-country-query",
  "country": "mx",
  "purpose": "agent",
  "accessMode": "local",
  "sqlMode": "query",
  "sql": "SHOW TABLES FROM testdb",
  "page": 1,
  "pageSize": 100,
  "timeoutSec": 60
}
```

Supported countries: `cn`, `th`, `mx`, `ph`, `pk`, `id`.

Fixed country mapping:

| country | local datasource | remote datasource | write db |
| --- | --- | --- | --- |
| `cn` | `sr_cn_local` | `sr_cn_remote` | `testdb` |
| `th` | `sr_th_local` | `sr_th_remote` | `testdb` |
| `mx` | `sr_mx_local` | `sr_mx_remote` | `testdb` |
| `ph` | `sr_ph_local` | `sr_ph_remote` | `testdb` |
| `pk` | `sr_pk_local` | `sr_pk_remote` | `testdb` |
| `id` | `sr_id_local` | `sr_id_remote` | `testdb` |

Token permissions return `authType`, `principal`, `kylithEmail`, `srUser`, `country`, `datasource`, `tokenOwner`, `tokenPrefix`, `allowedDatasources`, `allowedDatabases`, `allowHiveRead`, `allowedHiveDatabases`, `allowedSqlTypes`, `allowWrite`, rate limits, and default LIMIT values. The client mirrors these fields into `_client.permissionSummary`.

Logs query parameters include `country`, `logType`, `eventType`, `datasource`, `success`, `identity`, `requestPath`, `sqlText`, `taskName`, `from`, `to`, `pageNo`, and `pageSize`.

## Generic Datasource Sandbox

`POST /api/fuxi/sandbox/execute`

```json
{
  "taskName": "generic-sandbox-query",
  "engine": "starrocks-sql",
  "datasource": "sr_cn_local",
  "sqlMode": "query",
  "sql": "SELECT * FROM testdb.sr_box LIMIT 10",
  "page": 1,
  "pageSize": 100,
  "timeoutSec": 60
}
```

Use this only when the user provides a datasource code or asks for datasource diagnostics. For Hive authorization, use `POST /api/rust/v1/sr-sandboxes/sql-executions`.

## Safety Rules

- Allow read-only statements against any database.
- Allow write/DDL/DML only when each target is explicitly `testdb.<table>`.
- Reject business-database writes even if the gateway token appears to allow them.
- Reject implicit writes that depend on current database, such as `CREATE TABLE t AS SELECT ...`.

## Admin APIs

Console/admin APIs require JWT login rather than sandbox API token or SSO session. Use them only when the user explicitly asks for gateway administration.
