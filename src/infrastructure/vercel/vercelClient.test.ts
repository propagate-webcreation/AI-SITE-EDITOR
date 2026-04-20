import { describe, it, expect, vi } from "vitest";
import { VercelClient } from "./vercelClient";

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("VercelClient.waitForDeploymentByCommit", () => {
  it("READY になったら deploy URL を返す", async () => {
    const fetchImpl = vi.fn().mockImplementation(() =>
      Promise.resolve(
        makeJsonResponse({
          deployments: [
            {
              uid: "dep_1",
              readyState: "READY",
              url: "demo-site.vercel.app",
              createdAt: 1000,
              meta: { githubCommitSha: "abcdef1234567890" },
            },
          ],
        }),
      ),
    );

    const client = new VercelClient({
      token: "vt_x",
      pollIntervalMs: 10,
      maxWaitMs: 1000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const url = await client.waitForDeploymentByCommit({
      projectName: "demo-site",
      commitSha: "abcdef1234567890",
    });
    expect(url).toBe("https://demo-site.vercel.app");
  });

  it("ERROR なら例外を投げる", async () => {
    const fetchImpl = vi.fn().mockImplementation(() =>
      Promise.resolve(
        makeJsonResponse({
          deployments: [
            {
              uid: "dep_1",
              readyState: "ERROR",
              createdAt: 1000,
              meta: { githubCommitSha: "abcdef1234567890" },
            },
          ],
        }),
      ),
    );

    const client = new VercelClient({
      token: "vt_x",
      pollIntervalMs: 10,
      maxWaitMs: 1000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      client.waitForDeploymentByCommit({
        projectName: "demo-site",
        commitSha: "abcdef1234567890",
      }),
    ).rejects.toThrow(/ERROR/);
  });

  it("最大待機時間を超えたら例外", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(makeJsonResponse({ deployments: [] })),
      );
    const client = new VercelClient({
      token: "vt_x",
      pollIntervalMs: 10,
      maxWaitMs: 50,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      client.waitForDeploymentByCommit({
        projectName: "demo-site",
        commitSha: "abcdef1234567890",
      }),
    ).rejects.toThrow(/時間内に READY/);
  });

  it("commit_sha が短すぎる場合はエラー", async () => {
    const client = new VercelClient({
      token: "vt_x",
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    await expect(
      client.waitForDeploymentByCommit({
        projectName: "p",
        commitSha: "abc",
      }),
    ).rejects.toThrow(/commit_sha/);
  });
});

describe("VercelClient.verifyDeploymentUrl", () => {
  it("200 なら true", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    const client = new VercelClient({
      token: "vt_x",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await client.verifyDeploymentUrl("https://x.vercel.app")).toBe(true);
  });

  it("500 なら false", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("err", { status: 500 }));
    const client = new VercelClient({
      token: "vt_x",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await client.verifyDeploymentUrl("https://x.vercel.app")).toBe(
      false,
    );
  });

  it("fetch 例外は false", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network"));
    const client = new VercelClient({
      token: "vt_x",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await client.verifyDeploymentUrl("https://x.vercel.app")).toBe(
      false,
    );
  });
});
