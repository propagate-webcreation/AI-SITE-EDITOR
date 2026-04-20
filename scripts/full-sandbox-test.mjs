#!/usr/bin/env node
// 本番相当のシーケンス (create -> install -> run dev -> wait) を試す。

import { Sandbox } from "@vercel/sandbox";

const creds = {
  token: process.env.VERCEL_TOKEN,
  teamId: process.env.VERCEL_TEAM_ID,
  projectId: process.env.VERCEL_PROJECT_ID,
};

console.log("1. Sandbox.create() ...");
const sbx = await Sandbox.create({
  ...creds,
  source: {
    type: "git",
    url: "https://github.com/propagate-webcreation/16668-tejinaanyan-dono.git",
    username: "x-access-token",
    password: process.env.GITHUB_TOKEN,
    depth: 1,
  },
  ports: [3000],
  timeout: 20 * 60 * 1000,
  runtime: "node24",
});
console.log("  sandboxId:", sbx.sandboxId);
console.log("  domain(3000):", sbx.domain(3000));

console.log("\n2. ls /vercel/sandbox");
await sbx.runCommand({
  cmd: "bash",
  args: ["-lc", "ls -1 /vercel/sandbox | head -20"],
  stdout: process.stdout,
  stderr: process.stderr,
});

console.log("\n3. package.json scripts");
await sbx.runCommand({
  cmd: "bash",
  args: ["-lc", "cat /vercel/sandbox/package.json 2>/dev/null | grep -A20 scripts || echo 'no package.json'"],
  stdout: process.stdout,
  stderr: process.stderr,
});

console.log("\n4. npm install ...");
const t0 = Date.now();
const inst = await sbx.runCommand({
  cmd: "npm",
  args: ["install", "--no-audit", "--no-fund"],
  stdout: process.stdout,
  stderr: process.stderr,
});
console.log(`  exit=${inst.exitCode}, took ${Math.round((Date.now() - t0) / 1000)}s`);

if (inst.exitCode !== 0) {
  console.error("npm install failed");
  await sbx.stop();
  process.exit(1);
}

console.log("\n5. npm run dev (detached) ...");
await sbx.runCommand({
  cmd: "bash",
  args: ["-lc", "cd /vercel/sandbox && nohup npm run dev -- -p 3000 > /tmp/dev.log 2>&1 &"],
});

console.log("\n6. 30 秒待機 → ログ確認");
await new Promise((r) => setTimeout(r, 30000));

await sbx.runCommand({
  cmd: "bash",
  args: ["-lc", "tail -n 40 /tmp/dev.log"],
  stdout: process.stdout,
  stderr: process.stderr,
});

console.log("\n7. port 3000 listening?");
await sbx.runCommand({
  cmd: "bash",
  args: ["-lc", "ss -tln 2>/dev/null | grep ':3000' || netstat -tln 2>/dev/null | grep ':3000' || echo 'not listening'"],
  stdout: process.stdout,
  stderr: process.stderr,
});

console.log("\n8. curl localhost:3000 from inside sandbox");
await sbx.runCommand({
  cmd: "bash",
  args: ["-lc", "curl -s -I http://127.0.0.1:3000/ | head -5 || echo 'curl failed'"],
  stdout: process.stdout,
  stderr: process.stderr,
});

console.log("\nDone. sandboxId:", sbx.sandboxId);
console.log("URL:", sbx.domain(3000));
