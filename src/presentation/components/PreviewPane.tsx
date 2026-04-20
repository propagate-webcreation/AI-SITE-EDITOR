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
}

const VIEWPORT_WIDTH = 1440;
const VIEWPORT_HEIGHT = 900;

export function PreviewPane({
  previewUrl,
  onElementSelected,
  reloadKey = 0,
}: PreviewPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [scale, setScale] = useState(1);
  const [selectMode, setSelectMode] = useState(false);

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
      if (e.key === "Escape") setSelectMode(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectMode]);

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
        setSelectMode(false);
      } else if (data.type === "directors-bot:selection-cancel") {
        setSelectMode(false);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [onElementSelected]);

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

  function toggleSelectMode(): void {
    setSelectMode((v) => !v);
  }

  const scaledWidth = VIEWPORT_WIDTH * scale;
  const scaledHeight = VIEWPORT_HEIGHT * scale;

  return (
    <section className="flex-1 flex flex-col min-h-0 border-r border-neutral-800">
      <div className="px-4 h-10 border-b border-neutral-800 text-sm text-neutral-400 flex items-center gap-2">
        <span className="font-medium text-neutral-100">プレビュー</span>
        <span className="text-xs text-neutral-500">
          {VIEWPORT_WIDTH}×{VIEWPORT_HEIGHT} ({Math.round(scale * 100)}%)
        </span>
        <button
          type="button"
          onClick={toggleSelectMode}
          disabled={!previewUrl}
          className={`ml-3 px-2 py-0.5 rounded text-xs font-semibold border transition ${
            selectMode
              ? "bg-sky-500 text-white border-sky-500"
              : "border-neutral-700 text-neutral-200 hover:border-sky-500 hover:text-sky-300"
          } disabled:opacity-50`}
          title="プレビュー内の HTML 要素をクリックで選択し、指示にタグとして添付します"
        >
          {selectMode ? "🏷️ 要素選択中 (Esc で解除)" : "🏷️ 要素を選択"}
        </button>
        {previewUrl && (
          <span className="ml-auto truncate text-xs" title={previewUrl}>
            {previewUrl}
          </span>
        )}
      </div>
      <div
        ref={containerRef}
        className="relative flex-1 min-h-0 bg-neutral-900 overflow-hidden flex items-center justify-center"
      >
        {previewUrl ? (
          <div
            className="relative bg-white shadow-2xl"
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
          <div className="text-neutral-500 text-sm">
            デモサイトを選択してください
          </div>
        )}
      </div>
    </section>
  );
}
