/**
 * Níveis de acesso da equipa interna EduFlow.
 *
 * - ADMIN: acesso total (todas as permissões, sempre).
 * - GESTOR: só as permissões do papel + as que um admin lhe atribuir.
 *
 * Permissões efetivas = permissões do papel ∪ permissões extra do membro.
 */
export const STAFF_ROLES = ["ADMIN", "GESTOR"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const STAFF_STATUSES = ["PENDING_APPROVAL", "ACTIVE", "SUSPENDED"] as const;
export type StaffStatus = (typeof STAFF_STATUSES)[number];

/** Catálogo de permissões (a ordem é a usada na interface). */
export const PERMISSION_CATALOG = [
  { key: "schools.view", group: "Colégios", label: "Ver colégios", description: "Consultar a lista e os dados dos colégios clientes." },
  { key: "schools.manage", group: "Colégios", label: "Gerir colégios", description: "Criar, editar e desativar colégios." },
  { key: "staff.view", group: "Equipa", label: "Ver equipa", description: "Consultar os membros da equipa e o seu histórico." },
  { key: "staff.manage", group: "Equipa", label: "Gerir equipa", description: "Aprovar, desativar e atribuir permissões a gestores." },
  { key: "billing.view", group: "Faturação", label: "Ver faturação", description: "Consultar planos, faturas e pagamentos." },
  { key: "billing.manage", group: "Faturação", label: "Gerir faturação", description: "Alterar planos, emitir e anular faturas." },
  { key: "databases.view", group: "Bases de dados", label: "Ver bases de dados", description: "Consultar servidores, ocupação e testar ligações." },
  { key: "databases.manage", group: "Bases de dados", label: "Gerir bases de dados", description: "Registar servidores, trocar credenciais e atribuir colégios." },
  { key: "settings.manage", group: "Definições", label: "Gerir definições", description: "Alterar as definições gerais da plataforma." },
] as const;

export type Permission = (typeof PERMISSION_CATALOG)[number]["key"];
export const PERMISSIONS = PERMISSION_CATALOG.map((p) => p.key) as Permission[];

const ROLE_PERMISSIONS: Record<StaffRole, readonly Permission[]> = {
  ADMIN: PERMISSIONS,
  GESTOR: [], // por omissão nada — um admin atribui caso a caso
};

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as string[]).includes(value);
}

export function rolePermissions(role: StaffRole): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}

export function effectivePermissions(role: StaffRole, extra: readonly Permission[]): Permission[] {
  const set = new Set<Permission>([...ROLE_PERMISSIONS[role], ...extra]);
  return PERMISSIONS.filter((p) => set.has(p));
}

/** Mantido por compatibilidade: verifica só o papel (sem permissões extra). */
export function roleHasPermission(role: StaffRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export const ROLE_LABELS: Record<StaffRole, string> = {
  ADMIN: "Administrador",
  GESTOR: "Gestor",
};

export const STATUS_LABELS: Record<StaffStatus, string> = {
  PENDING_APPROVAL: "A aguardar aprovação",
  ACTIVE: "Ativo",
  SUSPENDED: "Desativado",
};
