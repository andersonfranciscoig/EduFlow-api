/**
 * Cópias de segurança das BDs dos colégios — a mesma regra para a API (o que
 * se mostra no painel) e para o provisioner (o que se faz).
 */
export const BACKUP_POLICY = {
  /** Cópia automática de cada colégio, de X em X horas. */
  EVERY_HOURS: 24,
  /** Quanto tempo se guarda cada cópia. */
  RETENTION_DAYS: 30,
} as const;
