/**
 * Result — representa explicitamente sucesso ou falha, sem exceções.
 * Os casos de uso e os value objects devolvem Result em vez de lançar erros,
 * o que torna os fluxos de erro visíveis no sistema de tipos.
 */
export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const fail = <E>(error: E): Result<never, E> => ({ ok: false, error });
