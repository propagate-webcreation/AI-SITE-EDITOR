import { NextResponse } from "next/server";
import {
  AuthRequiredError,
  buildCaseLoadingContainer,
} from "@/infrastructure/config/container";

export const maxDuration = 60;

/**
 * ページリロード時 / タブ復帰時に呼ばれる reconcile API。
 * Sandbox 内の git log を読んで、ディレクターによる修正コミットを列挙し、
 * client 側の localStorage (submitted のまま) を applied に昇格させるための
 * 最新状態を返す。
 *
 * このエンドポイントは DB 非依存。`sessions` 行 (Sandbox ID) だけを DB から引く。
 */
export async function GET(request: Request): Promise<Response> {
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

  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId")?.trim() ?? "";
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

  try {
    const { commits, hasDirty } = await container.sandbox.listDirectorCommits(
      session.sandboxId,
    );
    return NextResponse.json({ ok: true, commits, hasDirty });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        message: `git log の取得に失敗: ${error instanceof Error ? error.message : String(error)}`,
      },
      { status: 500 },
    );
  }
}
