"use client";

import { useEffect, useRef, useState } from "react";

export type LogEntryKind =
  | "phase"
  | "instruction"
  | "toolCall"
  | "log"
  | "result";

export interface LogEntry {
  id: string;
  ts: number;
  kind: LogEntryKind;
  /** 指示 id に紐付く場合のみ */
  instructionId?: string;
  /** 一覧表示用の短い 1 行テキスト */
  headline: string;
  /** 追加情報 (tool の引数など) */
  detail?: string;
  /** true なら失敗系 */
  error?: boolean;
  /** phase 種別 (prepare/regular/global/complete) */
  phase?: "prepare" | "regular" | "global" | "complete";
}

interface LogDrawerProps {
  entries: readonly LogEntry[];
  running: boolean;
  onClear: () => void;
}

export function LogDrawer({ entries, running, onClear }: LogDrawerProps) {
  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // 開いている間だけ末尾追従スクロール。
  // 自動 pull-up はしない (ユーザーが明示的にトグルバーを開くまで閉じたまま)。
  useEffect(() => {
    if (!open) return;
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [entries, open]);

  const lastEntry = entries[entries.length - 1];
  const toolCallCount = entries.filter((e) => e.kind === "toolCall").length;

  return (
    <div className="flex flex-col bg-[#17171a] border-t border-[#2d2d31] shrink-0">
      {/* pull-up: ログリストが上に伸び、トグルバーは下に固定 */}
      {open && (
        <div
          ref={listRef}
          className="max-h-[50vh] overflow-y-auto font-mono text-[11px] bg-[#121214] border-b border-[#2d2d31]"
        >
          {entries.length === 0 ? (
            <div className="p-6 text-center text-[#55555c]">
              実行時に tool call / ステータスがここに流れます
            </div>
          ) : (
            <ul className="divide-y divide-[#1f1f23]">
              {entries.map((entry) => (
                <li
                  key={entry.id}
                  className="px-4 py-1.5 flex items-start gap-3 hover:bg-[#17171a]"
                >
                  <span className="text-[10px] text-[#55555c] tabular-nums shrink-0 w-[56px]">
                    {formatTs(entry.ts)}
                  </span>
                  <span
                    className={`shrink-0 w-[72px] uppercase text-[9px] tracking-wider ${
                      entry.error
                        ? "text-red-300"
                        : entry.kind === "toolCall"
                          ? "text-teal-300"
                          : entry.kind === "phase"
                            ? "text-violet-300"
                            : entry.kind === "instruction"
                              ? "text-amber-300"
                              : "text-[#a9a9b0]"
                    }`}
                  >
                    {labelFor(entry)}
                  </span>
                  <span
                    className={`flex-1 break-all ${entry.error ? "text-red-300" : "text-[#d0d0d4]"}`}
                  >
                    {entry.headline}
                    {entry.detail && (
                      <span className="text-[#70707a]"> — {entry.detail}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-4 h-8 flex items-center gap-3 text-xs hover:bg-[#1b1b1d] transition text-left"
      >
        <span
          className={`font-mono text-[11px] transition-transform ${open ? "" : "rotate-180"}`}
          aria-hidden
        >
          ▾
        </span>
        <span className="font-medium text-[#d0d0d4]">ログ</span>
        <span className="text-[#70707a] tabular-nums">
          {entries.length} 件{toolCallCount > 0 ? ` (tool call ${toolCallCount})` : ""}
        </span>
        {running && (
          <span className="inline-flex items-center gap-1 text-amber-300">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
            実行中
          </span>
        )}
        {!open && lastEntry && (
          <span
            className="ml-auto truncate text-[#70707a] max-w-[60%]"
            title={lastEntry.headline}
          >
            {lastEntry.headline}
          </span>
        )}
        {open && entries.length > 0 && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onClear();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.stopPropagation();
                onClear();
              }
            }}
            className="ml-auto text-[10px] text-[#70707a] hover:text-red-300 transition"
          >
            クリア
          </span>
        )}
      </button>
    </div>
  );
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function labelFor(entry: LogEntry): string {
  if (entry.kind === "toolCall") return "tool";
  if (entry.kind === "phase") return entry.phase ?? "phase";
  if (entry.kind === "instruction") return "inst";
  if (entry.kind === "result") return "result";
  return "log";
}
