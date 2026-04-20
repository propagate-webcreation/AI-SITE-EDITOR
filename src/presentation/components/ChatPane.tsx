"use client";

import { useRef, useState, type FormEvent } from "react";

export interface ChatAttachment {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** base64 エンコード済みファイル本体 (data: URL prefix 無し) */
  base64: string;
}

export interface ChatSelector {
  tag: string;
  selector: string;
  text: string;
  html: string;
}

export type ChatItemStatus =
  | "draft"
  | "submitted"
  | "applied"
  | "failed"
  | "reverted";

export interface ChatItem {
  id: string;
  comment: string;
  attachments: readonly ChatAttachment[];
  selectors: readonly ChatSelector[];
  status: ChatItemStatus;
  applicationId?: string;
  summary?: string;
  commitSha?: string;
  errorMessage?: string;
}

interface ChatPaneProps {
  items: readonly ChatItem[];
  pendingSelectors: readonly ChatSelector[];
  onRemovePendingSelector: (index: number) => void;
  onSubmit: (params: {
    comment: string;
    attachments: File[];
  }) => void | Promise<void>;
  onRun: () => void;
  onRevert: (itemId: string) => void;
  onSave: () => void;
  running: boolean;
  saving: boolean;
  revertingItemId: string | null;
  hasAppliedItems: boolean;
}

