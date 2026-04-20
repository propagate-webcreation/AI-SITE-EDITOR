export interface LLMAgentRunOptions {
  prompt: string;
  cwd: string;
  env?: Record<string, string>;
  allowedTools?: readonly string[];
  timeoutSec?: number;
  signal?: AbortSignal;
}

export interface LLMAgentResult {
  success: boolean;
  durationSec: number;
  finalMessage: string;
  toolUseCount: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  };
}

export interface LLMAgentPort {
  runAgent(options: LLMAgentRunOptions): Promise<LLMAgentResult>;
}
