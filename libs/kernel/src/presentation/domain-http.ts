import { HttpException, HttpStatus } from "@nestjs/common";
import type { DomainError } from "../domain/DomainError";

/** Converte um erro de domínio em HTTP, com corpo { code, message, meta }. */
export function domainToHttp<C extends string>(error: DomainError<C>, statusByCode: Partial<Record<C, HttpStatus>>) {
  return new HttpException(
    { code: error.code, message: error.message, meta: error.meta ?? null },
    statusByCode[error.code] ?? HttpStatus.UNPROCESSABLE_ENTITY,
  );
}

/** Desembrulha um Result, lançando o erro HTTP correspondente. */
export function unwrap<T, C extends string>(
  result: { ok: true; value: T } | { ok: false; error: DomainError<C> },
  statusByCode: Partial<Record<C, HttpStatus>>,
): T {
  if (!result.ok) throw domainToHttp(result.error, statusByCode);
  return result.value;
}
