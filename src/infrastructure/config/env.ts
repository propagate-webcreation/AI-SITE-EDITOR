import "server-only";

export interface AppEnv {
  geminiApiKey: string | undefined;
  geminiModel: string;
  /**
   * 全体指示モード用のモデル。未設定時は geminiModel を流用。
   * 精度重視 (例: gemini-3-pro-preview) を推奨。
   */
  geminiGlobalModel: string;
  geminiMaxIterations: number;
  agentTimeoutSec: number;

  githubToken: string | undefined;
  githubUsername: string;
  botGitAuthorName: string;
  botGitAuthorEmail: string;
  gitDeployBranch: string;

  googleSheets: {
    spreadsheetId: string;
    sheetName: string;
    credentialsPath: string | undefined;
    credentialsJson: string | undefined;
  } | null;

  doneStatus: string;

  vercel: {
    oidcToken: string | undefined;
    teamId: string | undefined;
    projectId: string | undefined;
    accessToken: string | undefined;
  };

  supabase: {
    url: string;
    anonKey: string;
    serviceRoleKey: string;
  } | null;

  sessionDefaultTtlSec: number;
  defaultPreviewUrl: string | undefined;
}

function readOptional(name: string): string | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  return value;
}

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `環境変数 ${name} は正の数である必要があります。受信値: ${raw}`,
    );
  }
  return parsed;
}

function readGoogleSheetsConfig(): AppEnv["googleSheets"] {
  const spreadsheetId = readOptional("GOOGLE_SHEETS_SPREADSHEET_ID");
  const sheetName = readOptional("GOOGLE_SHEETS_SHEET_NAME");
  const credentialsPath = readOptional("GOOGLE_SHEETS_CREDENTIALS_PATH");
  const credentialsJson = readOptional("GOOGLE_SHEETS_CREDENTIALS_JSON");
  if (!spreadsheetId || !sheetName || (!credentialsPath && !credentialsJson)) {
    return null;
  }
  return { spreadsheetId, sheetName, credentialsPath, credentialsJson };
}

function readSupabaseConfig(): AppEnv["supabase"] {
  const url = readOptional("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = readOptional("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const serviceRoleKey = readOptional("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceRoleKey) {
    return null;
  }
  return { url, anonKey, serviceRoleKey };
}

export function loadAppEnv(): AppEnv {
  const geminiModel = process.env.GEMINI_MODEL ?? "gemini-3-flash-preview";
  return {
    geminiApiKey: readOptional("GEMINI_API_KEY"),
    geminiModel,
    geminiGlobalModel: process.env.GEMINI_GLOBAL_MODEL ?? geminiModel,
    geminiMaxIterations: Math.floor(readNumber("GEMINI_MAX_ITERATIONS", 120)),
    agentTimeoutSec: readNumber("AGENT_TIMEOUT_SEC", 1800),

    githubToken: readOptional("GITHUB_TOKEN"),
    githubUsername: process.env.GITHUB_USERNAME ?? "propagate-webcreation",
    botGitAuthorName: process.env.BOT_GIT_AUTHOR_NAME ?? "propagate-bot",
    botGitAuthorEmail:
      process.env.BOT_GIT_AUTHOR_EMAIL ?? "bot@propagateinc.com",
    gitDeployBranch: process.env.GIT_DEPLOY_BRANCH ?? "main",

    googleSheets: readGoogleSheetsConfig(),

    doneStatus: process.env.SPREADSHEET_DONE_STATUS ?? "デモサイト制作完了",

    vercel: {
      oidcToken: readOptional("VERCEL_OIDC_TOKEN"),
      teamId: readOptional("VERCEL_TEAM_ID"),
      projectId: readOptional("VERCEL_PROJECT_ID"),
      accessToken: readOptional("VERCEL_TOKEN"),
    },

    supabase: readSupabaseConfig(),

    sessionDefaultTtlSec: readNumber(
      "SESSION_DEFAULT_TTL_SEC",
      2 * 60 * 60,
    ),
    defaultPreviewUrl: readOptional("DEFAULT_PREVIEW_URL"),
  };
}

export function assertCaseLoadingEnv(env: AppEnv): asserts env is AppEnv & {
  githubToken: string;
  googleSheets: NonNullable<AppEnv["googleSheets"]>;
  supabase: NonNullable<AppEnv["supabase"]>;
} {
  const missing: string[] = [];
  if (!env.githubToken) missing.push("GITHUB_TOKEN");
  if (!env.googleSheets)
    missing.push(
      "GOOGLE_SHEETS_SPREADSHEET_ID / _SHEET_NAME / (_CREDENTIALS_JSON or _CREDENTIALS_PATH)",
    );
  if (!env.supabase)
    missing.push(
      "NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY / SUPABASE_SERVICE_ROLE_KEY",
    );
  if (missing.length > 0) {
    throw new Error(
      `案件取得に必要な環境変数が不足しています: ${missing.join(", ")}`,
    );
  }
}

export function assertCorrectionEnv(env: AppEnv): asserts env is AppEnv & {
  geminiApiKey: string;
  supabase: NonNullable<AppEnv["supabase"]>;
} {
  const missing: string[] = [];
  if (!env.geminiApiKey) missing.push("GEMINI_API_KEY");
  if (!env.supabase)
    missing.push(
      "NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY / SUPABASE_SERVICE_ROLE_KEY",
    );
  if (missing.length > 0) {
    throw new Error(
      `修正実行に必要な環境変数が不足しています: ${missing.join(", ")}`,
    );
  }
}
