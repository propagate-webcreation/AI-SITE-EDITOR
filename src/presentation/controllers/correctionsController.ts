import { NextResponse } from "next/server";
import type {
  InstructionApplicationRepositoryPort,
  SessionRepositoryPort,
} from "@/domain/ports";
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
  }): Promise<string | null>;
}

export interface CorrectionsControllerDependencies {
  sessions: SessionRepositoryPort;
  applications: InstructionApplicationRepositoryPort;
  runtimeProvider: RuntimeProvider;
  agentRunner: Pick<GeminiAgentRunner, "run">;
  committer: GitCommitter;
  directorId: string;
  sandboxCwd: string;
  botAuthorName: string;
  botAuthorEmail: string;
}

interface ParsedBody {
  sessionId: string;
  instructions: CorrectionInstructionInput[];
}

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const ACCEPTED_MIME_PREFIXES = ["image/"];

export async function handleCorrectionsRequest(
  request: Request,
  deps: CorrectionsControllerDependencies,
): Promise<NextResponse> {
  const parsed = await parseBody(request);
  if ("error" in parsed) {
    return NextResponse.json(
      { ok: false, message: parsed.error },
      { status: 400 },
    );
  }

  const session = await deps.sessions.getById(parsed.sessionId);
  if (!session) {
    return NextResponse.json(
      { ok: false, message: "セッションが見つかりません。案件を開き直してください。" },
      { status: 404 },
    );
  }
  if (session.directorId !== deps.directorId) {
    return NextResponse.json(
      { ok: false, message: "このセッションを扱う権限がありません。" },
      { status: 403 },
    );
  }
  if (session.status !== "active") {
    return NextResponse.json(
      {
        ok: false,
        message: `セッションは ${session.status} です。もう一度案件を開いてください。`,
      },
      { status: 410 },
    );
  }

  const runtime = await deps.runtimeProvider.getRuntime(session.sandboxId);
  const start = Date.now();
  const results: InstructionApplication[] = [];

  for (const inst of parsed.instructions) {
    const existing = await deps.applications.getBySessionAndInstructionId({
      sessionId: session.id,
      instructionId: inst.id,
    });
    if (existing) {
      // 既に適用済みの指示はスキップ (idempotent)
      results.push(existing);
      continue;
    }

    const orderIndex = await deps.applications.nextOrderIndex(session.id);
    const attachmentsMeta: InstructionAttachmentMeta[] = (inst.attachments ?? []).map(
      (a) => ({
        filename: a.filename,
        mimeType: a.mimeType,
        sizeBytes: base64Bytes(a.base64),
      }),
    );
    const created = await deps.applications.create({
      sessionId: session.id,
      instructionId: inst.id,
      comment: inst.comment,
      pinIndex: inst.pinIndex,
      attachments: attachmentsMeta,
      orderIndex,
    });

    await deps.applications.update({
      id: created.id,
      status: "running",
      startedAt: new Date(),
    });

    const userPrompt = buildUserPromptSingle({
      recordNumber: session.recordNumber,
      partnerName: session.partnerName,
      contractPlan: session.contractPlan,
      instruction: inst,
      orderIndex,
    });
    const attachments = collectAttachments([inst]);

    let agentResult: RunAgentOutput;
    try {
      agentResult = await deps.agentRunner.run({
        systemInstruction: SYSTEM_INSTRUCTION,
        userPrompt,
        attachments,
        sandbox: runtime,
        cwd: deps.sandboxCwd,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await deps.applications.update({
        id: created.id,
        status: "failed",
        errorMessage: msg,
        completedAt: new Date(),
      });
      const refreshed = await deps.applications.getById(created.id);
      if (refreshed) results.push(refreshed);
      // 1 件失敗したら後続を止める (状態の辻褄を保つため)
      break;
    }

    if (!agentResult.success) {
      await deps.applications.update({
        id: created.id,
        status: "failed",
        errorMessage: agentResult.errorMessage ?? agentResult.finalMessage,
        summary: agentResult.finalMessage,
        completedAt: new Date(),
      });
      const refreshed = await deps.applications.getById(created.id);
      if (refreshed) results.push(refreshed);
      break;
    }

    // commit
    let commitSha: string | null;
    try {
      commitSha = await deps.committer.commitOnly({
        sandboxId: session.sandboxId,
        authorName: deps.botAuthorName,
        authorEmail: deps.botAuthorEmail,
        commitMessage: buildCommitMessage({
          recordNumber: session.recordNumber,
          instructionId: inst.id,
          pinIndex: inst.pinIndex,
          comment: inst.comment,
          summary: agentResult.finalMessage,
        }),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await deps.applications.update({
        id: created.id,
        status: "failed",
        errorMessage: `AI 修正は完了しましたが commit に失敗: ${msg}`,
        summary: agentResult.finalMessage,
        completedAt: new Date(),
      });
      const refreshed = await deps.applications.getById(created.id);
      if (refreshed) results.push(refreshed);
      break;
    }

    await deps.applications.update({
      id: created.id,
      status: "applied",
      summary: agentResult.finalMessage,
      commitSha,
      completedAt: new Date(),
    });
    const refreshed = await deps.applications.getById(created.id);
    if (refreshed) results.push(refreshed);
  }

  const durationSec = (Date.now() - start) / 1000;
  const anyFailed = results.some((r) => r.status === "failed");
  return NextResponse.json(
    {
      ok: !anyFailed,
      message: buildResultMessage(results),
      applications: results.map(toClientApplication),
      durationSec,
    },
    { status: anyFailed ? 500 : 200 },
  );
}

const SYSTEM_INSTRUCTION = `あなたはウェブディレクターのアシスタントです。
Vercel Sandbox 上に clone されたデモサイトのソースコードを、ディレクターの指示に従って編集してください。

行動ルール:
- 破壊的な変更 (デザイン全体の作り直し、フレームワーク変更など) は避ける
- 指示に関係ない箇所は触らない
- まず必要なファイルを read_file / list_dir / glob / grep で確認してから編集する
- 編集は edit_file (1 箇所置換) を優先し、丸ごと書き換える場合のみ write_file を使う
- 添付画像がある場合は、ディレクターが「この画像を差し替えろ」「この画像のように配置しろ」等で使っている。文脈から判断する
- 画像の bytes を Sandbox に直接コピーするツールは無いので、コード上の image 参照箇所を変更する程度にとどめる
- この呼び出しでは **1 つの修正指示のみ** を処理する。複数の指示を受け取ったように見えても 1 件ずつ分けて呼ばれる
- 作業完了後、最後に短い日本語で「何をどう修正したか」のサマリを自由テキストで返して会話を終える
`;

async function parseBody(
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
          return { error: `添付ファイル ${filename} が大きすぎます (上限 8MB)` };
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

    instructions.push({ id, comment, pinIndex, attachments, selectors });
  }
  if (instructions.length === 0) {
    return { error: "修正指示が 1 件もありません。" };
  }
  return { sessionId, instructions };
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
}): string {
  const lines: string[] = [
    `# デモサイト修正タスク`,
    ``,
    `案件番号: ${params.recordNumber}`,
    `パートナー名: ${params.partnerName}`,
    `契約プラン: ${params.contractPlan}`,
    ``,
    `## 修正指示 (第 ${params.orderIndex + 1} 件目, id=${params.instruction.id})`,
    ``,
    params.instruction.comment,
    ``,
  ];
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
  if (params.instruction.attachments && params.instruction.attachments.length > 0) {
    lines.push(`添付ファイル:`);
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
  if (failed > 0) {
    return `${applied} 件の修正を適用しました。${failed} 件で失敗したため以降の指示はスキップされています。`;
  }
  if (applied === 0) {
    return `すべての指示は既に適用済みでした。`;
  }
  return `${applied} 件の修正を Sandbox に適用しました。確認のうえ「そのまま変更する」で GitHub に保存してください。`;
}

export function toClientApplication(app: InstructionApplication) {
  return {
    id: app.id,
    instructionId: app.instructionId,
    comment: app.comment,
    pinIndex: app.pinIndex,
    orderIndex: app.orderIndex,
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
