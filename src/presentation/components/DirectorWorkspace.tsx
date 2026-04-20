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
  status: ChatItemStatus;
  summary: string | null;
  errorMessage: string | null;
  commitSha: string | null;
  revertCommitSha: string | null;
  attachments: { filename: string; mimeType: string; sizeBytes: number }[];
  selectors?: ChatSelector[];
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
  const [revertingItemId, setRevertingItemId] = useState<string | null>(null);
  const [lastResultMessage, setLastResultMessage] = useState<string | null>(
    initialSession
      ? `案件 ${initialSession.recordNumber} (${initialSession.partnerName}) を復元しました`
      : null,
  );
  const previewKeyRef = useRef(0);
  const [previewKey, setPreviewKey] = useState(0);

  useEffect(() => {
    if (!loadedCase) return;
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(
          `/api/sessions/applications?sessionId=${encodeURIComponent(loadedCase.sessionId)}`,
        );
        if (!resp.ok) return;
        const body = (await resp.json()) as {
          ok: boolean;
          applications: ApiApplication[];
        };
        if (!body.ok || cancelled) return;
        setItems((prev) => mergeFromServer(prev, body.applications));
      } catch {
        /* noop */
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
        selectors: pendingSelectors,
        status: "draft",
      },
    ]);
    setPendingSelectors([]);
  }

  async function handleRun(): Promise<void> {
    if (!loadedCase || running || saving) return;
    const drafts = items.filter((it) => it.status === "draft");
    if (drafts.length === 0) return;

    setRunning(true);
    setLastResultMessage(null);
    setItems((prev) =>
      prev.map((it) =>
        it.status === "draft" ? { ...it, status: "submitted" as const } : it,
      ),
    );
    try {
      const resp = await fetch("/api/corrections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: loadedCase.sessionId,
          instructions: drafts.map((it) => ({
            id: it.id,
            comment: it.comment,
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
      const data = (await resp.json()) as {
        ok: boolean;
        message?: string;
        applications?: ApiApplication[];
      };
      if (Array.isArray(data.applications)) {
        setItems((prev) => mergeFromServer(prev, data.applications!));
      }
      setLastResultMessage(
        data.message ?? (data.ok ? "修正が完了しました" : "修正に失敗しました"),
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

  async function handleRevert(itemId: string): Promise<void> {
    if (!loadedCase || revertingItemId) return;
    const target = items.find((it) => it.id === itemId);
    if (!target?.applicationId) return;
    setRevertingItemId(itemId);
    try {
      const resp = await fetch("/api/instructions/revert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicationId: target.applicationId }),
      });
      const data = (await resp.json()) as {
        ok: boolean;
        message?: string;
        application?: ApiApplication;
      };
      if (data.ok && data.application) {
        setItems((prev) => mergeFromServer(prev, [data.application!]));
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

  const caseLabel = loadedCase
    ? `案件 ${loadedCase.recordNumber} | ${loadedCase.partnerName} | ${loadedCase.contractPlan}`
    : "案件未選択";

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <header className="px-4 h-12 border-b border-neutral-800 flex items-center gap-4 text-sm">
        <span className="font-semibold whitespace-nowrap">directors-bot-v1</span>
        <CaseLoader onLoaded={handleCaseLoaded} />
        <span className="text-neutral-400 truncate">| {caseLabel}</span>
        {lastResultMessage && (
          <span className="flex-1 text-xs text-neutral-400 truncate">
            {lastResultMessage}
          </span>
        )}
        <div className="ml-auto flex items-center gap-3 text-xs text-neutral-400 whitespace-nowrap">
          {directorEmail && <span>{directorEmail}</span>}
          <button
            type="button"
            onClick={handleSignOut}
            className="px-2 py-0.5 rounded border border-neutral-700 hover:border-neutral-500"
          >
            ログアウト
          </button>
        </div>
      </header>
      <div className="flex flex-1 min-h-0">
        <PreviewPane
          previewUrl={loadedCase?.previewUrl ?? null}
          onElementSelected={handleElementSelected}
          reloadKey={previewKey}
        />
        <ChatPane
          items={items}
          pendingSelectors={pendingSelectors}
          onRemovePendingSelector={handleRemovePendingSelector}
          onSubmit={handleSubmitInstruction}
          onRun={handleRun}
          onRevert={handleRevert}
          onSave={handleSave}
          running={running}
          saving={saving}
          revertingItemId={revertingItemId}
          hasAppliedItems={hasAppliedItems}
        />
      </div>
    </div>
  );
}
