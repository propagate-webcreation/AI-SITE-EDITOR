"use client";

import { useState, type FormEvent } from "react";

export interface LoadedCase {
  sessionId: string;
  recordNumber: string;
  partnerName: string;
  contractPlan: string;
  githubRepoUrl: string;
  previewUrl: string;
  expiresAt: string;
  /** Vercel 本番デプロイ URL。スプレッドシートに記載があれば。 */
  deployUrl?: string;
}

interface CaseLoaderProps {
  onLoaded: (loaded: LoadedCase) => void;
}

interface FetchCaseResponse {
  ok: boolean;
  code?: string;
  message?: string;
  session?: {
    id: string;
    previewUrl: string;
    expiresAt: string;
  };
  case?: {
    recordNumber: string;
    partnerName: string;
    contractPlan: string;
    githubRepoUrl: string;
    deployUrl?: string;
  };
}

export function CaseLoader({ onLoaded }: CaseLoaderProps) {
  const [recordNumber, setRecordNumber] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = recordNumber.trim();
    if (!trimmed || loading) return;
    setLoading(true);
    setError(null);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10 * 60 * 1000);
    try {
      const resp = await fetch(
        `/api/cases/${encodeURIComponent(trimmed)}`,
        { method: "GET", signal: controller.signal },
      );
      const body = (await resp.json()) as FetchCaseResponse;
      if (!body.ok || !body.session || !body.case) {
        setError(body.message ?? "エラーが発生しました。");
        return;
      }
      onLoaded({
        sessionId: body.session.id,
        previewUrl: body.session.previewUrl,
        expiresAt: body.session.expiresAt,
        recordNumber: body.case.recordNumber,
        partnerName: body.case.partnerName,
        contractPlan: body.case.contractPlan,
        githubRepoUrl: body.case.githubRepoUrl,
        deployUrl: body.case.deployUrl,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        setError("10 分以内に Sandbox が起動しませんでした。");
      } else {
        setError(err instanceof Error ? err.message : "通信エラーが発生しました");
      }
    } finally {
      clearTimeout(timer);
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex items-center gap-2 min-w-0">
      <label className="text-xs text-[#a9a9b0] whitespace-nowrap">
        レコード番号
      </label>
      <input
        type="text"
        value={recordNumber}
        onChange={(e) => setRecordNumber(e.target.value)}
        placeholder="例: 001"
        className="w-40 h-[30px] rounded-md bg-[#0f0f11] border border-[#3a3a3f] px-2 text-sm text-[#e8e8ea] placeholder:text-[#55555c] focus:outline-none focus:border-amber-500/50 transition disabled:opacity-50"
        disabled={loading}
      />
      <button
        type="submit"
        disabled={!recordNumber.trim() || loading}
        className="inline-flex items-center justify-center h-[30px] px-3 rounded-md border border-amber-500/60 bg-amber-500/90 text-[#0b0b0d] text-xs font-semibold hover:bg-amber-400 disabled:bg-[#2b2b30] disabled:text-[#55555c] disabled:border-[#3a3a3f] transition whitespace-nowrap"
      >
        {loading ? "起動中..." : "案件を開く"}
      </button>
      {loading && (
        <span className="text-xs text-[#a9a9b0] truncate">
          clone → install → dev server 起動中
        </span>
      )}
      {error && (
        <span className="text-xs text-red-400 truncate" title={error}>
          {error}
        </span>
      )}
    </form>
  );
}
