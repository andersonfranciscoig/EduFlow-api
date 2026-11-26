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
  "hr.doc_types.manage": { group: "hr", label: "Configurar os documentos dos funcionários", hint: "Que declarações e documentos profissionais os funcionários podem pedir, como se emitem e em que prazo." },
  "hr.doc_requests.view": { group: "hr", label: "Consultar os pedidos de documentos dos funcionários", hint: "Ver os pedidos de declarações e documentos profissionais e o seu histórico." },
  "hr.doc_requests.process": { group: "hr", label: "Tratar os pedidos de documentos dos funcionários", hint: "Analisar, preparar, rejeitar (com motivo) e marcar como pronto; registar pedidos em nome de um funcionário." },
  "hr.doc_requests.deliver": { group: "hr", label: "Entregar documentos aos funcionários", hint: "Confirmar o levantamento, com quem recebeu." },
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
  // ---- Finanças: pagamentos (o preçário continua a ser da direção)
  "finance.access": { group: "finance", label: "Aceder às finanças", hint: "Sem esta, nenhuma das outras das finanças funciona." },
  "finance.settings.manage": { group: "finance", label: "Configurar os pagamentos", hint: "Formas de pagamento, coordenadas bancárias do colégio e pedidos à EduFlow." },
  "finance.payments.view": { group: "finance", label: "Consultar pagamentos e cobranças", hint: "Ver o que cada aluno tem a pagar, os pagamentos e os comprovativos." },
  "finance.payments.validate": { group: "finance", label: "Validar pagamentos", hint: "Validar ou recusar os pagamentos (e anular uma validação), com motivo." },
  "finance.charges.manage": { group: "finance", label: "Isentar cobranças e registar pagamentos", hint: "Isentar uma cobrança, com motivo, e registar pagamentos entregues em mão." },
  "finance.expenses.view": { group: "finance", label: "Consultar despesas", hint: "Ver as despesas do colégio e os seus comprovativos." },
  "finance.expenses.manage": { group: "finance", label: "Gerir despesas", hint: "Registar, pagar e anular despesas (com motivo) e gerir as categorias." },
  "finance.reports.view": { group: "finance", label: "Painel e relatórios das finanças", hint: "Receitas, dívidas, despesas, resultado e isenções, com gráficos e exportação." },
  // ---- Assiduidade e provas: presenças, ocorrências dos professores, provas (as restantes chegam com cada fase)
  "attendance.access": { group: "attendance", label: "Aceder à assiduidade e provas", hint: "Sem esta, nenhuma das outras da assiduidade funciona." },
  "attendance.settings.manage": { group: "attendance", label: "Configurar as regras de assiduidade", hint: "Modelo dos professores (por aula ou por dia), procedimento sem presenças, prazo, alertas e fuso horário." },
  "attendance.teachers.view": { group: "attendance", label: "Consultar a assiduidade dos professores", hint: "Ver as faltas e atrasos dos professores (marcados pelo RH ou automáticos) e o histórico." },
  "attendance.students.view": { group: "attendance", label: "Consultar as presenças dos alunos", hint: "Ver as aulas registadas de cada turma e a assiduidade de cada aluno." },
  "attendance.students.edit": { group: "attendance", label: "Corrigir as presenças dos alunos", hint: "Alterar presenças já registadas (depois do prazo do professor), sempre com motivo." },
  "attendance.teachers.manage": { group: "attendance", label: "Gerir as faltas dos professores", hint: "Marcar faltas e atrasos, justificar, alterar, anular e reabrir — sempre com o motivo." },
  "attendance.reports.view": { group: "attendance", label: "Consultar os relatórios de assiduidade", hint: "O painel da pedagogia: presença por turma e disciplina, alunos com mais faltas, aulas sem registo e provas." },
  "attendance.exams.view": { group: "attendance", label: "Consultar o calendário de provas", hint: "Ver as provas de cada período, mesmo em preparação, e o histórico." },
  "attendance.exams.manage": { group: "attendance", label: "Gerir o calendário de provas", hint: "Definir as provas de cada período, as turmas e disciplinas, e marcar, alterar ou retirar provas." },
  "attendance.exams.generate": { group: "attendance", label: "Gerar o calendário automaticamente", hint: "Pedir ao sistema uma proposta de calendário e usá-la (fica em preparação, para rever e publicar)." },
  "attendance.exams.publish": { group: "attendance", label: "Publicar o calendário de provas", hint: "Publicar para professores e famílias; com a gestão, também alterar ou cancelar o que já está publicado." },
  // ---- Avaliação e pautas: critérios (as restantes chegam com cada fase)
  "grading.access": { group: "grading", label: "Aceder à avaliação e pautas", hint: "Consultar os critérios de avaliação, as cadernetas e o estado das classificações. Sem esta, nenhuma das outras da avaliação funciona." },
  "grading.settings.manage": { group: "grading", label: "Configurar os critérios de avaliação", hint: "Modelos, componentes e pesos, elementos de avaliação e a que classes e disciplinas se aplicam." },
  "grading.results.validate": { group: "grading", label: "Validar as classificações", hint: "Validar ou devolver ao professor as classificações submetidas (o diretor de turma valida as da sua turma sem esta permissão)." },
  "grading.results.publish": { group: "grading", label: "Publicar as classificações", hint: "Publicar as classificações validadas de cada turma e período: só então as famílias as veem." },
  "grading.results.rectify": { group: "grading", label: "Abrir retificações", hint: "Reabrir classificações já publicadas para o professor as corrigir, com o motivo; voltam a ser validadas e publicadas." },
  // ---- Documentos dos alunos (secretaria e pedagogia); os dos funcionários são do RH (hr.doc_*)
  "documents.access": { group: "documents", label: "Aceder aos pedidos de documentos", hint: "Sem esta, nenhuma das outras dos documentos funciona." },
  "documents.settings.manage": { group: "documents", label: "Configurar os documentos dos alunos", hint: "Que documentos os alunos e encarregados podem pedir, como se emitem, prazos e campos." },
  "documents.requests.view": { group: "documents", label: "Consultar os pedidos de documentos", hint: "Ver os pedidos dos alunos e encarregados e o seu histórico." },
  "documents.requests.process": { group: "documents", label: "Tratar os pedidos de documentos", hint: "Analisar, preparar, rejeitar (com motivo) e marcar como pronto; registar pedidos ao balcão." },
  "documents.requests.deliver": { group: "documents", label: "Entregar documentos", hint: "Confirmar o levantamento, com quem recebeu e a relação com o aluno." },
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];
type Group = (typeof PERMISSIONS)[Permission]["group"];

