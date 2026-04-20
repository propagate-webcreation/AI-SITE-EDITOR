import "server-only";
import { Sandbox } from "@vercel/sandbox";
import type { SandboxRuntime } from "@/infrastructure/gemini/sandboxTools";
import { INJECTED_SELECTOR_SCRIPT } from "@/presentation/assets/injectedSelector";

export interface VercelSandboxCreds {
  oidcToken?: string;
  teamId?: string;
  projectId?: string;
  accessToken?: string;
}

export interface SandboxCreationParams {
  repoUrl: string;
  /** GitHub HTTPS 認証のユーザー名。Personal Access Token の場合は "x-access-token"。 */
  githubUsername?: string;
  githubToken: string;
  revision?: string;
  timeoutMs?: number;
  devPort?: number;
  /** dev server が READY になるまでの最大待機時間 (ms)。既定 3 分。 */
  readyTimeoutMs?: number;
}

export interface SandboxInfo {
  sandboxId: string;
  previewUrl: string;
  devPort: number;
  workingDir: string;
}

const DEFAULT_CWD = "/vercel/sandbox";
// push 直前の skills/ クリーンアップ commit に使う author。通常は
// correctionsController 側の bot 名義で commit されているが、この最終クリーンアップは
// manager 内で自己完結させるためフォールバック名義を持つ。
const BOT_NAME_FALLBACK = "propagate-bot";
const BOT_EMAIL_FALLBACK = "bot@propagateinc.com";

/**
 * Vercel Sandbox を 1 つ起動し、デモサイトを clone + npm install + dev server まで用意する。
 * Gemini AgentRunner が必要とするツール (read/write/edit/run_bash) は
 * 同一 sandbox に対して都度 sandbox.get() で再接続して実行する。
 */
export class VercelSandboxManager {
  constructor(private readonly creds: VercelSandboxCreds) {}

  async createForCase(params: SandboxCreationParams): Promise<SandboxInfo> {
    const devPort = params.devPort ?? 3000;
    // Vercel Sandbox Pro プラン上限 = 5 時間
    const timeoutMs = params.timeoutMs ?? 5 * 60 * 60 * 1000;

    const sandbox = await Sandbox.create({
      ...this.credsArg(),
      source: {
        type: "git",
        url: params.repoUrl,
        // GitHub Personal Access Token の HTTPS 認証慣例は username=x-access-token。
        username: params.githubUsername ?? "x-access-token",
        password: params.githubToken,
        depth: 1,
      },
      ports: [devPort],
      timeout: timeoutMs,
      runtime: "node24",
      env: {
        GITHUB_TOKEN: params.githubToken,
      },
    });

    await patchHostRedirectMiddleware(sandbox);
    await injectDomSelectorScript(sandbox);

    const npmInstall = await sandbox.runCommand({
      cmd: "npm",
      args: ["install", "--no-audit", "--no-fund"],
    });
    if (npmInstall.exitCode !== 0) {
      throw new Error(
        `npm install に失敗しました (exit=${npmInstall.exitCode})`,
      );
    }

    await sandbox.runCommand({
      cmd: "npm",
      args: ["run", "dev", "--", "-p", String(devPort)],
      detached: true,
      env: { PORT: String(devPort), BROWSER: "none" },
    });

    await waitForDevServer(sandbox, devPort, params.readyTimeoutMs ?? 180_000);

    return {
      sandboxId: sandbox.sandboxId,
      previewUrl: sandbox.domain(devPort),
      devPort,
      workingDir: DEFAULT_CWD,
    };
  }

  async getRuntime(sandboxId: string): Promise<SandboxRuntime> {
    const sandbox = await Sandbox.get({ ...this.credsArg(), sandboxId });
    return new VercelSandboxRuntime(sandbox);
  }

  async stop(sandboxId: string): Promise<void> {
    try {
      const sandbox = await Sandbox.get({ ...this.credsArg(), sandboxId });
      await sandbox.stop({ blocking: false });
    } catch {
      // 既に停止済みなら握り潰す
    }
  }

