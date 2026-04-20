import "server-only";
import {
  GoogleGenAI,
  type Content,
  type FunctionCall,
  type Part,
} from "@google/genai";
import {
  TOOL_SCHEMAS,
  executeTool,
  type SandboxRuntime,
  type ToolResult,
} from "./sandboxTools";

export interface GeminiAgentRunnerConfig {
  apiKey: string;
  model: string;
  maxIterations: number;
  bashTimeoutSec: number;
}

export interface UserAttachment {
  filename: string;
  mimeType: string;
  /** base64 (no data: URL prefix) */
  base64: string;
  associatedInstructionId?: string;
}

export interface RunAgentInput {
  systemInstruction: string;
  userPrompt: string;
  attachments?: readonly UserAttachment[];
  sandbox: SandboxRuntime;
  cwd: string;
  signal?: AbortSignal;
  onToolCall?: (event: ToolCallEvent) => void;
  /** 指定されると config.maxIterations を上書きする。全体指示用に使う。 */
  maxIterationsOverride?: number;
  /** 指定されると config.model を上書きする。全体指示モードで pro モデル等を使うため。 */
  modelOverride?: string;
}

export interface ToolCallEvent {
  name: string;
  args: Record<string, unknown>;
  result: ToolResult;
  iteration: number;
}

export interface RunAgentOutput {
  success: boolean;
  finalMessage: string;
  iterations: number;
  toolUseCount: number;
  errorMessage?: string;
}

/**
 * Gemini Function Calling をループさせる最小エージェントハーネス。
 * Anthropic SDK の "Claude Code" 相当の振る舞いを自前で構築する。
 */
export class GeminiAgentRunner {
  private readonly client: GoogleGenAI;

  constructor(private readonly config: GeminiAgentRunnerConfig) {
    if (!config.apiKey) {
      throw new Error("GeminiAgentRunner: apiKey が未設定です。");
    }
    this.client = new GoogleGenAI({ apiKey: config.apiKey });
  }

  async run(input: RunAgentInput): Promise<RunAgentOutput> {
    const userParts: Part[] = [{ text: input.userPrompt }];
    for (const att of input.attachments ?? []) {
      userParts.push({
        inlineData: {
          mimeType: att.mimeType,
          data: att.base64,
        },
      });
    }
    const history: Content[] = [{ role: "user", parts: userParts }];
    let toolUseCount = 0;
    let iteration = 0;
    let lastText = "";
    const maxIterations = Math.max(
      1,
      input.maxIterationsOverride ?? this.config.maxIterations,
    );
    const model = input.modelOverride ?? this.config.model;

    while (iteration < maxIterations) {
      iteration += 1;
      if (input.signal?.aborted) {
        return {
          success: false,
          finalMessage: lastText,
          iterations: iteration,
          toolUseCount,
          errorMessage: "ユーザーによって中断されました",
        };
      }

      const response = await this.client.models.generateContent({
        model,
        contents: history,
        config: {
          systemInstruction: input.systemInstruction,
          tools: [{ functionDeclarations: TOOL_SCHEMAS }],
        },
      });

      const candidate = response.candidates?.[0];
      const modelContent = candidate?.content;
      if (!modelContent) {
        return {
          success: false,
          finalMessage: lastText,
          iterations: iteration,
          toolUseCount,
          errorMessage: "Gemini から応答コンテンツが返りませんでした",
        };
      }
      history.push(modelContent);

      const text = extractText(modelContent.parts);
      if (text) lastText = text;

      const calls = collectFunctionCalls(modelContent.parts);
      if (calls.length === 0) {
        // Final text turn
        return {
          success: true,
          finalMessage: lastText || text || "",
          iterations: iteration,
          toolUseCount,
        };
      }

      const responseParts: Part[] = [];
      for (const call of calls) {
        toolUseCount += 1;
        const args = (call.args ?? {}) as Record<string, unknown>;
        const result = await executeTool(call.name ?? "", args, {
          sandbox: input.sandbox,
          defaultCwd: input.cwd,
          bashTimeoutSec: this.config.bashTimeoutSec,
        });
        input.onToolCall?.({
          name: call.name ?? "",
          args,
          result,
          iteration,
        });
        responseParts.push({
          functionResponse: {
            id: call.id,
            name: call.name,
            response: { result: result.output, success: result.success },
          },
        });
      }
      history.push({ role: "user", parts: responseParts });
    }

    return {
      success: false,
      finalMessage: lastText,
      iterations: iteration,
      toolUseCount,
      errorMessage: `最大反復回数 ${maxIterations} に達しました`,
    };
  }
}

function extractText(parts: Part[] | undefined): string {
  if (!parts) return "";
  return parts
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .join("")
    .trim();
}

function collectFunctionCalls(parts: Part[] | undefined): FunctionCall[] {
  if (!parts) return [];
  const out: FunctionCall[] = [];
  for (const p of parts) {
    if (p.functionCall) out.push(p.functionCall);
  }
  return out;
}
