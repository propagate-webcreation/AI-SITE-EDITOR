import { randomUUID } from "node:crypto";
import type {
  CreateSessionInput,
  Session,
  SessionStatus,
} from "@/domain/models";
import {
  SessionAlreadyActiveError,
  type SessionRepositoryPort,
} from "@/domain/ports";

export class InMemorySessionRepository implements SessionRepositoryPort {
  private readonly sessions: Map<string, Session> = new Map();

  async create(input: CreateSessionInput): Promise<Session> {
    const existing = await this.getActiveByRecordNumber(input.recordNumber);
    if (existing) {
      throw new SessionAlreadyActiveError(
        input.recordNumber,
        existing.directorId,
      );
    }
    const session: Session = {
      id: randomUUID(),
      directorId: input.directorId,
      recordNumber: input.recordNumber,
      partnerName: input.partnerName,
      contractPlan: input.contractPlan,
      sandboxId: input.sandboxId,
      previewUrl: input.previewUrl,
      githubRepoUrl: input.githubRepoUrl,
      status: "active",
      startedAt: new Date(),
      expiresAt: input.expiresAt,
    };
    this.sessions.set(session.id, session);
    return { ...session };
  }

  async getById(id: string): Promise<Session | null> {
    const s = this.sessions.get(id);
    return s ? { ...s } : null;
  }

  async getActiveByRecordNumber(recordNumber: string): Promise<Session | null> {
    for (const s of this.sessions.values()) {
      if (s.recordNumber === recordNumber && s.status === "active") {
        return { ...s };
      }
    }
    return null;
  }

  async listActiveByDirector(directorId: string): Promise<Session[]> {
    const result: Session[] = [];
    for (const s of this.sessions.values()) {
      if (s.directorId === directorId && s.status === "active") {
        result.push({ ...s });
      }
    }
    return result;
  }

  async getDirectorEmail(_directorId: string): Promise<string | null> {
    return null;
  }

  async updateStatus(params: {
    id: string;
    status: SessionStatus;
    errorMessage?: string;
    closedAt?: Date;
  }): Promise<void> {
    const s = this.sessions.get(params.id);
    if (!s) {
      throw new Error(
        `InMemorySessionRepository: session ${params.id} が存在しません。`,
      );
    }
    this.sessions.set(params.id, {
      ...s,
      status: params.status,
      errorMessage: params.errorMessage ?? s.errorMessage,
      closedAt: params.closedAt ?? s.closedAt,
    });
  }
}
