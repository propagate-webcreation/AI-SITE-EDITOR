"use client";

import { useEffect, useRef, useState } from "react";

export interface PreviewSelectorPayload {
  tag: string;
  selector: string;
  text: string;
  html: string;
}

interface PreviewPaneProps {
  previewUrl: string | null;
  onElementSelected?: (sel: PreviewSelectorPayload) => void;
  /** 値が変わるたびに iframe を強制リロードする */
  reloadKey?: number;
  /** 選択モードの状態 (ChatPane のトグルから制御される) */
  selectMode: boolean;
  /** 要素選択完了 / キャンセル / Esc などで選択モードを外したいとき */
  onSelectModeReset: () => void;
}

const VIEWPORT_WIDTH = 1440;
const VIEWPORT_HEIGHT = 900;

export function PreviewPane({
  previewUrl,
  onElementSelected,
  reloadKey = 0,
  selectMode,
  onSelectModeReset,
}: PreviewPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      const next = Math.min(width / VIEWPORT_WIDTH, height / VIEWPORT_HEIGHT);
      setScale(next > 0 ? next : 1);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Esc で選択モード解除
  useEffect(() => {
    if (!selectMode) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onSelectModeReset();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectMode, onSelectModeReset]);

  // iframe からの postMessage (要素選択結果) を受け取る
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const data = e.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "directors-bot:selection" && data.payload) {
        const p = data.payload as Partial<PreviewSelectorPayload>;
        if (
          typeof p.selector === "string" &&
          typeof p.tag === "string" &&
          typeof p.text === "string" &&
          typeof p.html === "string"
        ) {
          onElementSelected?.({
            selector: p.selector,
            tag: p.tag,
            text: p.text,
            html: p.html,
          });
        }
        onSelectModeReset();
      } else if (data.type === "directors-bot:selection-cancel") {
        onSelectModeReset();
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [onElementSelected, onSelectModeReset]);

  // selectMode の変化を iframe に送信
  useEffect(() => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage(
      {
        type: selectMode
          ? "directors-bot:enable-selection"
          : "directors-bot:disable-selection",
      },
      "*",
    );
  }, [selectMode]);

  const scaledWidth = VIEWPORT_WIDTH * scale;
  const scaledHeight = VIEWPORT_HEIGHT * scale;

  return (
    <section className="flex-1 flex flex-col min-h-0 border-r border-[#2d2d31] bg-[#141414]">
      <div className="px-4 h-10 border-b border-[#2d2d31] bg-[#1b1b1d] text-sm text-[#a9a9b0] flex items-center gap-3">
        <span className="text-xs font-medium text-[#d0d0d4]">プレビュー</span>
        <span className="text-[10px] font-mono text-[#70707a] tabular-nums">
          {VIEWPORT_WIDTH}×{VIEWPORT_HEIGHT}
          <span className="mx-1 text-[#55555c]">·</span>
          {Math.round(scale * 100)}%
        </span>
        {selectMode && (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-amber-500/15 border border-amber-500/40 text-[10px] font-medium text-amber-200">
            <span className="font-mono text-amber-400">&lt;/&gt;</span>
            要素選択中 · Esc で解除
          </span>
        )}
        {previewUrl && (
          <span
            className="ml-auto truncate text-[10px] font-mono text-[#70707a]"
            title={previewUrl}
          >
            {previewUrl}
          </span>
        )}
      </div>
      <div
        ref={containerRef}
        className="relative flex-1 min-h-0 bg-[#121214] overflow-hidden flex items-center justify-center"
      >
        {previewUrl ? (
          <div
            className="relative bg-white shadow-[0_10px_40px_-10px_rgba(0,0,0,0.7)] ring-1 ring-black/30"
            style={{ width: `${scaledWidth}px`, height: `${scaledHeight}px` }}
          >
            <iframe
              ref={iframeRef}
              key={reloadKey}
              src={previewUrl}
              title="demo site preview"
              className="absolute top-0 left-0 border-0"
              style={{
                width: `${VIEWPORT_WIDTH}px`,
                height: `${VIEWPORT_HEIGHT}px`,
                transform: `scale(${scale})`,
                transformOrigin: "top left",
              }}
            />
          </div>
        ) : (
          <span className="text-sm text-[#55555c]">
            案件を読み込むとここにプレビューが表示されます
          </span>
        )}
      </div>
    </section>
  );
}
