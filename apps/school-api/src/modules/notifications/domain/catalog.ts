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
  /** pode ir por email (na família, para já, só o resumo diário; os processos têm emails próprios) */
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
  ATTENDANCE_PENDING: {
    audience: "STAFF",
    label: "Aulas sem presenças no prazo",
    hint: "Um resumo das aulas cujo prazo passou sem presenças (e das faltas automáticas, na gestão automática).",
    to: "O RH (quem gere as faltas dos professores) e o responsável",
    defaultEnabled: true,
    defaultEmail: true,
    emailAvailable: true,
  },
  ATTENDANCE_MISSING: {
    audience: "STAFF",
    label: "Presenças por registar",
    hint: "O prazo de uma aula passou sem presenças: lembra o professor (ainda as pode registar, fora do prazo).",
    to: "O professor da aula",
    defaultEnabled: true,
    defaultEmail: false,
    emailAvailable: true,
  },
  SUBSTITUTION: {
    audience: "STAFF",
    label: "Substituições",
    hint: "Quando o RH marca (ou retira) uma substituição numa aula.",
    to: "O professor substituto e o titular",
    defaultEnabled: true,
    defaultEmail: true,
    emailAvailable: true,
  },
  JUSTIFICATION_SUBMITTED: {
    audience: "STAFF",
    label: "Justificações dos professores",
    hint: "Um professor justificou uma falta ou atraso: fica à espera da decisão do RH.",
    to: "O RH (quem gere as faltas dos professores) e o responsável",
    defaultEnabled: true,
    defaultEmail: false,
    emailAvailable: true,
  },
  ATTENDANCE_ALERT: {
    audience: "STAFF",
    label: "Alertas de assiduidade dos alunos",
    hint: "Um aluno chegou ao limite de faltas ou de faltas seguidas das regras do colégio (uma vez por limite).",
    to: "O diretor de turma",
    defaultEnabled: true,
    defaultEmail: true,
    emailAvailable: true,
  },
  DAILY_DIGEST: {
    audience: "STAFF",
    label: "Resumo diário",
    hint: "Um por dia, 1 hora depois da última aula: as aulas e presenças do dia e, para o diretor de turma, a assiduidade da turma.",
    to: "Professores e diretores de turma (com conta no portal)",
    defaultEnabled: true,
    defaultEmail: false,
    emailAvailable: true,
  },
  EXAMS: {
    audience: "STAFF",
    label: "Calendário de provas",
    hint: "Um calendário de provas foi publicado, ou uma prova publicada mudou ou foi cancelada.",
    to: "Os professores das turmas e das provas (com as datas das suas), e os diretores de turma",
    defaultEnabled: true,
    defaultEmail: true,
    emailAvailable: true,
  },
  EXAM_INVIGILATION: {
    audience: "STAFF",
    label: "Vigilância de provas",
    hint: "O professor foi escalado para vigiar uma prova (ou deixou de a vigiar).",
    to: "O professor escalado",
    defaultEnabled: true,
    defaultEmail: true,
    emailAvailable: true,
  },
  PAYMENTS: {
    audience: "STAFF",
    label: "Pagamentos",
    hint: "Um pagamento foi submetido, validado, recusado ou retirado, ou passou o prazo de validação.",
    to: "As Finanças (quem consulta ou valida pagamentos) e a secretaria (quem consulta as inscrições)",
    defaultEnabled: true,
    defaultEmail: true,
    emailAvailable: true,
  },
  GRADES_SUBMITTED: {
    audience: "STAFF",
    label: "Classificações para validar",
    hint: "Um professor submeteu as classificações de um período: ficam à espera de validação.",
    to: "O diretor de turma e quem valida as classificações",
    defaultEnabled: true,
    defaultEmail: true,
    emailAvailable: true,
  },
  GRADES_RETURNED: {
    audience: "STAFF",
    label: "Classificações devolvidas ou reabertas",
    hint: "As classificações de um período foram devolvidas ao professor, ou reabertas para retificação (com o motivo).",
    to: "O professor da disciplina",
    defaultEnabled: true,
    defaultEmail: true,
    emailAvailable: true,
  },
  GRADES_VALIDATED: {
    audience: "STAFF",
    label: "Classificações por publicar",
    hint: "As classificações de uma disciplina foram validadas: falta publicá-las.",
    to: "Quem publica as classificações",
    defaultEnabled: true,
    defaultEmail: false,
    emailAvailable: true,
  },
  DOCUMENT_REQUESTS: {
    audience: "STAFF",
    label: "Pedidos de documentos",
    hint: "Chegou um pedido de documento novo, ou o requerente cancelou um pedido.",
    to: "Quem trata os pedidos (secretaria para os alunos, RH para os funcionários)",
    defaultEnabled: true,
    defaultEmail: false,
    emailAvailable: true,
  },
  MY_DOCUMENTS: {
    audience: "STAFF",
    label: "Os meus pedidos de documentos",
    hint: "Um pedido de documento do próprio funcionário mudou de estado: em análise, pronto a levantar, entregue, rejeitado ou cancelado.",
    to: "O funcionário que fez o pedido",
    defaultEnabled: true,
    defaultEmail: true,
    emailAvailable: true,
  },
  ANNOUNCEMENTS: {
    audience: "STAFF",
    label: "Avisos",
    hint: "Foi publicado um aviso para si (os urgentes também por email, se o colégio o enviar por email).",
    to: "Os destinatários de cada aviso (equipa e professores)",
    defaultEnabled: true,
    defaultEmail: false,
    emailAvailable: true,
  },
  URGENT_ANNOUNCEMENTS: {
    audience: "STAFF",
    label: "Avisos urgentes",
    hint: "Foi publicado um aviso urgente para si.",
    to: "Os destinatários de cada aviso urgente (equipa e professores)",
    defaultEnabled: true,
    defaultEmail: true,
    emailAvailable: true,
  },
  MESSAGES: {
    audience: "STAFF",
    label: "Mensagens",
    hint: "Recebeu uma mensagem numa conversa ou grupo (uma notificação até ler a conversa, não uma por mensagem).",
    to: "Os participantes da conversa",
    defaultEnabled: true,
    defaultEmail: false,
    emailAvailable: true,
  },
  GROUP_ADDED: {
    audience: "STAFF",
    label: "Adicionado a um grupo",
    hint: "Foi adicionado a um grupo de conversa.",
    to: "Quem é adicionado",
    defaultEnabled: true,
    defaultEmail: false,
    emailAvailable: true,
  },
  // ---- família (área da família)
  FAMILY_MESSAGES: {
    audience: "FAMILY",
    label: "Mensagens",
    hint: "Recebeu uma mensagem de um professor, do diretor de turma ou do colégio (uma notificação até ler a conversa).",
    to: "O encarregado ou o aluno (com conta) da conversa",
    defaultEnabled: true,
    defaultEmail: false,
    emailAvailable: false,
  },
  FAMILY_GROUP_ADDED: { audience: "FAMILY", label: "Adicionado a um grupo", hint: "Foi adicionado a um grupo de conversa do colégio.", to: "Quem é adicionado", defaultEnabled: true, defaultEmail: false, emailAvailable: false },
  FAMILY_ANNOUNCEMENTS: {
    audience: "FAMILY",
    label: "Avisos do colégio",
    hint: "O colégio publicou um aviso para o encarregado ou para o aluno.",
    to: "Os encarregados e alunos (com conta) a quem o aviso se destina",
    defaultEnabled: true,
    defaultEmail: false,
    emailAvailable: false,
  },
  APPLICATION_CORRECTION: { audience: "FAMILY", label: "Correções pedidas", hint: "A secretaria pede correções numa inscrição.", to: "Quem fez a inscrição", defaultEnabled: true, defaultEmail: false, emailAvailable: false },
  APPLICATION_APPROVED: { audience: "FAMILY", label: "Inscrição aprovada", hint: "A inscrição foi aprovada.", to: "Quem fez a inscrição", defaultEnabled: true, defaultEmail: false, emailAvailable: false },
  APPLICATION_REJECTED: { audience: "FAMILY", label: "Inscrição não aprovada", hint: "A inscrição não foi aprovada (com o motivo).", to: "Quem fez a inscrição", defaultEnabled: true, defaultEmail: false, emailAvailable: false },
  ENROLLED: { audience: "FAMILY", label: "Matrícula confirmada", hint: "A matrícula foi confirmada (turma e n.º).", to: "Quem fez a inscrição", defaultEnabled: true, defaultEmail: false, emailAvailable: false },
  HANDOVER_INVITED: { audience: "FAMILY", label: "Convite ao aluno maior", hint: "O encarregado convidou o aluno maior a gerir a conta.", to: "O encarregado", defaultEnabled: true, defaultEmail: false, emailAvailable: false },
  HANDOVER_DONE: { audience: "FAMILY", label: "Conta passada ao aluno", hint: "O aluno maior passou a gerir a própria conta.", to: "O encarregado", defaultEnabled: true, defaultEmail: false, emailAvailable: false },
  HANDOVER_WELCOME: { audience: "FAMILY", label: "Boas-vindas ao aluno maior", hint: "O registo de aluno passou a ser do próprio aluno.", to: "O aluno", defaultEnabled: true, defaultEmail: false, emailAvailable: false },
  STUDENT_ATTENDANCE_ALERT: {
    audience: "FAMILY",
    label: "Alertas de assiduidade",
    hint: "O aluno chegou ao limite de faltas ou de faltas seguidas das regras do colégio.",
    to: "O encarregado que gere o aluno (menor) ou o próprio aluno (maior, com conta)",
    defaultEnabled: true,
    defaultEmail: false,
    emailAvailable: false,
  },
  STUDENT_EXAMS: {
    audience: "FAMILY",
    label: "Calendário de provas",
    hint: "Um calendário de provas foi publicado, ou uma prova publicada mudou ou foi cancelada.",
    to: "O encarregado que gere o aluno (menor) ou o próprio aluno (maior, com conta)",
    defaultEnabled: true,
    defaultEmail: false,
    emailAvailable: false,
  },
  STUDENT_GRADES: {
    audience: "FAMILY",
    label: "Classificações publicadas",
    hint: "O colégio publicou as classificações de um período (ou uma retificação).",
    to: "O encarregado que gere o aluno (menor) ou o próprio aluno (maior, com conta)",
    defaultEnabled: true,
    defaultEmail: false,
    emailAvailable: false,
  },
  PAYMENT: {
    audience: "FAMILY",
    label: "Pagamentos",
    hint: "Há valores a pagar, ou um pagamento ficou em validação, foi validado ou não foi aceite.",
    to: "Quem fez o pagamento",
    defaultEnabled: true,
    defaultEmail: true,
    emailAvailable: true,
  },
  PAYMENT_REMINDER: {
    audience: "FAMILY",
    label: "Lembretes de propinas",
    hint: "Uma propina está a vencer ou ficou em atraso, ou o colégio enviou um lembrete.",
    to: "O aluno maior de idade ou o encarregado",
    defaultEnabled: true,
    defaultEmail: true,
    emailAvailable: true,
  },
  DOCUMENT_STATUS: {
    audience: "FAMILY",
    label: "Pedidos de documentos",
    hint: "Um pedido de documento foi recebido, entrou em análise, está pronto a levantar, foi entregue, rejeitado ou cancelado.",
    to: "O encarregado que gere o aluno (menor) ou o próprio aluno (maior, com conta)",
    defaultEnabled: true,
    defaultEmail: false,
    emailAvailable: false,
  },
  FAMILY_DAILY_DIGEST: {
    audience: "FAMILY",
    label: "Resumo diário",
    hint: "Um por dia, 1 hora depois da última aula: presenças, faltas, atrasos e sumários do dia.",
    to: "O encarregado que gere o aluno (menor) ou o próprio aluno (maior, com conta)",
    defaultEnabled: true,
    defaultEmail: false,
    emailAvailable: true,
  },
} satisfies Record<string, KindInfo>;

export type Kind = keyof typeof KINDS;
export const isKind = (k: string): k is Kind => k in KINDS;
export const STAFF_KINDS = (Object.keys(KINDS) as Kind[]).filter((k) => KINDS[k].audience === "STAFF");

export const CHANNEL_LABELS = { IN_APP: "Na plataforma", EMAIL: "Email" } as const;
export const DELIVERY_LABELS = { SENT: "Entregue", FAILED: "Falhou", SKIPPED: "Não enviado" } as const;
export type Channel = keyof typeof CHANNEL_LABELS;
export type DeliveryStatus = keyof typeof DELIVERY_LABELS;
