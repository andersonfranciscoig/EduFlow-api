import type { ApplicationStatus, Entry, FileRef, Shift, StepKey } from "../domain/applications";
import type { ProcessType } from "../domain/settings";

export interface ApplicationRow {
  id: string;
  number: string | null;
  accountId: string;
  studentId: string | null;
  processType: ProcessType;
  formVersion: number;
  academicYearId: string | null;
  classId: string | null;
  shift: Shift | null;
  studentData: Entry;
  guardianData: Entry;
  sectionsData: Record<string, Entry[]>;
  status: ApplicationStatus;
  currentStep: StepKey;
  version: number;
  termsAcceptedAt: Date | null;
  legitimacyDeclared: boolean;
  submittedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApplicationFileRow extends FileRef {
  applicationId: string;
  label: string;
  fileName: string;
  mimeType: string;
  size: number;
  sha256: string;
  storageKey: string;
  createdAt: Date;
}

/** Uma classe que se pode pedir (no ano), com os turnos das turmas que já existem. */
export interface OfferedClass {
  id: string;
  grade: number;
  courseName: string | null;
  description: string | null;
  shifts: Shift[];
}

export interface OpenYear {
  id: string;
  name: string;
  /** "AAAA-MM-DD" */
  from: string;
  to: string;
  classes: OfferedClass[];
}

export interface ApplicationSummaryRow {
  id: string;
  number: string | null;
  processType: ProcessType;
  status: ApplicationStatus;
  currentStep: StepKey;
  studentName: string | null;
  yearName: string | null;
  grade: number | null;
  courseName: string | null;
  submittedAt: Date | null;
  updatedAt: Date;
}

/** O que a submissão grava, numa só transação. */
export interface SubmitInput {
  applicationId: string;
  expectedVersion: number;
  accountId: string;
  accountKind: "GUARDIAN" | "STUDENT";
  year: string;
  now: Date;
  student: { fullName: string; birthDate: string; gender: string | null; data: Entry };
  /** encarregado indicado na inscrição (para o aluno maior, pode não haver) */
  guardian: { fullName: string; email: string | null; phone: string | null; relationship: string; relationshipOther: string | null; data: Entry } | null;
  termsAcceptedAt: Date;
  legitimacyDeclared: boolean;
  actorName: string;
}

export type SubmitOutcome = { ok: true; number: string; studentId: string } | { ok: false; reason: "STALE" } | { ok: false; reason: "DUPLICATE"; number: string };

/** Inscrições (na BD do PRÓPRIO colégio). */
export interface ApplicationsRepository {
  byAccount(accountId: string): Promise<ApplicationSummaryRow[]>;
  byId(id: string): Promise<ApplicationRow | null>;
  create(row: Omit<ApplicationRow, "number" | "studentId" | "version" | "termsAcceptedAt" | "legitimacyDeclared" | "submittedAt" | "updatedAt">): Promise<void>;
  /** Grava se a versão ainda for a esperada (e sobe-a). false = alterada noutra janela. */
  save(id: string, expectedVersion: number, set: Partial<Pick<ApplicationRow, "academicYearId" | "classId" | "shift" | "studentData" | "guardianData" | "sectionsData" | "currentStep">>, now: Date): Promise<number | null>;
  remove(id: string): Promise<void>;
  files(applicationId: string): Promise<ApplicationFileRow[]>;
  addFile(row: ApplicationFileRow): Promise<void>;
  removeFile(id: string): Promise<void>;
  /** Anos com o período de inscrições aberto hoje (ou todos os que têm período, com `includeClosed`). */
  openYears(today: string): Promise<OpenYear[]>;
  yearName(id: string): Promise<string | null>;
  classLabel(id: string): Promise<{ grade: number; courseName: string | null } | null>;
  submit(input: SubmitInput): Promise<SubmitOutcome>;
  record(type: string, subjectId: string, actorId: string | null, details: Record<string, unknown>, now: Date): Promise<void>;
}

export interface ApplicationsMailer {
  submitted(input: { to: { email: string; name: string }; school: { name: string; slug: string }; number: string; studentName: string; yearName: string; classLabel: string }): Promise<void>;
}

/** Armazenamento cifrado dos ficheiros do colégio (o mesmo do RH). */
export interface ApplicationFileStore {
  readonly ready: boolean;
  save(folder: string, file: { fileName: string; mimeType: string; content: Buffer }): Promise<{ key: string }>;
  read(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}
