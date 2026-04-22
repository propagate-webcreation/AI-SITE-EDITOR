import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  InstructionApplication,
  InstructionAttachmentMeta,
} from "@/domain/models";
import type { SandboxRuntime } from "@/infrastructure/gemini/sandboxTools";
import type {
  GeminiAgentRunner,
  RunAgentOutput,
  UserAttachment,
} from "@/infrastructure/gemini/geminiAgentRunner";

export interface CorrectionInstructionInput {
  id: string;
  comment: string;
  /** pin 機能は廃止。DB 互換のため null を保持。 */
  pinIndex: number | null;
  /** 全体指示。true なら他の指示完了後に単独で順次実行される。 */
  isGlobal?: boolean;
  attachments?: {
    filename: string;
    mimeType: string;
    /** base64 (no data: URL prefix) */
    base64: string;
  }[];
  selectors?: {
    tag: string;
    selector: string;
    text: string;
    html: string;
  }[];
}

export interface RuntimeProvider {
  getRuntime(sandboxId: string): Promise<SandboxRuntime>;
}

export interface GitCommitter {
  commitOnly(params: {
    sandboxId: string;
    authorName: string;
    authorEmail: string;
    commitMessage: string;
    pathSpec?: readonly string[];
  }): Promise<string | null>;
}

export interface CorrectionsControllerDependencies {
  runtimeProvider: RuntimeProvider;
  agentRunner: Pick<GeminiAgentRunner, "run">;
  committer: GitCommitter;
  sandboxCwd: string;
  botAuthorName: string;
  botAuthorEmail: string;
  /** 全体指示モード用のモデル名 (省略時は agentRunner が持つ既定モデル)。 */
  globalModel?: string;
  /**
   * 進行状況イベントを受け取るコールバック。
   * ルートハンドラ側でストリーミングレスポンスに変換するためのフック。省略可。
   */
  emit?: (event: CorrectionEvent) => void;
}

export type CorrectionEvent =
  | {
      kind: "phase";
      phase: "prepare" | "regular" | "global" | "complete";
      regularCount: number;
      globalCount: number;
    }
  | {
      kind: "instruction";
      instructionId: string;
      status:
        | "queued"
        | "running"
        | "applied"
        | "failed"
        | "reverted"
        | "unclear";
      isGlobal: boolean;
      message?: string;
      commitSha?: string;
    }
  | {
      kind: "toolCall";
      instructionId: string;
      name: string;
      argsSummary: string;
      success: boolean;
      iteration: number;
    }
  | {
      kind: "log";
      level: "info" | "warn" | "error";
      message: string;
    }
  | {
      kind: "result";
      ok: boolean;
      message: string;
      applications: ReturnType<typeof toClientApplication>[];
      durationSec: number;
    };

interface ParsedBody {
  sessionId: string;
  instructions: CorrectionInstructionInput[];
}

// Vercel Function の request body は 4.5 MB hard limit (FUNCTION_PAYLOAD_TOO_LARGE)。
// 関数本体に届く前に edge で 413 されるのを避けるため、1 添付あたりの上限は 4 MB に
// 抑える。client 側は compressImageForUpload で送信前に長辺 2048px / JPEG q=0.85 へ
// 縮小しているので、Mac の Retina スクリーンショット (10 MB+) でも通常はこの値に収まる。
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const ACCEPTED_MIME_PREFIXES = ["image/"];

/**
 * バリデーション済み入力を受けて修正フェーズを流す。
 * HTTP レベルのバリデーション (session 存在・所有権・active 状態) は
 * route 側で完了している前提。ここでは例外はそのまま throw し、route が受け取る。
 */
