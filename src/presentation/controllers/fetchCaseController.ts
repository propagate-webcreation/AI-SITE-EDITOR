import type { SessionRepositoryPort, SpreadsheetPort } from "@/domain/ports";
import { SessionAlreadyActiveError } from "@/domain/ports";
import type { CaseRecord, Session } from "@/domain/models";

export interface SandboxStarter {
  createForCase(params: {
    repoUrl: string;
    githubUsername: string;
    githubToken: string;
  }): Promise<{ sandboxId: string; previewUrl: string }>;
}

export interface FetchCaseDependencies {
  spreadsheet: SpreadsheetPort;
  sandbox: SandboxStarter;
  sessions: SessionRepositoryPort;
  directorId: string;
  githubUsername: string;
  githubToken: string;
  sessionTtlSec: number;
}

export interface FetchCaseSuccess {
  ok: true;
  session: {
    id: string;
    previewUrl: string;
    expiresAt: string;
  };
  case: {
    recordNumber: string;
    partnerName: string;
    contractPlan: string;
    githubRepoUrl: string;
  };
}

export type FetchCaseFailureCode =
  | "invalid-record-number"
  | "case-not-found"
  | "missing-repo-url"
  | "session-conflict"
  | "sandbox-failed";

export interface FetchCaseFailure {
  ok: false;
  code: FetchCaseFailureCode;
  message: string;
  occupiedByDirectorId?: string;
  occupiedByDirectorEmail?: string | null;
}

export type FetchCaseResult = FetchCaseSuccess | FetchCaseFailure;

export async function fetchCaseByRecordNumber(
  recordNumber: string,
  deps: FetchCaseDependencies,
): Promise<FetchCaseResult> {
  const trimmed = recordNumber.trim();
  if (!trimmed) {
    return failure("invalid-record-number", "レコード番号を入力してください。");
  }

  const caseRecord = await deps.spreadsheet.getCaseByRecordNumber(trimmed);
  if (!caseRecord) {
    return failure(
      "case-not-found",
      `レコード番号 ${trimmed} はスプレッドシートに見つかりません。`,
    );
  }
  if (!caseRecord.githubRepoUrl) {
    return failure(
      "missing-repo-url",
      "案件に GitHub リポジトリ URL が設定されていません。",
    );
  }

  const occupied = await deps.sessions.getActiveByRecordNumber(trimmed);
  if (occupied && occupied.directorId !== deps.directorId) {
    const email = await deps.sessions.getDirectorEmail(occupied.directorId);
    return {
      ok: false,
      code: "session-conflict",
      message: `この案件は現在 ${email ?? "別のディレクター"} が作業中です。`,
      occupiedByDirectorId: occupied.directorId,
      occupiedByDirectorEmail: email,
    };
  }

  if (occupied && occupied.directorId === deps.directorId) {
    return {
      ok: true,
      session: {
        id: occupied.id,
        previewUrl: occupied.previewUrl,
        expiresAt: occupied.expiresAt.toISOString(),
      },
      case: toCaseResponse(caseRecord),
    };
  }

  let sandboxInfo;
  try {
    sandboxInfo = await deps.sandbox.createForCase({
      repoUrl: caseRecord.githubRepoUrl,
      githubUsername: deps.githubUsername,
      githubToken: deps.githubToken,
    });
  } catch (error) {
    return failure(
      "sandbox-failed",
      `Sandbox の起動に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let session: Session;
  try {
    session = await deps.sessions.create({
      directorId: deps.directorId,
      recordNumber: caseRecord.recordNumber,
      partnerName: caseRecord.partnerName,
      contractPlan: caseRecord.contractPlan,
      sandboxId: sandboxInfo.sandboxId,
      previewUrl: sandboxInfo.previewUrl,
      githubRepoUrl: caseRecord.githubRepoUrl,
      expiresAt: new Date(Date.now() + deps.sessionTtlSec * 1000),
    });
  } catch (error) {
    if (error instanceof SessionAlreadyActiveError) {
      const email = await deps.sessions.getDirectorEmail(
        error.occupiedByDirectorId,
      );
      return {
        ok: false,
        code: "session-conflict",
        message: `この案件は現在 ${email ?? "別のディレクター"} が作業中です。`,
        occupiedByDirectorId: error.occupiedByDirectorId,
        occupiedByDirectorEmail: email,
      };
    }
    throw error;
  }

  return {
    ok: true,
    session: {
      id: session.id,
      previewUrl: session.previewUrl,
      expiresAt: session.expiresAt.toISOString(),
    },
    case: toCaseResponse(caseRecord),
  };
}

function toCaseResponse(caseRecord: CaseRecord): FetchCaseSuccess["case"] {
  return {
    recordNumber: caseRecord.recordNumber,
    partnerName: caseRecord.partnerName,
    contractPlan: caseRecord.contractPlan,
    githubRepoUrl: caseRecord.githubRepoUrl,
  };
}

function failure(code: FetchCaseFailureCode, message: string): FetchCaseFailure {
  return { ok: false, code, message };
}
