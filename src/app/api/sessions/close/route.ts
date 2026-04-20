import { NextResponse } from "next/server";
import {
  AuthRequiredError,
  buildCaseLoadingContainer,
} from "@/infrastructure/config/container";

export const maxDuration = 60;

/**
 * セッションを閉じる: Vercel Sandbox を stop し、DB 上の sessions 行を物理削除する。
 * instruction_applications / corrections は FK の on delete cascade で一緒に消える。
 * directors / auth.users には一切影響せず、ログイン情報は保持される。
 *
 * 「案件の AI 修正履歴」自体は GitHub の commit 履歴に残るので、
 * 監査証跡としてはそれを参照する。DB 側は一時的な状態管理だけの役割にする。
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
  // Sandbox 停止は best-effort (既に停止済み / 404 でも DB 側は必ず消す)
  await container.sandbox.stop(session.sandboxId).catch(() => undefined);

  await container.sessions.deleteById(session.id);

  return NextResponse.json({
    ok: true,
    message: "案件を閉じました。",
  });
}
