import { NextResponse } from "next/server";
import {
  AuthRequiredError,
  buildCaseLoadingContainer,
} from "@/infrastructure/config/container";
import { fetchCaseByRecordNumber } from "@/presentation/controllers/fetchCaseController";

export const maxDuration = 800;

export async function GET(
  _request: Request,
  context: { params: Promise<{ recordNumber: string }> },
): Promise<Response> {
  const { recordNumber } = await context.params;

  let container;
  try {
    container = await buildCaseLoadingContainer();
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return NextResponse.json(
        { ok: false, code: "auth-required", message: error.message },
        { status: 401 },
      );
    }
    return NextResponse.json(
      {
        ok: false,
        code: "env-missing",
        message: `サーバー設定が不足しています: ${error instanceof Error ? error.message : String(error)}`,
      },
      { status: 500 },
    );
  }

  const result = await fetchCaseByRecordNumber(recordNumber, {
    spreadsheet: container.spreadsheet,
    sandbox: container.sandbox,
    sessions: container.sessions,
    directorId: container.directorId,
    // GitHub HTTPS auth では PAT は x-access-token をユーザー名にする必要がある。
    // env の GITHUB_USERNAME (= bot アカウント) は clone 認証には使わない。
    githubUsername: "x-access-token",
    githubToken: container.env.githubToken,
    sessionTtlSec: container.env.sessionDefaultTtlSec,
  });

  const httpStatus = result.ok
    ? 200
    : result.code === "case-not-found"
      ? 404
      : result.code === "session-conflict" ||
          result.code === "max-cases-reached"
        ? 409
        : result.code === "invalid-record-number" ||
            result.code === "missing-repo-url"
          ? 400
          : 500;

  return NextResponse.json(result, { status: httpStatus });
}
