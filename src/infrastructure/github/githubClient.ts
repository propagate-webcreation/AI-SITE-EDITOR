import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import type { GitHubPort, GitHubPushResult } from "@/domain/ports";

const execFileAsync = promisify(execFile);

export interface GitHubClientConfig {
  token: string;
  authorName: string;
  authorEmail: string;
  deployBranch: string;
}

export class GitHubClient implements GitHubPort {
  constructor(private readonly config: GitHubClientConfig) {
    if (!config.token) {
      throw new Error("GitHubClient: token が未設定です。");
    }
    if (!config.authorName || !config.authorEmail) {
      throw new Error(
        "GitHubClient: authorName / authorEmail が未設定です。" +
          "Vercel team に紐付いたアカウントを設定してください。",
      );
    }
  }

  authenticatedHttpsCloneUrl(cloneUrl: string): string {
    const raw = this.ensureGitSuffix((cloneUrl ?? "").trim().replace(/\/$/, ""));
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error(`GitHubClient: 無効な URL です: ${raw}`);
    }
    if (!parsed.hostname.toLowerCase().includes("github.com")) {
      return raw;
    }
    parsed.username = "x-access-token";
    parsed.password = this.config.token;
    return parsed.toString();
  }

  async shallowCloneRepoIntoSiteDir(params: {
    repoUrl: string;
    siteDir: string;
  }): Promise<void> {
    await rm(params.siteDir, { recursive: true, force: true });
    await mkdir(params.siteDir, { recursive: true });

    const authed = this.authenticatedHttpsCloneUrl(params.repoUrl);
    await this.runGit([
      "clone",
      "--depth",
      "1",
      "--branch",
      this.config.deployBranch,
      authed,
      params.siteDir,
    ]);

    await this.runGit(
      ["config", "user.name", this.config.authorName],
      params.siteDir,
    );
    await this.runGit(
      ["config", "user.email", this.config.authorEmail],
      params.siteDir,
    );
  }

  async pushToGitHubForce(params: {
    siteDir: string;
    repoUrl: string;
    commitMessage: string;
  }): Promise<GitHubPushResult> {
    await this.runGit(["add", "-A"], params.siteDir);

    const status = await this.runGit(
      ["status", "--porcelain"],
      params.siteDir,
    );
    if (status.trim().length === 0) {
      throw new Error(
        "GitHubClient: 変更がありません。commit する内容がないため push を中止します。",
      );
    }

    await this.runGit(
      ["commit", "-m", params.commitMessage],
      params.siteDir,
    );

    const authed = this.authenticatedHttpsCloneUrl(params.repoUrl);
    await this.runGit(
      ["push", "--force", authed, `HEAD:${this.config.deployBranch}`],
      params.siteDir,
    );

    const commitSha = (
      await this.runGit(["rev-parse", "HEAD"], params.siteDir)
    ).trim();

    return {
      commitSha,
      branch: this.config.deployBranch,
    };
  }

  private ensureGitSuffix(url: string): string {
    return url.toLowerCase().endsWith(".git") ? url : `${url}.git`;
  }

  private async runGit(args: string[], cwd?: string): Promise<string> {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    return stdout;
  }
}

export function maskTokenInUrl(url: string): string {
  return url.replace(/(x-access-token:)[^@]+(@)/g, "$1****$2");
}
