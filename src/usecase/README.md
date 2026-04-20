# usecase 層

アプリケーションのビジネスロジックを置く層。

## 方針
- **ポートに依存する**: 具体的な実装（infrastructure）ではなくインターフェースに依存する (DIP)。
- **フレームワーク非依存**: Next.js や外部ライブラリを直接 import しない。
- **単体テストしやすい**: ポートをモック差し替えできる構造。

## 依存方向
- 依存先: `domain/`
- 依存元: `presentation/` から呼ばれる
- `infrastructure/` への直接参照は**禁止**（DI 経由のみ）

## 典型的な置き方
- `evaluationCorrection.ts` — デモサイト評価中フローのユースケース
- `notificationService.ts` — 通知配信のユースケース
