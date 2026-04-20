"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  PreviewPane,
  type PreviewSelectorPayload,
} from "./PreviewPane";
import {
  ChatPane,
  type ChatItem,
  type ChatItemStatus,
  type ChatSelector,
} from "./ChatPane";
import { CaseLoader, type LoadedCase } from "./CaseLoader";
import { LogDrawer, type LogEntry } from "./LogDrawer";

export interface InitialSessionSummary {
  sessionId: string;
  recordNumber: string;
  partnerName: string;
  contractPlan: string;
  githubRepoUrl: string;
  previewUrl: string;
  expiresAt: string;
}

interface DirectorWorkspaceProps {
  directorEmail: string | null;
  initialSession: InitialSessionSummary | null;
}

interface PersistedWork {
  items: ChatItem[];
  pendingSelectors: ChatSelector[];
}

interface ApiApplication {
  id: string;
  instructionId: string;
  comment: string;
  pinIndex: number | null;
  orderIndex: number;
  isGlobal?: boolean;
  status: ChatItemStatus;
  summary: string | null;
  errorMessage: string | null;
  commitSha: string | null;
  revertCommitSha: string | null;
  attachments: { filename: string; mimeType: string; sizeBytes: number }[];
  selectors?: ChatSelector[];
}

type StreamEvent =
  | {
      kind: "phase";
      phase: "prepare" | "regular" | "global" | "complete";
      regularCount: number;
      globalCount: number;
    }
  | {
      kind: "instruction";
      instructionId: string;
      status:
        | "queued"
        | "running"
        | "applied"
        | "failed"
        | "reverted"
        | "unclear";
      isGlobal: boolean;
      commitSha?: string;
      message?: string;
    }
  | {
      kind: "toolCall";
      instructionId: string;
      name: string;
      argsSummary: string;
      success: boolean;
      iteration: number;
    }
  | { kind: "log"; level: "info" | "warn" | "error"; message: string }
  | {
      kind: "result";
      ok: boolean;
      message: string;
      applications: ApiApplication[];
      durationSec: number;
    };

function shortInstructionId(id: string): string {
  // "ins-1756781234-abc" → "abc"
  const parts = id.split("-");
  return parts[parts.length - 1] ?? id.slice(0, 6);
}

function workStorageKey(sessionId: string): string {
  return `directors-bot:work:${sessionId}`;
}

function loadPersistedWork(sessionId: string): PersistedWork | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(workStorageKey(sessionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedWork;
    return {
      items: Array.isArray(parsed.items)
        ? parsed.items.map((it) => ({
            ...it,
            selectors: Array.isArray(it.selectors) ? it.selectors : [],
            isGlobal: typeof it.isGlobal === "boolean" ? it.isGlobal : false,
          }))
        : [],
      pendingSelectors: Array.isArray(parsed.pendingSelectors)
        ? parsed.pendingSelectors
        : [],
    };
  } catch {
    return null;
  }
}

function savePersistedWork(sessionId: string, work: PersistedWork): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(workStorageKey(sessionId), JSON.stringify(work));
  } catch {
    /* ignore quota errors */
  }
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("file read error"));
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("file read error"));
    reader.readAsDataURL(file);
  });
}

/**
 * Sandbox の git log から得た commit 情報で localStorage の items を整合させる。
 * - apply commit が見つかった instruction → `applied` + commitSha に昇格
 * - revert commit が見つかった instruction → `reverted` に更新
 * - git log に無い `submitted` / `running` → サーバー応答を取り逃がしたケース
 *   ページ再読み込みを跨いだ時点で fetch は既に切れているので、そのままだと
 *   永遠に「AI 処理中」表示が残ってしまう。`failed` に降格して再送信を促す。
 */
function reconcileFromGitLog(
  existing: ChatItem[],
  commits: {
    sha: string;
    instructionId: string;
    kind: "apply" | "revert";
    targetSha?: string;
    committedAt: number;
  }[],
): ChatItem[] {
  const latestByInstruction = new Map<
    string,
    { sha: string; kind: "apply" | "revert"; committedAt: number }
  >();
  for (const c of commits) {
    const cur = latestByInstruction.get(c.instructionId);
    if (!cur || c.committedAt > cur.committedAt) {
      latestByInstruction.set(c.instructionId, {
        sha: c.sha,
        kind: c.kind,
        committedAt: c.committedAt,
      });
    }
  }
  return existing.map((item) => {
    const latest = latestByInstruction.get(item.id);
    if (latest) {
      if (latest.kind === "revert") {
        return { ...item, status: "reverted" as const };
      }
      if (item.status === "applied" && item.commitSha === latest.sha) return item;
      return {
        ...item,
        status: "applied" as const,
        commitSha: latest.sha,
      };
    }
    // git log に無い submitted はページ再読み込み時点で迷子扱い。
    if (item.status === "submitted") {
      return {
        ...item,
        status: "failed" as const,
        errorMessage:
          item.errorMessage ??
          "サーバーからの応答を受け取れませんでした。コミット履歴にも記録がないため、同じ内容を新しい指示として追加し直してください。",
      };
    }
    return item;
  });
}

