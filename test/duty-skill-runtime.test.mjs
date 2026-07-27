import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DutySkillRuntime } from "../src/duty-skill-runtime.mjs";
import { createPlatformApi } from "../src/platform-api.mjs";

async function makeRuntimeFixture(execFileFn) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "duty-skill-runtime-"));
  const fullSkills = path.join(rootDir, "runtime/skills/full/sr-dev/skills");
  const packs = path.join(rootDir, "runtime/skills/full/sr-dev/skill-packs/packs");
  const srBoxScripts = path.join(rootDir, "runtime/skills/standalone/sr_box/scripts");
  await fs.mkdir(path.join(fullSkills, "sr_box"), { recursive: true });
  await fs.mkdir(path.join(fullSkills, "dw-knowledge"), { recursive: true });
  await fs.mkdir(packs, { recursive: true });
  await fs.mkdir(srBoxScripts, { recursive: true });
  await fs.writeFile(path.join(fullSkills, "sr_box/SKILL.md"), "# sr-box");
  await fs.writeFile(path.join(fullSkills, "dw-knowledge/SKILL.md"), "# knowledge");
  await fs.writeFile(path.join(packs, "sr-box.yaml"), "id: sr-box");
  await fs.writeFile(path.join(srBoxScripts, "sr_gateway_client.py"), "# runtime");
  return new DutySkillRuntime({
    rootDir,
    pythonExecutable: "/usr/bin/python3",
    execFileFn,
  });
}

test("duty skill runtime discovers the full bundle and bundled SR Box", async () => {
  const runtime = await makeRuntimeFixture(async () => ({
    stdout: JSON.stringify({
      success: true,
      configured: true,
      valid: true,
      source: "sso",
      sessionPreview: "srbs_secret",
      user: { email: "owner@example.com", displayName: "Owner", srUser: "'owner'@'%'" },
    }),
    stderr: "",
  }));

  const status = await runtime.getStatus();

  assert.equal(status.available, true);
  assert.deepEqual(status.fullBundle.skills, ["dw-knowledge", "sr_box"]);
  assert.deepEqual(status.fullBundle.packs, ["sr-box"]);
  assert.equal(status.srBox.sso.valid, true);
  assert.equal(Object.hasOwn(status.srBox.sso, "sessionPreview"), false);
});

test("duty skill runtime executes only read-only SR Box SQL and redacts tokens", async () => {
  const calls = [];
  const runtime = await makeRuntimeFixture(async (file, args, options) => {
    calls.push({ file, args, options });
    if (args.includes("status")) {
      return {
        stdout: JSON.stringify({ success: true, configured: true, valid: true, source: "sso" }),
        stderr: "",
      };
    }
    return {
      stdout: JSON.stringify({
        success: true,
        traceId: "trace-1",
        sessionToken: "srbs_secret",
        data: { rows: [{ ok: 1 }] },
      }),
      stderr: "",
    };
  });

  const result = await runtime.runSrBoxAction({
    action: "execute",
    country: "INE",
    sql: "SELECT 1 AS ok",
  });

  assert.equal(result.ok, true);
  assert.equal(result.result.sessionToken, "[REDACTED]");
  assert.ok(calls[1].args.includes("id"));
  assert.ok(calls[1].args.includes("SELECT 1 AS ok"));
  assert.equal(Object.hasOwn(calls[1].options, "shell"), false);

  await assert.rejects(
    () => runtime.runSrBoxAction({ action: "execute", country: "cn", sql: "DELETE FROM prod.t" }),
    /read-only|must start|forbidden/i,
  );
});

test("duty skill runtime blocks authenticated commands when SSO is unavailable", async () => {
  const runtime = await makeRuntimeFixture(async () => ({
    stdout: JSON.stringify({ success: true, configured: false, valid: false, source: "none" }),
    stderr: "",
  }));

  await assert.rejects(
    () => runtime.runSrBoxAction({ action: "permissions", country: "cn" }),
    (error) => error.statusCode === 409 && /SSO session is not ready/.test(error.message),
  );
});

test("platform API exposes the bundled skill runtime", async () => {
  const calls = [];
  const api = createPlatformApi({
    rootDir: "/tmp/duty-skill-runtime-platform",
    skillRuntimeFactory: ({ rootDir }) => ({
      async getStatus() {
        calls.push(["status", rootDir]);
        return { available: true, fullBundle: { skillCount: 10 } };
      },
      async runSrBoxAction(body) {
        calls.push(["run", body]);
        return { ok: true, action: body.action };
      },
    }),
  });

  assert.equal((await api.getSkillRuntimeStatus()).fullBundle.skillCount, 10);
  assert.deepEqual(await api.runSrBoxSkill({ action: "health" }), {
    ok: true,
    action: "health",
  });
  assert.deepEqual(calls, [
    ["status", "/tmp/duty-skill-runtime-platform"],
    ["run", { action: "health" }],
  ]);
});
