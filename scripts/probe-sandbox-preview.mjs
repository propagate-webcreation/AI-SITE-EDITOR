#!/usr/bin/env node
// Vercel Sandbox の preview URL とその内部挙動を探る。
// Usage: node --env-file=.env.local scripts/probe-sandbox-preview.mjs <sandboxId>

import { Sandbox } from "@vercel/sandbox";

const sandboxId = process.argv[2];
if (!sandboxId) {
  console.error("usage: probe-sandbox-preview.mjs <sandboxId>");
  process.exit(1);
}

const sbx = await Sandbox.get({
  token: process.env.VERCEL_TOKEN,
  teamId: process.env.VERCEL_TEAM_ID,
  projectId: process.env.VERCEL_PROJECT_ID,
  sandboxId,
});

console.log("domain(3000):", sbx.domain(3000));

async function runCaptured(cmd, args) {
  const { Writable } = await import("node:stream");
  let stdout = "";
  let stderr = "";
  await sbx.runCommand({
    cmd,
    args,
    stdout: new Writable({
      write(chunk, _enc, cb) { stdout += chunk.toString("utf8"); cb(); },
    }),
    stderr: new Writable({
      write(chunk, _enc, cb) { stderr += chunk.toString("utf8"); cb(); },
    }),
  });
  return { stdout, stderr };
}

console.log("\n=== dev サーバーが内部で listening しているか ===");
const netstat = await runCaptured("bash", [
  "-lc",
  "ss -tln 2>/dev/null | grep LISTEN | head -10",
]);
console.log(netstat.stdout);

console.log("\n=== localhost:3000 内部から HTTP status ===");
const local = await runCaptured("bash", [
  "-lc",
  `curl -s -o /dev/null -w "status=%{http_code} redirect=%{redirect_url}\\n" -I http://127.0.0.1:3000/`,
]);
console.log(local.stdout);

console.log("\n=== localhost:3000 内部から HTML 先頭 ===");
const body = await runCaptured("bash", [
  "-lc",
  "curl -s --max-time 10 http://127.0.0.1:3000/ | head -20",
]);
console.log(body.stdout.slice(0, 2000));

console.log("\n=== dev ログの末尾 ===");
const devlog = await runCaptured("bash", [
  "-lc",
  "ls /tmp/*.log 2>/dev/null; find / -name '.next*' -type d 2>/dev/null | head; cat /vercel/sandbox/.next/trace 2>/dev/null | head -5 || echo 'no trace'",
]);
console.log(devlog.stdout.slice(0, 2000));

console.log("\n=== 外部からフェッチ ===");
const url = sbx.domain(3000);
try {
  const resp = await fetch(url, { redirect: "manual" });
  console.log("status:", resp.status);
  console.log("location:", resp.headers.get("location"));
  console.log("x-vercel-id:", resp.headers.get("x-vercel-id"));
  console.log("content-type:", resp.headers.get("content-type"));
  console.log("x-frame-options:", resp.headers.get("x-frame-options"));
  console.log("content-security-policy:", resp.headers.get("content-security-policy"));
  const text = await resp.text();
  console.log("body preview:", text.slice(0, 500));
} catch (e) {
  console.error("fetch failed:", e.message);
}
