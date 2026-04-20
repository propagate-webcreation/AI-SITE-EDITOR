import { NextResponse } from "next/server";
import {
  AuthRequiredError,
  buildCorrectionContainer,
} from "@/infrastructure/config/container";
import { toClientApplication } from "@/presentation/controllers/correctionsController";

export async function GET(request: Request): Promise<Response> {
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

  const list = await container.applications.listBySession(session.id);
  return NextResponse.json({
    ok: true,
    applications: list.map(toClientApplication),
  });
}
