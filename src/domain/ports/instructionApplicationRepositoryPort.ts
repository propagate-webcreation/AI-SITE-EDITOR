import type {
  InstructionApplication,
  InstructionApplicationStatus,
  InstructionAttachmentMeta,
} from "../models/instructionApplication";

export interface CreateInstructionApplicationInput {
  sessionId: string;
  instructionId: string;
  comment: string;
  pinIndex: number | null;
  attachments: InstructionAttachmentMeta[];
  orderIndex: number;
}

export interface UpdateInstructionApplicationInput {
  id: string;
  status?: InstructionApplicationStatus;
  summary?: string | null;
  errorMessage?: string | null;
  commitSha?: string | null;
  revertCommitSha?: string | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  revertedAt?: Date | null;
}

export interface InstructionApplicationRepositoryPort {
  create(input: CreateInstructionApplicationInput): Promise<InstructionApplication>;

  /** session 内の最大 order_index を返す (新規挿入順を決めるため) */
  nextOrderIndex(sessionId: string): Promise<number>;

  getById(id: string): Promise<InstructionApplication | null>;

  getBySessionAndInstructionId(params: {
    sessionId: string;
    instructionId: string;
  }): Promise<InstructionApplication | null>;

  listBySession(sessionId: string): Promise<InstructionApplication[]>;

  update(input: UpdateInstructionApplicationInput): Promise<void>;
}
