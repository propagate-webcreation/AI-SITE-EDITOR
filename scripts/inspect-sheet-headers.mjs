#!/usr/bin/env node
// 1 行目のヘッダーと、指定レコードの各列値を出力する診断スクリプト。
// Usage: node --env-file=.env.local scripts/inspect-sheet-headers.mjs [recordNumber]

import { readFileSync } from "node:fs";
import { google } from "googleapis";
import { JWT } from "google-auth-library";

const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
const sheetName = process.env.GOOGLE_SHEETS_SHEET_NAME;
const credentialsPath = process.env.GOOGLE_SHEETS_CREDENTIALS_PATH;

if (!spreadsheetId || !sheetName || !credentialsPath) {
  console.error("env が足りません (GOOGLE_SHEETS_*)");
  process.exit(1);
}

const creds = JSON.parse(readFileSync(credentialsPath, "utf8"));
const jwt = new JWT({
  email: creds.client_email,
  key: creds.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});
const sheets = google.sheets({ version: "v4", auth: jwt });

function indexToLetter(i) {
  let n = i + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Row 1 (headers)
const r1 = await sheets.spreadsheets.values.get({
  spreadsheetId,
  range: `${sheetName}!1:1`,
});
const headers = r1.data.values?.[0] ?? [];
console.log("=== 1 行目ヘッダー ===");
headers.forEach((h, i) => {
  if (h) console.log(`  ${indexToLetter(i)}: "${h}"`);
});

// Try to find a URL-like column
console.log("\n=== URL っぽい列 ===");
headers.forEach((h, i) => {
  const lc = (h ?? "").toLowerCase();
  if (lc.includes("url") || lc.includes("repo") || lc.includes("git")) {
    console.log(`  ${indexToLetter(i)}: "${h}"`);
  }
});

// Specific record
const record = process.argv[2];
if (record) {
  console.log(`\n=== レコード ${record} の行データ ===`);
  const all = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A2:ZZ`,
  });
  const rows = all.data.values ?? [];
  // Try to find the record_id column; fall back to column A
  const recordIdIdx = headers.findIndex((h) => h?.trim() === "record_id");
  const idx = recordIdIdx >= 0 ? recordIdIdx : 0;
  const match = rows.find((r) => r[idx] === record);
  if (!match) {
    console.log(`  レコード ${record} が見つかりません (検索列=${indexToLetter(idx)})`);
  } else {
    headers.forEach((h, i) => {
      const v = match[i];
      if (v !== undefined && v !== "") {
        console.log(`  ${indexToLetter(i)} [${h}]: ${v.slice(0, 120)}`);
      }
    });
  }
}
