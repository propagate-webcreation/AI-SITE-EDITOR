import "server-only";
import path from "node:path";
import type {
  SessionRepositoryPort,
  SpreadsheetPort,
} from "@/domain/ports";
import { GoogleSheetsClient } from "@/infrastructure/sheets/googleSheetsClient";
import { VercelSandboxManager } from "@/infrastructure/sandbox/vercelSandboxManager";
import { GeminiAgentRunner } from "@/infrastructure/gemini/geminiAgentRunner";
import {
  createSupabaseAdminClient,
  createSupabaseServerClient,
} from "@/infrastructure/supabase/supabaseClients";
import { SupabaseSessionRepository } from "@/infrastructure/supabase/supabaseSessionRepository";
import {
  assertCaseLoadingEnv,
  assertCorrectionEnv,
  loadAppEnv,
  type AppEnv,
} from "./env";

export interface CaseLoadingContainer {
  env: AppEnv & {
    githubToken: string;
    googleSheets: NonNullable<AppEnv["googleSheets"]>;
    supabase: NonNullable<AppEnv["supabase"]>;
  };
  spreadsheet: SpreadsheetPort;
  sandbox: VercelSandboxManager;
  sessions: SessionRepositoryPort;
  directorId: string;
}

export async function buildCaseLoadingContainer(): Promise<CaseLoadingContainer> {
  const env = loadAppEnv();
  assertCaseLoadingEnv(env);

  const supabaseServer = await createSupabaseServerClient(env.supabase);
  const { data: userData, error: userError } = await supabaseServer.auth.getUser();
  if (userError || !userData.user) {
    throw new AuthRequiredError();
  }

  const spreadsheet = new GoogleSheetsClient({
    spreadsheetId: env.googleSheets.spreadsheetId,
    sheetName: env.googleSheets.sheetName,
    credentialsPath: path.resolve(
      process.cwd(),
      env.googleSheets.credentialsPath,
    ),
  });

  const sandbox = new VercelSandboxManager({
    oidcToken: env.vercel.oidcToken,
    teamId: env.vercel.teamId,
    projectId: env.vercel.projectId,
    accessToken: env.vercel.accessToken,
  });

  const supabaseAdmin = createSupabaseAdminClient(env.supabase);
  const sessions = new SupabaseSessionRepository(supabaseAdmin);

  return {
    env,
    spreadsheet,
    sandbox,
    sessions,
    directorId: userData.user.id,
  };
}

export interface CorrectionContainer {
  env: AppEnv & {
    geminiApiKey: string;
    githubToken: string;
    supabase: NonNullable<AppEnv["supabase"]>;
  };
  sandbox: VercelSandboxManager;
  agentRunner: GeminiAgentRunner;
  sessions: SessionRepositoryPort;
  directorId: string;
}

export async function buildCorrectionContainer(): Promise<CorrectionContainer> {
  const env = loadAppEnv();
  assertCorrectionEnv(env);
  if (!env.githubToken) {
    throw new Error("GITHUB_TOKEN が未設定のため修正結果を push できません。");
  }

  const supabaseServer = await createSupabaseServerClient(env.supabase);
  const { data: userData, error: userError } = await supabaseServer.auth.getUser();
  if (userError || !userData.user) {
    throw new AuthRequiredError();
  }

  const sandbox = new VercelSandboxManager({
    oidcToken: env.vercel.oidcToken,
    teamId: env.vercel.teamId,
    projectId: env.vercel.projectId,
    accessToken: env.vercel.accessToken,
  });

  const agentRunner = new GeminiAgentRunner({
    apiKey: env.geminiApiKey,
    model: env.geminiModel,
    maxIterations: env.geminiMaxIterations,
    bashTimeoutSec: env.agentTimeoutSec,
  });

  const supabaseAdmin = createSupabaseAdminClient(env.supabase);
  const sessions = new SupabaseSessionRepository(supabaseAdmin);

  return {
    env: env as CorrectionContainer["env"],
    sandbox,
    agentRunner,
    sessions,
    directorId: userData.user.id,
  };
}

export interface SessionReadContainer {
  sessions: SessionRepositoryPort;
  directorId: string;
}

/**
 * 認証済みディレクター自身の session を読むだけに必要な最小コンテナ。
 */
export async function buildSessionReadContainer(): Promise<SessionReadContainer> {
  const env = loadAppEnv();
  if (!env.supabase) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。",
    );
  }
  const supabaseServer = await createSupabaseServerClient(env.supabase);
  const { data: userData, error } = await supabaseServer.auth.getUser();
  if (error || !userData.user) {
    throw new AuthRequiredError();
  }
  const supabaseAdmin = createSupabaseAdminClient(env.supabase);
  const sessions = new SupabaseSessionRepository(supabaseAdmin);
  return { sessions, directorId: userData.user.id };
}

export class AuthRequiredError extends Error {
  constructor() {
    super("ログインが必要です。");
    this.name = "AuthRequiredError";
  }
}