  /**
   * Sandbox 内の git log から `directors-bot: <recordNumber> <instructionId>` 形式の
   * 修正コミットを列挙する。案件を閉じずにタブ/セッションが切れたとき、
   * client 側で localStorage の submitted 状態を applied に昇格させるために使う。
   *
   * revert コミット (`revert directors-bot: ...`) も返す。client 側で revert 判定に使う。
   *
   * hasDirty は `git status --porcelain` で検出。途中中断した修正作業の痕跡チェック。
   */
  async listDirectorCommits(sandboxId: string): Promise<{
    commits: {
      sha: string;
      instructionId: string;
      recordNumber: string;
      kind: "apply" | "revert";
      targetSha?: string;
      committedAt: number;
      bodyFirstLine: string;
    }[];
    hasDirty: boolean;
  }> {
    const sandbox = await Sandbox.get({ ...this.credsArg(), sandboxId });

    const LOG_DELIM = "\x1fEND_COMMIT\x1f";
    const shellCmd = [
      `cd ${DEFAULT_CWD}`,
      // `%H` sha / `%ct` commit time (epoch) / `%B` body
      `git log --grep='^\\(revert \\)\\?directors-bot: ' --extended-regexp ` +
        `--format='%H%x1f%ct%x1f%B${LOG_DELIM}'`,
      `echo "==STATUS=="`,
      `git status --porcelain`,
    ].join(" && ");

    const res = await runAndCaptureStdout(sandbox, {
      cmd: "bash",
      args: ["-lc", shellCmd],
      timeoutMs: 60_000,
    });
    if (res.exitCode !== 0) {
      throw new Error(
        `git log / status に失敗 (exit=${res.exitCode})\nstderr: ${res.stderr.slice(0, 800)}`,
      );
    }

    const [logPart = "", statusPart = ""] = res.stdout.split("==STATUS==");
    const hasDirty = statusPart.trim().length > 0;

    const commits: Awaited<
      ReturnType<VercelSandboxManager["listDirectorCommits"]>
    >["commits"] = [];
    for (const chunk of logPart.split(LOG_DELIM)) {
      const entry = chunk.trim();
      if (!entry) continue;
      const parts = entry.split("\x1f");
      if (parts.length < 3) continue;
      const sha = (parts[0] ?? "").trim();
      const ctStr = (parts[1] ?? "").trim();
      const body = (parts.slice(2).join("\x1f") ?? "").trim();
      if (!sha) continue;

      const firstLine = body.split("\n")[0] ?? "";
      const applyMatch = firstLine.match(
        /^directors-bot:\s+(\S+)\s+(\S+)/,
      );
      const revertMatch = firstLine.match(
        /^revert directors-bot:\s+(\S+)\s+(\S+)/,
      );
      const bodyLines = body.split("\n");
      const targetShaMatch = bodyLines
        .join("\n")
        .match(/rollback of ([a-f0-9]{7,40})/);
      const committedAt = Number.parseInt(ctStr, 10) * 1000;

      if (revertMatch) {
        commits.push({
          sha,
          recordNumber: revertMatch[1] ?? "",
          instructionId: revertMatch[2] ?? "",
          kind: "revert",
          targetSha: targetShaMatch?.[1],
          committedAt: Number.isFinite(committedAt) ? committedAt : Date.now(),
          bodyFirstLine: firstLine,
        });
      } else if (applyMatch) {
        commits.push({
          sha,
          recordNumber: applyMatch[1] ?? "",
          instructionId: applyMatch[2] ?? "",
          kind: "apply",
          committedAt: Number.isFinite(committedAt) ? committedAt : Date.now(),
          bodyFirstLine: firstLine,
        });
      }
    }

    return { commits, hasDirty };
  }

