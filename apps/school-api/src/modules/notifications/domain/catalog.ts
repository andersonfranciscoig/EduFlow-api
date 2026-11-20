/**
 * CATÁLOGO DOS TIPOS DE NOTIFICAÇÃO — o que existe, para quem, e os valores por omissão.
 * O colégio liga/desliga cada tipo e escolhe se também vai por email (onde há email);
 * cada pessoa da equipa pode recusar o email de um tipo. Cresce com cada fase.
 */
export type Audience = "STAFF" | "FAMILY";

export interface KindInfo {
  audience: Audience;
  label: string;
  hint: string;
  /** a quem chega (texto para a configuração) */
  to: string;
  defaultEnabled: boolean;
  defaultEmail: boolean;
  /** pode ir por email (as da família têm, para já, os emails próprios de cada processo) */
  emailAvailable: boolean;
}

export const KINDS = {
  // ---- equipa
  TEACHER_OCCURRENCE: {
    audience: "STAFF",
    label: "Faltas e atrasos do professor",
    hint: "Quando o RH regista, justifica, altera ou anula uma falta ou atraso do professor.",
    to: "O professor",
    defaultEnabled: true,
    defaultEmail: true,
    emailAvailable: true,
  },
  ATTENDANCE_CORRECTED: {
    audience: "STAFF",
    label: "Presenças corrigidas",
    hint: "Quando a direção pedagógica corrige as presenças de uma aula que o professor registou.",
    to: "O professor da aula",
    defaultEnabled: true,
    defaultEmail: false,
    emailAvailable: true,
  },
  // ---- família (área da família)
  APPLICATION_CORRECTION: { audience: "FAMILY", label: "Correções pedidas", hint: "A secretaria pede correções numa inscrição.", to: "Quem fez a inscrição", defaultEnabled: true, defaultEmail: false, emailAvailable: false },
  APPLICATION_APPROVED: { audience: "FAMILY", label: "Inscrição aprovada", hint: "A inscrição foi aprovada.", to: "Quem fez a inscrição", defaultEnabled: true, defaultEmail: false, emailAvailable: false },
  APPLICATION_REJECTED: { audience: "FAMILY", label: "Inscrição não aprovada", hint: "A inscrição não foi aprovada (com o motivo).", to: "Quem fez a inscrição", defaultEnabled: true, defaultEmail: false, emailAvailable: false },
  ENROLLED: { audience: "FAMILY", label: "Matrícula confirmada", hint: "A matrícula foi confirmada (turma e n.º).", to: "Quem fez a inscrição", defaultEnabled: true, defaultEmail: false, emailAvailable: false },
  HANDOVER_INVITED: { audience: "FAMILY", label: "Convite ao aluno maior", hint: "O encarregado convidou o aluno maior a gerir a conta.", to: "O encarregado", defaultEnabled: true, defaultEmail: false, emailAvailable: false },
  HANDOVER_DONE: { audience: "FAMILY", label: "Conta passada ao aluno", hint: "O aluno maior passou a gerir a própria conta.", to: "O encarregado", defaultEnabled: true, defaultEmail: false, emailAvailable: false },
  HANDOVER_WELCOME: { audience: "FAMILY", label: "Boas-vindas ao aluno maior", hint: "O registo de aluno passou a ser do próprio aluno.", to: "O aluno", defaultEnabled: true, defaultEmail: false, emailAvailable: false },
} satisfies Record<string, KindInfo>;

export type Kind = keyof typeof KINDS;
export const isKind = (k: string): k is Kind => k in KINDS;
export const STAFF_KINDS = (Object.keys(KINDS) as Kind[]).filter((k) => KINDS[k].audience === "STAFF");

export const CHANNEL_LABELS = { IN_APP: "Na plataforma", EMAIL: "Email" } as const;
export const DELIVERY_LABELS = { SENT: "Entregue", FAILED: "Falhou", SKIPPED: "Não enviado" } as const;
export type Channel = keyof typeof CHANNEL_LABELS;
export type DeliveryStatus = keyof typeof DELIVERY_LABELS;