export async function handleCorrectionsRequest(
  input: {
    session: {
      id: string;
      sandboxId: string;
      recordNumber: string;
      partnerName: string;
      contractPlan: string;
    };
    instructions: CorrectionInstructionInput[];
  },
  deps: CorrectionsControllerDependencies,
): Promise<{ ok: boolean; status: number; body: {
  ok: boolean;
  message: string;
  applications: ReturnType<typeof toClientApplication>[];
  durationSec: number;
} }> {
  const activeSession = input.session;
  const runtime = await deps.runtimeProvider.getRuntime(activeSession.sandboxId);
  const start = Date.now();
  const results: InstructionApplication[] = [];
  const emit = deps.emit ?? (() => {});

  // instruction_applications は DB に保存せず、このリクエスト処理中だけ
  // in-memory で保持する。案件を閉じたら状態ごと破棄する方針なので
  // 永続化は不要 (client 側が localStorage に最終結果を保存する)。
  const store = new Map<string, InstructionApplication>();
  function createApp(params: {
    instructionId: string;
    comment: string;
    pinIndex: number | null;
    attachments: InstructionAttachmentMeta[];
    orderIndex: number;
    isGlobal: boolean;
  }): InstructionApplication {
    const now = new Date();
    const app: InstructionApplication = {
      id: randomUUID(),
      sessionId: activeSession.id,
      instructionId: params.instructionId,
      comment: params.comment,
      pinIndex: params.pinIndex,
      attachments: params.attachments,
      orderIndex: params.orderIndex,
      isGlobal: params.isGlobal,
      status: "running",
      summary: null,
      errorMessage: null,
      commitSha: null,
      revertCommitSha: null,
      startedAt: now,
      completedAt: null,
      revertedAt: null,
      createdAt: now,
    };
    store.set(app.id, app);
    return app;
  }
  function updateApp(
    id: string,
    patch: Partial<InstructionApplication>,
  ): InstructionApplication | null {
    const cur = store.get(id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    store.set(id, next);
    return next;
  }

  // ---- Phase 1: 準備 ----
  interface Prepared {
    inst: CorrectionInstructionInput;
    created: InstructionApplication;
    orderIndex: number;
    tracker: TrackingRuntime;
    isGlobal: boolean;
  }
  const regulars: Prepared[] = [];
  const globals: Prepared[] = [];

  let orderCounter = 0;
  for (const inst of input.instructions) {
    const orderIndex = orderCounter++;
    const attachmentsMeta: InstructionAttachmentMeta[] = (inst.attachments ?? []).map(
      (a) => ({
        filename: a.filename,
        mimeType: a.mimeType,
        sizeBytes: base64Bytes(a.base64),
      }),
    );
    const isGlobal = !!inst.isGlobal;
    const created = createApp({
      instructionId: inst.id,
      comment: inst.comment,
      pinIndex: inst.pinIndex,
      attachments: attachmentsMeta,
      orderIndex,
      isGlobal,
    });
    emit({
      kind: "instruction",
      instructionId: inst.id,
      status: "queued",
      isGlobal,
    });

    const slot: Prepared = {
      inst,
      created,
      orderIndex,
      tracker: wrapRuntimeWithTracking(runtime),
      isGlobal,
    };
    if (isGlobal) globals.push(slot);
    else regulars.push(slot);
  }

  emit({
    kind: "phase",
    phase: "prepare",
    regularCount: regulars.length,
    globalCount: globals.length,
  });

  // ---- Phase 2A: 通常指示を並列実行 → 順次コミット ----
  if (regulars.length > 0) {
    emit({
      kind: "phase",
      phase: "regular",
      regularCount: regulars.length,
      globalCount: globals.length,
    });
    const regularOutcomes = await Promise.all(
      regulars.map((slot) => {
        emit({
          kind: "instruction",
          instructionId: slot.inst.id,
          status: "running",
          isGlobal: false,
        });
        return runAgent(slot, {
          systemInstruction: SYSTEM_INSTRUCTION_DEFAULT,
          maxIterationsOverride: undefined,
          deps,
          session: activeSession,
          emit,
        });
      }),
    );
    for (let i = 0; i < regulars.length; i++) {
      const slot = regulars[i];
      const outcome = regularOutcomes[i];
      if (!slot || !outcome) continue;
      const finalized = await commitAndFinalize(
        slot,
        outcome,
        deps,
        activeSession,
        updateApp,
      );
      if (finalized) {
        results.push(finalized);
        emit({
          kind: "instruction",
          instructionId: slot.inst.id,
          status: mapStatusToEventStatus(finalized.status),
          isGlobal: false,
          commitSha: finalized.commitSha ?? undefined,
          message: finalized.errorMessage ?? finalized.summary ?? undefined,
        });
      }
    }
  }

  // ---- Phase 2B: 全体指示を 1 件ずつ順次実行 ----
  // 通常指示の commit が全部終わってから、緩めた prompt + 大きな iteration 上限で回す。
  if (globals.length > 0) {
    emit({
      kind: "phase",
      phase: "global",
      regularCount: regulars.length,
      globalCount: globals.length,
    });
    for (const slot of globals) {
      emit({
        kind: "instruction",
        instructionId: slot.inst.id,
        status: "running",
        isGlobal: true,
      });
      const outcome = await runAgent(slot, {
        systemInstruction: SYSTEM_INSTRUCTION_GLOBAL,
        maxIterationsOverride: GLOBAL_MAX_ITERATIONS,
        modelOverride: deps.globalModel,
        deps,
        session: activeSession,
        emit,
      });
      const finalized = await commitAndFinalize(
        slot,
        outcome,
        deps,
        activeSession,
        updateApp,
      );
      if (finalized) {
        results.push(finalized);
        emit({
          kind: "instruction",
          instructionId: slot.inst.id,
          status: mapStatusToEventStatus(finalized.status),
          isGlobal: true,
          commitSha: finalized.commitSha ?? undefined,
          message: finalized.errorMessage ?? finalized.summary ?? undefined,
        });
      }
    }
  }

  const durationSec = (Date.now() - start) / 1000;
  const anyFailed = results.some((r) => r.status === "failed");
  const clientApplications = results.map(toClientApplication);
  const responseBody = {
    ok: !anyFailed,
    message: buildResultMessage(results),
    applications: clientApplications,
    durationSec,
  };
  emit({
    kind: "phase",
    phase: "complete",
    regularCount: regulars.length,
    globalCount: globals.length,
  });
  emit({
    kind: "result",
    ...responseBody,
  });
  return {
    ok: !anyFailed,
    status: anyFailed ? 500 : 200,
    body: responseBody,
  };
}

function mapStatusToEventStatus(
  s: InstructionApplication["status"],
): "queued" | "running" | "applied" | "failed" | "reverted" | "unclear" {
  if (s === "pending") return "queued";
  return s;
}

// ---------------------------------------------------------------------------
// agent 実行 / commit のヘルパ
// ---------------------------------------------------------------------------
type AgentOutcome =
  | { kind: "success"; agentResult: RunAgentOutput }
  | { kind: "agentFailed"; agentResult: RunAgentOutput }
  | { kind: "runError"; error: unknown };

interface AgentRunOptions {
  systemInstruction: string;
  maxIterationsOverride: number | undefined;
  modelOverride?: string;
  deps: CorrectionsControllerDependencies;
  session: { recordNumber: string; partnerName: string; contractPlan: string };
  emit: (event: CorrectionEvent) => void;
}

async function runAgent(
  slot: {
    inst: CorrectionInstructionInput;
    orderIndex: number;
    tracker: TrackingRuntime;
    isGlobal: boolean;
  },
  opts: AgentRunOptions,
): Promise<AgentOutcome> {
  // 添付画像を sandbox に pre-upload し、Gemini が参照できる公開 URL を生成する。
  // 失敗してもテキスト添付のマルチモーダル入力には支障しないので try/catch で握りつぶす。
  let uploaded: UploadedAttachment[] = [];
  try {
    uploaded = await uploadInstructionAttachments(
      slot.inst,
      slot.tracker.runtime,
    );
  } catch (error) {
    opts.emit({
      kind: "log",
      level: "warn",
      message: `画像の sandbox への書き込みに失敗: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }

  const userPrompt = buildUserPromptSingle({
    recordNumber: opts.session.recordNumber,
    partnerName: opts.session.partnerName,
    contractPlan: opts.session.contractPlan,
    instruction: slot.inst,
    orderIndex: slot.orderIndex,
    isGlobal: slot.isGlobal,
    uploaded,
  });
  const attachments = collectAttachments([slot.inst]);
  try {
    const agentResult = await opts.deps.agentRunner.run({
      systemInstruction: opts.systemInstruction,
      userPrompt,
      attachments,
      sandbox: slot.tracker.runtime,
      cwd: opts.deps.sandboxCwd,
      maxIterationsOverride: opts.maxIterationsOverride,
      modelOverride: opts.modelOverride,
      onToolCall: (event) => {
        opts.emit({
          kind: "toolCall",
          instructionId: slot.inst.id,
          name: event.name,
          argsSummary: summarizeArgs(event.name, event.args),
          success: event.result.success,
          iteration: event.iteration,
        });
      },
    });
    return agentResult.success
      ? { kind: "success", agentResult }
      : { kind: "agentFailed", agentResult };
  } catch (error) {
    return { kind: "runError", error };
  }
}

/**
 * tool call 引数を 1 行の短い要約文字列に変換する。
 * UI のログ表示で長大なコード内容を垂れ流さないため。
 */
function summarizeArgs(name: string, args: Record<string, unknown>): string {
  const pick = (k: string): string => {
    const v = args[k];
    return typeof v === "string" ? v : "";
  };
  switch (name) {
    case "read_file":
    case "list_dir":
    case "write_file":
    case "edit_file":
      return pick("path") || "(no path)";
    case "glob":
      return `${pick("pattern")}${pick("path") ? ` in ${pick("path")}` : ""}`;
    case "grep":
      return `/${pick("pattern")}/${pick("file_glob") ? ` glob=${pick("file_glob")}` : ""}`;
    case "run_bash": {
      const cmd = pick("command");
      return cmd.length > 120 ? `${cmd.slice(0, 120)}…` : cmd;
    }
    default: {
      const keys = Object.keys(args);
      return keys.length > 0 ? `${keys[0]}=…` : "";
    }
  }
}

/**
 * agent 実行結果を解釈して commit → 状態確定までを行う。
 *
 * 「修正は成功したのに失敗扱い」になる事故を避けるため、
 * 以下のすべての分岐で「編集が残っているなら commit して applied に昇格」を試みる:
 *
 * - success: 通常パス。commit が null なら "unclear"、sha なら "applied"
 * - agentFailed (success: false / maxIterations 等): tracker に編集記録があれば
 *   commit を試行。sha が出れば applied (summary に注記)、編集無しなら failed
 * - runError (Gemini API throw 等): 同上。最終応答の手前で例外が出ても、
 *   write_file/edit_file 直後ならファイルは sandbox に残っているので拾える
 *
 * commit 自体の throw は 1 回だけリトライして transient な失敗を吸収する。
 */
async function commitAndFinalize(
  slot: {
    inst: CorrectionInstructionInput;
    created: InstructionApplication;
    tracker: TrackingRuntime;
  },
  outcome: AgentOutcome,
  deps: CorrectionsControllerDependencies,
  session: { recordNumber: string; sandboxId: string },
  updateApp: (
    id: string,
    patch: Partial<InstructionApplication>,
  ) => InstructionApplication | null,
): Promise<InstructionApplication | null> {
  const { inst, created, tracker } = slot;
  const now = () => new Date();

  let summary: string | null = null;
  let outcomeError: string | null = null;
  let agentSucceeded = false;
  switch (outcome.kind) {
    case "success":
      summary = outcome.agentResult.finalMessage;
      agentSucceeded = true;
      break;
    case "agentFailed":
      summary = outcome.agentResult.finalMessage;
      outcomeError =
        outcome.agentResult.errorMessage ?? outcome.agentResult.finalMessage;
      break;
    case "runError":
      outcomeError =
        outcome.error instanceof Error
          ? outcome.error.message
          : String(outcome.error);
      break;
  }

  // run_bash (mutating) が走った agent は tracker が touched path を把握できないので、
  // pathSpec を指定せず全差分を対象にする。そうしないと sed/mv/cp 由来の
  // 変更が commit に入らず "判定不可" で終わってしまう。
  const touchedPaths = tracker.getTouchedPaths();
  const hadBash = tracker.hadRunCommand();
  const possiblyHasChanges = touchedPaths.length > 0 || hadBash;

  // 編集も bash も走らずに agent が落ちたケース → commit する意味がない。
  // success の場合は変更ゼロでも `git diff` で確認したい (commit が null を返して unclear に倒れる) ので、
  // この早期 return は agent 失敗ケースに限定する。
  if (!agentSucceeded && !possiblyHasChanges) {
    return updateApp(created.id, {
      status: "failed",
      errorMessage: outcomeError,
      summary,
      completedAt: now(),
    });
  }

  const usePathSpec = !hadBash && touchedPaths.length > 0;
  const commitArgs = {
    sandboxId: session.sandboxId,
    authorName: deps.botAuthorName,
    authorEmail: deps.botAuthorEmail,
    commitMessage: buildCommitMessage({
      recordNumber: session.recordNumber,
      instructionId: inst.id,
      pinIndex: inst.pinIndex,
      comment: inst.comment,
      summary: summary ?? inst.comment,
    }),
    pathSpec: usePathSpec ? touchedPaths : undefined,
  };

  let commitSha: string | null = null;
  let commitError: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      commitSha = await deps.committer.commitOnly(commitArgs);
      commitError = null;
      break;
    } catch (error) {
      commitError = error instanceof Error ? error.message : String(error);
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  if (commitError) {
    const baseMsg = `commit に失敗 (${commitError})`;
    const fullMsg = agentSucceeded
      ? `AI 修正は完了しましたが ${baseMsg}`
      : outcomeError
        ? `${outcomeError} / さらに ${baseMsg}`
        : baseMsg;
    return updateApp(created.id, {
      status: "failed",
      errorMessage: fullMsg,
      summary,
      completedAt: now(),
    });
  }

  if (commitSha === null) {
    if (agentSucceeded) {
      return updateApp(created.id, {
        status: "unclear",
        summary,
        errorMessage:
          "AI は変更すべき箇所を特定できませんでした。指示をもう少し具体的にするか、プレビュー上で対象要素を選択してから再送信してください。",
        completedAt: now(),
      });
    }
    return updateApp(created.id, {
      status: "failed",
      errorMessage: outcomeError,
      summary,
      completedAt: now(),
    });
  }

  // commit 成功。agent が graceful に終わらなかった場合は summary 冒頭に注記を付ける。
  const finalSummary = agentSucceeded
    ? summary
    : [
        `※ AI の応答が完了前に途切れましたが、編集内容は commit に保存しました (${outcomeError ?? "原因不明"})`,
        summary,
      ]
        .filter((s): s is string => !!s)
        .join("\n\n");

  return updateApp(created.id, {
    status: "applied",
    summary: finalSummary,
    commitSha,
    completedAt: now(),
  });
}

// ---------------------------------------------------------------------------
// agent 毎に書き込みパスを記録するラッパ
// ---------------------------------------------------------------------------
interface TrackingRuntime {
  runtime: SandboxRuntime;
  /**
   * write_file / write_binary_file で触ったパス一覧。
   * ただし run_bash が走った場合は「どのファイルを触ったか」を tracker が
   * 知る術がない (sed, mv, cp, rm 等は直接 FS を変更する) ので、
   * 代わりに {@link hadRunCommand} で「全差分を対象にすべき」シグナルを返す。
   */
  getTouchedPaths(): string[];
  /**
   * run_bash 由来の FS 変更があった可能性があるか。
   * true の場合、commit 側では pathSpec を使わず `git add -A` で全差分を拾うべき。
   */
  hadRunCommand(): boolean;
}

function wrapRuntimeWithTracking(underlying: SandboxRuntime): TrackingRuntime {
  const touched = new Set<string>();
  let ranBash = false;
  return {
    runtime: {
      readFile: (p) => underlying.readFile(p),
      writeFile: async (p) => {
        touched.add(p.path);
        await underlying.writeFile(p);
      },
      writeBinaryFile: async (p) => {
        touched.add(p.path);
        await underlying.writeBinaryFile(p);
      },
      runCommand: async (p) => {
        // sandboxTools 側で明示的に mutating: false と宣言された (list_dir / glob / grep)
        // 場合は pathSpec を維持。それ以外は run_bash 由来と見なして全差分モード。
        if (p.mutating !== false) ranBash = true;
        return underlying.runCommand(p);
      },
    },
    getTouchedPaths: () => Array.from(touched),
    hadRunCommand: () => ranBash,
  };
}

const SYSTEM_INSTRUCTION_DEFAULT = `あなたはウェブディレクターのアシスタントです。
Vercel Sandbox 上に clone されたデモサイトのソースコードを、ディレクターの指示に従って編集してください。

行動ルール:
- 破壊的な変更 (デザイン全体の作り直し、フレームワーク変更など) は避ける
- 指示に関係ない箇所は触らない
- まず必要なファイルを read_file / list_dir / glob / grep で確認してから編集する
- 編集は edit_file (1 箇所置換) を優先し、丸ごと書き換える場合のみ write_file を使う
- 添付画像がある場合は、ディレクターが「この画像を差し替えろ」「この画像のように配置しろ」等で使っている。文脈から判断する
- ディレクターから添付された画像は自動的に sandbox の public/directors-bot-uploads/<instructionId>/ 配下に配置済み。
  具体的なファイルパスと公開 URL は「添付ファイル」セクションに列挙してあるので、そこに出ているものを信頼して参照すること。
  コード上の src / href / url() / backgroundImage 等を、案内された公開 URL に置き換えて差し替えを実装する。
  用途に応じて run_bash で mv / cp して別の場所へ再配置してもよい (その場合はコード側の参照パスも合わせて更新)。
- この呼び出しでは **1 つの修正指示のみ** を処理する。複数の指示は独立した並列呼び出しで別 agent が担当するので、他の指示の存在は気にしない
- 作業完了後、最後に短い日本語で「何をどう修正したか」のサマリを自由テキストで返して会話を終える
- **どうしても変更箇所を特定できない場合**（指示が曖昧、対象の要素が見つからない、コードベースが想定と違う等）は、
  無理に write_file / edit_file を実行せず、**ファイルを一切変更しないまま** 最終メッセージに
  「なぜ特定できなかったか」と「ディレクターに何を補足してほしいか」を簡潔に日本語で説明して会話を終える。
  推測で関係ない箇所を弄るのは絶対に避ける。
`;

/**
 * Anthropic 公式 frontend-design skill (Apache-2.0) を読み込む。
 * 全体指示モード時のみ system prompt に連結され、デザイン品質ガードレールとして機能する。
 * 詳細は skills/frontend-design/README.md 参照。
 */
const FRONTEND_DESIGN_SKILL = readFileSync(
  join(process.cwd(), "skills", "frontend-design", "SKILL.md"),
  "utf8",
);

/**
 * 「全体指示」モード用の system prompt。
 * 通常モードの「破壊的変更を避ける」「関係ない箇所は触らない」制約を緩め、
 * サイト全体のデザイン・トーン変更を許可する。
 * 並列実行は終わった後に単独で走るので、他 agent との衝突は考えなくて良い。
 *
 * frontend-design skill を強制参照として末尾に連結する。
 */
const SYSTEM_INSTRUCTION_GLOBAL = `あなたはウェブディレクターのアシスタントです。
Vercel Sandbox 上に clone されたデモサイトのソースコードを、**サイト全体に渡る大きな変更** で書き換えてください。

このリクエストは「全体指示」と呼ばれる特殊モードで、他の通常指示がすべて完了した後に単独で走ります。
他の agent と FS を奪い合うことはないので、必要なら大胆に複数ファイルを横断的に編集して構いません。

行動ルール:
- サイト全体のトーン / デザイン / レイアウトの作り直しは許可される。フレームワーク変更だけは避ける。
- まず list_dir / glob / grep / read_file で対象ファイル群を一通り把握してから編集計画を立てる
- 編集は edit_file (1 箇所置換) を優先しつつ、必要なら write_file で大きく書き換えてもよい
- 共通スタイル・色・フォント・余白などは tailwind config やグローバル CSS、共通レイアウトなど横断的な箇所を狙うと効率的
- 添付画像がある場合は「このトーン / 配色 / 雰囲気を真似ろ」等の参考素材として扱う
- ディレクターから添付された画像は自動的に sandbox の public/directors-bot-uploads/<instructionId>/ 配下に配置済み。
  具体的なファイルパスと公開 URL は「添付ファイル」セクションに列挙してあるので、そこに出ているものを信頼して参照すること。
  コード上の src / href / url() / backgroundImage 等を、案内された公開 URL に置き換えて差し替えを実装する。
  用途に応じて run_bash で mv / cp して別の場所へ再配置してもよい (その場合はコード側の参照パスも合わせて更新)。
- 複数ファイルを編集して構わないが、変更が複数の論理的話題を跨ぐ場合は無理に 1 回で全部やらず、
  最も重要な見た目改善にフォーカスして、残りはサマリで「次の全体指示で扱うことを推奨」と言及する
- 作業完了後、最後に日本語で「何をどう変更したか (どのファイル群をどの方向に書き換えたか)」のサマリを返して会話を終える
- **どうしても方針が立たない場合**（指示が抽象的すぎる、参考が無い等）は、
  無理に編集を行わず、**ファイルを一切変更しないまま** 最終メッセージに
  「なぜ着手できなかったか」と「ディレクターに何を補足してほしいか」を簡潔に説明して会話を終える。

---

# 【必須】デザイン判断の基準: frontend-design skill

以下は Anthropic 公式 frontend-design skill (Apache-2.0) の原文。
**全体指示モードでは、このガイドラインを必ず参照して美的方向性を決定すること。**
「generic AI aesthetics を避ける」「BOLD な方向に振り切る」「Inter / Roboto / Arial / purple-on-white
等の手癖を避ける」などの禁則は厳密に守ること。コミットメッセージやサマリでは、
skill のどの原則に従ったか (例: Typography を見直し / Color を dominant+sharp accent に再構築 / 等)
を 1 文含めること。

${FRONTEND_DESIGN_SKILL}
`;

/** 全体指示モードの最大反復回数 (通常の約 2.5 倍を想定)。 */
const GLOBAL_MAX_ITERATIONS = 300;

export async function parseCorrectionsBody(
  request: Request,
): Promise<ParsedBody | { error: string }> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return { error: "リクエスト本文が JSON として解釈できません。" };
  }
  if (!isRecord(payload)) return { error: "リクエスト本文が不正です。" };
  const sessionId =
    typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
  if (!sessionId) return { error: "sessionId が必要です。" };
  if (!Array.isArray(payload.instructions)) {
    return { error: "instructions 配列が必要です。" };
  }
  const instructions: CorrectionInstructionInput[] = [];
  for (const raw of payload.instructions) {
    if (!isRecord(raw)) return { error: "instructions の要素が不正です。" };
    const id = typeof raw.id === "string" ? raw.id : "";
    const comment = typeof raw.comment === "string" ? raw.comment : "";
    // pin は UI から廃止済みだが DB 互換のため null を保持
    const pinIndex = typeof raw.pinIndex === "number" ? raw.pinIndex : null;
    const isGlobal = raw.isGlobal === true;
    if (!id || !comment) return { error: "id と comment は必須です。" };

    const attachments: CorrectionInstructionInput["attachments"] = [];
    if (Array.isArray(raw.attachments)) {
      for (const a of raw.attachments) {
        if (!isRecord(a)) continue;
        const filename = typeof a.filename === "string" ? a.filename : "";
        const mimeType = typeof a.mimeType === "string" ? a.mimeType : "";
        const base64 = typeof a.base64 === "string" ? a.base64 : "";
        if (!filename || !mimeType || !base64) continue;
        if (!ACCEPTED_MIME_PREFIXES.some((p) => mimeType.startsWith(p))) continue;
        if (base64.length > (MAX_ATTACHMENT_BYTES * 4) / 3) {
          return {
            error: `添付ファイル ${filename} が大きすぎます (上限 ${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB)。ブラウザを再読み込みしてもう一度試すか、画像を JPEG に変換 / 縮小してから添付してください。`,
          };
        }
        attachments.push({ filename, mimeType, base64 });
      }
    }

    const selectors: CorrectionInstructionInput["selectors"] = [];
    if (Array.isArray(raw.selectors)) {
      for (const s of raw.selectors) {
        if (!isRecord(s)) continue;
        const tag = typeof s.tag === "string" ? s.tag.slice(0, 40) : "";
        const selector =
          typeof s.selector === "string" ? s.selector.slice(0, 400) : "";
        const text = typeof s.text === "string" ? s.text.slice(0, 400) : "";
        const html = typeof s.html === "string" ? s.html.slice(0, 4000) : "";
        if (!tag || !selector) continue;
        selectors.push({ tag, selector, text, html });
      }
    }

    instructions.push({ id, comment, pinIndex, isGlobal, attachments, selectors });
  }
  if (instructions.length === 0) {
    return { error: "修正指示が 1 件もありません。" };
  }
  return { sessionId, instructions };
}

interface UploadedAttachment {
  originalFilename: string;
  mimeType: string;
  /** sandbox FS 上のパス (working dir からの相対) */
  sandboxPath: string;
  /** Next.js demo サイト上で配信される公開 URL (/public を剥がしたもの) */
  publicUrl: string;
  sizeBytes: number;
}

/** Next.js public/ 配下に添付画像を配置してコード参照できるようにする。 */
const UPLOAD_PUBLIC_ROOT = "public/directors-bot-uploads";

async function uploadInstructionAttachments(
  inst: CorrectionInstructionInput,
  runtime: SandboxRuntime,
): Promise<UploadedAttachment[]> {
  const atts = inst.attachments ?? [];
  if (atts.length === 0) return [];
  // 個々の upload は相互に独立なので並列化。画像 N 枚 = N RTT → 1 RTT相当に短縮。
  return Promise.all(
    atts.map(async (att, i) => {
      const safeName = sanitizeUploadFilename(att.filename);
      const rel = `${UPLOAD_PUBLIC_ROOT}/${inst.id}/${String(i).padStart(2, "0")}-${safeName}`;
      const buf = Buffer.from(att.base64, "base64");
      await runtime.writeBinaryFile({ path: rel, content: buf });
      return {
        originalFilename: att.filename,
        mimeType: att.mimeType,
        sandboxPath: rel,
        publicUrl: `/${rel.replace(/^public\//, "")}`,
        sizeBytes: buf.byteLength,
      };
    }),
  );
}

function sanitizeUploadFilename(name: string): string {
  // パス区切り・NULL・制御文字・スペース・バックスラッシュを除去し、80 文字に丸める。
  const trimmed = name
    .replace(/[/\\\x00-\x1f]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_");
  const truncated = trimmed.length > 80 ? trimmed.slice(-80) : trimmed;
  return truncated || "file";
}

function collectAttachments(
  instructions: readonly CorrectionInstructionInput[],
): UserAttachment[] {
  const out: UserAttachment[] = [];
  for (const inst of instructions) {
    for (const a of inst.attachments ?? []) {
      out.push({
        filename: a.filename,
        mimeType: a.mimeType,
        base64: a.base64,
        associatedInstructionId: inst.id,
      });
    }
  }
  return out;
}

function buildUserPromptSingle(params: {
  recordNumber: string;
  partnerName: string;
  contractPlan: string;
  instruction: CorrectionInstructionInput;
  orderIndex: number;
  isGlobal: boolean;
  uploaded: readonly UploadedAttachment[];
}): string {
  const heading = params.isGlobal
    ? `## 全体指示 (第 ${params.orderIndex + 1} 件目, id=${params.instruction.id})`
    : `## 修正指示 (第 ${params.orderIndex + 1} 件目, id=${params.instruction.id})`;
  const lines: string[] = [
    `# デモサイト修正タスク`,
    ``,
    `案件番号: ${params.recordNumber}`,
    `パートナー名: ${params.partnerName}`,
    `契約プラン: ${params.contractPlan}`,
    ``,
    heading,
    ``,
    params.instruction.comment,
    ``,
  ];
  if (params.isGlobal) {
    lines.push(
      `※ これは「全体指示」モード。サイト全体に渡る大胆な編集が許可されている。`,
    );
    lines.push(``);
  }
  if (params.instruction.selectors && params.instruction.selectors.length > 0) {
    lines.push(`### ディレクターが指定した対象 DOM 要素`);
    lines.push(
      `(プレビュー上で選択された。CSS selector を参考に、該当ファイルで同等の要素を探してから編集せよ)`,
    );
    for (const s of params.instruction.selectors) {
      lines.push(``);
      lines.push(`- タグ: \`<${s.tag}>\``);
      lines.push(`- CSS selector: \`${s.selector}\``);
      if (s.text) lines.push(`- テキスト: "${s.text}"`);
      if (s.html) lines.push(`- HTML スニペット:\n\`\`\`html\n${s.html}\n\`\`\``);
    }
    lines.push(``);
  }
  if (params.uploaded.length > 0) {
    lines.push(`### 添付ファイル (sandbox に配置済み)`);
    lines.push(
      `以下のパス / 公開 URL で既に FS に書き込まれている。差し替え先としてそのまま使える。`,
    );
    for (const u of params.uploaded) {
      lines.push(``);
      lines.push(
        `- 元ファイル名: \`${u.originalFilename}\` (${u.mimeType}, ${u.sizeBytes} bytes)`,
      );
      lines.push(`  - sandbox FS パス: \`${u.sandboxPath}\``);
      lines.push(`  - 公開 URL: \`${u.publicUrl}\``);
    }
    lines.push(``);
  } else if (
    params.instruction.attachments &&
    params.instruction.attachments.length > 0
  ) {
    lines.push(`添付ファイル (メタ情報のみ / FS 書き込みには失敗しています):`);
    for (const a of params.instruction.attachments) {
      lines.push(`- ${a.filename} (${a.mimeType})`);
    }
    lines.push(``);
  }
  return lines.join("\n");
}

function buildCommitMessage(params: {
  recordNumber: string;
  instructionId: string;
  pinIndex: number | null;
  comment: string;
  summary: string;
}): string {
  const head = `directors-bot: ${params.recordNumber} ${params.instructionId}`;
  const pin = params.pinIndex !== null ? `ピン#${params.pinIndex + 1} ` : "";
  const body =
    `${pin}${params.comment}\n\n` +
    params.summary.split("\n").slice(0, 6).join("\n").trim();
  return `${head}\n\n${body}`;
}

function buildResultMessage(results: readonly InstructionApplication[]): string {
  const applied = results.filter((r) => r.status === "applied").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const unclear = results.filter((r) => r.status === "unclear").length;
  const parts: string[] = [];
  if (applied > 0) parts.push(`${applied} 件適用`);
  if (unclear > 0) parts.push(`${unclear} 件は判定不可 (変更箇所を特定できず)`);
  if (failed > 0) parts.push(`${failed} 件で失敗`);
  if (applied === 0 && unclear === 0 && failed === 0) {
    return `すべての指示は既に処理済みでした。`;
  }
  if (applied === 0 && failed === 0) {
    return `${unclear} 件のすべてで AI は変更箇所を特定できませんでした。指示をより具体的にして再送信してください。`;
  }
  if (failed > 0 && applied === 0) {
    return `${parts.join(" / ")}。`;
  }
  return `${parts.join(" / ")}。確認のうえ「変更を保存する」で GitHub に保存してください。`;
}

export function toClientApplication(app: InstructionApplication) {
  return {
    id: app.id,
    instructionId: app.instructionId,
    comment: app.comment,
    pinIndex: app.pinIndex,
    orderIndex: app.orderIndex,
    isGlobal: app.isGlobal,
    status: app.status,
    summary: app.summary,
    errorMessage: app.errorMessage,
    commitSha: app.commitSha,
    revertCommitSha: app.revertCommitSha,
    attachments: app.attachments,
    revertedAt: app.revertedAt?.toISOString() ?? null,
    completedAt: app.completedAt?.toISOString() ?? null,
    createdAt: app.createdAt.toISOString(),
  };
}

function base64Bytes(b64: string): number {
  // approximation
  const padding = (b64.match(/=+$/)?.[0].length ?? 0);
  return Math.floor((b64.length * 3) / 4) - padding;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
