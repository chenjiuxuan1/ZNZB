import json
import os
import stat
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import sr_gateway_client as client


class SqlGuardrailTests(unittest.TestCase):
    def test_split_sql_ignores_semicolons_inside_strings_and_comments(self):
        sql = """
        SELECT ';' AS marker; -- comment ; stays ignored
        INSERT INTO testdb.t VALUES ('a;b');
        """

        self.assertEqual(
            client.split_sql_statements(sql),
            ["SELECT ';' AS marker", "INSERT INTO testdb.t VALUES ('a;b')"],
        )

    def test_read_only_statements_may_reference_any_database(self):
        client.validate_sql_guardrails("SELECT * FROM prod.orders LIMIT 1", "query")
        client.validate_sql_guardrails("SHOW TABLES FROM prod", "query")
        client.validate_sql_guardrails("SELECT * FROM hive.dwd.some_table LIMIT 1", "query")

    def test_writes_are_allowed_only_when_targets_are_explicitly_in_testdb(self):
        client.validate_sql_guardrails(
            "INSERT INTO testdb.sr_box_new_probe(id) VALUES (1)", "write"
        )
        client.validate_sql_guardrails(
            "INSERT INTO `testdb`.`sr_box_new_probe`(id) VALUES (1)", "write"
        )
        client.validate_sql_guardrails(
            "CREATE TABLE testdb.sr_box_new_copy AS SELECT 1 AS id", "query"
        )

        with self.assertRaisesRegex(client.GuardrailError, "testdb"):
            client.validate_sql_guardrails("INSERT INTO prod.orders VALUES (1)", "write")

        with self.assertRaisesRegex(client.GuardrailError, "qualified"):
            client.validate_sql_guardrails("DELETE FROM orders WHERE id = 1", "write")

        with self.assertRaisesRegex(client.GuardrailError, "testdb"):
            client.validate_sql_guardrails("CREATE TABLE scratch_copy AS SELECT 1", "write")

    def test_materialized_view_writes_are_allowed_only_in_testdb(self):
        client.validate_sql_guardrails(
            "DROP MATERIALIZED VIEW IF EXISTS testdb.dwb_asset_sub_period_info_mv_test",
            "write",
        )
        client.validate_sql_guardrails(
            "CREATE MATERIALIZED VIEW testdb.dwb_asset_sub_period_info_mv_test AS SELECT * FROM dwd.source_table",
            "write",
        )
        client.validate_sql_guardrails(
            "REFRESH MATERIALIZED VIEW testdb.dwb_asset_sub_period_info_mv_test",
            "write",
        )

        with self.assertRaisesRegex(client.GuardrailError, "testdb"):
            client.validate_sql_guardrails(
                "CREATE MATERIALIZED VIEW dwd.dwb_asset_sub_period_info_mv_test AS SELECT 1",
                "write",
            )

    def test_multi_statement_batch_stops_on_unsafe_write(self):
        sql = "SELECT 1; UPDATE prod.orders SET status = 'x' WHERE id = 1"

        with self.assertRaisesRegex(client.GuardrailError, "prod.orders"):
            client.validate_sql_guardrails(sql, "query")


