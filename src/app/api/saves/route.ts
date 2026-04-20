import { NextResponse } from "next/server";
import {
  AuthRequiredError,
  buildCorrectionContainer,
} from "@/infrastructure/config/container";

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

  try {
    const commitSha = await container.sandbox.pushAll({
      sandboxId: session.sandboxId,
      repoUrl: session.githubRepoUrl,
      githubToken: container.env.githubToken,
      branch: container.env.gitDeployBranch,
    });
    return NextResponse.json({
      ok: true,
      message: `GitHub に保存しました (${commitSha.slice(0, 7)})。デプロイが自動で走ります。`,
      commitSha,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        message: `保存に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
      },
      { status: 500 },
    );
  }
}
