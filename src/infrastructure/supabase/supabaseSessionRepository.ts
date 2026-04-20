import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CreateSessionInput,
  Session,
  SessionStatus,
} from "@/domain/models";
import {
  SessionAlreadyActiveError,
  type SessionRepositoryPort,
} from "@/domain/ports";

interface SessionRow {
  id: string;
  director_id: string;
  record_number: string;
  partner_name: string;
  contract_plan: string | null;
  sandbox_id: string;
  preview_url: string;
  github_repo_url: string;
  status: SessionStatus;
  started_at: string;
  expires_at: string;
  closed_at: string | null;
  error_message: string | null;
}

export class SupabaseSessionRepository implements SessionRepositoryPort {
  constructor(private readonly supabase: SupabaseClient) {}

  async create(input: CreateSessionInput): Promise<Session> {
    const { data, error } = await this.supabase
      .from("sessions")
      .insert({
        director_id: input.directorId,
        record_number: input.recordNumber,
        partner_name: input.partnerName,
        contract_plan: input.contractPlan,
        sandbox_id: input.sandboxId,
        preview_url: input.previewUrl,
        github_repo_url: input.githubRepoUrl,
        status: "active",
        expires_at: input.expiresAt.toISOString(),
      })
      .select("*")
      .single<SessionRow>();

    if (error) {
      if (isUniqueViolation(error)) {
        const occupied = await this.getActiveByRecordNumber(input.recordNumber);
        throw new SessionAlreadyActiveError(
          input.recordNumber,
          occupied?.directorId ?? "(不明)",
        );
      }
      throw new Error(`Supabase session 作成に失敗: ${error.message}`);
    }
    return rowToSession(data);
  }

  async getById(id: string): Promise<Session | null> {
    const { data, error } = await this.supabase
      .from("sessions")
      .select("*")
      .eq("id", id)
      .maybeSingle<SessionRow>();
    if (error) throw new Error(`Supabase session 取得に失敗: ${error.message}`);
    return data ? rowToSession(data) : null;
  }

  async getActiveByRecordNumber(recordNumber: string): Promise<Session | null> {
    const { data, error } = await this.supabase
      .from("sessions")
      .select("*")
      .eq("record_number", recordNumber)
      .eq("status", "active")
      .maybeSingle<SessionRow>();
    if (error) throw new Error(`Supabase session 検索に失敗: ${error.message}`);
    return data ? rowToSession(data) : null;
  }

  async listActiveByDirector(directorId: string): Promise<Session[]> {
    const { data, error } = await this.supabase
      .from("sessions")
      .select("*")
      .eq("director_id", directorId)
      .eq("status", "active")
      .order("started_at", { ascending: false });
    if (error) throw new Error(`Supabase session 一覧取得に失敗: ${error.message}`);
    return (data ?? []).map((row) => rowToSession(row as SessionRow));
  }

  async getDirectorEmail(directorId: string): Promise<string | null> {
    const { data, error } = await this.supabase
      .from("directors")
      .select("email")
      .eq("id", directorId)
      .maybeSingle<{ email: string }>();
    if (error) return null;
    return data?.email ?? null;
  }

  async updateStatus(params: {
    id: string;
    status: SessionStatus;
    errorMessage?: string;
    closedAt?: Date;
  }): Promise<void> {
    const patch: Record<string, string | null> = { status: params.status };
    if (params.errorMessage !== undefined)
      patch.error_message = params.errorMessage;
    if (params.closedAt !== undefined)
      patch.closed_at = params.closedAt.toISOString();
    const { error } = await this.supabase
      .from("sessions")
      .update(patch)
      .eq("id", params.id);
    if (error) throw new Error(`Supabase session 更新に失敗: ${error.message}`);
  }

  async deleteById(id: string): Promise<void> {
    const { error } = await this.supabase
      .from("sessions")
      .delete()
      .eq("id", id);
    if (error) throw new Error(`Supabase session 削除に失敗: ${error.message}`);
  }
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    directorId: row.director_id,
    recordNumber: row.record_number,
    partnerName: row.partner_name,
    contractPlan: row.contract_plan ?? "",
    sandboxId: row.sandbox_id,
    previewUrl: row.preview_url,
    githubRepoUrl: row.github_repo_url,
    status: row.status,
    startedAt: new Date(row.started_at),
    expiresAt: new Date(row.expires_at),
    closedAt: row.closed_at ? new Date(row.closed_at) : undefined,
    errorMessage: row.error_message ?? undefined,
  };
}

function isUniqueViolation(error: { code?: string; message?: string }): boolean {
  return (
    error.code === "23505" ||
    /duplicate key/i.test(error.message ?? "") ||
    /unique/i.test(error.message ?? "")
  );
}
