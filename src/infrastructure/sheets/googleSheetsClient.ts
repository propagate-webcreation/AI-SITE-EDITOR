import { readFileSync } from "node:fs";
import { google, type sheets_v4 } from "googleapis";
import { JWT } from "google-auth-library";
import type { CaseRecord } from "@/domain/models";
import type { SpreadsheetPort } from "@/domain/ports";

/**
 * シート 1 行目のヘッダー文字列 → CaseRecord のフィールド名。
 * 旧システムの SPREADSHEET_HEADER_LABELS と一致させてある。
 */
export interface GoogleSheetsHeaderLabels {
  recordNumber: string;
  partnerName: string;
  contractPlan: string;
  phaseStatus: string;
  githubRepoUrl: string;
  deployUrl: string;
}

export const DEFAULT_HEADER_LABELS: GoogleSheetsHeaderLabels = {
  recordNumber: "record_id",
  partnerName: "client_name",
  contractPlan: "plan_type",
  phaseStatus: "overall_status",
  githubRepoUrl: "git_repo_url",
  deployUrl: "test_url",
};

export interface GoogleSheetsClientConfig {
  spreadsheetId: string;
  sheetName: string;
  credentialsPath?: string;
  credentialsJson?: string;
  headerLabels?: GoogleSheetsHeaderLabels;
}

type ColumnIndexMap = Record<keyof GoogleSheetsHeaderLabels, number>;

interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
}

export class GoogleSheetsClient implements SpreadsheetPort {
  private readonly sheetsApi: sheets_v4.Sheets;
  private readonly headerLabels: GoogleSheetsHeaderLabels;
  private columnIndexCache: ColumnIndexMap | null = null;

  constructor(private readonly config: GoogleSheetsClientConfig) {
    const credentials = resolveServiceAccountCredentials(config);
    const jwt = new JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    this.sheetsApi = google.sheets({ version: "v4", auth: jwt });
    this.headerLabels = config.headerLabels ?? DEFAULT_HEADER_LABELS;
  }

  async getCaseByRecordNumber(recordNumber: string): Promise<CaseRecord | null> {
    const columns = await this.resolveColumns();
    const rows = await this.readDataRows();
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      if (!row) continue;
      const cellRecord = cellAt(row, columns.recordNumber);
      if (cellRecord === recordNumber) {
        return this.rowToCase(i + 2, row, columns);
      }
    }
    return null;
  }

  async updatePhaseStatus(params: {
    rowNumber: number;
    status: string;
    expectedRecord?: string;
  }): Promise<void> {
    const columns = await this.resolveColumns();
    if (params.expectedRecord) {
      const actual = await this.readCell(params.rowNumber, columns.recordNumber);
      if (actual !== params.expectedRecord) {
        throw new Error(
          `GoogleSheetsClient: 行 ${params.rowNumber} の record が一致しません expected=${params.expectedRecord} actual=${actual}`,
        );
      }
    }
    const range = `${this.config.sheetName}!${indexToColumnLetter(columns.phaseStatus)}${params.rowNumber}`;
    await this.sheetsApi.spreadsheets.values.update({
      spreadsheetId: this.config.spreadsheetId,
      range,
      valueInputOption: "RAW",
      requestBody: { values: [[params.status]] },
    });
  }

  private async resolveColumns(): Promise<ColumnIndexMap> {
    if (this.columnIndexCache) return this.columnIndexCache;
    const resp = await this.sheetsApi.spreadsheets.values.get({
      spreadsheetId: this.config.spreadsheetId,
      range: `${this.config.sheetName}!1:1`,
    });
    const header = (resp.data.values?.[0] ?? []) as string[];
    const find = (label: string): number => {
      const idx = header.findIndex(
        (v) => typeof v === "string" && v.trim() === label,
      );
      if (idx < 0) {
        throw new Error(
          `GoogleSheetsClient: シート 1 行目にヘッダー "${label}" が見つかりません。`,
        );
      }
      return idx;
    };
    const map: ColumnIndexMap = {
      recordNumber: find(this.headerLabels.recordNumber),
      partnerName: find(this.headerLabels.partnerName),
      contractPlan: find(this.headerLabels.contractPlan),
      phaseStatus: find(this.headerLabels.phaseStatus),
      githubRepoUrl: find(this.headerLabels.githubRepoUrl),
      deployUrl: find(this.headerLabels.deployUrl),
    };
    this.columnIndexCache = map;
    return map;
  }

  private async readDataRows(): Promise<string[][]> {
    // AI 列や AJ 列にフィールドがあるため、ZZ (26*26 = 最大 702 列) まで読む。
    const resp = await this.sheetsApi.spreadsheets.values.get({
      spreadsheetId: this.config.spreadsheetId,
      range: `${this.config.sheetName}!A2:ZZ`,
    });
    return (resp.data.values ?? []) as string[][];
  }

  private async readCell(rowNumber: number, columnIndex: number): Promise<string> {
    const letter = indexToColumnLetter(columnIndex);
    const range = `${this.config.sheetName}!${letter}${rowNumber}`;
    const resp = await this.sheetsApi.spreadsheets.values.get({
      spreadsheetId: this.config.spreadsheetId,
      range,
    });
    const values = resp.data.values ?? [];
    const first = values[0];
    return first && typeof first[0] === "string" ? first[0] : "";
  }

  private rowToCase(
    rowNumber: number,
    row: string[],
    columns: ColumnIndexMap,
  ): CaseRecord {
    const deployUrl = cellAt(row, columns.deployUrl);
    return {
      rowNumber,
      recordNumber: cellAt(row, columns.recordNumber),
      partnerName: cellAt(row, columns.partnerName),
      contractPlan: cellAt(row, columns.contractPlan),
      phaseStatus: cellAt(row, columns.phaseStatus),
      githubRepoUrl: cellAt(row, columns.githubRepoUrl),
      deployUrl: deployUrl || undefined,
    };
  }
}

function cellAt(row: string[], index: number): string {
  const v = row[index];
  return typeof v === "string" ? v : "";
}

function resolveServiceAccountCredentials(
  config: GoogleSheetsClientConfig,
): ServiceAccountCredentials {
  if (config.credentialsJson) {
    return parseServiceAccountJson(config.credentialsJson, "GOOGLE_SHEETS_CREDENTIALS_JSON");
  }
  if (config.credentialsPath) {
    const raw = readFileSync(config.credentialsPath, "utf8");
    return parseServiceAccountJson(raw, config.credentialsPath);
  }
  throw new Error(
    "GoogleSheetsClient: credentialsJson または credentialsPath のいずれかが必要です。",
  );
}

function parseServiceAccountJson(raw: string, source: string): ServiceAccountCredentials {
  let parsed: Partial<ServiceAccountCredentials>;
  try {
    parsed = JSON.parse(raw) as Partial<ServiceAccountCredentials>;
  } catch (error) {
    throw new Error(
      `GoogleSheetsClient: ${source} の JSON 解析に失敗しました: ${(error as Error).message}`,
    );
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error(
      `GoogleSheetsClient: ${source} に client_email / private_key が含まれていません。`,
    );
  }
  return {
    client_email: parsed.client_email,
    private_key: parsed.private_key.replace(/\\n/g, "\n"),
  };
}

export function indexToColumnLetter(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`indexToColumnLetter: 負のインデックス: ${index}`);
  }
  let n = index + 1;
  let result = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    result = String.fromCharCode("A".charCodeAt(0) + rem) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}
