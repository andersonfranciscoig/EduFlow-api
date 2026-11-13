import type { EmployeeStatus, Entry, PersonalData, Progress, SectionsData, StepKey } from "../domain/employee";
import type { FormSnapshot, SectionKey } from "../domain/form";
import type { HistoryRow, NewInvite, School } from "./registration-ports";

export interface EmployeeDocumentRow {
  id: string;
  slot: "PHOTO" | "DOCUMENT" | "FIELD";
  itemId: string | null;
  label: string;
  fileName: string;
  mimeType: string;
  size: number;
  storageKey: string;
  uploadedById: string | null;
  createdAt: Date;
}

export interface EmployeeRow {
  id: string;
  number: number | null;
  requestId: string | null;
  employeeTypeId: string | null;
  employeeTypeName: string | null;
  formVersion: { id: string; number: number; snapshot: FormSnapshot };
  status: EmployeeStatus;
  progress: Progress;
  lastStep: StepKey | null;
  completedSteps: StepKey[];
  revision: number;
  personal: PersonalData;
  sections: SectionsData;
  fullName: string;
  email: string | null;
  phone: string | null;
  jobTitle: string | null;
  department: string | null;
  correctionNote: string | null;
  createdById: string | null;
  submittedAt: Date | null;
  approvedAt: Date | null;
  activatedAt: Date | null;
  terminatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  documents: EmployeeDocumentRow[];
}

/** Na lista: sem os dados do formulário. */
export type EmployeeListRow = Omit<EmployeeRow, "formVersion" | "personal" | "sections" | "documents"> & { hasPhoto: boolean; photoId: string | null };

export interface StepPatch {
  personal?: PersonalData;
  section?: { key: SectionKey; entries: Entry[] };
  completedSteps: StepKey[];
  lastStep: StepKey;
  progress: Progress;
  /** colunas repetidas para listar/pesquisar (dos dados pessoais) */
  fullName?: string;
  email?: string | null;
  phone?: string | null;
  now: Date;
}

export type SaveOutcome = { ok: true; revision: number; updatedAt: Date } | { ok: false; reason: "not_found" | "conflict" | "state" };

export interface Transition {
  id: string;
  from: EmployeeStatus[];
  to: EmployeeStatus;
  actorId: string | null;
  actorName: string | null;
  reason: string | null;
  now: Date;
  /** colunas a mudar com o estado */
  set?: Partial<{
    progress: Progress;
    correctionNote: string | null;
    submittedAt: Date;
    approvedAt: Date;
    activatedAt: Date;
    terminatedAt: Date;
    jobTitle: string | null;
    department: string | null;
  }>;
  /** ao aprovar: atribui o n.º de funcionário (se ainda não tiver) */
  assignNumber?: boolean;
  /** só muda se a revisão for esta (submeter o que a pessoa viu) */
  revision?: number;
}

export type TransitionOutcome = { ok: true; value: EmployeeRow } | { ok: false; reason: "not_found" | "state" | "conflict"; status?: EmployeeStatus };

/** Cadastros de funcionários — na BD do PRÓPRIO colégio. */
export interface EmployeeRepository {
  find(id: string): Promise<EmployeeRow | null>;
  findByRequest(requestId: string): Promise<EmployeeRow | null>;
  list(input: { status: EmployeeStatus | null; q: string | null; typeId: string | null; page: number; pageSize: number }): Promise<{ items: EmployeeListRow[]; total: number; counts: Record<EmployeeStatus, number> }>;
  /** Novo rascunho, preso à versão do formulário. Falha "duplicate" se o pedido já tiver cadastro. */
  create(input: {
    id: string;
    requestId: string | null;
    employeeTypeId: string | null;
    formVersionId: string;
    fullName: string;
    email: string | null;
    phone: string | null;
    personal: PersonalData;
    createdById: string | null;
    actorName: string | null;
    now: Date;
  }): Promise<{ ok: true; value: EmployeeRow } | { ok: false; reason: "duplicate" }>;
  /** Grava um passo se a revisão for a esperada (concorrência otimista) e o estado o permitir. */
  saveStep(id: string, expectedRevision: number, allowed: EmployeeStatus[], patch: StepPatch): Promise<SaveOutcome>;
  transition(t: Transition): Promise<TransitionOutcome>;
  updateAdmin(id: string, input: { jobTitle: string | null; department: string | null; now: Date }): Promise<boolean>;
  history(id: string): Promise<HistoryRow[]>;
  addHistory(input: { employeeId: string; from: EmployeeStatus | null; to: EmployeeStatus; actorId: string | null; actorName: string | null; reason: string | null; now: Date }): Promise<void>;