class RequestBuilderTests(unittest.TestCase):
    def test_default_gateway_base_url_uses_data_map_dev(self):
        self.assertEqual(client.DEFAULT_BASE_URL, "https://data-map-dev.kuainiu.io")

    def test_country_execution_payload_uses_expected_endpoint_and_defaults(self):
        seen = {}

        def fake_request(method, url, token, payload=None, timeout=60):
            seen.update(
                {
                    "method": method,
                    "url": url,
                    "token": token,
                    "payload": payload,
                    "timeout": timeout,
                }
            )
            return {"success": True, "data": {"rows": []}}

        with patch.object(client, "request_json", fake_request):
            result = client.execute_country_sql(
                base_url="http://gateway",
                token="tok",
                country="mx",
                sql="SELECT 1",
                task_name="unit-test",
            )

        self.assertTrue(result["success"])
        self.assertEqual(seen["method"], "POST")
        self.assertEqual(
            seen["url"], "http://gateway/api/rust/v1/sr-sandboxes/sql-executions"
        )
        self.assertEqual(seen["token"], "tok")
        self.assertEqual(
            seen["payload"],
            {
                "taskName": "unit-test",
                "country": "mx",
                "purpose": "agent",
                "accessMode": "local",
                "sqlMode": "query",
                "sql": "SELECT 1",
                "page": 1,
                "pageSize": 100,
                "timeoutSec": 60,
            },
        )

    def test_old_pakistan_route_is_not_supported(self):
        with self.assertRaisesRegex(client.GuardrailError, "Unsupported country"):
            client.execute_country_sql(
                base_url="http://gateway",
                token="tok",
                country="pk_legacy",
                sql="SELECT 1",
            )

    def test_token_permissions_uses_expected_endpoint(self):
        seen = {}

        def fake_request(method, url, token, payload=None, timeout=60):
            seen.update({"method": method, "url": url, "token": token, "payload": payload})
            return {"success": True, "data": {"allowedDatasources": ["sr_cn_local"]}}

        with patch.object(client, "request_json", fake_request):
            result = client.get_token_permissions("http://gateway", "tok")

        self.assertTrue(result["success"])
        self.assertEqual(seen["method"], "GET")
        self.assertEqual(
            seen["url"], "http://gateway/api/rust/v1/sr-sandboxes/token-permissions"
        )
        self.assertEqual(seen["token"], "tok")
        self.assertIsNone(seen["payload"])

    def test_token_permissions_cli_attaches_hive_permission_summary(self):
        payload = {
            "success": True,
            "data": {
                "tokenOwner": "codex",
                "tokenPrefix": "0747",
                "allowedDatasources": ["sr_mx_local"],
                "allowedDatabases": ["testdb"],
                "allowHiveRead": True,
                "allowedHiveDatabases": ["dm_feature", "dwb", "dwd", "dwt", "temp"],
                "allowedSqlTypes": ["SELECT", "WITH", "SHOW"],
                "allowWrite": True,
            },
        }

        with patch.object(client, "get_token_permissions", return_value=payload):
            with patch.object(
                client,
                "resolve_query_token",
                return_value=client.TokenInfo(
                    "srbs_session", "session", auth_type="sso-session"
                ),
            ):
                with patch("sys.argv", ["sr_gateway_client.py", "permissions"]):
                    with patch("sys.stdout") as stdout:
                        client.main()

        written = "".join(call.args[0] for call in stdout.write.call_args_list)
        result = json.loads(written)
        self.assertEqual(result["_client"]["tokenSource"], "session")
        self.assertEqual(result["_client"]["authType"], "sso-session")
        self.assertEqual(
            result["_client"]["permissionSummary"],
            {
                "authType": None,
                "kylithEmail": None,
                "srUser": None,
                "country": None,
                "datasource": None,
                "tokenOwner": "codex",
                "tokenPrefix": "0747",
                "allowedDatasources": ["sr_mx_local"],
                "allowedDatabases": ["testdb"],
                "allowHiveRead": True,
                "allowedHiveDatabases": ["dm_feature", "dwb", "dwd", "dwt", "temp"],
                "allowedSqlTypes": ["SELECT", "WITH", "SHOW"],
                "allowWrite": True,
            },
        )

    def test_health_uses_actuator_without_token(self):
        seen = {}

        def fake_request(method, url, token=None, payload=None, timeout=60):
            seen.update({"method": method, "url": url, "token": token, "payload": payload})
            return {"status": "UP"}

        with patch.object(client, "request_json", fake_request):
            result = client.get_health("http://gateway")

        self.assertEqual(result["status"], "UP")
        self.assertEqual(seen["method"], "GET")
        self.assertEqual(seen["url"], "http://gateway/actuator/health")
        self.assertIsNone(seen["token"])

    def test_logs_support_identity_and_time_filters(self):
        seen = {}

        def fake_request(method, url, token, payload=None, timeout=60):
            seen.update({"method": method, "url": url, "token": token, "payload": payload})
            return {"success": True, "data": {"records": []}}

        with patch.object(client, "request_json", fake_request):
            result = client.get_logs(
                "http://gateway",
                "tok",
                {
                    "country": "cn",
                    "logType": "query",
                    "eventType": "sql-execution",
                    "datasource": "sr_cn_local",
                    "success": "true",
                    "identity": "admin",
                    "requestPath": "/api/rust/v1/sr-sandboxes/sql-executions",
                    "sqlText": "SELECT",
                    "from": "2026-05-26T00:00:00Z",
                    "to": "2026-05-26T23:59:59Z",
                    "pageNo": 2,
                    "pageSize": 10,
                },
            )

        self.assertTrue(result["success"])
        self.assertIn("identity=admin", seen["url"])
        self.assertIn("eventType=sql-execution", seen["url"])
        self.assertIn("requestPath=%2Fapi%2Frust%2Fv1%2Fsr-sandboxes%2Fsql-executions", seen["url"])
        self.assertIn("sqlText=SELECT", seen["url"])
        self.assertIn("from=2026-05-26T00%3A00%3A00Z", seen["url"])

    def test_cli_prints_json_for_guardrail_errors(self):
        with patch("sys.argv", ["sr_gateway_client.py", "execute", "--sql", "DROP TABLE prod.t"]):
            with self.assertRaises(SystemExit) as exit_context:
                with patch("sys.stderr") as stderr:
                    client.main()

        self.assertEqual(exit_context.exception.code, 2)
        written = "".join(call.args[0] for call in stderr.write.call_args_list)
        payload = json.loads(written)
        self.assertFalse(payload["success"])
        self.assertEqual(payload["errorType"], "GuardrailError")


class SharedTokenTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.token_path = os.path.join(self.tmpdir.name, "token.json")
        self.session_path = os.path.join(self.tmpdir.name, "session.json")
        self.login_attempt_path = os.path.join(self.tmpdir.name, "login-attempt.json")
        self.env_patcher = patch.dict(
            os.environ,
            {
                "SR_SKILLS_TOKEN_FILE": self.token_path,
                "SR_SKILLS_SESSION_FILE": self.session_path,
                "SR_SKILLS_LOGIN_ATTEMPT_FILE": self.login_attempt_path,
            },
            clear=False,
        )
        self.env_patcher.start()

    def tearDown(self):
        self.env_patcher.stop()
        self.tmpdir.cleanup()

    def test_token_config_round_trip_masks_secret_and_uses_private_permissions(self):
        client.save_token_config("tok_1234567890abcdef", base_url="http://gateway")

        config = client.load_token_config()
        self.assertEqual(config["token"], "tok_1234567890abcdef")
        self.assertEqual(config["baseUrl"], "http://gateway")
        self.assertEqual(stat.S_IMODE(os.stat(self.token_path).st_mode), 0o600)
        self.assertEqual(client.mask_token("tok_1234567890abcdef"), "tok_...cdef")

    def test_resolve_query_token_is_sso_only_even_when_token_sources_exist(self):
        client.save_token_config("config-token")

        def fake_sso_login(base_url, open_browser=True, auto_approve=True, timeout_sec=client.DEFAULT_LOGIN_TIMEOUT):
            expires_at = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
            client.save_session_config(
                "srbs_session_token",
                base_url,
                user={"email": "user@kn.group"},
                expires_at=expires_at,
            )
            return client.session_status_payload()

        with self.assertRaisesRegex(client.GuardrailError, "SSO"):
            client.resolve_query_token("https://data-map-dev.kuainiu.io", cli_token="cli-token")

        with patch.dict(os.environ, {"FUXI_API_TOKEN": "env-token"}, clear=False):
            with patch.object(client, "sso_login", fake_sso_login):
                token_info = client.resolve_query_token("https://data-map-dev.kuainiu.io")

        self.assertEqual(token_info.token, "srbs_session_token")
        self.assertEqual(token_info.source, "session")
        self.assertEqual(token_info.auth_type, "sso-session")

    def test_resolve_token_returns_only_valid_sso_session(self):
        expires_at = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
        client.save_session_config("srbs-session-token", "http://gateway", expires_at=expires_at)

        with patch.dict(os.environ, {"FUXI_API_TOKEN": "env-token"}, clear=False):
            token_info = client.resolve_token(None)

        self.assertEqual(token_info.token, "srbs-session-token")
        self.assertEqual(token_info.source, "session")
        self.assertEqual(token_info.auth_type, "sso-session")

    def test_session_config_round_trip_masks_secret_and_uses_private_permissions(self):
        expires_at = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
        client.save_session_config(
            "srbs_1234567890abcdef",
            "http://gateway",
            user={"email": "user@kn.group", "srUser": "'user'@'%'"},
            expires_at=expires_at,
        )

        config = client.load_session_config()
        self.assertEqual(config["sessionToken"], "srbs_1234567890abcdef")
        self.assertEqual(config["baseUrl"], "http://gateway")
        self.assertEqual(stat.S_IMODE(os.stat(self.session_path).st_mode), 0o600)
        status = client.session_status_payload()
        self.assertTrue(status["valid"])
        self.assertEqual(status["sessionPreview"], "srbs...cdef")
        self.assertIn("lastAccessedAt", status)

    def test_idle_sso_session_is_cleared_and_relogin_is_required(self):
        now = datetime.now(timezone.utc)
        old_access = (now - timedelta(hours=2)).isoformat()
        future_expiry = (now + timedelta(hours=1)).isoformat()
        client.write_private_json(
            self.session_path,
            {
                "sessionToken": "srbs_old_idle_session",
                "baseUrl": "https://data-map-dev.kuainiu.io",
                "user": {"email": "user@kn.group"},
                "expiresAt": future_expiry,
                "updatedAt": old_access,
                "lastAccessedAt": old_access,
            },
        )

        def fake_sso_login(base_url, open_browser=True, auto_approve=True, timeout_sec=client.DEFAULT_LOGIN_TIMEOUT):
            client.save_session_config(
                "srbs_new_session",
                base_url,
                user={"email": "user@kn.group"},
                expires_at=future_expiry,
            )
            return client.session_status_payload()

        with patch.object(client, "sso_login", fake_sso_login):
            token_info = client.resolve_query_token("https://data-map-dev.kuainiu.io")

        self.assertEqual(token_info.token, "srbs_new_session")
        self.assertEqual(client.load_session_config()["sessionToken"], "srbs_new_session")

    def test_kylith_authorization_page_opens_once_per_login_attempt(self):
        now = {"value": 0.0}

        def fake_time():
            return now["value"]

        def fake_sleep(_seconds):
            now["value"] += 1.0

        def fake_request():
            challenge = int(now["value"]) + 1
            return {
                "status": "authorization_required",
                "authorizationUrl": f"https://id.kylith.com/consent?challenge={challenge}",
            }

        with patch.object(client, "request_local_kylith_token", fake_request):
            with patch.object(client.time, "time", fake_time):
                with patch.object(client.time, "sleep", fake_sleep):
                    with patch.object(client.webbrowser, "open") as browser_open:
                        with self.assertRaisesRegex(client.GatewayError, "账号未登录|timed out"):
                            client.wait_for_local_kylith_access_token(
                                open_browser=True, timeout_sec=3
                            )

        browser_open.assert_called_once_with("https://id.kylith.com/consent?challenge=1")

    def test_sso_login_saves_approved_session(self):
        login_url = "http://gateway/api/rust/v1/sr-sandboxes/auth/login?login_session_id=ls_1&state=st_1"
        approval_url = login_url + "&approve=true&response=json"
        seen = []

        def fake_request(method, url, token=None, payload=None, timeout=60):
            seen.append((method, url, token))
            if method == "POST" and "login-sessions" in url:
                return {
                    "success": True,
                    "data": {
                        "loginSessionId": "ls_1",
                        "loginUrl": login_url,
                        "expiresAt": "2026-06-23T09:00:00Z",
                    },
                }
            if method == "GET" and url == approval_url:
                return {"success": True, "data": {"status": "APPROVED"}}
            if method == "GET" and url.endswith("/login-sessions/ls_1"):
                return {
                    "success": True,
                    "data": {
                        "status": "APPROVED",
                        "sessionToken": "srbs_approved123456",
                        "expiresAt": "2099-12-31T23:59:59Z",
                        "user": {
                            "email": "user@kn.group",
                            "displayName": "Demo User",
                            "srUser": "'user'@'%'",
                        },
                    },
                }
            raise AssertionError(f"unexpected request {method} {url}")

        with patch.object(client, "request_json", fake_request):
            with patch.object(client.webbrowser, "open") as browser_open:
                with patch("sys.stderr") as stderr:
                    result = client.sso_login("http://gateway", auto_approve=True, timeout_sec=5)

        browser_open.assert_called_once_with(login_url)
        self.assertTrue(result["configured"])
        self.assertEqual(client.load_session_config()["sessionToken"], "srbs_approved123456")
        self.assertIn(("GET", approval_url, None), seen)
        self.assertNotIn(("GET", login_url, None), seen)
        self.assertIn(
            login_url,
            "".join(call.args[0] for call in stderr.write.call_args_list),
        )

    def test_sso_login_manual_mode_prints_login_url_without_auto_approval(self):
        login_url = "http://gateway/api/rust/v1/sr-sandboxes/auth/login?login_session_id=ls_1&state=st_1"
        seen = []

        def fake_request(method, url, token=None, payload=None, timeout=60):
            seen.append((method, url, token))
            if method == "POST" and "login-sessions" in url:
                return {
                    "success": True,
                    "data": {
                        "loginSessionId": "ls_1",
                        "loginUrl": login_url,
                        "expiresAt": "2026-06-23T09:00:00Z",
                    },
                }
            if method == "GET" and url.endswith("/login-sessions/ls_1"):
                return {
                    "success": True,
                    "data": {
                        "status": "APPROVED",
                        "sessionToken": "srbs_approved123456",
                        "expiresAt": "2099-12-31T23:59:59Z",
                        "user": {
                            "email": "user@kn.group",
                            "displayName": "Demo User",
                            "srUser": "'user'@'%'",
                        },
                    },
                }
            raise AssertionError(f"unexpected request {method} {url}")

        with patch.object(client, "request_json", fake_request):
            with patch.object(client.webbrowser, "open") as browser_open:
                with patch("sys.stderr") as stderr:
                    result = client.sso_login(
                        "http://gateway",
                        open_browser=False,
                        auto_approve=False,
                        timeout_sec=5,
                    )

        browser_open.assert_not_called()
        self.assertTrue(result["configured"])
        self.assertNotIn(("GET", login_url, None), seen)
        self.assertIn(
            login_url,
            "".join(call.args[0] for call in stderr.write.call_args_list),
        )

    def test_sso_login_reuses_active_pending_login_without_opening_new_tab(self):
        login_url = "http://gateway/api/rust/v1/sr-sandboxes/auth/login?login_session_id=ls_existing&state=st_existing"
        expires_at = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()
        client.write_private_json(
            self.login_attempt_path,
            {
                "baseUrl": "http://gateway",
                "loginSessionId": "ls_existing",
                "loginUrl": login_url,
                "authorizationUrl": login_url,
                "openedAt": datetime.now(timezone.utc).isoformat(),
                "expiresAt": expires_at,
            },
        )
        seen = []

        def fake_request(method, url, token=None, payload=None, timeout=60):
            seen.append((method, url, token))
            if method == "POST" and "login-sessions" in url:
                raise AssertionError("active login attempt should be reused")
            if method == "GET" and url.endswith("/login-sessions/ls_existing"):
                return {
                    "success": True,
                    "data": {
                        "status": "APPROVED",
                        "sessionToken": "srbs_reused_session",
                        "expiresAt": "2099-12-31T23:59:59Z",
                        "user": {"email": "user@kn.group", "srUser": "'user'@'%'"},
                    },
                }
            raise AssertionError(f"unexpected request {method} {url}")

        with patch.object(client, "request_json", fake_request):
            with patch.object(client.webbrowser, "open") as browser_open:
                with patch("sys.stderr") as stderr:
                    result = client.sso_login("http://gateway", timeout_sec=5)

        browser_open.assert_not_called()
        self.assertTrue(result["configured"])
        self.assertEqual(client.load_session_config()["sessionToken"], "srbs_reused_session")
        self.assertFalse(os.path.exists(self.login_attempt_path))
        self.assertNotIn(("GET", login_url, None), seen)
        self.assertIn(
            "already open",
            "".join(call.args[0] for call in stderr.write.call_args_list),
        )

    def test_production_sso_login_uses_gateway_browser_by_default(self):
        login_url = "https://data-map-dev.kuainiu.io/api/rust/v1/sr-sandboxes/auth/login?login_session_id=ls_1&state=st_1"
        seen = []

        def fake_request(method, url, token=None, payload=None, timeout=60):
            seen.append((method, url, token, payload))
            if method == "POST" and "login-sessions" in url:
                return {
                    "success": True,
                    "data": {
                        "loginSessionId": "ls_1",
                        "loginUrl": login_url,
                        "expiresAt": "2026-06-23T09:00:00Z",
                    },
                }
            if method == "GET" and url.endswith("/login-sessions/ls_1"):
                return {
                    "success": True,
                    "data": {
                        "status": "APPROVED",
                        "sessionToken": "srbs_prod_session",
                        "expiresAt": "2099-12-31T23:59:59Z",
                        "user": {"email": "user@kn.group", "srUser": "'user'@'%'"},
                    },
                }
            raise AssertionError(f"unexpected request {method} {url}")

        def fail_local_token(*_args, **_kwargs):
            raise AssertionError("production login should not require local auth-service by default")

        with patch.object(client, "request_json", fake_request):
            with patch.object(client, "ensure_gateway_oauth_login_available") as probe:
                with patch.object(client, "wait_for_local_kylith_access_token", fail_local_token):
                    with patch.object(client.webbrowser, "open") as browser_open:
                        result = client.sso_login(
                            "https://data-map-dev.kuainiu.io",
                            open_browser=True,
                            timeout_sec=5,
                        )

        probe.assert_called_once_with(login_url)
        browser_open.assert_called_once_with(login_url)
        self.assertTrue(result["configured"])
        self.assertEqual(client.load_session_config()["sessionToken"], "srbs_prod_session")
        self.assertFalse(any(item[3] and item[3].get("accessToken") for item in seen))

    def test_production_sso_login_can_use_local_token_mode(self):
        login_url = "https://data-map-dev.kuainiu.io/api/rust/v1/sr-sandboxes/auth/login?login_session_id=ls_1&state=st_1"
        seen = []

        def fake_request(method, url, token=None, payload=None, timeout=60):
            seen.append((method, url, token, payload))
            if method == "POST" and "login-sessions" in url:
                return {
                    "success": True,
                    "data": {
                        "loginSessionId": "ls_1",
                        "loginUrl": login_url,
                        "expiresAt": "2026-06-23T09:00:00Z",
                    },
                }
            if method == "POST" and "external-token-approval" in url:
                self.assertEqual(payload["accessToken"], "kylith_access_token")
                return {
                    "success": True,
                    "data": {
                        "status": "APPROVED",
                        "sessionToken": "srbs_token_mode_session",
                        "expiresAt": "2099-12-31T23:59:59Z",
                        "user": {"email": "user@kn.group", "srUser": "'user'@'%'"},
                    },
                }
            raise AssertionError(f"unexpected request {method} {url}")

        with patch.dict(os.environ, {client.AUTH_MODE_ENV: "local-token"}, clear=False):
            with patch.object(client, "request_json", fake_request):
                with patch.object(client, "wait_for_local_kylith_access_token", return_value="kylith_access_token"):
                    with patch.object(client.webbrowser, "open") as browser_open:
                        result = client.sso_login(
                            "https://data-map-dev.kuainiu.io",
                            open_browser=True,
                            timeout_sec=5,
                        )

        browser_open.assert_not_called()
        self.assertTrue(result["configured"])
        self.assertEqual(client.load_session_config()["sessionToken"], "srbs_token_mode_session")

    def test_production_sso_login_falls_back_to_gateway_browser_when_local_auth_service_is_down(self):
        login_url = "https://data-map-dev.kuainiu.io/api/rust/v1/sr-sandboxes/auth/login?login_session_id=ls_1&state=st_1"

        def fake_request(method, url, token=None, payload=None, timeout=60):
            if method == "POST" and "login-sessions" in url:
                return {
                    "success": True,
                    "data": {
                        "loginSessionId": "ls_1",
                        "loginUrl": login_url,
                        "expiresAt": "2026-06-23T09:00:00Z",
                    },
                }
            if method == "GET" and url.endswith("/login-sessions/ls_1"):
                return {
                    "success": True,
                    "data": {
                        "status": "APPROVED",
                        "sessionToken": "srbs_gateway_fallback_session",
                        "expiresAt": "2099-12-31T23:59:59Z",
                        "user": {"email": "user@kn.group", "srUser": "'user'@'%'"},
                    },
                }
            raise AssertionError(f"unexpected request {method} {url}")

        def unavailable_local_token(*_args, **_kwargs):
            raise client.GatewayError(
                "Could not reach http://127.0.0.1:8787/skill-userinfo: [Errno 61] Connection refused"
            )

        with patch.dict(os.environ, {client.AUTH_MODE_ENV: "local-token"}, clear=False):
            with patch.object(client, "request_json", fake_request):
                with patch.object(client, "wait_for_local_kylith_access_token", unavailable_local_token):
                    with patch.object(client, "ensure_gateway_oauth_login_available") as probe:
                        with patch.object(client.webbrowser, "open") as browser_open:
                            result = client.sso_login(
                                "https://data-map-dev.kuainiu.io",
                                open_browser=True,
                                timeout_sec=5,
                            )

        probe.assert_called_once_with(login_url)
        browser_open.assert_called_once_with(login_url)
        self.assertTrue(result["configured"])
        self.assertEqual(
            client.load_session_config()["sessionToken"],
            "srbs_gateway_fallback_session",
        )

    def test_sso_whoami_cli_auto_starts_sso_when_session_is_missing(self):
        seen = {}

        def fake_sso_login(base_url, open_browser=True, auto_approve=True, timeout_sec=client.DEFAULT_LOGIN_TIMEOUT):
            seen["ssoLogin"] = {
                "baseUrl": base_url,
                "openBrowser": open_browser,
                "autoApprove": auto_approve,
                "timeoutSec": timeout_sec,
            }
            expires_at = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
            client.save_session_config(
                "srbs_whoami_auto_session",
                base_url,
                user={"email": "user@kn.group"},
                expires_at=expires_at,
            )
            return client.session_status_payload()

        def fake_me(base_url, token):
            seen["whoami"] = {"baseUrl": base_url, "token": token}
            return {
                "success": True,
                "data": {"email": "user@kn.group", "srUser": "'user'@'%'"},
            }

        argv = ["sr_gateway_client.py", "sso", "whoami"]
        with patch.object(client, "sso_login", fake_sso_login):
            with patch.object(client, "get_sso_me", fake_me):
                with patch("sys.argv", argv):
                    with patch("sys.stdout") as stdout:
                        client.main()

        self.assertEqual(
            seen["ssoLogin"],
            {
                "baseUrl": "https://data-map-dev.kuainiu.io",
                "openBrowser": True,
                "autoApprove": False,
                "timeoutSec": client.DEFAULT_LOGIN_TIMEOUT,
            },
        )
        self.assertEqual(seen["whoami"]["token"], "srbs_whoami_auto_session")
        written = "".join(call.args[0] for call in stdout.write.call_args_list)
        payload = json.loads(written)
        self.assertEqual(payload["_client"]["authType"], "sso-session")
        self.assertEqual(payload["_client"]["tokenSource"], "session")

    def test_gateway_oauth_redirect_uri_error_is_actionable(self):
        with patch.object(
            client,
            "gateway_oauth_error",
            return_value={
                "error": "invalid_request",
                "description": "The 'redirect_uri' parameter does not match any pre-registered redirect urls.",
                "redirectUri": "https://data-map-dev.kuainiu.io/api/rust/v1/sr-sandboxes/auth/callback",
            },
        ):
            with self.assertRaisesRegex(client.GatewayError, "redirect_uri.*预注册"):
                client.ensure_gateway_oauth_login_available("https://data-map-dev.kuainiu.io/login")

    def test_execute_cli_auto_starts_sso_for_local_gateway_when_session_is_missing(self):
        client.save_token_config("config-token", base_url="http://127.0.0.1:4888")
        seen = {}

        def fake_sso_login(base_url, open_browser=True, auto_approve=True, timeout_sec=client.DEFAULT_LOGIN_TIMEOUT):
            seen["ssoLogin"] = {
                "baseUrl": base_url,
                "openBrowser": open_browser,
                "autoApprove": auto_approve,
                "timeoutSec": timeout_sec,
            }
            expires_at = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
            client.save_session_config(
                "srbs_auto_login_session",
                base_url,
                user={
                    "email": "user@kn.group",
                    "displayName": "Demo User",
                    "srUser": "'e_fuxi'@'%'",
                },
                expires_at=expires_at,
            )
            return client.session_status_payload()

        def fake_execute(base_url, token, country, sql, **kwargs):
            seen["execute"] = {
                "baseUrl": base_url,
                "token": token,
                "country": country,
                "sql": sql,
            }
            return {
                "success": True,
                "data": {
                    "success": True,
                    "durationMs": 1,
                    "rows": [{"ok": 1}],
                },
            }

        argv = [
            "sr_gateway_client.py",
            "execute",
            "--base-url",
            "http://127.0.0.1:4888",
            "--country",
            "cn",
            "--sql",
            "SELECT 1 AS ok",
        ]
        with patch.object(client, "sso_login", fake_sso_login):
            with patch.object(client, "execute_country_sql", fake_execute):
                with patch("sys.argv", argv):
                    with patch("sys.stdout") as stdout:
                        client.main()

        self.assertEqual(
            seen["ssoLogin"],
            {
                "baseUrl": "http://127.0.0.1:4888",
                "openBrowser": True,
                "autoApprove": False,
                "timeoutSec": client.DEFAULT_LOGIN_TIMEOUT,
            },
        )
        self.assertEqual(seen["execute"]["token"], "srbs_auto_login_session")
        written = "".join(call.args[0] for call in stdout.write.call_args_list)
        payload = json.loads(written)
        self.assertEqual(payload["_client"]["authType"], "sso-session")
        self.assertEqual(payload["_client"]["tokenSource"], "session")

    def test_execute_cli_relogs_when_saved_local_sso_session_was_revoked(self):
        expires_at = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
        client.save_session_config(
            "srbs_old_session",
            "http://127.0.0.1:4888",
            user={"email": "user@kn.group"},
            expires_at=expires_at,
        )
        seen = {"tokens": []}

        def fake_sso_login(base_url, open_browser=True, auto_approve=True, timeout_sec=client.DEFAULT_LOGIN_TIMEOUT):
            seen["ssoLogin"] = {
                "baseUrl": base_url,
                "openBrowser": open_browser,
                "autoApprove": auto_approve,
                "timeoutSec": timeout_sec,
            }
            client.save_session_config(
                "srbs_new_session",
                base_url,
                user={"email": "user@kn.group"},
                expires_at=expires_at,
            )
            return client.session_status_payload()

        def fake_execute(base_url, token, country, sql, **kwargs):
            seen["tokens"].append(token)
            if token == "srbs_old_session":
                raise client.GatewayError(
                    "HTTP 401 from http://127.0.0.1:4888/api/rust/v1/sr-sandboxes/sql-executions: "
                    '{"success":false,"message":"SSO session 不存在或已吊销"}'
                )
            return {
                "success": True,
                "data": {"success": True, "durationMs": 1, "rows": [{"ok": 1}]},
            }

        argv = [
            "sr_gateway_client.py",
            "execute",
            "--base-url",
            "http://127.0.0.1:4888",
            "--country",
            "cn",
            "--sql",
            "SELECT 1 AS ok",
        ]
        with patch.object(client, "sso_login", fake_sso_login):
            with patch.object(client, "execute_country_sql", fake_execute):
                with patch("sys.argv", argv):
                    with patch("sys.stdout") as stdout:
                        client.main()

        self.assertEqual(seen["tokens"], ["srbs_old_session", "srbs_new_session"])
        self.assertEqual(client.load_session_config()["sessionToken"], "srbs_new_session")
        written = "".join(call.args[0] for call in stdout.write.call_args_list)
        payload = json.loads(written)
        self.assertEqual(payload["_client"]["tokenSource"], "session")

    def test_execute_cli_waits_and_retries_when_sso_policy_is_initializing(self):
        expires_at = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
        client.save_session_config(
            "srbs_initializing_session",
            "http://127.0.0.1:4888",
            user={"email": "user@kn.group"},
            expires_at=expires_at,
        )
        seen = {"attempts": 0}

        def fake_execute(base_url, token, country, sql, **kwargs):
            seen["attempts"] += 1
            if seen["attempts"] == 1:
                raise client.GatewayError(
                    "HTTP 409 from http://127.0.0.1:4888/api/rust/v1/sr-sandboxes/sql-executions: initializing",
                    status_code=409,
                    payload={
                        "success": False,
                        "message": "SSO 账号权限正在初始化，请稍后重试",
                        "data": {"code": "SSO_ACCOUNT_INITIALIZING"},
                    },
                )
            return {
                "success": True,
                "data": {"success": True, "durationMs": 1, "rows": [{"ok": 1}]},
            }

        argv = [
            "sr_gateway_client.py",
            "execute",
            "--base-url",
            "http://127.0.0.1:4888",
            "--country",
            "th",
            "--sql",
            "SELECT 1 AS ok",
        ]
        with patch.object(client, "execute_country_sql", fake_execute):
            with patch.object(client.time, "sleep") as sleep:
                with patch("sys.argv", argv):
                    with patch("sys.stdout") as stdout:
                        with patch("sys.stderr") as stderr:
                            client.main()

        self.assertEqual(seen["attempts"], 2)
        sleep.assert_called_once()
        self.assertIn("初始化", "".join(call.args[0] for call in stderr.write.call_args_list))
        written = "".join(call.args[0] for call in stdout.write.call_args_list)
        payload = json.loads(written)
        self.assertEqual(payload["_client"]["tokenSource"], "session")

    def test_execute_cli_without_base_url_defaults_to_data_map_dev_sso_not_shared_token(self):
        client.save_token_config("config-token", base_url="https://sr-box.kuainiu.io")
        seen = {}

        def fake_sso_login(base_url, open_browser=True, auto_approve=True, timeout_sec=client.DEFAULT_LOGIN_TIMEOUT):
            seen["ssoLogin"] = {
                "baseUrl": base_url,
                "openBrowser": open_browser,
                "autoApprove": auto_approve,
                "timeoutSec": timeout_sec,
            }
            expires_at = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
            client.save_session_config(
                "srbs_default_data_map_session",
                base_url,
                user={
                    "email": "user@kn.group",
                    "displayName": "Demo User",
                    "srUser": "'e_fuxi'@'%'",
                },
                expires_at=expires_at,
            )
            return client.session_status_payload()

        def fake_execute(base_url, token, country, sql, **kwargs):
            seen["execute"] = {
                "baseUrl": base_url,
                "token": token,
                "country": country,
                "sql": sql,
            }
            return {
                "success": True,
                "data": {
                    "success": True,
                    "durationMs": 1,
                    "rows": [{"ok": 1}],
                },
            }

        argv = [
            "sr_gateway_client.py",
            "execute",
            "--country",
            "cn",
            "--sql",
            "SELECT 1 AS ok",
        ]
        with patch.object(client, "sso_login", fake_sso_login):
            with patch.object(client, "execute_country_sql", fake_execute):
                with patch("sys.argv", argv):
                    with patch("sys.stdout") as stdout:
                        client.main()

        self.assertEqual(
            seen["ssoLogin"],
            {
                "baseUrl": "https://data-map-dev.kuainiu.io",
                "openBrowser": True,
                "autoApprove": False,
                "timeoutSec": client.DEFAULT_LOGIN_TIMEOUT,
            },
        )
        self.assertEqual(seen["execute"]["baseUrl"], "https://data-map-dev.kuainiu.io")
        self.assertEqual(seen["execute"]["token"], "srbs_default_data_map_session")
        written = "".join(call.args[0] for call in stdout.write.call_args_list)
        payload = json.loads(written)
        self.assertEqual(payload["_client"]["authType"], "sso-session")
        self.assertEqual(payload["_client"]["tokenSource"], "session")

    def test_cli_no_longer_exposes_token_subcommand_or_token_argument(self):
        parser = client.build_parser()

        with patch("sys.stderr"):
            with self.assertRaises(SystemExit):
                parser.parse_args(["token", "status"])

        with patch("sys.stderr"):
            with self.assertRaises(SystemExit):
                parser.parse_args(
                    [
                        "execute",
                        "--token",
                        "secret-token-abcdef",
                        "--country",
                        "cn",
                        "--sql",
                        "SELECT 1",
                    ]
                )


if __name__ == "__main__":
    unittest.main()