  /**
   * Sandbox 内で git add + commit を実行し、作成された commit SHA を返す。
   * 変更が無ければ null (= nothing to commit)。push は別メソッド。
   */
  async commitOnly(params: {
    sandboxId: string;
    authorName: string;
    authorEmail: string;
    commitMessage: string;
    /**
     * 指定された場合、このパス (または glob) のみを `git add` 対象にする。
     * 並列 Gemini 実行で、各 agent が触ったファイルだけを自分の commit に含めるために使う。
     * 省略時は `-A` (全差分)。
     */
    pathSpec?: readonly string[];
  }): Promise<string | null> {
    const sandbox = await Sandbox.get({
      ...this.credsArg(),
      sandboxId: params.sandboxId,
    });

    const hasPathSpec = !!params.pathSpec && params.pathSpec.length > 0;
    const pathArg = hasPathSpec
      ? params.pathSpec!.map((p) => shellQuote(p)).join(" ")
      : "";

    const statusCmd = hasPathSpec
      ? `git status --porcelain -- ${pathArg}`
      : `git status --porcelain`;
    const statusRes = await runAndCaptureStdout(sandbox, {
      cmd: "bash",
      args: ["-lc", `cd ${DEFAULT_CWD} && ${statusCmd}`],
      timeoutMs: 60_000,
    });
    if (statusRes.exitCode !== 0) {
      throw new Error(
        `git status に失敗しました (exit=${statusRes.exitCode})\n${statusRes.stderr.slice(0, 600)}`,
      );
    }
    if (statusRes.stdout.trim().length === 0) {
      return null;
    }

    const addCmd = hasPathSpec ? `git add -- ${pathArg}` : `git add -A`;
    const shellCmd = [
      `cd ${DEFAULT_CWD}`,
      `git config user.name ${shellQuote(params.authorName)}`,
      `git config user.email ${shellQuote(params.authorEmail)}`,
      addCmd,
      `git diff --cached --quiet && exit 65 || true`,
      `git commit -m ${shellQuote(params.commitMessage)}`,
      `git rev-parse HEAD`,
    ].join(" && ");

    const res = await runAndCaptureStdout(sandbox, {
      cmd: "bash",
      args: ["-lc", shellCmd],
      timeoutMs: 60_000,
    });
    // 65 = 並列 agent の別 commit で既に取り込まれており、このインスタンスの分は差分ゼロだった
    if (res.exitCode === 65) return null;
    if (res.exitCode !== 0) {
      throw new Error(
        `git commit が失敗しました (exit=${res.exitCode})\nstderr: ${res.stderr.slice(0, 1200)}`,
      );
    }
    return extractTrailingSha(res.stdout);
  }

  /**
   * 指定された commit を revert する (新しい revert commit を追加)。
   * 競合時は例外を投げる。revert 自体が成功したら revert commit の SHA を返す。
   */
  async revertCommit(params: {
    sandboxId: string;
    targetCommitSha: string;
    authorName: string;
    authorEmail: string;
    commitMessage: string;
  }): Promise<string> {
    const sandbox = await Sandbox.get({
      ...this.credsArg(),
      sandboxId: params.sandboxId,
    });

    const shellCmd = [
      `cd ${DEFAULT_CWD}`,
      `git config user.name ${shellQuote(params.authorName)}`,
      `git config user.email ${shellQuote(params.authorEmail)}`,
      `git revert --no-edit -m 1 ${shellQuote(params.targetCommitSha)} || ` +
        `{ git revert --abort 2>/dev/null; exit 64; }`,
      `git commit --amend -m ${shellQuote(params.commitMessage)} || true`,
      `git rev-parse HEAD`,
    ].join(" && ");

    const res = await runAndCaptureStdout(sandbox, {
      cmd: "bash",
      args: ["-lc", shellCmd],
      timeoutMs: 60_000,
    });
    if (res.exitCode !== 0) {
      if (res.exitCode === 64) {
        throw new Error(
          `この修正指示はあとの変更とぶつかっているため自動で戻せません。`,
        );
      }
      throw new Error(
        `git revert が失敗しました (exit=${res.exitCode})\nstderr: ${res.stderr.slice(0, 1200)}`,
      );
    }
    const sha = extractTrailingSha(res.stdout);
    if (!sha) {
      throw new Error("revert commit SHA が取得できませんでした");
    }
    return sha;
  }

