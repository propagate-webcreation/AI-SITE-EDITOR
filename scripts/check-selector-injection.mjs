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

console.log("=== public/directors-bot-selector.js の有無 ===");
console.log(await run("ls -la /vercel/sandbox/public/directors-bot-selector.js 2>&1 | head -3"));

console.log("\n=== selector.js の先頭 200 文字 ===");
console.log(await run("head -c 300 /vercel/sandbox/public/directors-bot-selector.js 2>&1"));

console.log("\n=== layout.tsx の場所 ===");
console.log(await run("find /vercel/sandbox/src/app /vercel/sandbox/app -name 'layout*' 2>/dev/null | head -5"));

console.log("\n=== src/app/layout.tsx の内容 (全文) ===");
console.log(await run("cat /vercel/sandbox/src/app/layout.tsx 2>&1 || cat /vercel/sandbox/app/layout.tsx 2>&1"));

console.log("\n=== middleware.ts は .vercel.run をホワイトリスト ===");
console.log(await run("grep -n 'vercel.run\\|vercel.app' /vercel/sandbox/middleware.ts 2>&1 | head -5"));

console.log("\n=== localhost:3000/directors-bot-selector.js で取得可能か ===");
console.log(await run("curl -s -o /dev/null -w 'status=%{http_code} size=%{size_download}\\n' --max-time 5 http://127.0.0.1:3000/directors-bot-selector.js"));

console.log("\n=== localhost:3000/ の HTML に script タグがあるか ===");
console.log(await run("curl -s --max-time 5 http://127.0.0.1:3000/ | grep -o 'directors-bot-selector[^\"]*' | head -3"));
