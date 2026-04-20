# infrastructure 層

外部 IO（API クライアント、ファイル、AI SDK 等）の具体実装を置く層。

## 方針
- **ポートを実装する**: `domain/ports/` のインターフェースに対する具象実装。
- **外部ライブラリの利用 OK**: Claude Agent SDK、Vercel Sandbox、GitHub API など。
- **ビジネスロジックを書かない**: 変換・ロギング・エラーハンドリングに限定する。

## サブディレクトリ
- `claude-agent/` — Claude Agent SDK を使った LLM エージェント実装
- `github/` — GitHub API（リポジトリ操作、PR 作成等）
- `vercel/` — Vercel API / Sandbox 起動
- `sheets/` — Google Sheets 連携
- `sandbox/` — Vercel Sandbox で Agent を走らせるアダプタ

## 依存方向
- 依存先: `domain/`（ポートの実装のため）
- 依存元: `presentation/` の DI コンテナからインスタンス化される
