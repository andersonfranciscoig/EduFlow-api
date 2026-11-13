import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";

/**
 * PERMISSÕES granulares do portal — independentes do papel (Direção, Secretaria…).
 * O responsável do colégio tem todas; os outros só as que o responsável lhes der.
 * Validadas SEMPRE no backend (o menu do portal só esconde o que não se pode usar).
 */
export const PERMISSIONS = {
  "hr.access": { group: "hr", label: "Aceder aos Recursos Humanos", hint: "Sem esta, nenhuma das outras do RH funciona." },
  "hr.registration_requests.view": { group: "hr", label: "Ver pedidos de cadastro", hint: "Consultar quem pediu para se cadastrar." },
  "hr.registration_requests.approve": { group: "hr", label: "Aprovar pedidos de cadastro", hint: "Aprovar e enviar o convite por email." },
  "hr.registration_requests.reject": { group: "hr", label: "Rejeitar pedidos de cadastro", hint: "Recusar um pedido, com justificação." },
  "hr.employees.view": { group: "hr", label: "Consultar funcionários", hint: "Ver fichas, documentos e histórico." },
  "hr.employees.create": { group: "hr", label: "Cadastrar funcionários", hint: "Criar um cadastro sem pedido do funcionário." },
  "hr.employees.edit": { group: "hr", label: "Editar funcionários", hint: "Alterar dados e o estado do vínculo." },
  "hr.employees.approve": { group: "hr", label: "Aprovar cadastros", hint: "Aprovar ou pedir correções a um cadastro submetido." },
  "hr.employees.reject": { group: "hr", label: "Rejeitar cadastros", hint: "Recusar um cadastro submetido." },
  "hr.settings.manage": { group: "hr", label: "Configurar o formulário", hint: "Campos da formação e dos dados profissionais; publicar versões." },
  "hr.documents.manage": { group: "hr", label: "Configurar os documentos", hint: "Documentos pedidos, formatos e tamanhos." },
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export const PERMISSION_GROUPS = [{ key: "hr", label: "Recursos Humanos", permissions: ALL_PERMISSIONS.filter((p) => PERMISSIONS[p].group === "hr") }];

/**
 * Sessões de SUPORTE EduFlow: podem ajudar a configurar o formulário (sem dados
 * pessoais de ninguém) — e continuam só de leitura, salvo modo de edição.
 */
export const SUPPORT_PERMISSIONS: Permission[] = ["hr.access", "hr.settings.manage", "hr.documents.manage"];

export const isPermission = (p: string): p is Permission => p in PERMISSIONS;

/**
 * Lista a gravar: só permissões conhecidas, sem repetidas; qualquer permissão do RH
 * traz consigo "hr.access" (sem ela as outras não serviriam de nada).
 */
export function normalizePermissions(list: string[]): Result<Permission[], { code: "INVALID_PERMISSION"; message: string }> {
  const unknown = list.find((p) => !isPermission(p));
  if (unknown) return fail({ code: "INVALID_PERMISSION", message: `Permissão desconhecida: ${unknown}.` });
  const set = new Set(list as Permission[]);
  if ([...set].some((p) => p.startsWith("hr."))) set.add("hr.access");
  return ok(ALL_PERMISSIONS.filter((p) => set.has(p)));
}
