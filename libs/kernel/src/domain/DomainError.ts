/**
 * Erro de domínio: uma regra de negócio foi violada.
 * `code` é estável (usado pelo código), `message` é para o utilizador final.
 */
export class DomainError<Code extends string = string> {
  constructor(
    readonly code: Code,
    readonly message: string,
    readonly meta?: Readonly<Record<string, unknown>>,
  ) {}
}
