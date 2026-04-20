import { describe, it, expect, vi } from "vitest";
import {
  fetchCaseByRecordNumber,
  type FetchCaseDependencies,
} from "./fetchCaseController";
import type { CaseRecord, Session } from "@/domain/models";
import type { SessionRepositoryPort, SpreadsheetPort } from "@/domain/ports";
import { SessionAlreadyActiveError } from "@/domain/ports";

function sampleCase(overrides: Partial<CaseRecord> = {}): CaseRecord {
  return {
    rowNumber: 10,
    recordNumber: "001",
    partnerName: "Feminique",
    contractPlan: "BASIC",
    phaseStatus: "デモサイト評価中",
    githubRepoUrl: "https://github.com/propagate/demo-001",
    deployUrl: "https://demo-001.vercel.app",
    ...overrides,
  };
}

function sampleSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess-001",
    directorId: "dir-A",
    recordNumber: "001",
    partnerName: "Feminique",
    contractPlan: "BASIC",
    sandboxId: "sbx_abc",
    previewUrl: "https://sbx.vercel.run",
    githubRepoUrl: "https://github.com/propagate/demo-001",
    status: "active",
    startedAt: new Date(),
    expiresAt: new Date(Date.now() + 3600_000),
    ...overrides,
  };
}

function makeDeps(params: {
  caseRecord?: CaseRecord | null;
  activeSession?: Session | null;
  sandboxError?: Error;
  createThrowsAlreadyActive?: boolean;
  directorId?: string;
} = {}): FetchCaseDependencies {
  const spreadsheet: SpreadsheetPort = {
    getCaseByRecordNumber: vi
      .fn()
      .mockResolvedValue(params.caseRecord === undefined ? sampleCase() : params.caseRecord),
    updatePhaseStatus: vi.fn(),
  };
  const sessions: SessionRepositoryPort = {
    create: params.createThrowsAlreadyActive
      ? vi.fn().mockRejectedValue(new SessionAlreadyActiveError("001", "dir-B"))
      : vi.fn().mockResolvedValue(sampleSession({ directorId: params.directorId ?? "dir-A" })),
    getById: vi.fn(),
    getActiveByRecordNumber: vi
      .fn()
      .mockResolvedValue(params.activeSession ?? null),
    listActiveByDirector: vi.fn(),
    updateStatus: vi.fn(),
    deleteById: vi.fn(),
    getDirectorEmail: vi.fn().mockResolvedValue(null),
  };
  const sandbox = {
    createForCase: params.sandboxError
      ? vi.fn().mockRejectedValue(params.sandboxError)
      : vi
          .fn()
          .mockResolvedValue({
            sandboxId: "sbx_new",
            previewUrl: "https://new.sandbox.run",
          }),
  };
  return {
    spreadsheet,
    sandbox,
    sessions,
    directorId: params.directorId ?? "dir-A",
    githubUsername: "propagate-webcreation",
    githubToken: "ghp_test",
    sessionTtlSec: 3600,
  };
}

describe("fetchCaseByRecordNumber", () => {
  it("正常系: sandbox 作成 + session insert で success", async () => {
    const deps = makeDeps();
    const result = await fetchCaseByRecordNumber("001", deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.case.partnerName).toBe("Feminique");
    expect(deps.sandbox.createForCase).toHaveBeenCalledOnce();
    expect(deps.sessions.create).toHaveBeenCalledOnce();
  });

  it("空文字は invalid-record-number", async () => {
    const result = await fetchCaseByRecordNumber("  ", makeDeps());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid-record-number");
  });

  it("見つからなければ case-not-found", async () => {
    const result = await fetchCaseByRecordNumber(
      "999",
      makeDeps({ caseRecord: null }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("case-not-found");
  });

  it("github_repo_url が空なら missing-repo-url", async () => {
    const deps = makeDeps({
      caseRecord: sampleCase({ githubRepoUrl: "" }),
    });
    const result = await fetchCaseByRecordNumber("001", deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("missing-repo-url");
  });

  it("他ディレクターが作業中なら session-conflict", async () => {
    const deps = makeDeps({
      activeSession: sampleSession({ directorId: "dir-B" }),
      directorId: "dir-A",
    });
    const result = await fetchCaseByRecordNumber("001", deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("session-conflict");
    expect(result.occupiedByDirectorId).toBe("dir-B");
    expect(deps.sandbox.createForCase).not.toHaveBeenCalled();
  });

  it("自分自身の既存セッションなら再作成せず既存を返す", async () => {
    const existing = sampleSession({ directorId: "dir-A" });
    const deps = makeDeps({ activeSession: existing });
    const result = await fetchCaseByRecordNumber("001", deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.id).toBe(existing.id);
    expect(deps.sandbox.createForCase).not.toHaveBeenCalled();
  });

  it("Sandbox 起動失敗は sandbox-failed", async () => {
    const deps = makeDeps({ sandboxError: new Error("vercel api 500") });
    const result = await fetchCaseByRecordNumber("001", deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("sandbox-failed");
  });

  it("create が UniqueConstraint 違反で session-conflict", async () => {
    const deps = makeDeps({ createThrowsAlreadyActive: true });
    const result = await fetchCaseByRecordNumber("001", deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("session-conflict");
  });
});
