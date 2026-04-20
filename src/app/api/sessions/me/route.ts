import { NextResponse } from "next/server";
import {
  AuthRequiredError,
  buildSessionReadContainer,
} from "@/infrastructure/config/container";

export async function GET(): Promise<Response> {
  let container;
  try {
    container = await buildSessionReadContainer();
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

  const active = await container.sessions.listActiveByDirector(
    container.directorId,
  );
  return NextResponse.json({
    ok: true,
    sessions: active.map((s) => ({
      id: s.id,
      recordNumber: s.recordNumber,
      partnerName: s.partnerName,
      contractPlan: s.contractPlan,
      githubRepoUrl: s.githubRepoUrl,
      previewUrl: s.previewUrl,
      startedAt: s.startedAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
    })),
  });
}
