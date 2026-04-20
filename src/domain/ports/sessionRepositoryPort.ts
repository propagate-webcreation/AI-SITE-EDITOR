import type { CreateSessionInput, Session, SessionStatus } from "../models/session";

export interface SessionRepositoryPort {
  /**
   * 新規セッションを作成する。
   * 同 record_number で active なセッションが存在する場合は
   * UniqueConstraintViolation を投げる (DB 側の unique index で保証)。
   */
  create(input: CreateSessionInput): Promise<Session>;

  getById(id: string): Promise<Session | null>;

  /**
   * 指定 record_number の active なセッションを返す。無ければ null。
   * 「誰か他の人が今作業中か」を判定する用途。
   */
  getActiveByRecordNumber(recordNumber: string): Promise<Session | null>;

  listActiveByDirector(directorId: string): Promise<Session[]>;

  updateStatus(params: {
    id: string;
    status: SessionStatus;
    errorMessage?: string;
    closedAt?: Date;
  }): Promise<void>;

  /**
   * セッション行を物理削除する (instruction_applications / corrections は
   * FK の on delete cascade により自動で一緒に消える)。
   * 「案件を閉じる」で呼ばれる想定。directors / auth.users には影響しない。
   */
  deleteById(id: string): Promise<void>;

  /**
   * director_id から email を逆引きする。見つからなければ null。
   * 主にセッション競合時に「誰が作業中か」を UI 表示するために使う。
   */
  getDirectorEmail(directorId: string): Promise<string | null>;
}

export class SessionAlreadyActiveError extends Error {
  constructor(
    public readonly recordNumber: string,
    public readonly occupiedByDirectorId: string,
  ) {
    super(
      `レコード ${recordNumber} は別のディレクターが作業中です。`,
    );
    this.name = "SessionAlreadyActiveError";
  }
}
