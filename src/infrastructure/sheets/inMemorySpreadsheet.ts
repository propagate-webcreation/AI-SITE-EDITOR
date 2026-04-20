import type { CaseRecord } from "@/domain/models";
import type { SpreadsheetPort } from "@/domain/ports";

export class InMemorySpreadsheet implements SpreadsheetPort {
  private readonly rows: Map<number, CaseRecord>;

  constructor(initialRows: CaseRecord[] = []) {
    this.rows = new Map();
    for (const row of initialRows) {
      this.rows.set(row.rowNumber, { ...row });
    }
  }

  async getCaseByRecordNumber(recordNumber: string): Promise<CaseRecord | null> {
    for (const row of this.rows.values()) {
      if (row.recordNumber === recordNumber) {
        return { ...row };
      }
    }
    return null;
  }

  async updatePhaseStatus(params: {
    rowNumber: number;
    status: string;
    expectedRecord?: string;
  }): Promise<void> {
    const row = this.rows.get(params.rowNumber);
    if (!row) {
      throw new Error(
        `InMemorySpreadsheet: 行 ${params.rowNumber} が存在しません。`,
      );
    }
    if (params.expectedRecord && row.recordNumber !== params.expectedRecord) {
      throw new Error(
        `InMemorySpreadsheet: 行 ${params.rowNumber} の record が一致しません expected=${params.expectedRecord} actual=${row.recordNumber}`,
      );
    }
    this.rows.set(params.rowNumber, { ...row, phaseStatus: params.status });
  }

  peek(rowNumber: number): CaseRecord | undefined {
    const row = this.rows.get(rowNumber);
    return row ? { ...row } : undefined;
  }
}