/** Cada grupo tem uma permissão de acesso: sem ela, as outras do grupo não servem. */
export const GROUP_ACCESS: Record<Group, Permission> = { hr: "hr.access", admissions: "admissions.access", finance: "finance.access", attendance: "attendance.access", grading: "grading.access", documents: "documents.access" };

export const PERMISSION_GROUPS = (
  [
    { key: "hr", label: "Recursos Humanos" },
    { key: "admissions", label: "Inscrições e matrículas" },
    { key: "finance", label: "Finanças" },
    { key: "attendance", label: "Assiduidade e provas" },
    { key: "grading", label: "Avaliação e pautas" },
    { key: "documents", label: "Documentos" },
  ] as const
).map((g) => ({ ...g, permissions: ALL_PERMISSIONS.filter((p) => PERMISSIONS[p].group === g.key) }));

/** A permissão de acesso do grupo de uma permissão (ex.: hr.settings.manage → hr.access). */
export const accessOf = (p: Permission) => GROUP_ACCESS[PERMISSIONS[p].group];

/**
 * Sessões de SUPORTE EduFlow: podem ajudar a configurar os formulários e os períodos
 * (sem dados pessoais de ninguém) — e continuam só de leitura, salvo modo de edição.
 */
export const SUPPORT_PERMISSIONS: Permission[] = ["hr.access", "hr.settings.manage", "hr.documents.manage", "admissions.access", "admissions.settings.manage", "admissions.documents.manage", "admissions.forms.manage", "attendance.access", "attendance.settings.manage", "finance.access", "finance.settings.manage", "grading.access", "grading.settings.manage", "documents.access", "documents.settings.manage", "hr.doc_types.manage"];

export const isPermission = (p: string): p is Permission => p in PERMISSIONS;

/**
 * As permissões do RH: o grupo hr e as faltas dos professores (com o acesso à assiduidade, que elas
 * pedem). São as sugeridas para o papel Recursos Humanos; o responsável pode juntar outras.
 */
export const HR_ROLE_PERMISSIONS: Permission[] = [...ALL_PERMISSIONS.filter((p) => PERMISSIONS[p].group === "hr"), "attendance.access", "attendance.teachers.view", "attendance.teachers.manage"];
/** O que o RH recebe por omissão quando o responsável lhe dá acesso a partir da ficha (o salário não: é sensível). */
export const HR_ROLE_DEFAULTS: Permission[] = HR_ROLE_PERMISSIONS.filter((p) => p !== "hr.contracts.salary");

/**
 * Lista a gravar: só permissões conhecidas, sem repetidas; qualquer permissão de um grupo
 * traz consigo a de acesso desse grupo (sem ela as outras não serviriam de nada).
 */
export function normalizePermissions(list: string[]): Result<Permission[], { code: "INVALID_PERMISSION"; message: string }> {
  const unknown = list.find((p) => !isPermission(p));
  if (unknown) return fail({ code: "INVALID_PERMISSION", message: `Permissão desconhecida: ${unknown}.` });
  const set = new Set(list as Permission[]);
  // gerir, gerar ou publicar provas não serve de nada sem as ver
  if (set.has("attendance.exams.manage") || set.has("attendance.exams.generate") || set.has("attendance.exams.publish")) set.add("attendance.exams.view");
  if (set.has("finance.payments.validate") || set.has("finance.charges.manage")) set.add("finance.payments.view");
  if (set.has("finance.expenses.manage")) set.add("finance.expenses.view");
  // tratar ou entregar pedidos não serve de nada sem os ver
  if (set.has("documents.requests.process") || set.has("documents.requests.deliver")) set.add("documents.requests.view");
  if (set.has("hr.doc_requests.process") || set.has("hr.doc_requests.deliver")) set.add("hr.doc_requests.view");
  for (const p of [...set]) set.add(accessOf(p));
  return ok(ALL_PERMISSIONS.filter((p) => set.has(p)));
}
