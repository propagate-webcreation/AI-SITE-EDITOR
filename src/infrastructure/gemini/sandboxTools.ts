import "server-only";
import { Type, type FunctionDeclaration } from "@google/genai";

/**
 * Sandbox 上で実行する最小限のツール群のインターフェース。
 * @vercel/sandbox の Sandbox インスタンスにマップされる。
 */
export interface SandboxRuntime {
  readFile(params: { path: string; cwd?: string }): Promise<string | null>;
  writeFile(params: { path: string; content: string }): Promise<void>;
  /**
   * バイナリ (画像など) を sandbox に書き出す。
   * Gemini tool として公開はしない (controller 側が添付画像の pre-upload にだけ使う)。
   */
  writeBinaryFile(params: { path: string; content: Buffer }): Promise<void>;
  runCommand(params: {
    cmd: string;
    args?: string[];
    cwd?: string;
    timeoutMs?: number;
    /**
     * "mutating" コマンドは FS を変更しうる。run_bash がこれに該当。
     * list_dir / glob / grep 等の読み取り専用ツールは false を明示する。
     * 既定は true (= 安全側、commit 時は全差分対象)。
     */
    mutating?: boolean;
  }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface ToolResult {
  success: boolean;
  output: string;
}

export interface ToolContext {
  sandbox: SandboxRuntime;
  defaultCwd: string;
  /** Bash 実行時の最大秒数 */
  bashTimeoutSec: number;
}

// ---------------------------------------------------------------------------
// 各ツールの schema (Gemini API の FunctionDeclaration 形式)
// ---------------------------------------------------------------------------

export const TOOL_SCHEMAS: FunctionDeclaration[] = [
  {
    name: "read_file",
    description:
      "指定パスのテキストファイルを読み込む。UTF-8 として解釈。存在しない場合は null 文字列を返す。",
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: {
          type: Type.STRING,
          description: "絶対パス、または作業ディレクトリからの相対パス",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "ファイル全体を書き換える。既存ファイルは上書き、無ければ作成。",
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: {
          type: Type.STRING,
          description: "絶対パス、または作業ディレクトリからの相対パス",
        },
        content: {
          type: Type.STRING,
          description: "ファイル全文の新しい内容 (UTF-8)",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "ファイル内の old_string を new_string に置換する。old_string がファイル内に正確に 1 度だけ出現する必要がある。複数出現すると失敗する。",
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: { type: Type.STRING, description: "編集対象のファイルパス" },
        old_string: {
          type: Type.STRING,
          description: "置換前の文字列 (空白・改行まで正確に一致)",
        },
        new_string: {
          type: Type.STRING,
          description: "置換後の文字列",
        },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "list_dir",
    description: "指定ディレクトリの直下のエントリ一覧を返す。",
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: {
          type: Type.STRING,
          description: "ディレクトリの絶対/相対パス。省略で作業ディレクトリ。",
        },
      },
    },
  },
  {
    name: "glob",
    description:
      "ファイル名パターン (例: '**/*.tsx') にマッチするファイル一覧を返す。.gitignore は考慮しない。",
    parameters: {
      type: Type.OBJECT,
      properties: {
        pattern: {
          type: Type.STRING,
          description: "find の -name に渡すパターン。例: '*.html', '*.tsx'",
        },
        path: {
          type: Type.STRING,
          description: "検索開始ディレクトリ。省略で作業ディレクトリ。",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "grep",
    description:
      "指定ディレクトリ以下のファイルからパターン (正規表現) を含む行を検索する。",
    parameters: {
      type: Type.OBJECT,
      properties: {
        pattern: {
          type: Type.STRING,
          description: "grep -E の正規表現パターン",
        },
        path: {
          type: Type.STRING,
          description: "検索開始ディレクトリ。省略で作業ディレクトリ。",
        },
        file_glob: {
          type: Type.STRING,
          description:
            "対象ファイル名フィルタ (例: '*.tsx')。省略で全ファイル。",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "run_bash",
    description:
      "任意の bash コマンドを作業ディレクトリで実行する。ネットワーク可。npm install / npm run build / git 等に利用。",
    parameters: {
      type: Type.OBJECT,
      properties: {
        command: {
          type: Type.STRING,
          description: "bash -lc に渡すシェル式 1 行",
        },
      },
      required: ["command"],
    },
  },
];

// ---------------------------------------------------------------------------
// 実行ディスパッチャ
// ---------------------------------------------------------------------------

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  try {
    switch (name) {
      case "read_file":
        return await readFile(args, context);
      case "write_file":
        return await writeFile(args, context);
      case "edit_file":
        return await editFile(args, context);
      case "list_dir":
        return await listDir(args, context);
      case "glob":
        return await glob(args, context);
      case "grep":
        return await grep(args, context);
      case "run_bash":
        return await runBash(args, context);
      default:
        return { success: false, output: `unknown tool: ${name}` };
    }
  } catch (error) {
    return {
      success: false,
      output: error instanceof Error ? error.message : String(error),
    };
  }
}

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") {
    throw new Error(`${key} が文字列ではありません`);
  }
  return v;
}

function optionalString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

async function readFile(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const path = requireString(args, "path");
  const content = await ctx.sandbox.readFile({ path, cwd: ctx.defaultCwd });
  if (content === null) {
    return { success: false, output: `ファイルが存在しません: ${path}` };
  }
  return { success: true, output: content };
}

async function writeFile(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const path = requireString(args, "path");
  const content = requireString(args, "content");
  await ctx.sandbox.writeFile({ path: resolvePath(path, ctx), content });
  return { success: true, output: `wrote ${content.length} chars to ${path}` };
}

async function editFile(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const path = requireString(args, "path");
  const oldStr = requireString(args, "old_string");
  const newStr = requireString(args, "new_string");

  const current = await ctx.sandbox.readFile({
    path,
    cwd: ctx.defaultCwd,
  });
  if (current === null) {
    return { success: false, output: `ファイルが存在しません: ${path}` };
  }
  const occurrences = countOccurrences(current, oldStr);
  if (occurrences === 0) {
    return {
      success: false,
      output: `old_string がファイルに見つかりません: ${path}`,
    };
  }
  if (occurrences > 1) {
    return {
      success: false,
      output: `old_string が ${occurrences} 箇所見つかりました。文脈を広げて 1 箇所に絞ってください`,
    };
  }
  const next = current.replace(oldStr, newStr);
  await ctx.sandbox.writeFile({ path: resolvePath(path, ctx), content: next });
  return { success: true, output: `edited ${path}` };
}

async function listDir(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const target = optionalString(args, "path") ?? ".";
  const res = await ctx.sandbox.runCommand({
    cmd: "bash",
    args: ["-lc", `ls -1 --color=never ${shellQuote(target)}`],
    cwd: ctx.defaultCwd,
    timeoutMs: 30_000,
    mutating: false,
  });
  if (res.exitCode !== 0) {
    return { success: false, output: res.stderr || `ls exit ${res.exitCode}` };
  }
  return { success: true, output: res.stdout.trim() || "(empty)" };
}

async function glob(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const pattern = requireString(args, "pattern");
  const target = optionalString(args, "path") ?? ".";
  const res = await ctx.sandbox.runCommand({
    cmd: "bash",
    args: [
      "-lc",
      `find ${shellQuote(target)} -type f -name ${shellQuote(pattern)} -not -path '*/node_modules/*' -not -path '*/.git/*' | head -n 200`,
    ],
    cwd: ctx.defaultCwd,
    timeoutMs: 30_000,
    mutating: false,
  });
  if (res.exitCode !== 0) {
    return { success: false, output: res.stderr || `find exit ${res.exitCode}` };
  }
  return { success: true, output: res.stdout.trim() || "(no matches)" };
}

async function grep(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const pattern = requireString(args, "pattern");
  const target = optionalString(args, "path") ?? ".";
  const glob = optionalString(args, "file_glob");
  const include = glob ? `--include=${shellQuote(glob)}` : "";
  const res = await ctx.sandbox.runCommand({
    cmd: "bash",
    args: [
      "-lc",
      `grep -RnE ${include} --exclude-dir=node_modules --exclude-dir=.git ${shellQuote(pattern)} ${shellQuote(target)} | head -n 200 || true`,
    ],
    cwd: ctx.defaultCwd,
    timeoutMs: 60_000,
    mutating: false,
  });
  return { success: true, output: res.stdout.trim() || "(no matches)" };
}

async function runBash(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const command = requireString(args, "command");
  const res = await ctx.sandbox.runCommand({
    cmd: "bash",
    args: ["-lc", command],
    cwd: ctx.defaultCwd,
    timeoutMs: ctx.bashTimeoutSec * 1000,
  });
  const tail = (s: string, n: number) =>
    s.length > n ? `...(truncated)\n${s.slice(-n)}` : s;
  return {
    success: res.exitCode === 0,
    output:
      `exit=${res.exitCode}\n` +
      `--- stdout ---\n${tail(res.stdout, 4000)}\n` +
      `--- stderr ---\n${tail(res.stderr, 2000)}`,
  };
}

function resolvePath(p: string, ctx: ToolContext): string {
  if (p.startsWith("/")) return p;
  return `${ctx.defaultCwd.replace(/\/$/, "")}/${p}`;
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./:=@*?-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count += 1;
    idx += needle.length;
  }
  return count;
}
