import { describe, it, expect } from "vitest";
import { InMemorySpreadsheet } from "./inMemorySpreadsheet";
import type { CaseRecord } from "@/domain/models";
import { EVALUATION_STATUS_DONE } from "@/domain/models";

function sampleRow(overrides: Partial<CaseRecord> = {}): CaseRecord {
  return {
    rowNumber: 10,
    recordNumber: "001",
    partnerName: "Feminique",
    contractPlan: "BASIC",
    phaseStatus: "デモサイト評価中",
    githubRepoUrl: "https://github.com/propagate/demo-001",
    ...overrides,
  };
}

describe("InMemorySpreadsheet.getCaseByRecordNumber", () => {
  it("一致する record を返す", async () => {
    const sheet = new InMemorySpreadsheet([sampleRow()]);
    const row = await sheet.getCaseByRecordNumber("001");
    expect(row?.partnerName).toBe("Feminique");
  });
  it("存在しない record は null", async () => {
    const sheet = new InMemorySpreadsheet([sampleRow()]);
    expect(await sheet.getCaseByRecordNumber("999")).toBeNull();
  });
});

describe("InMemorySpreadsheet.updatePhaseStatus", () => {
  it("phase status を更新できる", async () => {
    const sheet = new InMemorySpreadsheet([sampleRow()]);
    await sheet.updatePhaseStatus({
      rowNumber: 10,
      status: EVALUATION_STATUS_DONE,
    });
    expect(sheet.peek(10)?.phaseStatus).toBe(EVALUATION_STATUS_DONE);
  });

  it("expectedRecord 不一致で例外", async () => {
    const sheet = new InMemorySpreadsheet([sampleRow()]);
    await expect(
      sheet.updatePhaseStatus({
        rowNumber: 10,
        status: EVALUATION_STATUS_DONE,
        expectedRecord: "002",
      }),
    ).rejects.toThrow(/一致しません/);
  });

  it("存在しない行への更新は例外", async () => {
    const sheet = new InMemorySpreadsheet([]);
    await expect(
      sheet.updatePhaseStatus({ rowNumber: 999, status: "x" }),
    ).rejects.toThrow(/存在しません/);
  });
});
