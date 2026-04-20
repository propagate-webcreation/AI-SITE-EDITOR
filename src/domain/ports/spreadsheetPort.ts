import type { CaseRecord } from "../models/caseRecord";

export interface SpreadsheetPort {
  getCaseByRecordNumber(recordNumber: string): Promise<CaseRecord | null>;

  updatePhaseStatus(params: {
    rowNumber: number;
    status: string;
    expectedRecord?: string;
  }): Promise<void>;
}
