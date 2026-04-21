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

/**
 * 1 ディレクターが同時に開けるタブ (= active session) の上限。
 * Vercel Sandbox の VM 課金が並列数に比例するため、サーバ側
 * (`fetchCaseController.MAX_ACTIVE_CASES_PER_DIRECTOR`) と同じ値を UI 側でも
 * 強制してタブ追加ボタンを早めに無効化する。
 */
const MAX_OPEN_CASES = 5;

export interface InitialSessionSummary {
  sessionId: string;
  recordNumber: string;
  partnerName: string;
  contractPlan: string;
  githubRepoUrl: string;
  previewUrl: string;
  expiresAt: string;
  /** Vercel 本番デプロイ URL。スプレッドシート由来。無いケースもあり。 */
  deployUrl?: string;
}

interface DirectorWorkspaceProps {
  directorEmail: string | null;
  initialSessions: InitialSessionSummary[];
}

const EMPTY_STRING_ARRAY: readonly string[] = Object.freeze([]);

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

/**
 * 1 つの開いている案件タブに紐付く全 UI 状態。
 * タブ切替は `activeSessionId` を変えるだけで、各タブの fetch / stream は
 * バックグラウンドで動き続けるため、案件ごとに分離して持つ。
 */
interface CaseState {
  loaded: LoadedCase;
  items: ChatItem[];
  pendingSelectors: ChatSelector[];
  running: boolean;
  saving: boolean;
  closing: boolean;
  selectMode: boolean;
  revertingItemId: string | null;
  restartingDevServer: boolean;
  activeHighlightItemId: string | null;
  logEntries: LogEntry[];
  previewKey: number;
  lastResultMessage: string | null;
}

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

function loadedFromInitial(s: InitialSessionSummary): LoadedCase {
  return {
    sessionId: s.sessionId,
    recordNumber: s.recordNumber,
    partnerName: s.partnerName,
    contractPlan: s.contractPlan,
    githubRepoUrl: s.githubRepoUrl,
    previewUrl: s.previewUrl,
    expiresAt: s.expiresAt,
    deployUrl: s.deployUrl,
  };
}

function makeInitialCaseState(
  loaded: LoadedCase,
  persisted: PersistedWork | null,
  message: string | null,
): CaseState {
  return {
    loaded,
    items: persisted?.items ?? [],
    pendingSelectors: persisted?.pendingSelectors ?? [],
    running: false,
    saving: false,
    closing: false,
    selectMode: false,
    revertingItemId: null,
    restartingDevServer: false,
    activeHighlightItemId: null,
    logEntries: [],
    previewKey: 0,
    lastResultMessage: message,
  };
}