  /**
   * 累積された未 push コミットを GitHub に force-push する。
   * 現在の HEAD を返す。
   */
  async pushAll(params: {
    sandboxId: string;
    repoUrl: string;
    githubToken: string;
    branch: string;
  }): Promise<string> {
    const sandbox = await Sandbox.get({
      ...this.credsArg(),
      sandboxId: params.sandboxId,
    });

    const authedUrl = buildAuthenticatedRepoUrl(
      params.repoUrl,
      params.githubToken,
    );
    // Gemini が system prompt の skill 参照に引きずられて誤って skills/ を
    // demo 側に作成してしまった場合に備えて、push 前に必ずクリーンアップする。
    // 何も存在しなければ no-op (rm -rf は冪等、git diff で差分無しなら commit skip)。
    const shellCmd = [
      `cd ${DEFAULT_CWD}`,
      `rm -rf skills`,
      `git rm -rf --cached --ignore-unmatch skills > /dev/null 2>&1 || true`,
      `if ! git diff --cached --quiet; then ` +
        `git -c user.name=${shellQuote(BOT_NAME_FALLBACK)} ` +
        `-c user.email=${shellQuote(BOT_EMAIL_FALLBACK)} ` +
        `commit -m "internal: drop skills/ before push"; ` +
        `fi`,
      `git push --force ${shellQuote(authedUrl)} HEAD:${shellQuote(params.branch)}`,
      `git rev-parse HEAD`,
    ].join(" && ");

    const res = await runAndCaptureStdout(sandbox, {
      cmd: "bash",
      args: ["-lc", shellCmd],
      timeoutMs: 5 * 60 * 1000,
    });
    if (res.exitCode !== 0) {
      throw new Error(
        `git push が失敗しました (exit=${res.exitCode})\nstderr: ${res.stderr.slice(0, 1200)}`,
      );
    }
    const sha = extractTrailingSha(res.stdout);
    if (!sha) {
      throw new Error("push 後の HEAD SHA が取得できませんでした");
    }
    return sha;
  }

  private credsArg(): Record<string, string> {
    // Vercel Sandbox SDK は { token, teamId, projectId } の 3 点セットを要求する。
    // 3 つすべて揃わないと "Missing credentials parameters" エラー。
    // VERCEL_TOKEN (vcp_...) は長期有効なので優先。未設定時のみ OIDC トークンに fallback。
    const token = this.creds.accessToken ?? this.creds.oidcToken;
    const out: Record<string, string> = {};
    if (token && this.creds.teamId && this.creds.projectId) {
      out.token = token;
      out.teamId = this.creds.teamId;
      out.projectId = this.creds.projectId;
    }
    // 部分設定は SDK が拒否するため、全部揃わない場合は env 経由の自動取得に任せる
    return out;
  }
}

/**
 * SandboxRuntime の Vercel Sandbox 実装。
 * Gemini ツール (read/write/edit/run_bash 等) が共通で使うインターフェース。
 */
class VercelSandboxRuntime implements SandboxRuntime {
  constructor(private readonly sandbox: Sandbox) {}

  async readFile(params: { path: string; cwd?: string }): Promise<string | null> {
    const buf = await this.sandbox.readFileToBuffer({
      path: params.path,
      cwd: params.cwd ?? DEFAULT_CWD,
    });
    return buf ? buf.toString("utf8") : null;
  }

  async writeFile(params: { path: string; content: string }): Promise<void> {
    await this.sandbox.writeFiles([
      { path: params.path, content: Buffer.from(params.content, "utf8") },
    ]);
  }

  async writeBinaryFile(params: {
    path: string;
    content: Buffer;
  }): Promise<void> {
    // 相対パスは sandbox working dir 基準に正規化
    const absPath = params.path.startsWith("/")
      ? params.path
      : `${DEFAULT_CWD}/${params.path}`;
    // ネストしたディレクトリを先に作成 (writeFiles は親 dir 自動作成を保証しない)
    const dir = absPath.replace(/\/[^/]+$/, "");
    if (dir && dir !== absPath) {
      await this.sandbox.runCommand({
        cmd: "mkdir",
        args: ["-p", dir],
      });
    }
    await this.sandbox.writeFiles([
      { path: absPath, content: params.content },
    ]);
  }

