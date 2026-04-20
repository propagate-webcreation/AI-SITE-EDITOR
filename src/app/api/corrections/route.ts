import { NextResponse } from "next/server";
import {
  AuthRequiredError,
  buildCorrectionContainer,
} from "@/infrastructure/config/container";
import {
  handleCorrectionsRequest,
  parseCorrectionsBody,
  type CorrectionEvent,
} from "@/presentation/controllers/correctionsController";

export const maxDuration = 800;

/**
 * 修正指示の実行エンドポイント。
 *
 * レスポンス形式:
 * - バリデーション失敗 (400 / 401 / 403 / 404 / 410 / 5xx) → 通常の JSON レスポンス
 * - 実行開始できた場合 → 200 + `application/x-ndjson` ストリーム
 *   (tool call / phase / instruction / result イベントを逐次 push)
 *
 * ストリーミングは HTTP status を開始後に変えられないため、HTTP 層の失敗は
 * stream を開く前に確定させる (フェイルファスト)。
 */
export async function POST(request: Request): Promise<Response> {
  let container;
  try {
    container = await buildCorrectionContainer();
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return NextResponse.json(
        { ok: false, message: error.message },
        { status: 401 },
      );
    }
    return NextResponse.json(
      {
        ok: false,
        message: `サーバー設定が不足しています: ${error instanceof Error ? error.message : String(error)}`,
      },
      { status: 500 },
    );
  }

  const parsed = await parseCorrectionsBody(request);
  if ("error" in parsed) {
    return NextResponse.json(
      { ok: false, message: parsed.error },
      { status: 400 },
    );
  }

  const session = await container.sessions.getById(parsed.sessionId);
  if (!session) {
    return NextResponse.json(
      {
        ok: false,
        message: "セッションが見つかりません。案件を開き直してください。",
      },
      { status: 404 },
    );
  }
  if (session.directorId !== container.directorId) {
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

  const encoder = new TextEncoder();
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  let closed = false;

  async function writeEvent(event: CorrectionEvent): Promise<void> {
    if (closed) return;
    try {
      await writer.write(encoder.encode(JSON.stringify(event) + "\n"));
    } catch (error) {
      // client が stream を閉じた (navigate away 等) のは正常動作なので warn 程度。
      console.warn(
        "[corrections] stream write failed (client disconnected?):",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  let queue: Promise<void> = Promise.resolve();
  function emit(event: CorrectionEvent): void {
    // 同期呼び出しから非同期書き込みへ変換。順序は Promise チェインで担保。
    queue = queue.then(() => writeEvent(event));
  }

  (async () => {
    try {
      await handleCorrectionsRequest(
        {
          session: {
            id: session.id,
            sandboxId: session.sandboxId,
            recordNumber: session.recordNumber,
            partnerName: session.partnerName,
            contractPlan: session.contractPlan,
          },
          instructions: parsed.instructions,
        },
        {
          runtimeProvider: container.sandbox,
          agentRunner: container.agentRunner,
          committer: container.sandbox,
          sandboxCwd: "/vercel/sandbox",
          botAuthorName: container.env.botGitAuthorName,
          botAuthorEmail: container.env.botGitAuthorEmail,
          globalModel: container.env.geminiGlobalModel,
          emit,
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[corrections] handler threw:", err);
      emit({
        kind: "result",
        ok: false,
        message: `サーバーエラー: ${message}`,
        applications: [],
        durationSec: 0,
      });
    } finally {
      await queue;
      closed = true;
      await writer.close();
    }
  })();

  return new Response(stream.readable, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
