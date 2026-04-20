export type InstructionApplicationStatus =
  | "pending"
  | "running"
  | "applied"
  | "failed"
  | "reverted"
  | "unclear";

export interface InstructionAttachmentMeta {
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface InstructionApplication {
  id: string;
  sessionId: string;
  instructionId: string;
  comment: string;
  pinIndex: number | null;
  attachments: InstructionAttachmentMeta[];
  orderIndex: number;

  /**
   * 「全体指示」フラグ。true のものは並列フェーズの後に単独で順次実行され、
   * その間は system prompt が緩和され max iteration も拡張される。
   */
  isGlobal: boolean;

  status: InstructionApplicationStatus;
  summary: string | null;
  errorMessage: string | null;

  commitSha: string | null;
  revertCommitSha: string | null;

  startedAt: Date | null;
  completedAt: Date | null;
  revertedAt: Date | null;
  createdAt: Date;
}