  async runCommand(params: {
    cmd: string;
    args?: string[];
    cwd?: string;
    timeoutMs?: number;
  }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    let stdout = "";
    let stderr = "";
    const stdoutStream = makeCapture((c) => {
      stdout += c;
    });
    const stderrStream = makeCapture((c) => {
      stderr += c;
    });

    const controller = new AbortController();
    const timer = params.timeoutMs
      ? setTimeout(() => controller.abort(), params.timeoutMs)
      : null;
    try {
      const res = await this.sandbox.runCommand({
        cmd: params.cmd,
        args: params.args,
        cwd: params.cwd ?? DEFAULT_CWD,
        stdout: stdoutStream,
        stderr: stderrStream,
        signal: controller.signal,
      });
      return { stdout, stderr, exitCode: res.exitCode };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function makeCapture(onChunk: (chunk: string) => void) {
  // @vercel/sandbox は Writable を期待する。node:stream の Writable を使う。
  // SSR 環境 (Node) でのみ実行されるため require で OK。
  const { Writable } = require("node:stream") as typeof import("node:stream");
  return new Writable({
    write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
      onChunk(chunk.toString("utf8"));
      cb();
    },
  });
}

/**
 * Sandbox 内から localhost:port を curl し、HTTP 応答があるまで待つ。
 * Next.js dev (turbopack) は起動に 20-60 秒かかるので、3 分までリトライする。
 */
async function waitForDevServer(
  sandbox: Sandbox,
  port: number,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  const intervalMs = 3000;
  while (Date.now() - start < timeoutMs) {
    const code = await probeHttpStatus(sandbox, port);
    if (/^[23]\d\d$/.test(code)) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `dev server が ${timeoutMs}ms 以内にポート ${port} で応答しませんでした`,
  );
}

/**
 * Sandbox の Next.js アプリに DOM セレクタ注入スクリプトを仕込む。
 *
 * - `public/directors-bot-selector.js`: スクリプト本体を配置。新規ファイルなので
 *   `.git/info/exclude` に追記して untracked + 常に無視にする (本番 push に含めない)。
 * - `app/layout.tsx` or `src/app/layout.tsx`: Next.js の `<Script>` コンポーネントを
 *   `<body>` 直後に挿入。既存 import を増やす必要あれば import 文も追加。
 *   こちらは tracked ファイルなので `git update-index --skip-worktree` で変更を無視。
 *
 * 投入失敗は致命的ではなく、プレビュー自体は動く (要素選択機能のみが無効化)。
 * 例外を投げずに警告ログのみを出して続行する。
 */
async function injectDomSelectorScript(sandbox: Sandbox): Promise<void> {
  try {
    // 1. スクリプト本体を public/ に書き込み
    await sandbox.writeFiles([
      {
        path: `${DEFAULT_CWD}/public/directors-bot-selector.js`,
        content: INJECTED_SELECTOR_SCRIPT,
      },
    ]);

    // 2. .git/info/exclude に追記して commit 対象から確実に外す
    await sandbox.runCommand({
      cmd: "bash",
      args: [
        "-lc",
        [
          `cd ${DEFAULT_CWD}`,
          `mkdir -p .git/info`,
          `touch .git/info/exclude`,
          `grep -qxF 'public/directors-bot-selector.js' .git/info/exclude || echo 'public/directors-bot-selector.js' >> .git/info/exclude`,
        ].join(" && "),
      ],
    });

    // 3. layout.tsx を探して patch
    const layoutCandidates = [
      "src/app/layout.tsx",
      "src/app/layout.jsx",
      "app/layout.tsx",
      "app/layout.jsx",
    ];
    let patchedOne = false;
    for (const rel of layoutCandidates) {
      const abs = `${DEFAULT_CWD}/${rel}`;
      const buf = await sandbox
        .readFileToBuffer({ path: abs })
        .catch(() => null);
      if (!buf) continue;
      const src = buf.toString("utf8");
      if (src.includes("directors-bot-selector.js")) {
        patchedOne = true;
        break;
      }

      const patched = patchLayoutSource(src);
      if (patched === src) continue;

      await sandbox.writeFiles([{ path: abs, content: patched }]);
      await sandbox.runCommand({
        cmd: "bash",
        args: [
          "-lc",
          `cd ${DEFAULT_CWD} && git update-index --skip-worktree ${shellQuote(rel)} 2>/dev/null || true`,
        ],
      });
      patchedOne = true;
      break;
    }
    if (!patchedOne) {
      console.warn(
        "[directors-bot] layout.tsx に selector スクリプトを注入できませんでした。",
      );
    }
  } catch (error) {
    console.warn(
      "[directors-bot] selector 注入に失敗 (プレビューは動作):",
      error,
    );
  }
}

/**
 * layout.tsx の文字列に:
 *   - `import Script from "next/script";` (未 import 時のみ)
 *   - `<body>` 直後に `<Script src="/directors-bot-selector.js" strategy="beforeInteractive" />`
 * を挿入する。
 */
function patchLayoutSource(src: string): string {
  let out = src;

  // import Script from "next/script" が無ければ追加
  if (
    !/import\s+Script\s+from\s+["']next\/script["']/.test(out) &&
    !/from\s+["']next\/script["']/.test(out)
  ) {
    const lines = out.split("\n");
    let lastImport = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (/^\s*import\s/.test(lines[i] ?? "")) lastImport = i;
      else if (lastImport >= 0 && (lines[i] ?? "").trim() === "") continue;
      else if (lastImport >= 0) break;
    }
    if (lastImport >= 0) {
      lines.splice(lastImport + 1, 0, 'import Script from "next/script";');
      out = lines.join("\n");
    }
  }

  // <body ...> の直後に Script コンポーネントを挿入
  const bodyOpen = /<body([^>]*)>/;
  const scriptTag =
    '\n        <Script src="/directors-bot-selector.js" strategy="beforeInteractive" />';
  const matched = out.match(bodyOpen);
  if (matched) {
    out = out.replace(bodyOpen, `<body$1>${scriptTag}`);
  }
  return out;
}

/**
 * cloned デモサイトに `www.` 強制リダイレクトの middleware.ts / proxy.ts が
 * ある場合、Vercel Sandbox のドメイン ".vercel.run" を除外リストに追加する。
 * git には `--skip-worktree` で無視させるので、本番 push には含まれない。
 */
async function patchHostRedirectMiddleware(sandbox: Sandbox): Promise<void> {
  const candidates = [
    "middleware.ts",
    "middleware.js",
    "src/middleware.ts",
    "src/middleware.js",
    "proxy.ts",
    "proxy.js",
    "src/proxy.ts",
    "src/proxy.js",
  ];
  for (const rel of candidates) {
    const abs = `${DEFAULT_CWD}/${rel}`;
    const buf = await sandbox.readFileToBuffer({ path: abs }).catch(() => null);
    if (!buf) continue;
    const src = buf.toString("utf8");
    // 既にパッチ済みならスキップ
    if (src.includes(".vercel.run")) continue;
    // ホストリダイレクトのパターンが無ければスキップ
    if (!src.includes(".vercel.app")) continue;
    const patched = src.replace(
      /host\.endsWith\(["']\.vercel\.app["']\)/,
      'host.endsWith(".vercel.app") || host.endsWith(".vercel.run")',
    );
    if (patched === src) continue;
    await sandbox.writeFiles([{ path: abs, content: patched }]);
    await sandbox.runCommand({
      cmd: "bash",
      args: [
        "-lc",
        `cd ${DEFAULT_CWD} && git update-index --skip-worktree ${shellQuote(rel)}`,
      ],
    });
  }
}

function extractTrailingSha(stdout: string): string | null {
  const tail = stdout.trim().split(/\s+/).pop() ?? "";
  return /^[a-f0-9]{7,40}$/.test(tail) ? tail : null;
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function buildAuthenticatedRepoUrl(repoUrl: string, token: string): string {
  let raw = repoUrl.trim().replace(/\/$/, "");
  if (!raw.toLowerCase().endsWith(".git")) raw = `${raw}.git`;
  const parsed = new URL(raw);
  if (!parsed.hostname.toLowerCase().includes("github.com")) return raw;
  parsed.username = "x-access-token";
  parsed.password = token;
  return parsed.toString();
}

async function runAndCaptureStdout(
  sandbox: Sandbox,
  params: {
    cmd: string;
    args?: string[];
    cwd?: string;
    timeoutMs?: number;
  },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let stdout = "";
  let stderr = "";
  const stdoutStream = makeCapture((c) => {
    stdout += c;
  });
  const stderrStream = makeCapture((c) => {
    stderr += c;
  });
  const controller = new AbortController();
  const timer = params.timeoutMs
    ? setTimeout(() => controller.abort(), params.timeoutMs)
    : null;
  try {
    const res = await sandbox.runCommand({
      cmd: params.cmd,
      args: params.args,
      cwd: params.cwd,
      stdout: stdoutStream,
      stderr: stderrStream,
      signal: controller.signal,
    });
    return { stdout, stderr, exitCode: res.exitCode };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function probeHttpStatus(sandbox: Sandbox, port: number): Promise<string> {
  let stdout = "";
  const capture = makeCapture((c) => {
    stdout += c;
  });
  await sandbox.runCommand({
    cmd: "bash",
    args: [
      "-lc",
      `curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://127.0.0.1:${port}/ 2>/dev/null || echo "000"`,
    ],
    stdout: capture,
  });
  return stdout.trim();
}
