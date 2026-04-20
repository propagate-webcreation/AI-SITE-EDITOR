import { Sandbox } from "@vercel/sandbox";
const sbx = await Sandbox.get({
  token: process.env.VERCEL_TOKEN,
  teamId: process.env.VERCEL_TEAM_ID,
  projectId: process.env.VERCEL_PROJECT_ID,
  sandboxId: process.argv[2],
});
console.log("routes:", JSON.stringify(sbx.routes, null, 2));
console.log("sandbox:", JSON.stringify(sbx.sandbox, null, 2));
