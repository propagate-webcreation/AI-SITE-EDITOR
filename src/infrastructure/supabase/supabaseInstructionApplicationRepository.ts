import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  InstructionApplication,
  InstructionApplicationStatus,
  InstructionAttachmentMeta,
} from "@/domain/models";
import type {
  CreateInstructionApplicationInput,
  InstructionApplicationRepositoryPort,
  UpdateInstructionApplicationInput,
} from "@/domain/ports";

interface Row {
  id: string;
  session_id: string;
  instruction_id: string;
  comment: string;
  pin_index: number | null;
  attachments: InstructionAttachmentMeta[] | null;
  order_index: number;
  status: InstructionApplicationStatus;
  summary: string | null;
  error_message: string | null;
  commit_sha: string | null;
  revert_commit_sha: string | null;
  started_at: string | null;
  completed_at: string | null;
  reverted_at: string | null;
  created_at: string;
}

export class SupabaseInstructionApplicationRepository
  implements InstructionApplicationRepositoryPort
{
  constructor(private readonly supabase: SupabaseClient) {}

  async create(
    input: CreateInstructionApplicationInput,
  ): Promise<InstructionApplication> {
    const { data, error } = await this.supabase
      .from("instruction_applications")
      .insert({
        session_id: input.sessionId,
        instruction_id: input.instructionId,
        comment: input.comment,
        pin_index: input.pinIndex,
        attachments: input.attachments,
        order_index: input.orderIndex,
        status: "pending",
      })
      .select("*")
      .single<Row>();
    if (error) {
      throw new Error(
        `instruction_applications.create に失敗: ${error.message}`,
      );
    }
    return rowToDomain(data);
  }

  async nextOrderIndex(sessionId: string): Promise<number> {
    const { data, error } = await this.supabase
      .from("instruction_applications")
      .select("order_index")
      .eq("session_id", sessionId)
      .order("order_index", { ascending: false })
      .limit(1)
      .maybeSingle<{ order_index: number }>();
    if (error) {
      throw new Error(
        `instruction_applications.nextOrderIndex に失敗: ${error.message}`,
      );
    }
    return (data?.order_index ?? -1) + 1;
  }

  async getById(id: string): Promise<InstructionApplication | null> {
    const { data, error } = await this.supabase
      .from("instruction_applications")
      .select("*")
      .eq("id", id)
      .maybeSingle<Row>();
    if (error) {
      throw new Error(`instruction_applications.getById に失敗: ${error.message}`);
    }
    return data ? rowToDomain(data) : null;
  }

  async getBySessionAndInstructionId(params: {
    sessionId: string;
    instructionId: string;
  }): Promise<InstructionApplication | null> {
    const { data, error } = await this.supabase
      .from("instruction_applications")
      .select("*")
      .eq("session_id", params.sessionId)
      .eq("instruction_id", params.instructionId)
      .maybeSingle<Row>();
    if (error) {
      throw new Error(
        `instruction_applications.getBySessionAndInstructionId に失敗: ${error.message}`,
      );
    }
    return data ? rowToDomain(data) : null;
  }

  async listBySession(sessionId: string): Promise<InstructionApplication[]> {
    const { data, error } = await this.supabase
      .from("instruction_applications")
      .select("*")
      .eq("session_id", sessionId)
      .order("order_index", { ascending: true });
    if (error) {
      throw new Error(
        `instruction_applications.listBySession に失敗: ${error.message}`,
      );
    }
    return (data ?? []).map((r) => rowToDomain(r as Row));
  }

  async update(input: UpdateInstructionApplicationInput): Promise<void> {
    const patch: Record<string, unknown> = {};
    if (input.status !== undefined) patch.status = input.status;
    if (input.summary !== undefined) patch.summary = input.summary;
    if (input.errorMessage !== undefined) patch.error_message = input.errorMessage;
    if (input.commitSha !== undefined) patch.commit_sha = input.commitSha;
    if (input.revertCommitSha !== undefined)
      patch.revert_commit_sha = input.revertCommitSha;
    if (input.startedAt !== undefined)
      patch.started_at = input.startedAt?.toISOString() ?? null;
    if (input.completedAt !== undefined)
      patch.completed_at = input.completedAt?.toISOString() ?? null;
    if (input.revertedAt !== undefined)
      patch.reverted_at = input.revertedAt?.toISOString() ?? null;

    const { error } = await this.supabase
      .from("instruction_applications")
      .update(patch)
      .eq("id", input.id);
    if (error) {
      throw new Error(`instruction_applications.update に失敗: ${error.message}`);
    }
  }
}

function rowToDomain(row: Row): InstructionApplication {
  return {
    id: row.id,
    sessionId: row.session_id,
    instructionId: row.instruction_id,
    comment: row.comment,
    pinIndex: row.pin_index,
    attachments: Array.isArray(row.attachments) ? row.attachments : [],
    orderIndex: row.order_index,
    status: row.status,
    summary: row.summary,
    errorMessage: row.error_message,
    commitSha: row.commit_sha,
    revertCommitSha: row.revert_commit_sha,
    startedAt: row.started_at ? new Date(row.started_at) : null,
    completedAt: row.completed_at ? new Date(row.completed_at) : null,
    revertedAt: row.reverted_at ? new Date(row.reverted_at) : null,
    createdAt: new Date(row.created_at),
  };
}
