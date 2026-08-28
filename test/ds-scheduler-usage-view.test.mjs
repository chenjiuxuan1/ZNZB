import test from "node:test";
import assert from "node:assert/strict";
import {
  filterAccessUsers,
  fmtDuration,
  paginateAccessUsers,
} from "../web/src/views/ds-scheduler-usage.js";

test("gateway usage duration formatter", () => {
  assert.equal(fmtDuration(0), "-");
  assert.equal(fmtDuration(500), "500ms");
  assert.equal(fmtDuration(1500), "1.5s");
  assert.equal(fmtDuration(), "-");
});

const ACCESS_USERS = [
  { username: "alice", tokens: ["TOK-ALICE"], configured: true, status: "ok" },
  { username: "bob", tokens: ["TOK-BOB"], configured: false, status: "blocked" },
  { username: "carol", tokens: ["TOK-CAROL"], configured: true, status: "limited" },
];

test("access user filtering matches username and token case-insensitively", () => {
  assert.deepEqual(filterAccessUsers(ACCESS_USERS, "ALI", "all").map((u) => u.username), ["alice"]);
  assert.deepEqual(filterAccessUsers(ACCESS_USERS, "tok-bob", "all").map((u) => u.username), ["bob"]);
});

test("access user filtering supports configuration and runtime status", () => {
  assert.deepEqual(filterAccessUsers(ACCESS_USERS, "", "configured").map((u) => u.username), ["alice", "carol"]);
  assert.deepEqual(filterAccessUsers(ACCESS_USERS, "", "default").map((u) => u.username), ["bob"]);
  assert.deepEqual(filterAccessUsers(ACCESS_USERS, "", "limited").map((u) => u.username), ["carol"]);
  assert.deepEqual(filterAccessUsers(ACCESS_USERS, "", "blocked").map((u) => u.username), ["bob"]);
});

test("access user pagination clamps the requested page and reports its range", () => {
  const users = Array.from({ length: 10 }, (_, index) => ({ username: `user-${index + 1}` }));
  assert.deepEqual(paginateAccessUsers(users, 99, 8), {
    page: 1,
    totalPages: 2,
    start: 9,
    end: 10,
    items: users.slice(8),
  });
  assert.deepEqual(paginateAccessUsers([], 3, 8), {
    page: 0,
    totalPages: 1,
    start: 0,
    end: 0,
    items: [],
  });
});
