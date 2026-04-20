import { describe, it, expect, vi } from "vitest";
import {
  handleCorrectionsRequest,
  type CorrectionsControllerDependencies,
} from "./correctionsController";
import type {
  InstructionApplicationRepositoryPort,
  SessionRepositoryPort,
} from "@/domain/ports";
import type { InstructionApplication, Session } from "@/domain/models";

function sampleSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess-1",
    directorId: "dir-A",
    recordNumber: "001",
    partnerName: "Feminique",
    contractPlan: "BASIC",
    sandboxId: "sbx_1",
    previewUrl: "https://preview.run",
    githubRepoUrl: "https://github.com/x/y",
    status: "active",
    startedAt: new Date(),
    expiresAt: new Date(Date.now() + 3600_000),
    ...overrides,
  };
}

function sampleApp(
  overrides: Partial<InstructionApplication> = {},
): InstructionApplication {
  return {
    id: "app-1",
    sessionId: "sess-1",
    instructionId: "ins-1",
    comment: "修正してください",
    pinIndex: null,
    attachments: [],
    orderIndex: 0,
    status: "pending",
    summary: null,
    errorMessage: null,
    commitSha: null,
    revertCommitSha: null,
    startedAt: null,
    completedAt: null,
    revertedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function makeDeps(params: {
  session?: Session | null;
  agentResults?: Array<{
    success: boolean;
    finalMessage: string;
    errorMessage?: string;
    toolUseCount?: number;
    iterations?: number;
  }>;
  commitResults?: Array<string | null | Error>;
  directorId?: string;
} = {}): {
  deps: CorrectionsControllerDependencies;
  applicationsState: Map<string, InstructionApplication>;
} {
  const sessions: SessionRepositoryPort = {
    create: vi.fn(),
    getById: vi.fn().mockResolvedValue(
      params.session === undefined ? sampleSession() : params.session,
    ),
    getActiveByRecordNumber: vi.fn(),
    listActiveByDirector: vi.fn(),
    updateStatus: vi.fn(),
    getDirectorEmail: vi.fn().mockResolvedValue(null),
  };

  const state = new Map<string, InstructionApplication>();
  let nextId = 1;
  const applications: InstructionApplicationRepositoryPort = {
    create: vi.fn().mockImplementation(async (input) => {
      const app = sampleApp({
        id: `app-${nextId++}`,
        sessionId: input.sessionId,
        instructionId: input.instructionId,
        comment: input.comment,
        pinIndex: input.pinIndex,
        attachments: input.attachments,
        orderIndex: input.orderIndex,
        status: "pending",
      });
      state.set(app.id, app);
      return app;
    }),
    nextOrderIndex: vi.fn().mockImplementation(async () => state.size),
    getById: vi.fn().mockImplementation(async (id: string) => state.get(id) ?? null),
    getBySessionAndInstructionId: vi.fn().mockResolvedValue(null),
    listBySession: vi.fn().mockImplementation(async () => Array.from(state.values())),
    update: vi.fn().mockImplementation(async (input) => {
      const app = state.get(input.id);
      if (!app) return;
      state.set(input.id, {
        ...app,
        status: input.status ?? app.status,
        summary: input.summary ?? app.summary,
        errorMessage: input.errorMessage ?? app.errorMessage,
        commitSha: input.commitSha ?? app.commitSha,
        revertCommitSha: input.revertCommitSha ?? app.revertCommitSha,
        startedAt: input.startedAt ?? app.startedAt,
        completedAt: input.completedAt ?? app.completedAt,
        revertedAt: input.revertedAt ?? app.revertedAt,
      });
    }),
  };

  const runtimeProvider = {
    getRuntime: vi.fn().mockResolvedValue({
      readFile: vi.fn(),
      writeFile: vi.fn(),
      runCommand: vi.fn(),
    }),
  };

  let agentCall = 0;
  const agentRunner = {
    run: vi.fn().mockImplementation(async () => {
      const r = params.agentResults?.[agentCall++] ?? {
        success: true,
        finalMessage: "修正完了",
        toolUseCount: 1,
        iterations: 1,
      };
      return { ...r, toolUseCount: r.toolUseCount ?? 1, iterations: r.iterations ?? 1 };
    }),
  };

  let commitCall = 0;
  const committer = {
    commitOnly: vi.fn().mockImplementation(async () => {
      const r = params.commitResults?.[commitCall++];
      if (r instanceof Error) throw r;
      return r === undefined ? `sha${commitCall}00000000000000000000000000000000` : r;
    }),
  };

  return {
    deps: {
      sessions,
      applications,
      runtimeProvider,
      agentRunner,
      committer,
      directorId: params.directorId ?? "dir-A",
      sandboxCwd: "/vercel/sandbox",
      botAuthorName: "bot",
      botAuthorEmail: "bot@example.com",
    },
    applicationsState: state,
  };
}

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/corrections", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("handleCorrectionsRequest (逐次実行)", () => {
  it("2 件の指示を順に処理し、各件 commit する", async () => {
    const { deps } = makeDeps();
    const res = await handleCorrectionsRequest(
      makeRequest({
        sessionId: "sess-1",
        instructions: [
          { id: "ins-1", comment: "A を修正", pinIndex: 0 },
          { id: "ins-2", comment: "B を修正", pinIndex: null },
        ],
      }),
      deps,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      applications: Array<{ status: string; commitSha: string | null }>;
    };
    expect(body.ok).toBe(true);
    expect(body.applications.length).toBe(2);
    expect(body.applications.every((a) => a.status === "applied")).toBe(true);
    expect(deps.agentRunner.run).toHaveBeenCalledTimes(2);
    expect(deps.committer.commitOnly).toHaveBeenCalledTimes(2);
  });

  it("途中の指示が失敗したら後続を停止", async () => {
    const { deps } = makeDeps({
      agentResults: [
        { success: true, finalMessage: "ok 1" },
        { success: false, finalMessage: "boom", errorMessage: "fail" },
        { success: true, finalMessage: "ok 3" },
      ],
    });
    const res = await handleCorrectionsRequest(
      makeRequest({
        sessionId: "sess-1",
        instructions: [
          { id: "i1", comment: "A", pinIndex: 0 },
          { id: "i2", comment: "B", pinIndex: 0 },
          { id: "i3", comment: "C", pinIndex: 0 },
        ],
      }),
      deps,
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      ok: boolean;
      applications: Array<{ instructionId: string; status: string }>;
    };
    expect(body.ok).toBe(false);
    expect(body.applications.length).toBe(2); // 3 件目は実行されない
    expect(body.applications[0]?.status).toBe("applied");
    expect(body.applications[1]?.status).toBe("failed");
    expect(deps.agentRunner.run).toHaveBeenCalledTimes(2);
  });

  it("既に適用済みの指示はスキップ (idempotent)", async () => {
    const { deps } = makeDeps();
    (deps.applications.getBySessionAndInstructionId as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(sampleApp({ instructionId: "ins-1", status: "applied" }))
      .mockResolvedValue(null);
    const res = await handleCorrectionsRequest(
      makeRequest({
        sessionId: "sess-1",
        instructions: [
          { id: "ins-1", comment: "already", pinIndex: 0 },
          { id: "ins-2", comment: "new", pinIndex: 0 },
        ],
      }),
      deps,
    );
    expect(res.status).toBe(200);
    // ins-1 は skip、ins-2 だけ agent 実行
    expect(deps.agentRunner.run).toHaveBeenCalledTimes(1);
  });

  it("セッション無しなら 404", async () => {
    const { deps } = makeDeps({ session: null });
    const res = await handleCorrectionsRequest(
      makeRequest({
        sessionId: "sess-1",
        instructions: [{ id: "a", comment: "x", pinIndex: 0 }],
      }),
      deps,
    );
    expect(res.status).toBe(404);
  });

  it("別ディレクターなら 403", async () => {
    const { deps } = makeDeps({
      session: sampleSession({ directorId: "dir-B" }),
      directorId: "dir-A",
    });
    const res = await handleCorrectionsRequest(
      makeRequest({
        sessionId: "sess-1",
        instructions: [{ id: "a", comment: "x", pinIndex: 0 }],
      }),
      deps,
    );
    expect(res.status).toBe(403);
  });

  it("closed セッションなら 410", async () => {
    const { deps } = makeDeps({
      session: sampleSession({ status: "closed" }),
    });
    const res = await handleCorrectionsRequest(
      makeRequest({
        sessionId: "sess-1",
        instructions: [{ id: "a", comment: "x", pinIndex: 0 }],
      }),
      deps,
    );
    expect(res.status).toBe(410);
  });

  it("instructions 空なら 400", async () => {
    const { deps } = makeDeps();
    const res = await handleCorrectionsRequest(
      makeRequest({ sessionId: "sess-1", instructions: [] }),
      deps,
    );
    expect(res.status).toBe(400);
  });
});
