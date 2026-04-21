import { describe, it, expect, vi } from "vitest";
import {
  handleCorrectionsRequest,
  type CorrectionsControllerDependencies,
} from "./correctionsController";

function makeDeps(params: {
  agentResults?: Array<{
    success: boolean;
    finalMessage: string;
    errorMessage?: string;
    toolUseCount?: number;
    iterations?: number;
  }>;
  commitResults?: Array<string | null | Error>;
} = {}): {
  deps: CorrectionsControllerDependencies;
} {

  const runtimeProvider = {
    getRuntime: vi.fn().mockResolvedValue({
      readFile: vi.fn(),
      writeFile: vi.fn(),
      writeBinaryFile: vi.fn(),
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
      runtimeProvider,
      agentRunner,
      committer,
      sandboxCwd: "/vercel/sandbox",
      botAuthorName: "bot",
      botAuthorEmail: "bot@example.com",
    },
  };
}

interface CorrectionInput {
  session?: {
    id: string;
    sandboxId: string;
    recordNumber: string;
    partnerName: string;
    contractPlan: string;
  };
  instructions: Array<{
    id: string;
    comment: string;
    pinIndex: number | null;
    isGlobal?: boolean;
    attachments?: Array<{ filename: string; mimeType: string; base64: string }>;
    selectors?: Array<{ tag: string; selector: string; text: string; html: string }>;
  }>;
}

function makeInput(body: CorrectionInput): {
  session: {
    id: string;
    sandboxId: string;
    recordNumber: string;
    partnerName: string;
    contractPlan: string;
  };
  instructions: CorrectionInput["instructions"];
} {
  return {
    session: body.session ?? {
      id: "sess-1",
      sandboxId: "sbx_1",
      recordNumber: "001",
      partnerName: "Feminique",
      contractPlan: "BASIC",
    },
    instructions: body.instructions,
  };
}

describe("handleCorrectionsRequest (並列実行)", () => {
  it("2 件の指示を並列で処理し、各件 commit する", async () => {
    const { deps } = makeDeps();
    const res = await handleCorrectionsRequest(
      makeInput({
        instructions: [
          { id: "ins-1", comment: "A を修正", pinIndex: 0 },
          { id: "ins-2", comment: "B を修正", pinIndex: null },
        ],
      }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.applications.length).toBe(2);
    expect(res.body.applications.every((a) => a.status === "applied")).toBe(true);
    expect(deps.agentRunner.run).toHaveBeenCalledTimes(2);
    expect(deps.committer.commitOnly).toHaveBeenCalledTimes(2);
  });

  it("1 件失敗しても他は独立に完了する (並列なので fail-fast しない)", async () => {
    const { deps } = makeDeps({
      agentResults: [
        { success: true, finalMessage: "ok 1" },
        { success: false, finalMessage: "boom", errorMessage: "fail" },
        { success: true, finalMessage: "ok 3" },
      ],
    });
    const res = await handleCorrectionsRequest(
      makeInput({
        instructions: [
          { id: "i1", comment: "A", pinIndex: 0 },
          { id: "i2", comment: "B", pinIndex: 0 },
          { id: "i3", comment: "C", pinIndex: 0 },
        ],
      }),
      deps,
    );
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.applications.length).toBe(3);
    expect(res.body.applications[0]?.status).toBe("applied");
    expect(res.body.applications[1]?.status).toBe("failed");
    expect(res.body.applications[2]?.status).toBe("applied");
    expect(deps.agentRunner.run).toHaveBeenCalledTimes(3);
  });

  it("isGlobal=true の指示は他の通常指示が完了してから単独で実行される", async () => {
    const callOrder: string[] = [];
    const { deps } = makeDeps();
    (deps.agentRunner.run as ReturnType<typeof vi.fn>).mockImplementation(
      async (input) => {
        const tag = input.userPrompt.includes("ins-global")
          ? "global"
          : input.userPrompt.includes("ins-1")
            ? "n1"
            : "n2";
        callOrder.push(`start:${tag}`);
        await new Promise((r) => setTimeout(r, 20));
        callOrder.push(`end:${tag}`);
        return {
          success: true,
          finalMessage: `done ${tag}`,
          toolUseCount: 1,
          iterations: 1,
        };
      },
    );

    const res = await handleCorrectionsRequest(
      makeInput({
        instructions: [
          { id: "ins-1", comment: "通常 1", pinIndex: 0 },
          { id: "ins-2", comment: "通常 2", pinIndex: 0 },
          { id: "ins-global", comment: "全体トーン変更", pinIndex: 0, isGlobal: true },
        ],
      }),
      deps,
    );
    expect(res.status).toBe(200);

    // 通常 2 件は並列、global は 通常 2 件の end の後に始まる
    const globalStartIdx = callOrder.indexOf("start:global");
    const n1EndIdx = callOrder.indexOf("end:n1");
    const n2EndIdx = callOrder.indexOf("end:n2");
    expect(globalStartIdx).toBeGreaterThan(n1EndIdx);
    expect(globalStartIdx).toBeGreaterThan(n2EndIdx);
  });

  it("並列: agent 呼び出しは同時に走りはじめる", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const { deps } = makeDeps();
    (deps.agentRunner.run as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 10));
        concurrent -= 1;
        return {
          success: true,
          finalMessage: "ok",
          toolUseCount: 1,
          iterations: 1,
        };
      },
    );
    await handleCorrectionsRequest(
      makeInput({
        instructions: [
          { id: "i1", comment: "A", pinIndex: 0 },
          { id: "i2", comment: "B", pinIndex: 0 },
          { id: "i3", comment: "C", pinIndex: 0 },
        ],
      }),
      deps,
    );
    expect(maxConcurrent).toBeGreaterThanOrEqual(2);
  });

  it("run_bash (mutating) が走ったら pathSpec を使わず全差分コミットに切替", async () => {
    const { deps } = makeDeps();
    (deps.runtimeProvider.getRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
      readFile: vi.fn(),
      writeFile: vi.fn(),
      writeBinaryFile: vi.fn(),
      runCommand: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
    });
    (deps.agentRunner.run as ReturnType<typeof vi.fn>).mockImplementation(
      async (input) => {
        // run_bash は mutating: undefined (= mutating 扱い) を渡す
        await input.sandbox.runCommand({
          cmd: "bash",
          args: ["-lc", "sed -i s/a/b/ x"],
        });
        return {
          success: true,
          finalMessage: "sed で書き換え",
          toolUseCount: 1,
          iterations: 1,
        };
      },
    );
    await handleCorrectionsRequest(
      makeInput({
        instructions: [{ id: "i1", comment: "sedで書き換えて", pinIndex: 0 }],
      }),
      deps,
    );
    const commitCallArgs = (deps.committer.commitOnly as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[0];
    expect(commitCallArgs?.pathSpec).toBeUndefined();
  });

  it("agentFailed でも writeFile 履歴があれば commit を試みて applied に昇格", async () => {
    const { deps } = makeDeps({
      agentResults: [
        { success: false, finalMessage: "途中まで作業", errorMessage: "rate limited" },
      ],
    });
    (deps.runtimeProvider.getRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
      readFile: vi.fn(),
      writeFile: vi.fn().mockResolvedValue(undefined),
      writeBinaryFile: vi.fn(),
      runCommand: vi.fn(),
    });
    (deps.agentRunner.run as ReturnType<typeof vi.fn>).mockImplementation(
      async (input) => {
        await input.sandbox.writeFile({ path: "app/page.tsx", content: "..." });
        return {
          success: false,
          finalMessage: "途中まで作業",
          errorMessage: "rate limited",
          toolUseCount: 1,
          iterations: 1,
        };
      },
    );
    const res = await handleCorrectionsRequest(
      makeInput({ instructions: [{ id: "i1", comment: "page修正", pinIndex: 0 }] }),
      deps,
    );
    expect(res.body.applications[0]?.status).toBe("applied");
    expect(res.body.applications[0]?.summary).toContain("途切れました");
    expect(res.body.applications[0]?.commitSha).toBeTruthy();
    expect(deps.committer.commitOnly).toHaveBeenCalledTimes(1);
  });

  it("runError でも mutating bash 履歴があれば commit を試みて applied に昇格", async () => {
    const { deps } = makeDeps();
    (deps.runtimeProvider.getRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
      readFile: vi.fn(),
      writeFile: vi.fn(),
      writeBinaryFile: vi.fn(),
      runCommand: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
    });
    (deps.agentRunner.run as ReturnType<typeof vi.fn>).mockImplementation(
      async (input) => {
        await input.sandbox.runCommand({
          cmd: "bash",
          args: ["-lc", "sed -i s/a/b/ x"],
        });
        throw new Error("socket hang up");
      },
    );
    const res = await handleCorrectionsRequest(
      makeInput({ instructions: [{ id: "i1", comment: "sed書換", pinIndex: 0 }] }),
      deps,
    );
    expect(res.body.applications[0]?.status).toBe("applied");
    expect(res.body.applications[0]?.summary).toContain("socket hang up");
    expect(res.body.applications[0]?.commitSha).toBeTruthy();
    const commitArgs = (deps.committer.commitOnly as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[0];
    expect(commitArgs?.pathSpec).toBeUndefined();
  });

  it("agent 失敗 + 編集履歴ゼロなら commit せず failed のまま", async () => {
    const { deps } = makeDeps({
      agentResults: [
        { success: false, finalMessage: "なにもできず", errorMessage: "boom" },
      ],
    });
    const res = await handleCorrectionsRequest(
      makeInput({ instructions: [{ id: "i1", comment: "X", pinIndex: 0 }] }),
      deps,
    );
    expect(res.body.applications[0]?.status).toBe("failed");
    expect(res.body.applications[0]?.errorMessage).toBe("boom");
    expect(deps.committer.commitOnly).not.toHaveBeenCalled();
  });

  it("commit throw を 1 回リトライして成功すれば applied", async () => {
    const { deps } = makeDeps({
      commitResults: [new Error("transient git lock"), "shaRetry00000000000000000000000000000000"],
    });
    (deps.runtimeProvider.getRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
      readFile: vi.fn(),
      writeFile: vi.fn().mockResolvedValue(undefined),
      writeBinaryFile: vi.fn(),
      runCommand: vi.fn(),
    });
    (deps.agentRunner.run as ReturnType<typeof vi.fn>).mockImplementation(
      async (input) => {
        await input.sandbox.writeFile({ path: "app/page.tsx", content: "..." });
        return {
          success: true,
          finalMessage: "ok",
          toolUseCount: 1,
          iterations: 1,
        };
      },
    );
    const res = await handleCorrectionsRequest(
      makeInput({ instructions: [{ id: "i1", comment: "X", pinIndex: 0 }] }),
      deps,
    );
    expect(res.body.applications[0]?.status).toBe("applied");
    expect(res.body.applications[0]?.commitSha).toBe(
      "shaRetry00000000000000000000000000000000",
    );
    expect(deps.committer.commitOnly).toHaveBeenCalledTimes(2);
  });

  it("commit throw が 2 回続けば failed", async () => {
    const { deps } = makeDeps({
      commitResults: [new Error("disk full"), new Error("disk full")],
    });
    (deps.runtimeProvider.getRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
      readFile: vi.fn(),
      writeFile: vi.fn().mockResolvedValue(undefined),
      writeBinaryFile: vi.fn(),
      runCommand: vi.fn(),
    });
    (deps.agentRunner.run as ReturnType<typeof vi.fn>).mockImplementation(
      async (input) => {
        await input.sandbox.writeFile({ path: "app/page.tsx", content: "..." });
        return {
          success: true,
          finalMessage: "ok",
          toolUseCount: 1,
          iterations: 1,
        };
      },
    );
    const res = await handleCorrectionsRequest(
      makeInput({ instructions: [{ id: "i1", comment: "X", pinIndex: 0 }] }),
      deps,
    );
    expect(res.body.applications[0]?.status).toBe("failed");
    expect(res.body.applications[0]?.errorMessage).toContain("commit に失敗");
    expect(deps.committer.commitOnly).toHaveBeenCalledTimes(2);
  });

  it("read-only bash (mutating=false) だけなら writeFile 由来の pathSpec を維持", async () => {
    const { deps } = makeDeps();
    (deps.runtimeProvider.getRuntime as ReturnType<typeof vi.fn>).mockResolvedValue({
      readFile: vi.fn(),
      writeFile: vi.fn().mockResolvedValue(undefined),
      writeBinaryFile: vi.fn(),
      runCommand: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
    });
    (deps.agentRunner.run as ReturnType<typeof vi.fn>).mockImplementation(
      async (input) => {
        // list_dir 相当 (mutating: false)
        await input.sandbox.runCommand({
          cmd: "bash",
          args: ["-lc", "ls -1"],
          mutating: false,
        });
        // edit_file 相当 (writeFile 経由で tracker に載る)
        await input.sandbox.writeFile({ path: "app/page.tsx", content: "..." });
        return {
          success: true,
          finalMessage: "edit",
          toolUseCount: 2,
          iterations: 1,
        };
      },
    );
    await handleCorrectionsRequest(
      makeInput({
        instructions: [{ id: "i1", comment: "page.tsx修正", pinIndex: 0 }],
      }),
      deps,
    );
    const commitCallArgs = (deps.committer.commitOnly as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[0];
    expect(commitCallArgs?.pathSpec).toEqual(["app/page.tsx"]);
  });
});
