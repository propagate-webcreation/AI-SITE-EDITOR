import { NextResponse } from "next/server";
import {
  AuthRequiredError,
  buildCaseLoadingContainer,
} from "@/infrastructure/config/container";

// dev server の ready 待ちで最大 3 分程度かかるので余裕を持たせる。
export const maxDuration = 300;

/**
 * Sandbox 内の Next.js dev server を再起動する。
 * AI の修正で dev が落ちた / OOM / stuck のリカバリー用。
 * Sandbox 自体は破棄せず、中の dev プロセスだけ bounce する。
 */
export async function POST(request: Request): Promise<Response> {
  let container;
  try {
    container = await buildCaseLoadingContainer();
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

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, message: "リクエスト本文が JSON として解釈できません。" },
      { status: 400 },
    );
  }
  const sessionId =
    typeof (payload as { sessionId?: unknown })?.sessionId === "string"
      ? (payload as { sessionId: string }).sessionId.trim()
      : "";
  if (!sessionId) {
    return NextResponse.json(
      { ok: false, message: "sessionId が必要です。" },
      { status: 400 },
    );
  }

  const session = await container.sessions.getById(sessionId);
  if (!session) {
    return NextResponse.json(
      { ok: false, message: "セッションが見つかりません。" },
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
      { ok: false, message: `セッションは ${session.status} です。` },
      { status: 410 },
    );
  }

  const result = await container.sandbox.restartDevServer({
    sandboxId: session.sandboxId,
  });

  if (!result.ok) {
    return NextResponse.json(
      {
        ok: false,
        message:
          result.message ??
          "dev server の再起動に失敗しました。案件を開き直してください。",
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    message: "開発サーバーを再起動しました。",
  });
}
