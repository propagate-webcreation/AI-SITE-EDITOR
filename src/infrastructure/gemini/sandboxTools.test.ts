import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { executeTool, type SandboxRuntime } from "./sandboxTools";

function makeSandbox(overrides: Partial<SandboxRuntime> = {}): SandboxRuntime {
  return {
    readFile: vi.fn().mockResolvedValue(null),
    writeFile: vi.fn().mockResolvedValue(undefined),
    runCommand: vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }),
    ...overrides,
  };
}

const ctx = (sandbox: SandboxRuntime) => ({
  sandbox,
  defaultCwd: "/vercel/sandbox",
  bashTimeoutSec: 30,
});

describe("executeTool", () => {
  it("read_file は SandboxRuntime.readFile を呼ぶ", async () => {
    const sandbox = makeSandbox({
      readFile: vi.fn().mockResolvedValue("hello"),
    });
    const res = await executeTool(
      "read_file",
      { path: "index.html" },
      ctx(sandbox),
    );
    expect(res.success).toBe(true);
    expect(res.output).toBe("hello");
    expect(sandbox.readFile).toHaveBeenCalledWith({
      path: "index.html",
      cwd: "/vercel/sandbox",
    });
  });

  it("read_file で null は error (ファイル未存在)", async () => {
    const sandbox = makeSandbox({
      readFile: vi.fn().mockResolvedValue(null),
    });
    const res = await executeTool(
      "read_file",
      { path: "missing.html" },
      ctx(sandbox),
    );
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/存在しません/);
  });

  it("write_file はパスを正規化して writeFile を呼ぶ", async () => {
    const sandbox = makeSandbox();
    const res = await executeTool(
      "write_file",
      { path: "index.html", content: "<h1>hi</h1>" },
      ctx(sandbox),
    );
    expect(res.success).toBe(true);
    expect(sandbox.writeFile).toHaveBeenCalledWith({
      path: "/vercel/sandbox/index.html",
      content: "<h1>hi</h1>",
    });
  });

  it("write_file 絶対パスはそのまま保持", async () => {
    const sandbox = makeSandbox();
    await executeTool(
      "write_file",
      { path: "/tmp/x", content: "x" },
      ctx(sandbox),
    );
    expect(sandbox.writeFile).toHaveBeenCalledWith({
      path: "/tmp/x",
      content: "x",
    });
  });

  it("edit_file: 1 箇所のみ置換", async () => {
    const sandbox = makeSandbox({
      readFile: vi.fn().mockResolvedValue("hello world"),
    });
    const res = await executeTool(
      "edit_file",
      {
        path: "a.txt",
        old_string: "world",
        new_string: "universe",
      },
      ctx(sandbox),
    );
    expect(res.success).toBe(true);
    expect(sandbox.writeFile).toHaveBeenCalledWith({
      path: "/vercel/sandbox/a.txt",
      content: "hello universe",
    });
  });

  it("edit_file: old_string が無ければ error", async () => {
    const sandbox = makeSandbox({
      readFile: vi.fn().mockResolvedValue("hello world"),
    });
    const res = await executeTool(
      "edit_file",
      { path: "a.txt", old_string: "notfound", new_string: "x" },
      ctx(sandbox),
    );
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/見つかりません/);
    expect(sandbox.writeFile).not.toHaveBeenCalled();
  });

  it("edit_file: 複数マッチはあいまい性 error", async () => {
    const sandbox = makeSandbox({
      readFile: vi.fn().mockResolvedValue("aaa bbb aaa"),
    });
    const res = await executeTool(
      "edit_file",
      { path: "a.txt", old_string: "aaa", new_string: "ccc" },
      ctx(sandbox),
    );
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/2 箇所/);
    expect(sandbox.writeFile).not.toHaveBeenCalled();
  });

  it("run_bash は runCommand に bash -lc で渡す", async () => {
    const runCommand = vi.fn().mockResolvedValue({
      stdout: "hi",
      stderr: "",
      exitCode: 0,
    });
    const sandbox = makeSandbox({ runCommand });
    const res = await executeTool(
      "run_bash",
      { command: "echo hi" },
      ctx(sandbox),
    );
    expect(res.success).toBe(true);
    expect(runCommand).toHaveBeenCalledWith({
      cmd: "bash",
      args: ["-lc", "echo hi"],
      cwd: "/vercel/sandbox",
      timeoutMs: 30_000,
    });
    expect(res.output).toMatch(/exit=0/);
    expect(res.output).toMatch(/hi/);
  });

  it("run_bash: 非 0 exit で success=false", async () => {
    const sandbox = makeSandbox({
      runCommand: vi.fn().mockResolvedValue({
        stdout: "",
        stderr: "oops",
        exitCode: 1,
      }),
    });
    const res = await executeTool(
      "run_bash",
      { command: "false" },
      ctx(sandbox),
    );
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/oops/);
  });

  it("glob は find コマンドを組み立てる", async () => {
    const runCommand = vi.fn().mockResolvedValue({
      stdout: "./a.html\n./b.html\n",
      stderr: "",
      exitCode: 0,
    });
    const sandbox = makeSandbox({ runCommand });
    const res = await executeTool(
      "glob",
      { pattern: "*.html" },
      ctx(sandbox),
    );
    expect(res.success).toBe(true);
    expect(res.output).toMatch(/a\.html/);
    const callArgs = runCommand.mock.calls[0]?.[0] as { args?: string[] };
    const shell = callArgs.args?.[1] ?? "";
    expect(shell).toContain("find");
    expect(shell).toContain("*.html");
    expect(shell).toContain("node_modules");
  });

  it("grep: 無結果は (no matches)", async () => {
    const sandbox = makeSandbox({
      runCommand: vi.fn().mockResolvedValue({
        stdout: "",
        stderr: "",
        exitCode: 1,
      }),
    });
    const res = await executeTool(
      "grep",
      { pattern: "xyzw" },
      ctx(sandbox),
    );
    expect(res.success).toBe(true);
    expect(res.output).toBe("(no matches)");
  });

  it("list_dir は ls -1 を実行", async () => {
    const runCommand = vi.fn().mockResolvedValue({
      stdout: "a.html\nb.html\n",
      stderr: "",
      exitCode: 0,
    });
    const sandbox = makeSandbox({ runCommand });
    const res = await executeTool("list_dir", {}, ctx(sandbox));
    expect(res.success).toBe(true);
    expect(res.output).toBe("a.html\nb.html");
  });

  it("未知のツールはエラー返却", async () => {
    const res = await executeTool(
      "unknown_tool",
      {},
      ctx(makeSandbox()),
    );
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/unknown tool/);
  });

  it("引数型違反は Error ではなく ToolResult として失敗返却", async () => {
    const res = await executeTool(
      "read_file",
      { path: 123 as unknown as string },
      ctx(makeSandbox()),
    );
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/path/);
  });
});