function mergeFromServer(
  existing: ChatItem[],
  applications: ApiApplication[],
): ChatItem[] {
  const byInstructionId = new Map(existing.map((it) => [it.id, it]));
  const out: ChatItem[] = [];
  const consumed = new Set<string>();

  for (const app of applications) {
    const local = byInstructionId.get(app.instructionId);
    if (local) consumed.add(app.instructionId);
    out.push({
      id: app.instructionId,
      comment: app.comment,
      attachments:
        local?.attachments ??
        app.attachments.map((a) => ({
          filename: a.filename,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
          base64: "",
        })),
      selectors: app.selectors ?? local?.selectors ?? [],
      isGlobal: app.isGlobal ?? local?.isGlobal ?? false,
      status: app.status,
      applicationId: app.id,
      summary: app.summary ?? undefined,
      commitSha: app.commitSha ?? undefined,
      errorMessage: app.errorMessage ?? undefined,
    });
  }
  for (const it of existing) {
    if (!consumed.has(it.id) && it.status === "draft") out.push(it);
  }
  return out;
}

export function DirectorWorkspace({
  directorEmail,
  initialSession,
}: DirectorWorkspaceProps) {
  const [loadedCase, setLoadedCase] = useState<LoadedCase | null>(() => {
    if (!initialSession) return null;
    return {
      sessionId: initialSession.sessionId,
      recordNumber: initialSession.recordNumber,
      partnerName: initialSession.partnerName,
      contractPlan: initialSession.contractPlan,
      githubRepoUrl: initialSession.githubRepoUrl,
      previewUrl: initialSession.previewUrl,
      expiresAt: initialSession.expiresAt,
    };
  });

  const initialWork = useMemo<PersistedWork>(() => {
    if (typeof window === "undefined" || !initialSession) {
      return { items: [], pendingSelectors: [] };
    }
    return (
      loadPersistedWork(initialSession.sessionId) ?? {
        items: [],
        pendingSelectors: [],
      }
    );
  }, [initialSession]);

  const [items, setItems] = useState<ChatItem[]>(initialWork.items);
  const [pendingSelectors, setPendingSelectors] = useState<ChatSelector[]>(
    initialWork.pendingSelectors,
  );
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [closing, setClosing] = useState(false);
  const [closeModalOpen, setCloseModalOpen] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [revertingItemId, setRevertingItemId] = useState<string | null>(null);
  const [restartingDevServer, setRestartingDevServer] = useState(false);
  const [lastResultMessage, setLastResultMessage] = useState<string | null>(
    initialSession
      ? `案件 ${initialSession.recordNumber} (${initialSession.partnerName}) を復元しました`
      : null,
  );
  const previewKeyRef = useRef(0);
  const [previewKey, setPreviewKey] = useState(0);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const logSeqRef = useRef(0);
  const pushLog = useMemo(
    () => (entry: Omit<LogEntry, "id" | "ts">) => {
      logSeqRef.current += 1;
      setLogEntries((prev) => [
        ...prev,
        { ...entry, id: `log-${logSeqRef.current}`, ts: Date.now() },
      ]);
    },
    [],
  );

  // ページリロード時の reconcile: Sandbox の git log を見て、
  // localStorage で submitted / running のまま止まっている item を
  // 実際に commit された状態 (applied + commitSha) に昇格させる。
  // あるいは revert commit が見つかれば reverted に更新。
  useEffect(() => {
    if (!loadedCase) return;
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(
          `/api/sessions/reconcile?sessionId=${encodeURIComponent(loadedCase.sessionId)}`,
        );
        if (!resp.ok) return;
        const body = (await resp.json()) as {
          ok: boolean;
          commits?: {
            sha: string;
            instructionId: string;
            kind: "apply" | "revert";
            targetSha?: string;
            committedAt: number;
          }[];
          hasDirty?: boolean;
        };
        if (!body.ok || cancelled) return;
        const commits = body.commits ?? [];
        setItems((prev) => reconcileFromGitLog(prev, commits));
      } catch {
        /* noop: localStorage の状態のまま */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadedCase]);

  useEffect(() => {
    if (!loadedCase) return;
    savePersistedWork(loadedCase.sessionId, {
      items,
      pendingSelectors,
    });
  }, [loadedCase, items, pendingSelectors]);

  const hasAppliedItems = useMemo(
    () => items.some((it) => it.status === "applied"),
    [items],
  );

  function handleCaseLoaded(loaded: LoadedCase): void {
    setLoadedCase(loaded);
    setItems([]);
    setPendingSelectors([]);
    setLastResultMessage(
      `案件 ${loaded.recordNumber} (${loaded.partnerName}) を開きました`,
    );
    previewKeyRef.current += 1;
    setPreviewKey(previewKeyRef.current);
  }

  function handleElementSelected(sel: PreviewSelectorPayload): void {
    setPendingSelectors((prev) => {
      if (prev.some((p) => p.selector === sel.selector)) return prev;
      return [...prev, sel];
    });
  }
  function handleRemovePendingSelector(index: number): void {
    setPendingSelectors((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmitInstruction(params: {
    comment: string;
    attachments: File[];
    isGlobal: boolean;
  }): Promise<void> {
    const id = `ins-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const encoded = await Promise.all(
      params.attachments.map(async (f) => ({
        filename: f.name,
        mimeType: f.type || "application/octet-stream",
        sizeBytes: f.size,
        base64: await fileToBase64(f),
      })),
    );
    setItems((prev) => [
      ...prev,
      {
        id,
        comment: params.comment,
        attachments: encoded,
        selectors: params.isGlobal ? [] : pendingSelectors,
        isGlobal: params.isGlobal,
        status: "draft",
      },
    ]);
    if (!params.isGlobal) setPendingSelectors([]);
  }

  async function handleRun(): Promise<void> {
    if (!loadedCase || running || saving) return;
    const drafts = items.filter((it) => it.status === "draft");
    if (drafts.length === 0) return;

    setRunning(true);
    setLastResultMessage(null);
    setLogEntries([]);
    setItems((prev) =>
      prev.map((it) =>
        it.status === "draft" ? { ...it, status: "submitted" as const } : it,
      ),
    );
    let finalResult: {
      ok: boolean;
      message?: string;
      applications?: ApiApplication[];
    } | null = null;
    try {
      const resp = await fetch("/api/corrections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: loadedCase.sessionId,
          instructions: drafts.map((it) => ({
            id: it.id,
            comment: it.comment,
            isGlobal: it.isGlobal,
            attachments: it.attachments.map((a) => ({
              filename: a.filename,
              mimeType: a.mimeType,
              base64: a.base64,
            })),
            selectors: it.selectors.map((s) => ({
              tag: s.tag,
              selector: s.selector,
              text: s.text,
              html: s.html,
            })),
          })),
        }),
      });

      if (!resp.ok || !resp.body) {
        // レガシー JSON フォールバック。5xx でも JSON が返ることがある。
        const fallback = (await resp.json().catch(() => null)) as {
          ok?: boolean;
          message?: string;
        } | null;
        throw new Error(fallback?.message ?? `HTTP ${resp.status}`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const event = JSON.parse(trimmed) as StreamEvent;
            handleStreamEvent(event);
            if (event.kind === "result") {
              finalResult = {
                ok: event.ok,
                message: event.message,
                applications: event.applications,
              };
            }
          } catch {
            /* ignore malformed line */
          }
        }
      }

      if (finalResult && Array.isArray(finalResult.applications)) {
        setItems((prev) => mergeFromServer(prev, finalResult!.applications!));
      }
      setLastResultMessage(
        finalResult?.message ??
          (finalResult?.ok ? "修正が完了しました" : "修正に失敗しました"),
      );
      previewKeyRef.current += 1;
      setPreviewKey(previewKeyRef.current);
    } catch (error) {
      setLastResultMessage(
        error instanceof Error ? error.message : "通信エラーが発生しました",
      );
      setItems((prev) =>
        prev.map((it) =>
          it.status === "submitted" ? { ...it, status: "failed" as const } : it,
        ),
      );
    } finally {
      setRunning(false);
    }
  }

  function handleStreamEvent(event: StreamEvent): void {
    if (event.kind === "phase") {
      const phaseLabel =
        event.phase === "prepare"
          ? `準備完了 (通常 ${event.regularCount} / 全体 ${event.globalCount})`
          : event.phase === "regular"
            ? `通常指示を並列実行 (${event.regularCount} 件)`
            : event.phase === "global"
              ? `全体指示を順次実行 (${event.globalCount} 件)`
              : "完了";
      pushLog({ kind: "phase", phase: event.phase, headline: phaseLabel });
    } else if (event.kind === "instruction") {
      const statusLabel = {
        queued: "キュー追加",
        running: "実行開始",
        applied: "✓ 反映済み",
        failed: "× 失敗",
        reverted: "元に戻した",
        unclear: "判定不可",
      }[event.status];
      pushLog({
        kind: "instruction",
        instructionId: event.instructionId,
        headline: `${shortInstructionId(event.instructionId)}${event.isGlobal ? " [全体]" : ""}  ${statusLabel}`,
        detail: event.commitSha
          ? event.commitSha.slice(0, 7)
          : event.message?.slice(0, 120),
        error: event.status === "failed",
      });
      // 実 item の status も即座に更新。result イベントの到着を待たない。
      // 途中でストリームが切れても UI が「AI 処理中」で固まらないようにする。
      const terminalStatus =
        event.status === "applied" ||
        event.status === "failed" ||
        event.status === "unclear" ||
        event.status === "reverted";
      if (terminalStatus) {
        setItems((prev) =>
          prev.map((item) => {
            if (item.id !== event.instructionId) return item;
            const isFailed =
              event.status === "failed" || event.status === "unclear";
            return {
              ...item,
              status: event.status as ChatItemStatus,
              commitSha: event.commitSha ?? item.commitSha,
              errorMessage: isFailed
                ? event.message ?? item.errorMessage
                : item.errorMessage,
            };
          }),
        );
      }
    } else if (event.kind === "toolCall") {
      pushLog({
        kind: "toolCall",
        instructionId: event.instructionId,
        headline: `${event.name} ${event.argsSummary}`,
        detail: `#${event.iteration} ${event.success ? "ok" : "fail"}`,
        error: !event.success,
      });
    } else if (event.kind === "log") {
      pushLog({
        kind: "log",
        headline: event.message,
        error: event.level === "error",
      });
    } else if (event.kind === "result") {
      pushLog({
        kind: "result",
        headline: event.message,
        detail: `${event.durationSec.toFixed(1)}s / ${event.applications.length} 件`,
        error: !event.ok,
      });
    }
  }

  function handleDeleteDraft(itemId: string): void {
    setItems((prev) =>
      prev.filter((it) => !(it.id === itemId && it.status === "draft")),
    );
  }

  async function handleRevert(itemId: string): Promise<void> {
    if (!loadedCase || revertingItemId) return;
    const target = items.find((it) => it.id === itemId);
    if (!target?.commitSha) return;
    setRevertingItemId(itemId);
    try {
      const resp = await fetch("/api/instructions/revert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: loadedCase.sessionId,
          instructionId: target.id,
          commitSha: target.commitSha,
          comment: target.comment,
        }),
      });
      const data = (await resp.json()) as {
        ok: boolean;
        message?: string;
        revertCommitSha?: string;
      };
      if (data.ok) {
        setItems((prev) =>
          prev.map((it) =>
            it.id === itemId ? { ...it, status: "reverted" as const } : it,
          ),
        );
        setLastResultMessage(data.message ?? "指示を元に戻しました");
        previewKeyRef.current += 1;
        setPreviewKey(previewKeyRef.current);
      } else {
        setLastResultMessage(data.message ?? "ロールバックに失敗しました");
      }
    } catch (error) {
      setLastResultMessage(
        error instanceof Error ? error.message : "通信エラーが発生しました",
      );
    } finally {
      setRevertingItemId(null);
    }
  }

  async function handleSave(): Promise<void> {
    if (!loadedCase || saving || running) return;
    setSaving(true);
    setLastResultMessage("GitHub に保存中...");
    try {
      const resp = await fetch("/api/saves", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: loadedCase.sessionId }),
      });
      const data = (await resp.json()) as { ok: boolean; message?: string };
      setLastResultMessage(
        data.message ?? (data.ok ? "保存しました" : "保存に失敗しました"),
      );
    } catch (error) {
      setLastResultMessage(
        error instanceof Error ? error.message : "通信エラーが発生しました",
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleSignOut(): Promise<void> {
    try {
      await fetch("/api/auth/signout", { method: "POST" });
    } finally {
      window.location.replace("/login");
    }
  }

  async function handleRestartDevServer(): Promise<void> {
    if (!loadedCase || restartingDevServer) return;
    setRestartingDevServer(true);
    setLastResultMessage("開発サーバーを再起動中... (最大 3 分)");
    try {
      const resp = await fetch("/api/sessions/restart-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: loadedCase.sessionId }),
      });
      const data = (await resp.json()) as { ok: boolean; message?: string };
      if (data.ok) {
        previewKeyRef.current += 1;
        setPreviewKey(previewKeyRef.current);
        setLastResultMessage(
          data.message ?? "開発サーバーを再起動しました。",
        );
      } else {
        setLastResultMessage(
          data.message ?? "開発サーバーの再起動に失敗しました。",
        );
      }
    } catch (error) {
      setLastResultMessage(
        error instanceof Error ? error.message : "通信エラーが発生しました",
      );
    } finally {
      setRestartingDevServer(false);
    }
  }

  async function handleCloseCase(saveFirst: boolean): Promise<void> {
    if (!loadedCase || closing) return;
    setCloseModalOpen(false);
    setClosing(true);
    setLastResultMessage(
      saveFirst ? "変更を保存してから閉じています..." : "案件を閉じています...",
    );
    try {
      if (saveFirst) {
        const saveResp = await fetch("/api/saves", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: loadedCase.sessionId }),
        });
        const saveData = (await saveResp.json()) as {
          ok: boolean;
          message?: string;
        };
        if (!saveData.ok) {
          setLastResultMessage(
            saveData.message ?? "保存に失敗したため、案件は開いたままにしました。",
          );
          return;
        }
      }
      const closeResp = await fetch("/api/sessions/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: loadedCase.sessionId }),
      });
      const closeData = (await closeResp.json()) as {
        ok: boolean;
        message?: string;
      };
      if (!closeData.ok) {
        setLastResultMessage(closeData.message ?? "案件のクローズに失敗しました。");
        return;
      }
      if (typeof window !== "undefined") {
        try {
          window.localStorage.removeItem(workStorageKey(loadedCase.sessionId));
        } catch {
          /* ignore */
        }
      }
      setLoadedCase(null);
      setItems([]);
      setPendingSelectors([]);
      previewKeyRef.current += 1;
      setPreviewKey(previewKeyRef.current);
      setLastResultMessage(
        saveFirst
          ? "変更を GitHub に保存してから案件を閉じました。"
          : "案件を閉じました。",
      );
    } catch (error) {
      setLastResultMessage(
        error instanceof Error ? error.message : "通信エラーが発生しました",
      );
    } finally {
      setClosing(false);
    }
  }

  const caseLabel = loadedCase
    ? `案件 ${loadedCase.recordNumber} | ${loadedCase.partnerName} | ${loadedCase.contractPlan}`
    : "案件未選択";

  return (
    <div className="flex flex-col h-[100dvh] min-h-[640px] min-w-[900px] bg-[#141414]">
      <header className="px-4 h-12 border-b border-[#2d2d31] bg-[#1b1b1d] flex items-center gap-3 text-sm">
        <span className="font-semibold text-[#e8e8ea] whitespace-nowrap tracking-wider">
          AI-SITE-EDITOR
        </span>
        <div className="h-5 w-px bg-[#2d2d31]" />
        {/* 案件操作クラスタ: Loader と Close は同一の責務なので詰めて配置 */}
        <div className="flex items-center gap-2">
          <CaseLoader onLoaded={handleCaseLoaded} />
          {loadedCase && (
            <button
              type="button"
              onClick={() => setCloseModalOpen(true)}
              disabled={closing || running || saving}
              className="inline-flex items-center justify-center h-[30px] px-3 rounded-md border border-red-500/30 bg-transparent text-xs font-semibold text-red-300/80 hover:border-red-500/60 hover:bg-red-500/10 hover:text-red-200 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:border-red-500/30 disabled:hover:text-red-300/80 transition whitespace-nowrap"
            >
              {closing ? "閉じ中..." : "案件を閉じる"}
            </button>
          )}
        </div>
        {(loadedCase || lastResultMessage) && (
          <div className="h-5 w-px bg-[#2d2d31]" />
        )}
        {loadedCase && (
          <span className="text-[#a9a9b0] truncate text-xs shrink-0 max-w-[30ch]">
            {caseLabel}
          </span>
        )}
        {lastResultMessage && (
          <span className="flex-1 text-xs text-[#a9a9b0] truncate italic">
            {lastResultMessage}
          </span>
        )}
        <div className="ml-auto flex items-center gap-3 text-xs text-[#a9a9b0] whitespace-nowrap">
          {directorEmail && (
            <span className="text-[#70707a]">{directorEmail}</span>
          )}
          <button
            type="button"
            onClick={handleSignOut}
            className="inline-flex items-center justify-center h-[30px] px-3 rounded-md border border-[#3a3a3f] bg-[#1b1b1d] hover:border-[#55555c] hover:text-[#e8e8ea] transition"
          >
            ログアウト
          </button>
        </div>
      </header>
      {closeModalOpen && loadedCase && (
        <CloseCaseModal
          hasAppliedItems={hasAppliedItems}
          onCancel={() => setCloseModalOpen(false)}
          onDiscardAndClose={() => handleCloseCase(false)}
          onSaveAndClose={() => handleCloseCase(true)}
        />
      )}
      <div className="flex flex-1 min-h-0">
        <PreviewPane
          previewUrl={loadedCase?.previewUrl ?? null}
          onElementSelected={handleElementSelected}
          reloadKey={previewKey}
          selectMode={selectMode}
          onSelectModeReset={() => setSelectMode(false)}
          onRestartDevServer={handleRestartDevServer}
          restartingDevServer={restartingDevServer}
        />
        <ChatPane
          items={items}
          pendingSelectors={pendingSelectors}
          onRemovePendingSelector={handleRemovePendingSelector}
          onSubmit={handleSubmitInstruction}
          onRun={handleRun}
          onRevert={handleRevert}
          onDeleteDraft={handleDeleteDraft}
          onSave={handleSave}
          running={running}
          saving={saving}
          revertingItemId={revertingItemId}
          hasAppliedItems={hasAppliedItems}
          selectMode={selectMode}
          onToggleSelectMode={() => setSelectMode((v) => !v)}
          selectModeAvailable={!!loadedCase?.previewUrl}
        />
      </div>
      <LogDrawer
        entries={logEntries}
        running={running}
        onClear={() => setLogEntries([])}
      />
    </div>
  );
}

