import { NextResponse } from "next/server";
import {
  AuthRequiredError,
  buildCorrectionContainer,
} from "@/infrastructure/config/container";
import { handleCorrectionsRequest } from "@/presentation/controllers/correctionsController";

export const maxDuration = 800;

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

  return handleCorrectionsRequest(request, {
    sessions: container.sessions,
    applications: container.applications,
    runtimeProvider: container.sandbox,
    agentRunner: container.agentRunner,
    committer: container.sandbox,
    directorId: container.directorId,
    sandboxCwd: "/vercel/sandbox",
    botAuthorName: container.env.botGitAuthorName,
    botAuthorEmail: container.env.botGitAuthorEmail,
  });
}
