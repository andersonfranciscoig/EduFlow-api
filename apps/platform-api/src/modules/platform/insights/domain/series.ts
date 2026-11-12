/**
 * Séries temporais da visão geral. Tudo em hora de Luanda (UTC+1, sem horário
 * de verão): um pagamento às 00:30 de dia 1 conta para o mês novo, não para o anterior.
 */
export const TIME_ZONE = "Africa/Luanda";
const OFFSET_MS = 60 * 60 * 1000;

/** "2026-11" do instante, em hora de Luanda. */
export const monthKey = (at: Date) => new Date(at.getTime() + OFFSET_MS).toISOString().slice(0, 7);
/** "2026-11-12" do instante, em hora de Luanda. */
export const dayKey = (at: Date) => new Date(at.getTime() + OFFSET_MS).toISOString().slice(0, 10);

/** Os últimos `n` meses (o atual incluído), do mais antigo para o mais recente. */
export function lastMonths(now: Date, n: number): string[] {
  const [y, m] = monthKey(now).split("-").map(Number);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - (n - 1 - i), 1));
    return d.toISOString().slice(0, 7);
  });
}

/** Os últimos `n` dias (hoje incluído), do mais antigo para o mais recente. */
export function lastDays(now: Date, n: number): string[] {
  const today = new Date(`${dayKey(now)}T00:00:00Z`).getTime();
  return Array.from({ length: n }, (_, i) => new Date(today - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10));
}

/** Início (instante UTC) do primeiro mês/dia de uma série em hora de Luanda. */
export const monthStart = (key: string) => new Date(Date.parse(`${key}-01T00:00:00Z`) - OFFSET_MS);
export const dayStart = (key: string) => new Date(Date.parse(`${key}T00:00:00Z`) - OFFSET_MS);

/** Preenche os buracos com zeros: a base de dados só devolve os meses/dias com dados. */
export function fill<K extends string, R extends Record<K, number>>(keys: string[], rows: (R & { key: string })[], fields: K[]) {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return keys.map((key) => {
    const row = byKey.get(key);
    return { key, ...Object.fromEntries(fields.map((f) => [f, row ? Number(row[f]) : 0])) } as { key: string } & Record<K, number>;
  });
}

/**
 * Valor mensal de uma subscrição paga: o total (já com desconto) dividido pelos
 * meses que cobre. Uma anual de 120 000 Kz conta 10 000 Kz por mês.
 */
export const monthlyEquivalent = (total: number, months: number) => (months > 0 ? Math.round(total / months) : 0);

/** Variação percentual (null quando não há base de comparação). */
export const change = (current: number, previous: number) => (previous > 0 ? Math.round(((current - previous) / previous) * 1000) / 10 : null);
