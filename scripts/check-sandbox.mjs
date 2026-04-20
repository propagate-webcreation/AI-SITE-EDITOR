#!/usr/bin/env node
// 既存 sandbox に繋いで状態を確認する。
// Usage: node --env-file=.env.local scripts/check-sandbox.mjs <sandboxId>

import { Sandbox } from "@vercel/sandbox";

const sandboxId = process.argv[2];
if (!sandboxId) {
  console.error("usage: check-sandbox.mjs <sandboxId>");
  process.exit(1);
}

const sbx = await Sandbox.get({
  token: process.env.VERCEL_TOKEN,
  teamId: process.env.VERCEL_TEAM_ID,
  projectId: process.env.VERCEL_PROJECT_ID,
  sandboxId,
});

console.log("=== domain(3000) ===");
console.log(sbx.domain(3000));

console.log("\n=== running processes ===");
const ps = await sbx.runCommand({
  cmd: "bash",
  args: ["-lc", "ps auxf | grep -E 'node|npm' | grep -v grep || true"],
});
console.log("exit:", ps.exitCode);
// 注意: runCommand は detached でないとき stdout/stderr を result に入れない可能性あり

console.log("\n=== ls /vercel/sandbox ===");
await sbx.runCommand({
  cmd: "bash",
  args: ["-lc", "ls -la /vercel/sandbox | head -30"],
  stdout: process.stdout,
  stderr: process.stderr,
});

console.log("\n=== package.json scripts ===");
await sbx.runCommand({
  cmd: "bash",
  args: ["-lc", "cat /vercel/sandbox/package.json 2>/dev/null | head -60 || echo 'no package.json'"],
  stdout: process.stdout,
  stderr: process.stderr,
});

console.log("\n=== port 3000 check ===");
await sbx.runCommand({
  cmd: "bash",
  args: ["-lc", "ss -tlnp 2>/dev/null | grep -E ':3000|:300' || netstat -tlnp 2>/dev/null | grep ':3000' || echo 'nothing listening on 3000'"],
  stdout: process.stdout,
  stderr: process.stderr,
});
