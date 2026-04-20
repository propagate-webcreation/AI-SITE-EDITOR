import { describe, it, expect } from "vitest";
import { GitHubClient, maskTokenInUrl } from "./githubClient";

function makeClient(): GitHubClient {
  return new GitHubClient({
    token: "ghp_TESTTOKEN",
    authorName: "bot",
    authorEmail: "bot@example.com",
    deployBranch: "main",
  });
}

describe("GitHubClient.authenticatedHttpsCloneUrl", () => {
  it("github.com URL に x-access-token を埋め込む", () => {
    const client = makeClient();
    const url = client.authenticatedHttpsCloneUrl(
      "https://github.com/owner/repo",
    );
    expect(url).toBe("https://x-access-token:ghp_TESTTOKEN@github.com/owner/repo.git");
  });

  it(".git が既にあれば重複させない", () => {
    const client = makeClient();
    const url = client.authenticatedHttpsCloneUrl(
      "https://github.com/owner/repo.git",
    );
    expect(url).toBe("https://x-access-token:ghp_TESTTOKEN@github.com/owner/repo.git");
  });

  it("末尾スラッシュを除去する", () => {
    const client = makeClient();
    const url = client.authenticatedHttpsCloneUrl(
      "https://github.com/owner/repo/",
    );
    expect(url).toBe("https://x-access-token:ghp_TESTTOKEN@github.com/owner/repo.git");
  });

  it("github.com 以外のホストはトークンを埋め込まない", () => {
    const client = makeClient();
    const url = client.authenticatedHttpsCloneUrl(
      "https://gitlab.com/owner/repo",
    );
    expect(url).toBe("https://gitlab.com/owner/repo.git");
  });

  it("無効な URL は例外を投げる", () => {
    const client = makeClient();
    expect(() => client.authenticatedHttpsCloneUrl("not-a-url")).toThrow();
  });
});

describe("GitHubClient constructor", () => {
  it("token が空ならエラー", () => {
    expect(
      () =>
        new GitHubClient({
          token: "",
          authorName: "bot",
          authorEmail: "bot@example.com",
          deployBranch: "main",
        }),
    ).toThrow(/token/);
  });

  it("authorName/authorEmail が空ならエラー", () => {
    expect(
      () =>
        new GitHubClient({
          token: "x",
          authorName: "",
          authorEmail: "bot@example.com",
          deployBranch: "main",
        }),
    ).toThrow(/authorName/);
  });
});

describe("maskTokenInUrl", () => {
  it("x-access-token のトークン部をマスクする", () => {
    expect(
      maskTokenInUrl(
        "https://x-access-token:ghp_SECRET@github.com/owner/repo.git",
      ),
    ).toBe("https://x-access-token:****@github.com/owner/repo.git");
  });

  it("トークンが無い URL はそのまま", () => {
    expect(maskTokenInUrl("https://github.com/owner/repo.git")).toBe(
      "https://github.com/owner/repo.git",
    );
  });
});
