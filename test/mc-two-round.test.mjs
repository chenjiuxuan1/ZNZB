import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAlertRegistry } from "../src/alert-registry.mjs";

async function tmpRegistry(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mc-two-round-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const registry = createAlertRegistry({ rootDir: dir });
  return { registry, dir };
}

test("两轮制：首次异常(repairTriggered)不计数 strike，持续异常(broadcast)才 +1", async (t) => {
  const { registry } = await tmpRegistry(t);

  // 第 1 轮：cn 首次异常（只 repairTriggered，不 broadcast）→ strike 不 +1
  const r1 = await registry.appendCheckResult({
    source: "multi-country",
    checkedAt: "2026-09-07T00:00:00.000Z",
    broadcast: [],
    repairTriggered: ["cn"],
    countries: [{ code: "cn", label: "中国", mismatches: [{ check_item: "user_flag", mismatch_cnt: 3 }] }],
    hasAlert: true,
  });
  assert.equal(r1.strikes.cn, 0, "首次异常不应计 strike");
  assert.deepEqual(r1.phoneNeeded, [], "首次异常不应触发电话");
  assert.deepEqual(r1.run.broadcast, []);
  assert.deepEqual(r1.run.repairTriggered, ["cn"]);

  // 第 2 轮：cn 持续异常（broadcast）→ strike +1
  const r2 = await registry.appendCheckResult({
    source: "multi-country",
    checkedAt: "2026-09-07T04:00:00.000Z",
    broadcast: ["cn"],
    repairTriggered: [],
    countries: [{ code: "cn", label: "中国", mismatches: [{ check_item: "user_flag", mismatch_cnt: 5 }] }],
    hasAlert: true,
  });
  assert.equal(r2.strikes.cn, 1, "持续异常应计 strike 1");
  assert.ok(r2.phoneNeeded.includes("cn"), "每次播报都打电话：broadcast 即触发电话");

  // 第 3 轮：cn 恢复（无 mismatch）→ strike 归零
  const r3 = await registry.appendCheckResult({
    source: "multi-country",
    checkedAt: "2026-09-07T08:00:00.000Z",
    broadcast: [],
    repairTriggered: [],
    countries: [{ code: "cn", label: "中国", mismatches: [] }],
    hasAlert: false,
  });
  assert.equal(r3.strikes.cn, 0, "恢复正常 strike 归零");
});

test("每次播报都打电话：broadcast 即触发 phoneNeeded，首次异常(repair)不触发", async (t) => {
  const { registry } = await tmpRegistry(t);

  // 第 1 次：cn 首次异常（repairTriggered，不 broadcast）→ 不电话
  const r1 = await registry.appendCheckResult({
    source: "multi-country",
    checkedAt: "2026-09-07T04:00:00.000Z",
    broadcast: [],
    repairTriggered: ["cn"],
    countries: [{ code: "cn", label: "中国", mismatches: [{ check_item: "user_flag", mismatch_cnt: 1 }] }],
    hasAlert: true,
  });
  assert.deepEqual(r1.phoneNeeded, [], "首次异常不触发电话");
  assert.equal(r1.strikes.cn, 0);

  // 第 2 次：cn 持续异常（broadcast）→ 立即触发电话（无需累计）
  const r2 = await registry.appendCheckResult({
    source: "multi-country",
    checkedAt: "2026-09-07T08:00:00.000Z",
    broadcast: ["cn"],
    repairTriggered: [],
    countries: [{ code: "cn", label: "中国", mismatches: [{ check_item: "user_flag", mismatch_cnt: 1 }] }],
    hasAlert: true,
  });
  assert.equal(r2.strikes.cn, 1);
  assert.ok(r2.phoneNeeded.includes("cn"), "每次播报都打电话：首次 broadcast 即触发电话");
});

test("两轮制：无异常国家计数不受他国影响", async (t) => {
  const { registry } = await tmpRegistry(t);

  // cn 持续异常 +1
  await registry.appendCheckResult({
    source: "multi-country",
    checkedAt: "2026-09-07T04:00:00.000Z",
    broadcast: ["cn"],
    repairTriggered: [],
    countries: [{ code: "cn", label: "中国", mismatches: [{ check_item: "a", mismatch_cnt: 1 }] }],
    hasAlert: true,
  });
  // id 首次异常（repair）→ 不影响 cn，id 不计数
  const r = await registry.appendCheckResult({
    source: "multi-country",
    checkedAt: "2026-09-07T08:00:00.000Z",
    broadcast: ["cn"],
    repairTriggered: ["id"],
    countries: [
      { code: "cn", label: "中国", mismatches: [{ check_item: "a", mismatch_cnt: 1 }] },
      { code: "id", label: "印尼", mismatches: [{ check_item: "b", mismatch_cnt: 2 }] },
    ],
    hasAlert: true,
  });
  assert.equal(r.strikes.cn, 2, "cn 持续计数继续累加");
  assert.equal(r.strikes.id, 0, "id 首次异常不计数");
});

test("历史保留 broadcast/repairTriggered 标记", async (t) => {
  const { registry } = await tmpRegistry(t);
  await registry.appendCheckResult({
    source: "multi-country",
    checkedAt: "2026-09-07T00:00:00.000Z",
    broadcast: [],
    repairTriggered: ["cn"],
    countries: [{ code: "cn", label: "中国", mismatches: [{ check_item: "a", mismatch_cnt: 1 }] }],
    hasAlert: true,
  });
  const list = await registry.listCheckResults();
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].repairTriggered, ["cn"]);
  assert.deepEqual(list[0].broadcast, []);
});