export function DirectorWorkspace({
  directorEmail,
  initialSessions,
}: DirectorWorkspaceProps) {
  const [cases, setCases] = useState<Record<string, CaseState>>(() => {
    const out: Record<string, CaseState> = {};
    for (const s of initialSessions) {
      const loaded = loadedFromInitial(s);
      const persisted =
        typeof window === "undefined" ? null : loadPersistedWork(s.sessionId);
      out[s.sessionId] = makeInitialCaseState(
        loaded,
        persisted,
        `案件 ${s.recordNumber} (${s.partnerName}) を復元しました`,
      );
    }
    return out;
  });
  const [activeSessionId, setActiveSessionId] = useState<string | null>(
    initialSessions[0]?.sessionId ?? null,
  );
  const [closeTargetSessionId, setCloseTargetSessionId] = useState<string | null>(
    null,
  );
  const [caseLoaderOpen, setCaseLoaderOpen] = useState(false);
  // 保存成功時のリンクモーダル。push が成功した瞬間に立ち上げ、
  // GitHub commit URL と Vercel 本番 URL を案内する。
  const [saveSuccess, setSaveSuccess] = useState<{
    sessionId: string;
    recordNumber: string;
    partnerName: string;
    commitSha?: string;
    githubRepoUrl: string;
    deployUrl?: string;
    /** 保存して閉じる経由かどうか。表示メッセージを少し変える。 */
    fromClose: boolean;
  } | null>(null);

  const logSeqRef = useRef(0);
  // どの session に対して reconcile 済みか。useEffect が cases 全体に反応するので、
  // 同じ session に対して何度も reconcile を撃たないよう Set で覚える。
  const reconciledRef = useRef<Set<string>>(new Set());

  // ---- ヘルパ ----
  function patchCase(
    sid: string,
    patch: Partial<CaseState> | ((cur: CaseState) => Partial<CaseState>),
  ): void {
    setCases((prev) => {
      const cur = prev[sid];
      if (!cur) return prev;
      const computed = typeof patch === "function" ? patch(cur) : patch;
      return { ...prev, [sid]: { ...cur, ...computed } };
    });
  }

  function updateCaseItems(
    sid: string,
    updater: (prev: ChatItem[]) => ChatItem[],
  ): void {
    setCases((prev) => {
      const cur = prev[sid];
      if (!cur) return prev;
      return { ...prev, [sid]: { ...cur, items: updater(cur.items) } };
    });
  }

  function pushLog(sid: string, entry: Omit<LogEntry, "id" | "ts">): void {
    logSeqRef.current += 1;
    const full: LogEntry = {
      ...entry,
      id: `log-${logSeqRef.current}`,
      ts: Date.now(),
    };
    setCases((prev) => {
      const cur = prev[sid];
      if (!cur) return prev;
      return {
        ...prev,
        [sid]: { ...cur, logEntries: [...cur.logEntries, full] },
      };
    });
  }

  function bumpPreview(sid: string): void {
    patchCase(sid, (cur) => ({ previewKey: cur.previewKey + 1 }));
  }

  // ---- 副作用: 各 case が初登場した瞬間に 1 回だけ reconcile を撃つ ----
  useEffect(() => {
    for (const sid of Object.keys(cases)) {
      if (reconciledRef.current.has(sid)) continue;
      reconciledRef.current.add(sid);
      (async () => {
        try {
          const resp = await fetch(
            `/api/sessions/reconcile?sessionId=${encodeURIComponent(sid)}`,
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
          if (!body.ok) return;
          updateCaseItems(sid, (prev) =>
            reconcileFromGitLog(prev, body.commits ?? []),
          );
        } catch {
          /* noop: localStorage の状態のまま */
        }
      })();
    }
    // close されたら ref からも掃除
    for (const sid of Array.from(reconciledRef.current)) {
      if (!cases[sid]) reconciledRef.current.delete(sid);
    }
  }, [cases]);

  // ---- 副作用: items / pendingSelectors の localStorage 永続化 ----
  useEffect(() => {
    for (const [sid, c] of Object.entries(cases)) {
      savePersistedWork(sid, {
        items: c.items,
        pendingSelectors: c.pendingSelectors,
      });
    }
  }, [cases]);

  // ---- 副作用: ハイライト中の item が applied 以外になったら自動解除 ----
  useEffect(() => {
    setCases((prev) => {
      let changed = false;
      const next: Record<string, CaseState> = {};
      for (const [sid, c] of Object.entries(prev)) {
        if (c.activeHighlightItemId) {
          const item = c.items.find(
            (it) => it.id === c.activeHighlightItemId,
          );
          if (!item || item.status !== "applied") {
            next[sid] = { ...c, activeHighlightItemId: null };
            changed = true;
            continue;
          }
        }
        next[sid] = c;
      }
      return changed ? next : prev;
    });
  }, [cases]);

  const activeCase = activeSessionId ? cases[activeSessionId] ?? null : null;

  // ---- アクティブタブ由来の derived ----
  const highlightSelectors = useMemo<readonly string[]>(() => {
    if (!activeCase || !activeCase.activeHighlightItemId)
      return EMPTY_STRING_ARRAY;
    const item = activeCase.items.find(
      (it) => it.id === activeCase.activeHighlightItemId,
    );
    if (!item || item.status !== "applied") return EMPTY_STRING_ARRAY;
    return item.selectors.map((s) => s.selector);
  }, [activeCase]);

  const caseCount = Object.keys(cases).length;
  const canOpenMore = caseCount < MAX_OPEN_CASES;

  // ---- ハンドラ群 ----

  function handleCaseLoaded(loaded: LoadedCase): void {
    setCaseLoaderOpen(false);
    if (cases[loaded.sessionId]) {
      // 同じ案件が既に開かれていたらそれをアクティブにするだけ。
      setActiveSessionId(loaded.sessionId);
      return;
    }
    if (!canOpenMore) return;
    const persisted =
      typeof window === "undefined"
        ? null
        : loadPersistedWork(loaded.sessionId);
    setCases((prev) => ({
      ...prev,
      [loaded.sessionId]: makeInitialCaseState(
        loaded,
        persisted,
        `案件 ${loaded.recordNumber} (${loaded.partnerName}) を開きました`,
      ),
    }));
    setActiveSessionId(loaded.sessionId);
  }

  function handleElementSelected(sel: PreviewSelectorPayload): void {
    if (!activeSessionId) return;
    patchCase(activeSessionId, (cur) => {
      if (cur.pendingSelectors.some((p) => p.selector === sel.selector))
        return {};
      return { pendingSelectors: [...cur.pendingSelectors, sel] };
    });
  }

  function handleRemovePendingSelector(index: number): void {
    if (!activeSessionId) return;
    patchCase(activeSessionId, (cur) => ({
      pendingSelectors: cur.pendingSelectors.filter((_, i) => i !== index),
    }));
  }

  async function handleSubmitInstruction(params: {
    comment: string;
    attachments: File[];
    isGlobal: boolean;
  }): Promise<void> {
    if (!activeSessionId) return;
    const sid = activeSessionId;
    const id = `ins-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const encoded = await Promise.all(
      params.attachments.map(async (f) => ({
        filename: f.name,
        mimeType: f.type || "application/octet-stream",
        sizeBytes: f.size,
        base64: await fileToBase64(f),
      })),
    );
    patchCase(sid, (cur) => ({
      items: [
        ...cur.items,
        {
          id,
          comment: params.comment,
          attachments: encoded,
          selectors: params.isGlobal ? [] : cur.pendingSelectors,
          isGlobal: params.isGlobal,
          status: "draft",
        },
      ],
      pendingSelectors: params.isGlobal ? cur.pendingSelectors : [],
    }));
  }

  function handleDeleteDraft(itemId: string): void {
    if (!activeSessionId) return;
    updateCaseItems(activeSessionId, (prev) =>
      prev.filter((it) => !(it.id === itemId && it.status === "draft")),
    );
  }

  function handleStreamEvent(sid: string, event: StreamEvent): void {
    if (event.kind === "phase") {
      const phaseLabel =
        event.phase === "prepare"
          ? `準備完了 (通常 ${event.regularCount} / 全体 ${event.globalCount})`
          : event.phase === "regular"
            ? `通常指示を並列実行 (${event.regularCount} 件)`
            : event.phase === "global"
              ? `全体指示を順次実行 (${event.globalCount} 件)`
              : "完了";
      pushLog(sid, { kind: "phase", phase: event.phase, headline: phaseLabel });
    } else if (event.kind === "instruction") {
      const statusLabel = {
        queued: "キュー追加",
        running: "実行開始",
        applied: "✓ 反映済み",
        failed: "× 失敗",
        reverted: "元に戻した",
        unclear: "判定不可",
      }[event.status];
      pushLog(sid, {
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
        updateCaseItems(sid, (prev) =>
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
      pushLog(sid, {
        kind: "toolCall",
        instructionId: event.instructionId,
        headline: `${event.name} ${event.argsSummary}`,
        detail: `#${event.iteration} ${event.success ? "ok" : "fail"}`,
        error: !event.success,
      });
    } else if (event.kind === "log") {
      pushLog(sid, {
        kind: "log",
        headline: event.message,
        error: event.level === "error",
      });
    } else if (event.kind === "result") {
      pushLog(sid, {
        kind: "result",
        headline: event.message,
        detail: `${event.durationSec.toFixed(1)}s / ${event.applications.length} 件`,
        error: !event.ok,
      });
    }
  }

  async function handleRun(): Promise<void> {
    if (!activeSessionId) return;
    const sid = activeSessionId;
    const cur = cases[sid];
    if (!cur || cur.running || cur.saving) return;
    const drafts = cur.items.filter((it) => it.status === "draft");
    if (drafts.length === 0) return;

    patchCase(sid, { running: true, lastResultMessage: null, logEntries: [] });
    updateCaseItems(sid, (prev) =>
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
          sessionId: cur.loaded.sessionId,
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
            handleStreamEvent(sid, event);
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
        updateCaseItems(sid, (prev) =>
          mergeFromServer(prev, finalResult!.applications!),
        );
      }
      patchCase(sid, {
        lastResultMessage:
          finalResult?.message ??
          (finalResult?.ok ? "修正が完了しました" : "修正に失敗しました"),
      });
      bumpPreview(sid);
    } catch (error) {
      patchCase(sid, {
        lastResultMessage:
          error instanceof Error ? error.message : "通信エラーが発生しました",
      });
      updateCaseItems(sid, (prev) =>
        prev.map((it) =>
          it.status === "submitted"
            ? { ...it, status: "failed" as const }
            : it,
        ),
      );
    } finally {
      patchCase(sid, { running: false });
    }
  }

  async function handleRevert(itemId: string): Promise<void> {
    if (!activeSessionId) return;
    const sid = activeSessionId;
    const cur = cases[sid];
    if (!cur || cur.revertingItemId) return;
    const target = cur.items.find((it) => it.id === itemId);
    if (!target?.commitSha) return;
    patchCase(sid, { revertingItemId: itemId });
    try {
      const resp = await fetch("/api/instructions/revert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: cur.loaded.sessionId,
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
        updateCaseItems(sid, (prev) =>
          prev.map((it) =>
            it.id === itemId ? { ...it, status: "reverted" as const } : it,
          ),
        );
        patchCase(sid, {
          lastResultMessage: data.message ?? "指示を元に戻しました",
        });
        bumpPreview(sid);
      } else {
        patchCase(sid, {
          lastResultMessage: data.message ?? "ロールバックに失敗しました",
        });
      }
    } catch (error) {
      patchCase(sid, {
        lastResultMessage:
          error instanceof Error ? error.message : "通信エラーが発生しました",
      });
    } finally {
      patchCase(sid, { revertingItemId: null });
    }
  }

  async function handleSave(): Promise<void> {
    if (!activeSessionId) return;
    const sid = activeSessionId;
    const cur = cases[sid];
    if (!cur || cur.saving || cur.running) return;
    patchCase(sid, {
      saving: true,
      lastResultMessage: "型チェック中... (最大 3 分)",
    });
    try {
      const resp = await fetch("/api/saves", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: cur.loaded.sessionId }),
      });
      const data = (await resp.json()) as {
        ok: boolean;
        message?: string;
        kind?: string;
        commitSha?: string;
        typeCheckOutput?: string;
        typeCheckDurationMs?: number;
      };
      if (!data.ok && data.kind === "typecheck" && data.typeCheckOutput) {
        const head = data.typeCheckOutput
          .split("\n")
          .filter((l) => l.trim().length > 0)
          .slice(0, 12)
          .join("\n");
        pushLog(sid, {
          kind: "log",
          headline: "型チェック失敗 — push を中止",
          detail: head,
          error: true,
        });
      }
      patchCase(sid, {
        lastResultMessage:
          data.message ?? (data.ok ? "保存しました" : "保存に失敗しました"),
      });
      if (data.ok) {
        setSaveSuccess({
          sessionId: sid,
          recordNumber: cur.loaded.recordNumber,
          partnerName: cur.loaded.partnerName,
          commitSha: data.commitSha,
          githubRepoUrl: cur.loaded.githubRepoUrl,
          deployUrl: cur.loaded.deployUrl,
          fromClose: false,
        });
      }
    } catch (error) {
      patchCase(sid, {
        lastResultMessage:
          error instanceof Error ? error.message : "通信エラーが発生しました",
      });
    } finally {
      patchCase(sid, { saving: false });
    }
  }

  async function handleSignOut(): Promise<void> {
    try {
      await fetch("/api/auth/signout", { method: "POST" });
    } finally {
      window.location.replace("/login");
    }
  }

  async function handleRestartDevServer(sid: string): Promise<void> {
    const cur = cases[sid];
    if (!cur || cur.restartingDevServer) return;
    patchCase(sid, {
      restartingDevServer: true,
      lastResultMessage: "開発サーバーを再起動中... (最大 3 分)",
    });
    try {
      const resp = await fetch("/api/sessions/restart-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: cur.loaded.sessionId }),
      });
      const data = (await resp.json()) as { ok: boolean; message?: string };
      if (data.ok) {
        bumpPreview(sid);
        patchCase(sid, {
          lastResultMessage: data.message ?? "開発サーバーを再起動しました。",
        });
      } else {
        patchCase(sid, {
          lastResultMessage:
            data.message ?? "開発サーバーの再起動に失敗しました。",
        });
      }
    } catch (error) {
      patchCase(sid, {
        lastResultMessage:
          error instanceof Error ? error.message : "通信エラーが発生しました",
      });
    } finally {
      patchCase(sid, { restartingDevServer: false });
    }
  }

  /**
   * 案件タブを閉じる。
   * - saveFirst=true: 型チェック → push → close
   * - saveFirst=false: 直接 close (Sandbox 破棄、変更喪失)
   *
   * close が成功したらタブを cases から外し、別タブにフォーカスを移す。
   */
  async function handleCloseCase(
    sid: string,
    saveFirst: boolean,
  ): Promise<void> {
    const cur = cases[sid];
    if (!cur || cur.closing) return;
    setCloseTargetSessionId(null);
    patchCase(sid, {
      closing: true,
      lastResultMessage: saveFirst
        ? "変更を保存してから閉じています..."
        : "案件を閉じています...",
    });
    try {
      let savedCommitSha: string | undefined;
      if (saveFirst) {
        patchCase(sid, { lastResultMessage: "型チェック中... (最大 3 分)" });
        const saveResp = await fetch("/api/saves", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: cur.loaded.sessionId }),
        });
        const saveData = (await saveResp.json()) as {
          ok: boolean;
          message?: string;
          kind?: string;
          commitSha?: string;
          typeCheckOutput?: string;
        };
        if (!saveData.ok) {
          if (saveData.kind === "typecheck" && saveData.typeCheckOutput) {
            const head = saveData.typeCheckOutput
              .split("\n")
              .filter((l) => l.trim().length > 0)
              .slice(0, 12)
              .join("\n");
            pushLog(sid, {
              kind: "log",
              headline: "型チェック失敗 — push を中止",
              detail: head,
              error: true,
            });
          }
          patchCase(sid, {
            closing: false,
            lastResultMessage:
              saveData.message ??
              "保存に失敗したため、案件は開いたままにしました。",
          });
          return;
        }
        savedCommitSha = saveData.commitSha;
      }
      const closeResp = await fetch("/api/sessions/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: cur.loaded.sessionId }),
      });
      const closeData = (await closeResp.json()) as {
        ok: boolean;
        message?: string;
      };
      if (!closeData.ok) {
        patchCase(sid, {
          closing: false,
          lastResultMessage:
            closeData.message ?? "案件のクローズに失敗しました。",
        });
        return;
      }
      // localStorage 掃除 + cases から削除 + 別タブへフォーカス
      if (typeof window !== "undefined") {
        try {
          window.localStorage.removeItem(workStorageKey(sid));
        } catch {
          /* ignore */
        }
      }
      reconciledRef.current.delete(sid);
      setCases((prev) => {
        const next = { ...prev };
        delete next[sid];
        return next;
      });
      setActiveSessionId((prevActive) => {
        if (prevActive !== sid) return prevActive;
        // 残った中で先頭をアクティブに
        const remaining = Object.keys(cases).filter((s) => s !== sid);
        return remaining[0] ?? null;
      });
      if (saveFirst) {
        // 案件を閉じた後でも保存先 (deploy URL / commit) を案内できるようモーダルを残す。
        setSaveSuccess({
          sessionId: sid,
          recordNumber: cur.loaded.recordNumber,
          partnerName: cur.loaded.partnerName,
          commitSha: savedCommitSha,
          githubRepoUrl: cur.loaded.githubRepoUrl,
          deployUrl: cur.loaded.deployUrl,
          fromClose: true,
        });
      }
    } catch (error) {
      patchCase(sid, {
        closing: false,
        lastResultMessage:
          error instanceof Error ? error.message : "通信エラーが発生しました",
      });
    }
  }

  const closeTargetCase = closeTargetSessionId
    ? cases[closeTargetSessionId] ?? null
    : null;
  const closeTargetHasApplied = closeTargetCase
    ? closeTargetCase.items.some((it) => it.status === "applied")
    : false;

  return (
    <div className="flex flex-col h-[100dvh] min-h-[640px] min-w-[900px] bg-[#141414]">
      <header className="px-4 h-12 border-b border-[#2d2d31] bg-[#1b1b1d] flex items-center gap-3 text-sm">
        <span className="font-semibold text-[#e8e8ea] whitespace-nowrap tracking-wider">
          AI-SITE-EDITOR
        </span>
        {activeCase?.lastResultMessage && (
          <>
            <div className="h-5 w-px bg-[#2d2d31]" />
            <span className="flex-1 text-xs text-[#a9a9b0] truncate italic">
              {activeCase.lastResultMessage}
            </span>
          </>
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

      {/* タブバー: 開いている案件を横一列、各タブに × と進捗ドット */}
      <div className="flex items-center px-2 h-9 border-b border-[#2d2d31] bg-[#0f0f11] gap-1 overflow-x-auto shrink-0">
        {Object.values(cases).map((c) => {
          const isActive = c.loaded.sessionId === activeSessionId;
          const busy =
            c.running || c.saving || c.restartingDevServer || c.closing;
          return (
            <button
              key={c.loaded.sessionId}
              type="button"
              onClick={() => setActiveSessionId(c.loaded.sessionId)}
              className={`group flex items-center gap-2 px-3 h-7 rounded-md text-xs whitespace-nowrap border ${
                isActive
                  ? "bg-[#1b1b1d] text-[#e8e8ea] border-[#3a3a3f]"
                  : "text-[#a9a9b0] hover:bg-[#1b1b1d] border-transparent"
              }`}
              title={`案件 ${c.loaded.recordNumber} | ${c.loaded.partnerName} | ${c.loaded.contractPlan}`}
            >
              <span className="font-medium">案件 {c.loaded.recordNumber}</span>
              <span className="text-[#70707a] truncate max-w-[15ch]">
                {c.loaded.partnerName}
              </span>
              {busy && (
                <span
                  className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse"
                  aria-label="処理中"
                />
              )}
              <span
                role="button"
                tabIndex={0}
                aria-label="案件を閉じる"
                onClick={(e) => {
                  e.stopPropagation();
                  setCloseTargetSessionId(c.loaded.sessionId);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.stopPropagation();
                    setCloseTargetSessionId(c.loaded.sessionId);
                  }
                }}
                className="ml-1 -mr-1 px-1 text-[#55555c] hover:text-red-300"
              >
                ×
              </span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setCaseLoaderOpen(true)}
          disabled={!canOpenMore}
          title={
            canOpenMore
              ? "新しい案件を開く"
              : `同時に開ける案件は最大 ${MAX_OPEN_CASES} 件です`
          }
          className="px-2 h-7 text-xs text-[#a9a9b0] hover:text-[#e8e8ea] disabled:opacity-40 disabled:hover:text-[#a9a9b0] whitespace-nowrap"
        >
          + 新規案件
        </button>
        <span className="ml-2 text-[10px] text-[#55555c] tabular-nums whitespace-nowrap">
          {caseCount} / {MAX_OPEN_CASES}
        </span>
      </div>

      {caseLoaderOpen && (
        <CaseLoaderModal
          onLoaded={handleCaseLoaded}
          onCancel={() => setCaseLoaderOpen(false)}
        />
      )}

      {closeTargetSessionId && closeTargetCase && (
        <CloseCaseModal
          hasAppliedItems={closeTargetHasApplied}
          recordNumber={closeTargetCase.loaded.recordNumber}
          partnerName={closeTargetCase.loaded.partnerName}
          onCancel={() => setCloseTargetSessionId(null)}
          onDiscardAndClose={() =>
            handleCloseCase(closeTargetSessionId, false)
          }
          onSaveAndClose={() => handleCloseCase(closeTargetSessionId, true)}
        />
      )}

      {saveSuccess && (
        <SaveSuccessModal
          info={saveSuccess}
          onClose={() => setSaveSuccess(null)}
        />
      )}

      <div className="flex flex-1 min-h-0">
        {activeCase ? (
          <>
            <div className="flex flex-col flex-1 min-w-0 min-h-0">
              <PreviewPane
                previewUrl={activeCase.loaded.previewUrl}
                onElementSelected={handleElementSelected}
                reloadKey={activeCase.previewKey}
                selectMode={activeCase.selectMode}
                onSelectModeReset={() =>
                  patchCase(activeCase.loaded.sessionId, { selectMode: false })
                }
                onRestartDevServer={() =>
                  handleRestartDevServer(activeCase.loaded.sessionId)
                }
                restartingDevServer={activeCase.restartingDevServer}
                highlightSelectors={highlightSelectors}
              />
              <LogDrawer
                entries={activeCase.logEntries}
                running={activeCase.running}
                onClear={() =>
                  patchCase(activeCase.loaded.sessionId, { logEntries: [] })
                }
              />
            </div>
            <ChatPane
              items={activeCase.items}
              pendingSelectors={activeCase.pendingSelectors}
              onRemovePendingSelector={handleRemovePendingSelector}
              onSubmit={handleSubmitInstruction}
              onRun={handleRun}
              onRevert={handleRevert}
              onDeleteDraft={handleDeleteDraft}
              onSave={handleSave}
              running={activeCase.running}
              saving={activeCase.saving}
              revertingItemId={activeCase.revertingItemId}
              selectMode={activeCase.selectMode}
              onToggleSelectMode={() =>
                patchCase(activeCase.loaded.sessionId, (c) => ({
                  selectMode: !c.selectMode,
                }))
              }
              selectModeAvailable={!!activeCase.loaded.previewUrl}
              activeHighlightItemId={activeCase.activeHighlightItemId}
              onToggleHighlight={(id) =>
                patchCase(activeCase.loaded.sessionId, (c) => ({
                  activeHighlightItemId:
                    c.activeHighlightItemId === id ? null : id,
                }))
              }
            />
          </>
        ) : (
          <EmptyState
            canOpenMore={canOpenMore}
            onOpenLoader={() => setCaseLoaderOpen(true)}
          />
        )}
      </div>
    </div>
  );
}

function EmptyState({
  canOpenMore,
  onOpenLoader,
}: {
  canOpenMore: boolean;
  onOpenLoader: () => void;
}) {
  return (
    <div className="flex-1 flex items-center justify-center bg-[#141414]">
      <div className="text-center">
        <p className="text-sm text-[#a9a9b0]">案件が開かれていません</p>
        <button
          type="button"
          onClick={onOpenLoader}
          disabled={!canOpenMore}
          className="mt-3 inline-flex items-center justify-center h-9 px-4 rounded-md bg-amber-500/90 text-[#0b0b0d] text-sm font-semibold hover:bg-amber-400 disabled:opacity-40 transition"
        >
          + 新規案件を開く
        </button>
      </div>
    </div>
  );
}

function CaseLoaderModal(props: {
  onLoaded: (loaded: LoadedCase) => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={props.onCancel}
      role="presentation"
    >
      <div
        className="w-[560px] max-w-[92vw] rounded-lg border border-[#3a3a3f] bg-[#1f1f22] p-5 shadow-[0_20px_50px_-10px_rgba(0,0,0,0.7)]"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-[#f0f0f2] tracking-wide mb-3">
          新しい案件を開く
        </h2>
        <p className="text-xs text-[#a9a9b0] mb-3 leading-relaxed">
          スプレッドシートに登録されているレコード番号を入力してください。
          クリック後に Sandbox の起動 (clone → npm install → dev server) が走ります。
        </p>
        <CaseLoader onLoaded={props.onLoaded} />
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={props.onCancel}
            className="px-3 py-1.5 rounded-md border border-[#3a3a3f] bg-[#1b1b1d] text-xs text-[#a9a9b0] hover:border-[#55555c] hover:text-[#e8e8ea] transition"
          >
            キャンセル
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * GitHub HTTPS URL から `.git` を剥がす。
 * 例: `https://github.com/foo/bar.git` → `https://github.com/foo/bar`
 */
function repoUrlBase(url: string): string {
  return url.replace(/\.git$/i, "");
}

function SaveSuccessModal({
  info,
  onClose,
}: {
  info: {
    recordNumber: string;
    partnerName: string;
    commitSha?: string;
    githubRepoUrl: string;
    deployUrl?: string;
    fromClose: boolean;
  };
  onClose: () => void;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const commitUrl = info.commitSha
    ? `${repoUrlBase(info.githubRepoUrl)}/commit/${info.commitSha}`
    : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-[520px] max-w-[92vw] rounded-lg border border-teal-500/40 bg-[#1f1f22] p-5 shadow-[0_20px_50px_-10px_rgba(0,0,0,0.7)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <span
            className="mt-0.5 inline-flex h-7 w-7 items-center justify-center rounded-full bg-teal-500/15 text-teal-300 text-base"
            aria-hidden
          >
            ✓
          </span>
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold text-[#f0f0f2] tracking-wide">
              {info.fromClose
                ? "保存して案件を閉じました"
                : "GitHub に保存しました"}
            </h2>
            <p className="mt-1 text-xs text-[#a9a9b0] truncate">
              案件 {info.recordNumber} ({info.partnerName})
            </p>
          </div>
        </div>

        <div className="mt-4 space-y-3 text-sm">
          {info.deployUrl ? (
            <div>
              <p className="text-[10px] font-medium uppercase tracking-wider text-[#70707a] mb-1">
                Vercel 本番サイト
              </p>
              <a
                href={info.deployUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-amber-300 hover:text-amber-200 underline decoration-amber-500/40 hover:decoration-amber-300 break-all"
              >
                {info.deployUrl}
                <span aria-hidden className="text-[10px]">↗</span>
              </a>
              <p className="mt-1 text-[11px] text-[#70707a]">
                デプロイ完了まで通常 1〜3 分かかります。反映が確認できるまで
                少し時間を置いてアクセスしてください。
              </p>
            </div>
          ) : (
            <p className="text-[11px] text-[#a9a9b0] leading-relaxed">
              本番デプロイ URL がスプレッドシートに登録されていません。
              GitHub の commit から Vercel
              ダッシュボード経由でデプロイ状況を確認してください。
            </p>
          )}

          {commitUrl && info.commitSha && (
            <div>
              <p className="text-[10px] font-medium uppercase tracking-wider text-[#70707a] mb-1">
                GitHub コミット
              </p>
              <a
                href={commitUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-[#d0d0d4] hover:text-[#f0f0f2] underline decoration-[#3a3a3f] hover:decoration-[#a9a9b0] font-mono text-[12px]"
                title={info.commitSha}
              >
                {info.commitSha.slice(0, 7)}
                <span aria-hidden className="text-[10px]">↗</span>
              </a>
            </div>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          {info.deployUrl && (
            <a
              href={info.deployUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center px-3 py-2 rounded-md bg-amber-500/90 text-[#0b0b0d] text-sm font-semibold hover:bg-amber-400 transition"
            >
              本番サイトを開く
            </a>
          )}
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-2 rounded-md border border-[#3a3a3f] bg-[#1b1b1d] text-sm text-[#a9a9b0] hover:border-[#55555c] hover:text-[#e8e8ea] transition"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}

function CloseCaseModal(props: {
  hasAppliedItems: boolean;
  recordNumber: string;
  partnerName: string;
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
          案件 {props.recordNumber} ({props.partnerName}) を閉じますか？
        </h2>
        <p className="mt-2 text-sm text-[#a9a9b0] leading-relaxed">
          {props.hasAppliedItems
            ? "この案件には AI が適用した未保存の変更があります。保存せずに閉じると Sandbox ごと破棄され、変更は失われます。閉じると DB 上のこの案件の記録も削除されます (GitHub に保存済みのコミットは残ります)。"
            : "案件を閉じると Sandbox が停止し、DB 上のこの案件の記録も削除されます。他のディレクターが同じ案件を開けるようになります。"}
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
