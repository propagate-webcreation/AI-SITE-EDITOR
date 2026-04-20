# domain 層

ビジネスのコアモデルと外部依存の抽象（ポート）を置く層。

## 方針
- **外部依存ゼロ**: 他のレイヤー、ライブラリ、フレームワークに依存しない。
- **純粋な型・値オブジェクト**: `models/` にエンティティと定数を置く。
- **ポート**: `ports/` にインターフェース（抽象）を置く。実装は infrastructure 層。

## ディレクトリ
- `models/` — `CaseRecord`, `CorrectionConfig`, ステータス定数
- `ports/` — `SpreadsheetPort`, `GitHubPort`, `VercelPort`, `LLMAgentPort`, `SlackNotifierPort`

## 依存方向
- このレイヤーは**誰にも依存しない** (Clean Architecture の最内層)
- usecase / infrastructure / presentation はこのレイヤーに依存する