function CloseCaseModal(props: {
  hasAppliedItems: boolean;
  onCancel: () => void;
  onDiscardAndClose: () => void;
  onSaveAndClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={props.onCancel}
      role="presentation"
    >
      <div
        className="w-[460px] max-w-[92vw] rounded-lg border border-[#3a3a3f] bg-[#1f1f22] p-5 shadow-[0_20px_50px_-10px_rgba(0,0,0,0.7)]"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-[#f0f0f2] tracking-wide">
          {props.hasAppliedItems ? "変更を保存しますか？" : "案件を閉じますか？"}
        </h2>
        <p className="mt-2 text-sm text-[#a9a9b0] leading-relaxed">
          {props.hasAppliedItems
            ? "この案件には AI が適用した未保存の変更があります。保存せずに閉じると、Sandbox ごと破棄され変更は失われます。閉じると DB 上のこの案件の記録も削除されます（GitHub へ保存済みのコミットは残ります）。"
            : "案件を閉じると Sandbox が停止し、DB 上のこの案件の記録も削除されます。他のディレクターが同じ案件を開けるようになります（ログイン情報は保持されます）。"}
        </p>
        <div className="mt-5 flex flex-col gap-2">
          {props.hasAppliedItems ? (
            <>
              <button
                type="button"
                onClick={props.onSaveAndClose}
                className="px-3 py-2 rounded-md bg-teal-500 text-[#0b0b0d] text-sm font-semibold hover:bg-teal-400 transition"
              >
                保存して閉じる
              </button>
              <button
                type="button"
                onClick={props.onDiscardAndClose}
                className="px-3 py-2 rounded-md bg-red-500/90 text-white text-sm font-semibold hover:bg-red-500 transition"
              >
                保存せずに閉じる
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={props.onDiscardAndClose}
              className="px-3 py-2 rounded-md bg-red-500/90 text-white text-sm font-semibold hover:bg-red-500 transition"
            >
              はい、閉じる
            </button>
          )}
          <button
            type="button"
            onClick={props.onCancel}
            className="px-3 py-2 rounded-md border border-[#3a3a3f] bg-[#1b1b1d] text-sm text-[#a9a9b0] hover:border-[#55555c] hover:text-[#e8e8ea] transition"
          >
            キャンセル
          </button>
        </div>
      </div>
    </div>
  );
}