  addDocument(employeeId: string, doc: Omit<EmployeeDocumentRow, "createdAt"> & { sha256: string; now: Date }): Promise<void>;
  removeDocument(employeeId: string, docId: string): Promise<EmployeeDocumentRow | null>;

  /** Quem é avisado (ativos, com email): o responsável e quem tem esta permissão. */
  recipients(permission: string): Promise<{ email: string; name: string }[]>;
  record(type: string, subjectId: string, actorId: string | null, details: Record<string, unknown>, now: Date): Promise<void>;
}

/** Acesso ao formulário pelo convite: link + palavra-passe do pedido → sessão curta. */
export interface InviteAccess {
  inviteId: string;
  requestId: string;
  requestStatus: string;
  fullName: string;
  email: string;
  phone: string | null;
  passwordHash: string;
  employeeTypeId: string | null;
  employeeTypeName: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  failedAttempts: number;
  lockedUntil: Date | null;
  expiredNotifiedAt: Date | null;
}

export interface ApplicantSession {
  inviteId: string;
  requestId: string;
  expiresAt: Date;
}

export interface ApplicantAccessRepository {
  inviteByTokenHash(hash: string): Promise<InviteAccess | null>;
  /** Mais uma tentativa errada; ao chegar ao limite bloqueia até `lockUntil`. */
  registerFailure(inviteId: string, maxAttempts: number, lockUntil: Date): Promise<{ attempts: number; lockedUntil: Date | null }>;
  startSession(inviteId: string, sessionHash: string, expiresAt: Date, now: Date): Promise<void>;
  /** Sessão válida (não expirada, convite não revogado, pedido aprovado). */
  session(sessionHash: string, now: Date): Promise<ApplicantSession | null>;
  extendSession(inviteId: string, expiresAt: Date): Promise<void>;
  endSession(sessionHash: string): Promise<void>;
  /** true só da primeira vez (o aviso de convite expirado segue uma vez). */
  markExpiredNotified(inviteId: string, now: Date): Promise<boolean>;
}

/** Ficheiros do RH: cifrados antes de sair da API (app do UploadThing do colégio, ou disco em dev). */
export interface HrFileStore {
  /** false = o colégio ainda não tem armazenamento configurado (envios recusados) */
  readonly ready: boolean;
  save(folder: string, file: { fileName: string; mimeType: string; content: Buffer }): Promise<{ key: string }>;
  read(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

export interface EmployeeMailer {
  submittedForHr(input: { to: { email: string; name: string }[]; school: School; employee: string; employeeId: string; resubmitted: boolean }): Promise<void>;
  submittedConfirmation(input: { to: { email: string; name: string }; school: School }): Promise<void>;
  approved(input: { to: { email: string; name: string }; school: School; number: string | null }): Promise<void>;
  rejected(input: { to: { email: string; name: string }; school: School; reason: string | null }): Promise<void>;
  correctionRequested(input: { to: { email: string; name: string }; school: School; note: string; token: string; expiresAt: Date }): Promise<void>;
  inviteExpiredForHr(input: { to: { email: string; name: string }[]; school: School; applicant: string }): Promise<void>;
}

export type { NewInvite };
