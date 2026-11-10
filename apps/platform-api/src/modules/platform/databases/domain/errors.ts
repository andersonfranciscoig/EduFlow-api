import { DomainError } from "../../../../../../../libs/kernel/src/domain/DomainError";

export type DatabaseErrorCode =
  | "INVALID_SERVER"
  | "INVALID_URL"
  | "ENDPOINT_TAKEN"
  | "SERVER_NOT_FOUND"
  | "CHECK_NOT_FOUND"
  | "ALLOCATION_NOT_FOUND"
  | "SCHOOL_NOT_FOUND"
  | "INVALID_STATE"
  | "NO_CAPACITY"
  | "SERVER_IN_USE";

export type DatabaseError = DomainError<DatabaseErrorCode>;

export const databaseError = (code: DatabaseErrorCode, message: string, meta?: Record<string, unknown>): DatabaseError =>
  new DomainError(code, message, meta);
