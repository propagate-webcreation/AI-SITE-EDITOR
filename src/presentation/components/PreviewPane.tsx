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
  /** Sandbox 内の dev server を再起動する。クリックで /api/sessions/restart-preview を叩く想定 */
  onRestartDevServer?: () => void;
  /** 再起動処理中の表示切替 */
  restartingDevServer?: boolean;
  /**
   * 永続ハイライトする CSS selector 群。
   * ChatPane で「修正実行済み」指示を押したとき、その指示が対象とした要素を
   * プレビュー内で枠線表示するために使う。空配列なら全クリア。
   */
  highlightSelectors?: readonly string[];
}

const VIEWPORT_WIDTH = 1440;
const VIEWPORT_HEIGHT = 900;

export function PreviewPane({
  previewUrl,
  onElementSelected,
  reloadKey = 0,
  selectMode,
  onSelectModeReset,
  onRestartDevServer,
  restartingDevServer = false,
  highlightSelectors,
}: PreviewPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [scale, setScale] = useState(1);
  const [manualOpen, setManualOpen] = useState(false);
  // iframe の script が ready になった後にハイライトを再送するために最新値を保持
  const highlightRef = useRef<readonly string[]>(highlightSelectors ?? []);
  highlightRef.current = highlightSelectors ?? [];

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

  // iframe からの postMessage (要素選択結果 / ready) を受け取る
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
      } else if (data.type === "directors-bot:ready") {
        // iframe がリロードされて script が再び上がった直後は
        // 親から送った postMessage が間に合わない。ready を受け取った時点で
        // 現在のハイライト状態を再送しておく。
        const win = iframeRef.current?.contentWindow;
        if (!win) return;
        win.postMessage(
          {
            type: "directors-bot:highlight-selectors",
            selectors: highlightRef.current,
          },
          "*",
        );
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [onElementSelected, onSelectModeReset]);

  // highlightSelectors の変化を iframe に送信
  useEffect(() => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage(
      {
        type: "directors-bot:highlight-selectors",
        selectors: highlightSelectors ?? [],
      },
      "*",
    );
  }, [highlightSelectors]);

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
        {onRestartDevServer && (
          <button
            type="button"
            onClick={onRestartDevServer}
            disabled={!previewUrl || restartingDevServer}
            className="inline-flex items-center justify-center h-[26px] px-2.5 rounded-md border border-[#3a3a3f] bg-[#1b1b1d] text-[11px] text-[#a9a9b0] hover:border-amber-500/60 hover:text-amber-200 hover:bg-amber-500/5 disabled:opacity-40 disabled:cursor-not-allowed transition whitespace-nowrap"
            title="Sandbox 内の Next.js dev server を再起動します。プレビューが応答しなくなったときに使用。"
          >
            {restartingDevServer ? "再起動中..." : "開発サーバー再起動"}
          </button>
        )}
        <button
          type="button"
          onClick={() => setManualOpen(true)}
          className="inline-flex items-center justify-center h-[26px] px-2.5 rounded-md border border-[#3a3a3f] bg-[#1b1b1d] text-[11px] text-[#a9a9b0] hover:border-amber-500/60 hover:text-amber-200 hover:bg-amber-500/5 transition whitespace-nowrap"
          title="ワークフローと操作方法を表示します"
        >
          操作マニュアル
        </button>
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
      {manualOpen && <ManualModal onClose={() => setManualOpen(false)} />}
    </section>
  );
}

function ManualModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-[640px] max-w-[92vw] max-h-[85vh] overflow-y-auto rounded-lg border border-[#3a3a3f] bg-[#1f1f22] shadow-[0_20px_50px_-10px_rgba(0,0,0,0.7)]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sticky top-0 px-5 h-11 flex items-center justify-between border-b border-[#2d2d31] bg-[#1f1f22]">
          <h2 className="text-sm font-semibold text-[#f0f0f2] tracking-wide">
            操作マニュアル
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="h-6 w-6 flex items-center justify-center rounded-md border border-[#3a3a3f] bg-[#1b1b1d] text-[#a9a9b0] hover:border-[#55555c] hover:text-[#e8e8ea] transition"
          >
            ×
          </button>
        </header>
        <div className="px-5 py-5 space-y-5 text-sm text-[#d0d0d4] leading-relaxed">
          <ManualSection title="① 案件を開く">
            <p>
              ヘッダーの案件番号欄に案件レコード番号 (例: 12345)を入力し「開く」。
              Sandbox が起動してプレビューが表示されます。既に開いている案件が
              あれば、そのまま自動復元されます。
            </p>
          </ManualSection>

          <ManualSection title="② 修正指示を作る">
            <ul className="list-disc pl-5 space-y-1.5">
              <li>
                <Kbd>要素</Kbd>{" "}
                ボタンでプレビュー内のパーツをクリック→指示に対象要素として紐付け。
                複数要素を続けてクリックできます。Esc で解除。
              </li>
              <li>
                <Kbd>画像添付</Kbd>{" "}
                で参考画像やスクショを添付。ドラッグ&ドロップも可。
              </li>
              <li>
                <Kbd>全体指示</Kbd>{" "}
                はサイト全体のトーン変更など、他の指示完了後に単独実行させたい
                場合にトグル。
              </li>
              <li>
                テキスト欄に日本語で修正内容を書き <Kbd>+ 追加</Kbd>{" "}
                で下書き登録。複数の下書きを溜めてから一括実行できます。
              </li>
            </ul>
          </ManualSection>

          <ManualSection title="③ AI に修正させる">
            <p>
              <Kbd variant="primary">AI修正実行</Kbd>{" "}
              を押すと、溜まっている下書きを AI
              が順次処理し、1指示ごとにコミットされます。実行中はログが
              自動で開き、tool call の進行が確認できます。
            </p>
          </ManualSection>

          <ManualSection title="④ 実行済み指示の確認">
            <ul className="list-disc pl-5 space-y-1.5">
              <li>
                <span className="text-amber-200">修正実行済みの指示</span>{" "}
                をクリック → プレビュー上で
                <span className="text-amber-200">対象要素をハイライト表示</span>
                。もう一度押すと解除。
              </li>
              <li>
                <Kbd>元に戻す</Kbd>{" "}
                でその指示だけ個別に revert
                コミットが作られます (他の指示はそのまま残ります)。
              </li>
            </ul>
          </ManualSection>

          <ManualSection title="⑤ 保存 / 終了">
            <ul className="list-disc pl-5 space-y-1.5">
              <li>
                <Kbd variant="teal">変更を保存</Kbd>{" "}
                で、適用済みの修正全部を GitHub
                に push。本番デプロイ (Vercel) が走ります。
              </li>
              <li>
                <Kbd>案件を閉じる</Kbd> で Sandbox が停止。DB
                の案件記録も消え、他のディレクターが同じ案件を開けるように
                なります (GitHub のコミット履歴は残ります)。
              </li>
              <li>
                保存せず閉じると、Sandbox 上の未 push の変更は失われます。
                閉じる時に確認ダイアログが出ます。
              </li>
            </ul>
          </ManualSection>

          <ManualSection title="トラブル時">
            <ul className="list-disc pl-5 space-y-1.5">
              <li>
                プレビューが応答しない / 白画面 →{" "}
                <Kbd>開発サーバー再起動</Kbd>{" "}
                で Sandbox 内の dev server だけ再起動
                (Sandbox 自体は生きたまま)。
              </li>
              <li>
                ページを再読み込みしても下書き・セッション状態は保持されます
                (localStorage + Sandbox 側の git log から復元)。
              </li>
              <li>
                AI 処理中にタブを閉じても、コミットされていれば次回復元時に
                「適用済み」として拾われます。コミットが残っていない指示は
                「失敗」になるので、同じ内容で再送信してください。
              </li>
            </ul>
          </ManualSection>
        </div>
      </div>
    </div>
  );
}

function ManualSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-amber-300/90 mb-2">
        {title}
      </h3>
      <div className="text-sm text-[#d0d0d4] leading-relaxed">{children}</div>
    </section>
  );
}

function Kbd({
  children,
  variant = "neutral",
}: {
  children: React.ReactNode;
  variant?: "neutral" | "primary" | "teal";
}) {
  const cls =
    variant === "primary"
      ? "bg-amber-500/10 border-amber-500/60 text-amber-200"
      : variant === "teal"
        ? "bg-teal-500/10 border-teal-500/60 text-teal-200"
        : "bg-[#1b1b1d] border-[#3a3a3f] text-[#d0d0d4]";
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[11px] font-medium whitespace-nowrap ${cls}`}
    >
      {children}
    </span>
  );
}
