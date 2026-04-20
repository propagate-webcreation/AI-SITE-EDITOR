import { Sandbox } from "@vercel/sandbox";
import { Writable } from "node:stream";

const sbx = await Sandbox.get({
  token: process.env.VERCEL_TOKEN,
  teamId: process.env.VERCEL_TEAM_ID,
  projectId: process.env.VERCEL_PROJECT_ID,
  sandboxId: process.argv[2],
});

async function run(cmd) {
  let out = "";
  await sbx.runCommand({
    cmd: "bash",
    args: ["-lc", cmd],
    stdout: new Writable({ write(c, _e, cb) { out += c.toString("utf8"); cb(); } }),
    stderr: new Writable({ write(c, _e, cb) { out += c.toString("utf8"); cb(); } }),
  });
  return out;
}

console.log("=== netstat / ss 出力 ===");
console.log(await run("(ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null) | grep -E ':3000|node' | head -20"));

console.log("=== lsof port 3000 ===");
console.log(await run("lsof -i :3000 2>/dev/null | head -10 || echo 'lsof not available'"));

console.log("=== curl 0.0.0.0:3000 から ===");
console.log(await run("curl -s -o /dev/null -w 'status=%{http_code}\\n' --max-time 5 http://0.0.0.0:3000/"));

console.log("=== curl eth0 の IP から ===");
console.log(await run("IP=$(hostname -i 2>/dev/null | awk '{print $1}'); echo \"local IP: $IP\"; curl -s -o /dev/null -w 'status=%{http_code}\\n' --max-time 5 http://$IP:3000/"));

console.log("=== dev server プロセス ===");
console.log(await run("ps auxf 2>/dev/null | grep -E 'node|next' | grep -v grep | head -10"));

console.log("\n=== middleware / proxy 定義を探す ===");
console.log(await run("find /vercel/sandbox/src /vercel/sandbox/app /vercel/sandbox/middleware* /vercel/sandbox/proxy* -maxdepth 4 -type f 2>/dev/null | grep -E 'middleware|proxy' | head -20"));
console.log(await run("cat /vercel/sandbox/middleware.ts 2>/dev/null | head -80 || cat /vercel/sandbox/src/middleware.ts 2>/dev/null | head -80 || cat /vercel/sandbox/proxy.ts 2>/dev/null | head -80 || cat /vercel/sandbox/src/proxy.ts 2>/dev/null | head -80 || echo 'no middleware'"));

console.log("\n=== next.config ===");
console.log(await run("cat /vercel/sandbox/next.config.ts 2>/dev/null || cat /vercel/sandbox/next.config.mjs 2>/dev/null || cat /vercel/sandbox/next.config.js 2>/dev/null"));

console.log("\n=== curl X-Forwarded-Host 付き ===");
console.log(await run(`curl -s -o /dev/null -w 'status=%{http_code} location=%{redirect_url}\\n' -I -H 'Host: sb-6uqrejzoeoho.vercel.run' -H 'X-Forwarded-Proto: https' --max-time 5 http://127.0.0.1:3000/`));
