import { NextResponse } from "next/server";
import {
  AuthRequiredError,
  buildCaseLoadingContainer,
} from "@/infrastructure/config/container";

export const maxDuration = 300;

/**
 * 指示の revert エンドポイント。
 * client は localStorage に持っている `commitSha` を直接投げる。
 * server は session の所有権を確認したあと、Sandbox に `git revert` を指示するだけ。
 * DB には何も書かない (案件を閉じたら状態ごと破棄するため)。
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

  const body = payload as {
    sessionId?: unknown;
    instructionId?: unknown;
    commitSha?: unknown;
    comment?: unknown;
  };
  const sessionId =
    typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  const instructionId =
    typeof body.instructionId === "string" ? body.instructionId.trim() : "";
  const commitSha =
    typeof body.commitSha === "string" ? body.commitSha.trim() : "";
  const commentHead =
    typeof body.comment === "string"
      ? body.comment.split("\n")[0]?.slice(0, 80) ?? ""
      : "";
  if (!sessionId || !instructionId || !commitSha) {
    return NextResponse.json(
      {
        ok: false,
        message: "sessionId / instructionId / commitSha が必要です。",
      },
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
    const revertSha = await container.sandbox.revertCommit({
      sandboxId: session.sandboxId,
      targetCommitSha: commitSha,
      authorName: container.env.botGitAuthorName,
      authorEmail: container.env.botGitAuthorEmail,
      commitMessage:
        `revert directors-bot: ${session.recordNumber} ${instructionId}\n\n` +
        `rollback of ${commitSha.slice(0, 7)}${commentHead ? ` (${commentHead})` : ""}`,
    });

    return NextResponse.json({
      ok: true,
      message: "指示を元に戻しました。",
      revertCommitSha: revertSha,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        message: `ロールバックに失敗しました: ${error instanceof Error ? error.message : String(error)}`,
      },
      { status: 500 },
    );
  }
}
