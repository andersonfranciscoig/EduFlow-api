/**
 * Leituras agregadas para a visão geral do painel. Só contagens e somas —
 * nenhum dado pessoal de colégios ou membros sai daqui.
 */
export interface MonthRow {
  key: string;
}

export interface SchoolFigures {
  byStatus: { status: string; count: number }[];
  /** colégios registados por mês (desde `from`) */
  registered: (MonthRow & { count: number })[];
  /** colégios cujo PRIMEIRO pagamento foi confirmado nesse mês */
  activated: (MonthRow & { count: number })[];
  /** colégios ativos por província */
  byProvince: { province: string; count: number }[];
  /** ativos cuja subscrição termina nos próximos 30 dias */
  expiringSoon: number;
}

export interface BillingFigures {
  /** último pagamento confirmado de cada colégio ATIVO (base da receita recorrente) */
  activeSubscriptions: { planName: string; total: number; months: number }[];
  /** pagamentos confirmados por mês (desde `from`) */
  paid: (MonthRow & { amount: number; count: number })[];
  byMethod: { method: string | null; amount: number; count: number }[];
  outstanding: { amount: number; count: number };
  proofsToCheck: number;
}

export interface TeamFigures {
  members: { role: string; status: string; count: number }[];
  mfaEnabled: number;
  pendingInvitations: number;
  /** entradas (novas sessões) por dia, e quantas pessoas diferentes */
  signIns: (MonthRow & { count: number; people: number })[];
  activeLast7Days: number;
}

export interface DatabaseFigures {
  serversByHealth: { health: string; count: number }[];
  capacity: number;
  assigned: number;
  backups: (MonthRow & { done: number; failed: number })[];
}

export interface OwnAccessFigures {
  mfaEnabledAt: Date | null;
  activeSessions: number;
  lastLoginAt: Date | null;
}

export interface InsightsQuery {
  schools(from: Date, now: Date): Promise<SchoolFigures>;
  billing(from: Date): Promise<BillingFigures>;
  team(from: Date, now: Date): Promise<TeamFigures>;
  databases(from: Date): Promise<DatabaseFigures>;
  ownAccess(staffId: string, now: Date): Promise<OwnAccessFigures>;
}

export const INSIGHTS_TOKENS = { Query: Symbol("InsightsQuery") } as const;
