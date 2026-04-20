# presentation 層

UI・API の入出力を扱う層。

## 方針
- **UI とユースケースの橋渡し**: リクエスト/レスポンス変換、認可チェック、UI コンポーネント。
- **ビジネスロジックを書かない**: usecase に委譲する。
- **infrastructure の具象を直接呼ばない**: DI 経由で usecase を呼び、usecase がポートを使う。

## サブディレクトリ
- `components/` — React コンポーネント（サーバー/クライアント両方）
- `controllers/` — `src/app/api/*` のルートハンドラから呼ばれる実体。薄いアダプタ。

## 依存方向
- 依存先: `usecase/`, `domain/`
- `src/app/` (Next.js ルート) から呼ばれる
