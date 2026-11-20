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
  "hr.contracts.view": { group: "hr", label: "Consultar contratos", hint: "Ver os contratos dos funcionários (sem o salário)." },
  "hr.contracts.manage": { group: "hr", label: "Gerir contratos", hint: "Criar, alterar, renovar e rescindir contratos; juntar a cópia assinada." },
  "hr.contracts.salary": { group: "hr", label: "Ver e definir salários", hint: "O salário base de cada contrato. Informação sensível." },
  "hr.attendance.view": { group: "hr", label: "Consultar a assiduidade", hint: "Ver as presenças, faltas e atrasos e o mapa mensal." },
  "hr.attendance.manage": { group: "hr", label: "Registar a assiduidade", hint: "Marcar presenças, atrasos e faltas; juntar comprovativos." },
  "hr.settings.manage": { group: "hr", label: "Configurar o formulário", hint: "Campos da formação e dos dados profissionais; publicar versões." },
  "hr.documents.manage": { group: "hr", label: "Configurar os documentos", hint: "Documentos pedidos, formatos e tamanhos." },
  // ---- Secretaria: inscrições e matrículas (as restantes chegam com cada fase)
  "admissions.access": { group: "admissions", label: "Aceder às inscrições e matrículas", hint: "Sem esta, nenhuma das outras das inscrições funciona." },
  "admissions.settings.manage": { group: "admissions", label: "Configurar os períodos", hint: "Quando abrem e fecham as inscrições, as matrículas e as renovações." },
  "admissions.documents.manage": { group: "admissions", label: "Configurar os documentos", hint: "Documentos pedidos ao aluno e ao encarregado, formatos e regras." },
  "admissions.forms.manage": { group: "admissions", label: "Configurar os formulários", hint: "Dados do aluno e do encarregado, secções e campos do colégio, condições; publicar versões." },
  "admissions.applications.view": { group: "admissions", label: "Consultar as inscrições", hint: "Ver as inscrições submetidas, os dados do aluno e do encarregado e os documentos." },
  "admissions.applications.review": { group: "admissions", label: "Analisar as inscrições", hint: "Começar a análise, pedir correções à família, aprovar e rejeitar." },
  "admissions.enrollments.manage": { group: "admissions", label: "Confirmar matrículas", hint: "Matricular as inscrições aprovadas: turma, n.º de matrícula e comprovativo." },
  "admissions.students.view": { group: "admissions", label: "Consultar os alunos", hint: "A lista e a ficha dos alunos: dados pessoais, encarregados, matrículas, inscrições e documentos." },
  "admissions.students.edit": { group: "admissions", label: "Alterar os dados dos alunos", hint: "Corrigir os dados pessoais do aluno (fica no histórico o que mudou)." },
  "admissions.enrollments.override": { group: "admissions", label: "Matricular sem vaga (exceção)", hint: "Matricular mesmo sem vaga ou com a turma cheia, com um motivo registado." },
  // ---- Assiduidade e avaliação: presenças, ocorrências dos professores, provas (as restantes chegam com cada fase)
  "attendance.access": { group: "attendance", label: "Aceder à assiduidade e avaliação", hint: "Sem esta, nenhuma das outras da assiduidade funciona." },
  "attendance.settings.manage": { group: "attendance", label: "Configurar as regras de assiduidade", hint: "Modelo dos professores (por aula ou por dia), procedimento sem presenças, prazo, alertas e fuso horário." },
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];
type Group = (typeof PERMISSIONS)[Permission]["group"];

/** Cada grupo tem uma permissão de acesso: sem ela, as outras do grupo não servem. */
export const GROUP_ACCESS: Record<Group, Permission> = { hr: "hr.access", admissions: "admissions.access", attendance: "attendance.access" };

export const PERMISSION_GROUPS = (
  [
    { key: "hr", label: "Recursos Humanos" },
    { key: "admissions", label: "Inscrições e matrículas" },
    { key: "attendance", label: "Assiduidade e avaliação" },
  ] as const
).map((g) => ({ ...g, permissions: ALL_PERMISSIONS.filter((p) => PERMISSIONS[p].group === g.key) }));

/** A permissão de acesso do grupo de uma permissão (ex.: hr.settings.manage → hr.access). */
export const accessOf = (p: Permission) => GROUP_ACCESS[PERMISSIONS[p].group];

/**
 * Sessões de SUPORTE EduFlow: podem ajudar a configurar os formulários e os períodos
 * (sem dados pessoais de ninguém) — e continuam só de leitura, salvo modo de edição.
 */
export const SUPPORT_PERMISSIONS: Permission[] = ["hr.access", "hr.settings.manage", "hr.documents.manage", "admissions.access", "admissions.settings.manage", "admissions.documents.manage", "admissions.forms.manage", "attendance.access", "attendance.settings.manage"];

export const isPermission = (p: string): p is Permission => p in PERMISSIONS;

/**
 * Lista a gravar: só permissões conhecidas, sem repetidas; qualquer permissão de um grupo
 * traz consigo a de acesso desse grupo (sem ela as outras não serviriam de nada).
 */
export function normalizePermissions(list: string[]): Result<Permission[], { code: "INVALID_PERMISSION"; message: string }> {
  const unknown = list.find((p) => !isPermission(p));
  if (unknown) return fail({ code: "INVALID_PERMISSION", message: `Permissão desconhecida: ${unknown}.` });
  const set = new Set(list as Permission[]);
  for (const p of [...set]) set.add(accessOf(p));
  return ok(ALL_PERMISSIONS.filter((p) => set.has(p)));
}
