"use client";

import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
} from "react";

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
  | "reverted"
  | "unclear";

export interface ChatItem {
  id: string;
  comment: string;
  attachments: readonly ChatAttachment[];
  selectors: readonly ChatSelector[];
  isGlobal: boolean;
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
    isGlobal: boolean;
  }) => void | Promise<void>;
  onRun: () => void;
  onRevert: (itemId: string) => void;
  onDeleteDraft: (itemId: string) => void;
  onSave: () => void;
  running: boolean;
  saving: boolean;
  revertingItemId: string | null;
  hasAppliedItems: boolean;
  selectMode: boolean;
  onToggleSelectMode: () => void;
  selectModeAvailable: boolean;
}

export function ChatPane({
  items,
  pendingSelectors,
  onRemovePendingSelector,
  onSubmit,
  onRun,
  onRevert,
  onDeleteDraft,
  onSave,
  running,
  saving,
  revertingItemId,
  hasAppliedItems,
  selectMode,
  onToggleSelectMode,
  selectModeAvailable,
}: ChatPaneProps) {
  const [comment, setComment] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [isGlobal, setIsGlobal] = useState(false);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const dragDepthRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const urls = files.map((f) => URL.createObjectURL(f));
    setPreviewUrls(urls);
    return () => {
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [files]);

  function addFiles(incoming: File[]): void {
    const images = incoming.filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    setFiles((prev) => [...prev, ...images]);
  }

  function handleRemoveFile(index: number): void {
    setFiles((prev) => prev.filter((_, i) => i !== index));
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function handleDragEnter(e: DragEvent<HTMLElement>): void {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    dragDepthRef.current += 1;
    setIsDragging(true);
  }
  function handleDragLeave(): void {
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragging(false);
  }
  function handleDragOver(e: DragEvent<HTMLElement>): void {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }
  function handleDrop(e: DragEvent<HTMLElement>): void {
    e.preventDefault();
    dragDepthRef.current = 0;
    setIsDragging(false);
    const dropped = Array.from(e.dataTransfer.files);
    addFiles(dropped);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmed = comment.trim();
    if (!trimmed) return;
    onSubmit({ comment: trimmed, attachments: files, isGlobal });
    setComment("");
    setFiles([]);
    setIsGlobal(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  const draftCount = items.filter((it) => it.status === "draft").length;

  return (
    <section className="w-[480px] flex flex-col min-h-0 bg-[#1b1b1d] border-l border-[#2d2d31]">
      <header className="px-4 h-10 border-b border-[#2d2d31] bg-[#1b1b1d] text-sm flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-[#d0d0d4] whitespace-nowrap">
          修正指示
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onRun}
            disabled={running || saving || draftCount === 0}
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-md bg-amber-500/90 text-[#0b0b0d] text-xs font-semibold hover:bg-amber-400 disabled:bg-[#2b2b30] disabled:text-[#55555c] transition whitespace-nowrap"
          >
            {running ? (
              <>修正中...</>
            ) : (
              <>
                AI に修正させる
                {draftCount > 0 && (
                  <span className="ml-0.5 px-1 rounded bg-[#0b0b0d]/25 text-[10px] tabular-nums">
                    {draftCount}
                  </span>
                )}
              </>
            )}
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={saving || running || !hasAppliedItems}
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-md border border-teal-500/60 bg-teal-500/5 text-teal-200 text-xs font-semibold hover:bg-teal-500/15 hover:text-teal-100 disabled:border-[#3a3a3f] disabled:bg-[#1b1b1d] disabled:text-[#55555c] transition whitespace-nowrap"
            title="Sandbox の修正を GitHub に push して本番デプロイを走らせます"
          >
            {saving ? "保存中..." : "変更を保存"}
          </button>
        </div>
      </header>
      <ul className="flex-1 basis-0 min-h-0 overflow-y-auto divide-y divide-[#2d2d31] bg-[#17171a]">
        {items.length === 0 && (
          <li className="p-8 text-xs text-[#70707a] text-center leading-relaxed">
            <div className="mx-auto mb-3 h-10 w-10 rounded-md border border-[#2d2d31] flex items-center justify-center font-mono text-[#3a3a3f] text-sm">
              &lt;/&gt;
            </div>
            プレビュー上部の「
            <span className="font-mono text-amber-400">&lt;/&gt;</span>{" "}
            要素を選択」で対象を指定し、
            <br />
            下のフォームで指示を追加してください
          </li>
        )}
        {items.map((item, index) => (
          <li
            key={item.id}
            className="p-4 space-y-2 hover:bg-[#1b1b1e] transition-colors"
          >
            <div className="flex items-center gap-2 text-xs">
              <span className="text-[#55555c] font-mono text-[10px] tabular-nums">
                #{String(index + 1).padStart(2, "0")}
              </span>
              <StatusBadge status={item.status} />
              {item.isGlobal && (
                <span
                  className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-violet-500/10 text-violet-200 border border-violet-500/40"
                  title="全体指示。他の指示完了後に単独実行されます"
                >
                  全体
                </span>
              )}
              {item.commitSha && (
                <span className="text-[10px] text-[#70707a] font-mono px-1.5 py-0.5 rounded bg-[#0f0f11] border border-[#2d2d31]">
                  {item.commitSha.slice(0, 7)}
                </span>
              )}
              <div className="ml-auto">
                {item.status === "applied" && item.commitSha && (
                  <button
                    type="button"
                    onClick={() => onRevert(item.id)}
                    disabled={revertingItemId === item.id || saving}
                    className="px-2 py-0.5 rounded border border-[#3a3a3f] bg-[#1b1b1d] text-[10px] text-[#a9a9b0] hover:border-red-500/70 hover:text-red-300 hover:bg-red-500/10 transition disabled:opacity-40"
                  >
                    {revertingItemId === item.id ? "戻し中..." : "元に戻す"}
                  </button>
                )}
                {item.status === "draft" && (
                  <button
                    type="button"
                    onClick={() => onDeleteDraft(item.id)}
                    disabled={running || saving}
                    title="この下書きを削除"
                    aria-label="下書きを削除"
                    className="px-1.5 py-0.5 rounded border border-[#3a3a3f] bg-[#1b1b1d] text-[11px] text-[#a9a9b0] hover:border-red-500/70 hover:text-red-300 hover:bg-red-500/10 transition disabled:opacity-40"
                  >
                    ×
                  </button>
                )}
              </div>
            </div>
            <p className="text-sm text-[#e0e0e4] whitespace-pre-wrap leading-relaxed">
              {item.comment}
            </p>
            {item.summary && (
              <p className="text-xs text-[#a9a9b0] whitespace-pre-wrap bg-[#0f0f11] border border-[#2d2d31] rounded-md p-2.5 leading-relaxed">
                {item.summary}
              </p>
            )}
            {item.errorMessage && item.status === "failed" && (
              <p className="text-xs text-red-300 whitespace-pre-wrap bg-red-500/5 border border-red-500/30 rounded-md p-2.5">
                {item.errorMessage}
              </p>
            )}
            {item.errorMessage && item.status === "unclear" && (
              <p className="text-xs text-yellow-200 whitespace-pre-wrap bg-yellow-500/5 border border-yellow-500/30 rounded-md p-2.5">
                {item.errorMessage}
              </p>
            )}
            {item.selectors.length > 0 && (
              <div className="flex flex-wrap gap-1 text-[10px]">
                {item.selectors.map((s, i) => (
                  <span
                    key={`${s.selector}-${i}`}
                    className="px-2 py-0.5 rounded bg-amber-500/5 border border-amber-500/30 font-mono text-amber-200/90 truncate max-w-full"
                    title={`${s.selector}\n${s.text}`}
                  >
                    <span className="text-amber-400">&lt;/&gt;</span> &lt;{s.tag}&gt;{" "}
                    {s.text
                      ? `"${s.text.slice(0, 30)}"`
                      : s.selector.slice(0, 40)}
                  </span>
                ))}
              </div>
            )}
            {item.attachments.length > 0 && (
              <div className="flex flex-wrap gap-2 text-xs text-[#a9a9b0]">
                {item.attachments.map((a) => (
                  <span
                    key={a.filename}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#1b1b1d] border border-[#3a3a3f] text-[10px]"
                  >
                    <span className="text-[#70707a]">📎</span> {a.filename}
                  </span>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
      <form
        onSubmit={handleSubmit}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        className={`relative flex-1 basis-0 min-h-0 flex flex-col gap-2 border-t p-3 bg-[#17171a] transition-colors ${
          isDragging
            ? "border-amber-500/70"
            : "border-[#2d2d31]"
        }`}
      >
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onToggleSelectMode}
            disabled={!selectModeAvailable}
            className={`flex-1 inline-flex items-center justify-center gap-1 h-[30px] rounded-md border text-[11px] transition disabled:opacity-40 disabled:cursor-not-allowed ${
              selectMode
                ? "bg-amber-500/90 text-[#0b0b0d] border-amber-500"
                : "border-[#3a3a3f] bg-[#1b1b1d] text-[#d0d0d4] hover:border-amber-500/60 hover:text-amber-200 hover:bg-amber-500/5"
            }`}
            title="プレビュー内の HTML 要素をクリックで選択し、指示にタグとして添付します"
          >
            <span
              className={`font-mono leading-none ${
                selectMode ? "text-[#0b0b0d]" : "text-amber-400"
              }`}
            >
              &lt;/&gt;
            </span>
            <span>要素</span>
          </button>
          <label className="flex-1 cursor-pointer inline-flex items-center justify-center gap-1 h-[30px] rounded-md border border-[#3a3a3f] bg-[#1b1b1d] text-[11px] text-[#a9a9b0] hover:border-amber-500/60 hover:text-amber-300 transition">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                addFiles(Array.from(e.target.files ?? []));
                if (fileInputRef.current) fileInputRef.current.value = "";
              }}
            />
            <span>画像添付</span>
            {files.length > 0 && (
              <span className="text-amber-300 font-mono tabular-nums">
                {files.length}
              </span>
            )}
          </label>
          <label
            className={`flex-1 cursor-pointer inline-flex items-center justify-center gap-1.5 h-[30px] rounded-md border text-[11px] transition ${
              isGlobal
                ? "border-violet-500/70 bg-violet-500/10 text-violet-200"
                : "border-[#3a3a3f] bg-[#1b1b1d] text-[#a9a9b0] hover:border-violet-500/60 hover:text-violet-300"
            }`}
            title="チェックすると、他の指示がすべて完了した後にこの指示だけ単独で実行されます。サイト全体のトーン変更などに。"
          >
            <input
              type="checkbox"
              checked={isGlobal}
              onChange={(e) => setIsGlobal(e.target.checked)}
              className="chk"
            />
            全体指示
          </label>
          <button
            type="submit"
            disabled={!comment.trim()}
            className="flex-1 inline-flex items-center justify-center h-[30px] rounded-md border border-amber-500/60 bg-amber-500/10 text-[11px] font-semibold text-amber-200 hover:bg-amber-500/20 hover:text-amber-100 disabled:opacity-40 disabled:hover:bg-amber-500/10 disabled:hover:text-amber-200 transition"
          >
            + 追加
          </button>
        </div>
        {pendingSelectors.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {pendingSelectors.map((s, i) => (
              <span
                key={`${s.selector}-${i}`}
                className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/40 font-mono text-amber-200 max-w-full"
                title={`${s.selector}\n${s.text}`}
              >
                <span className="text-amber-400">&lt;/&gt;</span> &lt;{s.tag}&gt;
                <span className="truncate max-w-[180px]">
                  {s.text
                    ? `"${s.text.slice(0, 28)}"`
                    : s.selector.slice(0, 40)}
                </span>
                <button
                  type="button"
                  onClick={() => onRemovePendingSelector(i)}
                  className="ml-1 text-amber-400/70 hover:text-red-400 transition"
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
          className="w-full flex-1 min-h-0 rounded-md bg-[#0f0f11] border border-[#2d2d31] p-3 text-sm text-[#e8e8ea] placeholder:text-[#55555c] focus:outline-none focus:border-amber-500/50 transition resize-none"
        />
        {files.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {files.map((f, i) => (
              <div
                key={`${f.name}-${i}`}
                className="relative h-14 w-14 rounded-md overflow-hidden border border-[#3a3a3f] bg-[#0f0f11] group"
                title={`${f.name} (${formatBytes(f.size)})`}
              >
                {previewUrls[i] ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={previewUrls[i]}
                    alt={f.name}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="h-full w-full flex items-center justify-center text-[10px] text-[#70707a] px-1 text-center">
                    {f.name.slice(0, 12)}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => handleRemoveFile(i)}
                  aria-label="添付を削除"
                  className="absolute top-0.5 right-0.5 h-4 w-4 rounded-full bg-black/70 hover:bg-red-500/90 text-white text-[10px] leading-none flex items-center justify-center opacity-0 group-hover:opacity-100 focus:opacity-100 transition"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {isDragging && (
          <div className="pointer-events-none absolute inset-0 rounded-md border-2 border-dashed border-amber-500/70 bg-amber-500/5 flex items-center justify-center text-amber-300 text-sm font-medium">
            画像をドロップして添付
          </div>
        )}
      </form>
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function StatusBadge({ status }: { status: ChatItemStatus }) {
  const map: Record<ChatItemStatus, { text: string; className: string }> = {
    draft: {
      text: "下書き",
      className:
        "bg-[#1b1b1d] text-[#a9a9b0] border border-[#3a3a3f]",
    },
    submitted: {
      text: "AI 処理中",
      className:
        "bg-amber-500/10 text-amber-300 border border-amber-500/40",
    },
    applied: {
      text: "反映済み",
      className:
        "bg-teal-500/10 text-teal-300 border border-teal-500/40",
    },
    failed: {
      text: "失敗",
      className:
        "bg-red-500/10 text-red-300 border border-red-500/40",
    },
    reverted: {
      text: "元に戻した",
      className:
        "bg-[#2b2b30] text-[#d0d0d4] border border-[#3a3a3f]",
    },
    unclear: {
      text: "判定不可",
      className:
        "bg-yellow-500/10 text-yellow-200 border border-yellow-500/40",
    },
  };
  const v = map[status] ?? {
    text: status,
    className: "bg-[#1b1b1d] text-[#a9a9b0] border border-[#3a3a3f]",
  };
  return (
    <span
      className={`px-1.5 py-0.5 rounded text-[10px] font-medium tracking-wide ${v.className}`}
    >
      {v.text}
    </span>
  );
}