export function ChatPane({
  items,
  pendingSelectors,
  onRemovePendingSelector,
  onSubmit,
  onRun,
  onRevert,
  onSave,
  running,
  saving,
  revertingItemId,
  hasAppliedItems,
}: ChatPaneProps) {
  const [comment, setComment] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmed = comment.trim();
    if (!trimmed) return;
    onSubmit({ comment: trimmed, attachments: files });
    setComment("");
    setFiles([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  const draftCount = items.filter((it) => it.status === "draft").length;

  return (
    <section className="w-[480px] flex flex-col min-h-0 bg-neutral-950">
      <header className="px-4 h-10 border-b border-neutral-800 text-sm flex items-center justify-between gap-2">
        <span className="font-medium whitespace-nowrap">修正指示</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onRun}
            disabled={running || saving || draftCount === 0}
            className="px-3 py-1 rounded bg-emerald-500 text-white text-xs font-semibold disabled:bg-neutral-700 disabled:text-neutral-400 hover:bg-emerald-400 transition whitespace-nowrap"
          >
            {running
              ? "修正中..."
              : `AI に修正させる${draftCount > 0 ? ` (${draftCount})` : ""}`}
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={saving || running || !hasAppliedItems}
            className="px-3 py-1 rounded bg-sky-500 text-white text-xs font-semibold disabled:bg-neutral-700 disabled:text-neutral-400 hover:bg-sky-400 transition whitespace-nowrap"
            title="Sandbox の修正を GitHub に push して本番デプロイを走らせます"
          >
            {saving ? "保存中..." : "変更を保存する"}
          </button>
        </div>
      </header>
      <ul className="flex-1 basis-0 min-h-0 overflow-y-auto divide-y divide-neutral-800">
        {items.length === 0 && (
          <li className="p-6 text-sm text-neutral-500 text-center">
            プレビュー上部の「🏷️ 要素を選択」で対象を指定し、下のフォームで指示を追加してください
          </li>
        )}
        {items.map((item, index) => (
          <li key={item.id} className="p-4 space-y-2">
            <div className="flex items-center gap-2 text-xs">
              <span className="text-neutral-500">#{index + 1}</span>
              <StatusBadge status={item.status} />
              {item.commitSha && (
                <span className="text-[10px] text-neutral-500 font-mono">
                  {item.commitSha.slice(0, 7)}
                </span>
              )}
              <div className="ml-auto">
                {item.status === "applied" && item.applicationId && (
                  <button
                    type="button"
                    onClick={() => onRevert(item.id)}
                    disabled={revertingItemId === item.id || saving}
                    className="px-2 py-0.5 rounded border border-neutral-700 text-[10px] text-neutral-300 hover:border-red-500 hover:text-red-300 disabled:opacity-50"
                  >
                    {revertingItemId === item.id ? "戻し中..." : "元に戻す"}
                  </button>
                )}
              </div>
            </div>
            <p className="text-sm text-neutral-200 whitespace-pre-wrap">
              {item.comment}
            </p>
            {item.summary && (
              <p className="text-xs text-neutral-400 whitespace-pre-wrap bg-neutral-900 border border-neutral-800 rounded p-2">
                {item.summary}
              </p>
            )}
            {item.errorMessage && item.status === "failed" && (
              <p className="text-xs text-red-400 whitespace-pre-wrap">
                {item.errorMessage}
              </p>
            )}
            {item.selectors.length > 0 && (
              <div className="flex flex-wrap gap-1 text-[10px] text-sky-300">
                {item.selectors.map((s, i) => (
                  <span
                    key={`${s.selector}-${i}`}
                    className="px-2 py-0.5 rounded bg-sky-950 border border-sky-800 font-mono truncate max-w-full"
                    title={`${s.selector}\n${s.text}`}
                  >
                    🏷️ &lt;{s.tag}&gt;{" "}
                    {s.text
                      ? `"${s.text.slice(0, 30)}"`
                      : s.selector.slice(0, 40)}
                  </span>
                ))}
              </div>
            )}
            {item.attachments.length > 0 && (
              <div className="flex flex-wrap gap-2 text-xs text-neutral-400">
                {item.attachments.map((a) => (
                  <span
                    key={a.filename}
                    className="px-2 py-0.5 rounded bg-neutral-800 border border-neutral-700"
                  >
                    📎 {a.filename}
                  </span>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
      <form
        onSubmit={handleSubmit}
        className="flex-1 basis-0 min-h-0 flex flex-col gap-2 border-t border-neutral-800 p-3 bg-neutral-900"
      >
        <div className="text-xs text-neutral-500">
          {pendingSelectors.length > 0
            ? `🏷️ ${pendingSelectors.length} 個のタグに紐付けて投稿されます`
            : "プレビュー上部の「🏷️ 要素を選択」で対象を指定できます"}
        </div>
        {pendingSelectors.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {pendingSelectors.map((s, i) => (
              <span
                key={`${s.selector}-${i}`}
                className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-sky-950 border border-sky-800 font-mono text-sky-200 max-w-full"
                title={`${s.selector}\n${s.text}`}
              >
                🏷️ &lt;{s.tag}&gt;
                <span className="truncate max-w-[180px]">
                  {s.text
                    ? `"${s.text.slice(0, 28)}"`
                    : s.selector.slice(0, 40)}
                </span>
                <button
                  type="button"
                  onClick={() => onRemovePendingSelector(i)}
                  className="ml-1 text-sky-400 hover:text-red-400"
                  aria-label="タグを外す"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="修正内容を日本語で..."
          className="w-full flex-1 min-h-0 rounded bg-neutral-950 border border-neutral-700 p-3 text-sm text-neutral-100 focus:outline-none focus:border-emerald-500 resize-none"
        />
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-xs text-neutral-400">
            <label className="cursor-pointer hover:text-emerald-400">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*"
                className="hidden"
                onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
              />
              📎 添付
            </label>
            {files.length > 0 && <span>{files.length} 件</span>}
          </div>
          <button
            type="submit"
            disabled={!comment.trim()}
            className="px-3 py-1 rounded bg-emerald-500 text-white text-xs font-semibold disabled:bg-neutral-700 disabled:text-neutral-400"
          >
            追加
          </button>
        </div>
      </form>
    </section>
  );
}

function StatusBadge({ status }: { status: ChatItemStatus }) {
  const map: Record<ChatItemStatus, { text: string; className: string }> = {
    draft: { text: "下書き", className: "bg-neutral-700 text-neutral-300" },
    submitted: { text: "AI 処理中", className: "bg-sky-700 text-sky-100" },
    applied: { text: "反映済み", className: "bg-emerald-700 text-emerald-100" },
    failed: { text: "失敗", className: "bg-red-700 text-red-100" },
    reverted: { text: "元に戻した", className: "bg-orange-700 text-orange-100" },
  };
  const v = map[status];
  return (
    <span className={`px-2 py-0.5 rounded text-[10px] ${v.className}`}>
      {v.text}
    </span>
  );
}
