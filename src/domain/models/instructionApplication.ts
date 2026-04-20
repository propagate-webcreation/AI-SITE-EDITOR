export type InstructionApplicationStatus =
  | "pending"
  | "running"
  | "applied"
  | "failed"
  | "reverted";

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
