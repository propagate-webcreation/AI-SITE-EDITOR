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
      <label className="text-xs text-neutral-400">レコード番号</label>
      <input
        type="text"
        value={recordNumber}
        onChange={(e) => setRecordNumber(e.target.value)}
        placeholder="例: 001"
        className="w-32 rounded bg-neutral-950 border border-neutral-700 px-2 py-1.5 text-sm text-neutral-100 focus:outline-none focus:border-emerald-500"
        disabled={loading}
      />
      <button
        type="submit"
        disabled={!recordNumber.trim() || loading}
        className="px-3 py-1 rounded bg-emerald-500 text-white text-xs font-semibold disabled:bg-neutral-700 disabled:text-neutral-400 hover:bg-emerald-400 transition whitespace-nowrap"
      >
        {loading ? "起動中..." : "案件を開く"}
      </button>
      {loading && (
        <span className="text-xs text-neutral-400 animate-pulse truncate">
          clone → npm install → dev server 起動中
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
