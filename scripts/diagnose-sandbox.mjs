#!/usr/bin/env node
// Sandbox 作成を直接試してエラー詳細を捕捉する。
// Usage: node --env-file=.env.local scripts/diagnose-sandbox.mjs

import { Sandbox } from "@vercel/sandbox";

const repoUrl =
  "https://github.com/propagate-webcreation/16668-tejinaanyan-dono.git";
const githubUser = "x-access-token";
const githubToken = process.env.GITHUB_TOKEN;

const oidc = process.env.VERCEL_OIDC_TOKEN;
const teamId = process.env.VERCEL_TEAM_ID;
const projectId = process.env.VERCEL_PROJECT_ID;

console.log("env summary:");
console.log("  OIDC_TOKEN:", oidc ? "set" : "MISSING");
console.log("  TEAM_ID:", teamId);
console.log("  PROJECT_ID:", projectId);
console.log("  GITHUB_TOKEN:", githubToken ? "set" : "MISSING");
console.log("");

try {
  console.log("Sandbox.create() 試行中...");
  const sbx = await Sandbox.create({
    token: process.env.VERCEL_TOKEN ?? oidc,
    teamId,
    projectId,
    source: {
      type: "git",
      url: repoUrl,
      username: githubUser,
      password: githubToken,
      depth: 1,
    },
    ports: [3000],
    timeout: 10 * 60 * 1000,
    runtime: "node24",
  });
  console.log("✅ 成功 sandboxId=", sbx.sandboxId);
  console.log("   domain=", sbx.domain(3000));
} catch (err) {
  console.error("❌ エラー");
  console.error("name:", err?.name);
  console.error("message:", err?.message);
  console.error("status:", err?.response?.status);
  console.error("statusText:", err?.response?.statusText);
  console.error("text:", err?.text);
  console.error("json:", JSON.stringify(err?.json, null, 2));
  if (err?.cause) console.error("cause:", err.cause);
}
