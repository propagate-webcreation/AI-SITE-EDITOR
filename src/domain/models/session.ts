export type SessionStatus = "active" | "closed" | "expired" | "error";

export interface Session {
  id: string;
  directorId: string;
  recordNumber: string;
  partnerName: string;
  contractPlan: string;
  sandboxId: string;
  previewUrl: string;
  githubRepoUrl: string;
  status: SessionStatus;
  startedAt: Date;
  expiresAt: Date;
  closedAt?: Date;
  errorMessage?: string;
}

export interface CreateSessionInput {
  directorId: string;
  recordNumber: string;
  partnerName: string;
  contractPlan: string;
  sandboxId: string;
  previewUrl: string;
  githubRepoUrl: string;
  expiresAt: Date;
}
