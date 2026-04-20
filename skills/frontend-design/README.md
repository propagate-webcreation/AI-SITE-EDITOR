# frontend-design skill

Anthropic 公式 Agent Skills リポジトリからの複製。
本ディレクトリは参考値として保持し、全体指示 (`isGlobal=true`) モードの Gemini
system prompt に連結される。

- Upstream: https://github.com/anthropics/skills/tree/main/skills/frontend-design
- License: Apache-2.0 (LICENSE.txt 参照)
- Source commit: main ブランチから取得 (2026-04-20 時点)

## 取り込み経路

`src/presentation/controllers/correctionsController.ts` が `SKILL.md` を
読み込み、`SYSTEM_INSTRUCTION_GLOBAL` の末尾に連結する。全体指示が発行された
Gemini 呼び出しでのみ参照される。

更新したい場合は以下:

```bash
curl -s https://raw.githubusercontent.com/anthropics/skills/main/skills/frontend-design/SKILL.md \
  -o skills/frontend-design/SKILL.md
```
