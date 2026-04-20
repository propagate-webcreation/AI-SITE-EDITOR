import { describe, it, expect } from "vitest";
import { InMemorySessionRepository } from "./inMemorySessionRepository";
import { SessionAlreadyActiveError } from "@/domain/ports";

function sampleInput(overrides: Partial<Parameters<InMemorySessionRepository["create"]>[0]> = {}) {
  return {
    directorId: "dir-001",
    recordNumber: "001",
    partnerName: "Feminique",
    contractPlan: "BASIC",
    sandboxId: "sbx_abc",
    previewUrl: "https://sbx.vercel.run",
    githubRepoUrl: "https://github.com/propagate/demo-001",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    ...overrides,
  };
}

describe("InMemorySessionRepository", () => {
  it("新規作成 → active で取得可能", async () => {
    const repo = new InMemorySessionRepository();
    const s = await repo.create(sampleInput());
    expect(s.status).toBe("active");

    const got = await repo.getById(s.id);
    expect(got?.id).toBe(s.id);

    const active = await repo.getActiveByRecordNumber("001");
    expect(active?.id).toBe(s.id);
  });

  it("同 record_number の重複 active は SessionAlreadyActiveError", async () => {
    const repo = new InMemorySessionRepository();
    await repo.create(sampleInput());
    await expect(repo.create(sampleInput({ directorId: "dir-002" }))).rejects.toBeInstanceOf(
      SessionAlreadyActiveError,
    );
  });

  it("closed にすれば同 record_number で再度作成可能", async () => {
    const repo = new InMemorySessionRepository();
    const first = await repo.create(sampleInput());
    await repo.updateStatus({
      id: first.id,
      status: "closed",
      closedAt: new Date(),
    });
    const second = await repo.create(sampleInput({ directorId: "dir-002" }));
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("active");
  });

  it("listActiveByDirector は該当 director のものだけ", async () => {
    const repo = new InMemorySessionRepository();
    await repo.create(sampleInput({ recordNumber: "001" }));
    await repo.create(
      sampleInput({ recordNumber: "002", directorId: "dir-002" }),
    );
    const list = await repo.listActiveByDirector("dir-001");
    expect(list.length).toBe(1);
    expect(list[0]?.recordNumber).toBe("001");
  });
});
