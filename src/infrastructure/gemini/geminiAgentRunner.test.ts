import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const generateContentMock = vi.fn();

class MockGoogleGenAI {
  models = { generateContent: generateContentMock };
}

vi.mock("@google/genai", async () => {
  const actual = await vi.importActual<typeof import("@google/genai")>(
    "@google/genai",
  );
  return {
    ...actual,
    GoogleGenAI: MockGoogleGenAI,
  };
});

function makeSandboxMock() {
  return {
    readFile: vi.fn().mockResolvedValue("hello world"),
    writeFile: vi.fn().mockResolvedValue(undefined),
    writeBinaryFile: vi.fn().mockResolvedValue(undefined),
    runCommand: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
  };
}

beforeEach(() => {
  generateContentMock.mockReset();
});

describe("GeminiAgentRunner.run", () => {
  it("単純な text 応答 (tool 呼び出しなし) で success", async () => {
    generateContentMock.mockResolvedValueOnce({
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ text: "修正完了しました" }],
          },
        },
      ],
    });
    const { GeminiAgentRunner } = await import("./geminiAgentRunner");
    const runner = new GeminiAgentRunner({
      apiKey: "test-key",
      model: "gemini-3.1-pro-preview",
      maxIterations: 5,
      bashTimeoutSec: 60,
    });
    const sandbox = makeSandboxMock();
    const res = await runner.run({
      systemInstruction: "sys",
      userPrompt: "修正して",
      sandbox,
      cwd: "/vercel/sandbox",
    });
    expect(res.success).toBe(true);
    expect(res.finalMessage).toBe("修正完了しました");
    expect(res.toolUseCount).toBe(0);
    expect(generateContentMock).toHaveBeenCalledOnce();
  });

  it("function call → tool 実行 → functionResponse → 最終テキストで success", async () => {
    generateContentMock
      .mockResolvedValueOnce({
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  functionCall: {
                    id: "c1",
                    name: "read_file",
                    args: { path: "index.html" },
                  },
                },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: "読みました。変更無し。" }],
            },
          },
        ],
      });

    const { GeminiAgentRunner } = await import("./geminiAgentRunner");
    const runner = new GeminiAgentRunner({
      apiKey: "test-key",
      model: "x",
      maxIterations: 5,
      bashTimeoutSec: 60,
    });
    const sandbox = makeSandboxMock();
    const res = await runner.run({
      systemInstruction: "sys",
      userPrompt: "confirm",
      sandbox,
      cwd: "/vercel/sandbox",
    });
    expect(res.success).toBe(true);
    expect(res.toolUseCount).toBe(1);
    expect(sandbox.readFile).toHaveBeenCalledOnce();
    expect(generateContentMock).toHaveBeenCalledTimes(2);
    // 2 回目の contents に functionResponse turn が含まれていること
    // NB: history は参照渡しなので runner の後続 push で成長するが、
    //     少なくとも 1 つの turn に functionResponse part が入っていれば OK。
    const secondCall = generateContentMock.mock.calls[1]?.[0] as {
      contents: { role: string; parts: Array<Record<string, unknown>> }[];
    };
    const hasFunctionResponseTurn = secondCall.contents.some(
      (turn) => turn.parts.some((p) => "functionResponse" in p),
    );
    expect(hasFunctionResponseTurn).toBe(true);
  });

  it("複数 function call を同一 turn で並列実行", async () => {
    generateContentMock
      .mockResolvedValueOnce({
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  functionCall: {
                    id: "a",
                    name: "read_file",
                    args: { path: "a.html" },
                  },
                },
                {
                  functionCall: {
                    id: "b",
                    name: "read_file",
                    args: { path: "b.html" },
                  },
                },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        candidates: [
          {
            content: { role: "model", parts: [{ text: "done" }] },
          },
        ],
      });

    const { GeminiAgentRunner } = await import("./geminiAgentRunner");
    const runner = new GeminiAgentRunner({
      apiKey: "k",
      model: "x",
      maxIterations: 5,
      bashTimeoutSec: 60,
    });
    const sandbox = makeSandboxMock();
    const res = await runner.run({
      systemInstruction: "sys",
      userPrompt: "read both",
      sandbox,
      cwd: "/vercel/sandbox",
    });
    expect(res.success).toBe(true);
    expect(res.toolUseCount).toBe(2);
    expect(sandbox.readFile).toHaveBeenCalledTimes(2);
  });

  it("maxIterations を超えたら error", async () => {
    generateContentMock.mockResolvedValue({
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              {
                functionCall: {
                  id: "loop",
                  name: "read_file",
                  args: { path: "a" },
                },
              },
            ],
          },
        },
      ],
    });
    const { GeminiAgentRunner } = await import("./geminiAgentRunner");
    const runner = new GeminiAgentRunner({
      apiKey: "k",
      model: "x",
      maxIterations: 2,
      bashTimeoutSec: 60,
    });
    const res = await runner.run({
      systemInstruction: "sys",
      userPrompt: "x",
      sandbox: makeSandboxMock(),
      cwd: "/vercel/sandbox",
    });
    expect(res.success).toBe(false);
    expect(res.errorMessage).toMatch(/最大反復回数/);
  });

  it("AbortSignal を受けたら中断", async () => {
    generateContentMock.mockResolvedValue({
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              {
                functionCall: {
                  id: "x",
                  name: "read_file",
                  args: { path: "a" },
                },
              },
            ],
          },
        },
      ],
    });
    const { GeminiAgentRunner } = await import("./geminiAgentRunner");
    const runner = new GeminiAgentRunner({
      apiKey: "k",
      model: "x",
      maxIterations: 10,
      bashTimeoutSec: 60,
    });
    const ac = new AbortController();
    ac.abort();
    const res = await runner.run({
      systemInstruction: "sys",
      userPrompt: "x",
      sandbox: makeSandboxMock(),
      cwd: "/vercel/sandbox",
      signal: ac.signal,
    });
    expect(res.success).toBe(false);
    expect(res.errorMessage).toMatch(/中断/);
  });

  it("添付画像は初回 user turn に inlineData part として入る", async () => {
    generateContentMock.mockResolvedValueOnce({
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ text: "ok" }],
          },
        },
      ],
    });
    const { GeminiAgentRunner } = await import("./geminiAgentRunner");
    const runner = new GeminiAgentRunner({
      apiKey: "k",
      model: "x",
      maxIterations: 3,
      bashTimeoutSec: 60,
    });
    await runner.run({
      systemInstruction: "sys",
      userPrompt: "see image",
      attachments: [
        { filename: "a.png", mimeType: "image/png", base64: "AAAA" },
      ],
      sandbox: makeSandboxMock(),
      cwd: "/vercel/sandbox",
    });
    const call = generateContentMock.mock.calls[0]?.[0] as {
      contents: { role: string; parts: Array<Record<string, unknown>> }[];
    };
    const firstTurn = call.contents[0];
    expect(firstTurn?.role).toBe("user");
    expect(firstTurn?.parts.some((p) => "inlineData" in p)).toBe(true);
  });

  it("apiKey 未設定なら constructor で例外", async () => {
    const { GeminiAgentRunner } = await import("./geminiAgentRunner");
    expect(
      () =>
        new GeminiAgentRunner({
          apiKey: "",
          model: "x",
          maxIterations: 1,
          bashTimeoutSec: 60,
        }),
    ).toThrow(/apiKey/);
  });
});
