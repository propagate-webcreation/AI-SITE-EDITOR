import { NextResponse } from "next/server";
import {
  AuthRequiredError,
  buildCorrectionContainer,
} from "@/infrastructure/config/container";
import { toClientApplication } from "@/presentation/controllers/correctionsController";

export const maxDuration = 300;

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

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, message: "リクエスト本文が JSON として解釈できません。" },
      { status: 400 },
    );
  }

  const applicationId =
    typeof (payload as { applicationId?: unknown })?.applicationId === "string"
      ? (payload as { applicationId: string }).applicationId.trim()
      : "";
  if (!applicationId) {
    return NextResponse.json(
      { ok: false, message: "applicationId が必要です。" },
      { status: 400 },
    );
  }

  const app = await container.applications.getById(applicationId);
  if (!app) {
    return NextResponse.json(
      { ok: false, message: "修正履歴が見つかりません。" },
      { status: 404 },
    );
  }
  if (app.status === "reverted") {
    return NextResponse.json(
      { ok: false, message: "この指示は既にロールバック済みです。" },
      { status: 409 },
    );
  }
  if (app.status !== "applied") {
    return NextResponse.json(
      {
        ok: false,
        message: `status=${app.status} の指示はロールバックできません。`,
      },
      { status: 409 },
    );
  }
  if (!app.commitSha) {
    return NextResponse.json(
      {
        ok: false,
        message: "この指示に対応するコミットが記録されていません。",
      },
      { status: 409 },
    );
  }

  const session = await container.sessions.getById(app.sessionId);
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
      targetCommitSha: app.commitSha,
      authorName: container.env.botGitAuthorName,
      authorEmail: container.env.botGitAuthorEmail,
      commitMessage:
        `revert directors-bot: ${session.recordNumber} ${app.instructionId}\n\n` +
        `rollback of ${app.commitSha.slice(0, 7)} (${(app.comment.split("\n")[0] ?? "").slice(0, 80)})`,
    });

    await container.applications.update({
      id: app.id,
      status: "reverted",
      revertCommitSha: revertSha,
      revertedAt: new Date(),
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

  const refreshed = await container.applications.getById(app.id);
  return NextResponse.json({
    ok: true,
    message: "指示を元に戻しました。",
    application: refreshed ? toClientApplication(refreshed) : null,
  });
}
