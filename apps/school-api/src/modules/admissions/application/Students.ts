import type { Clock } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok } from "../../../../../../libs/kernel/src/domain/Result";
import { ageOn, canAccessStudent, isAdult, luandaToday } from "../../family/domain/family";
import { gradeLabel } from "../../pedagogy/domain/academic";
import { APPLICATION_STATUS, type ApplicationStatus, checkFixed, type Entry, SHIFTS, type Shift } from "../domain/applications";
import { formatStudentNumber } from "../domain/enrollment";
import { ACTIVITY_LABELS, CORE_KEYS, isStudentStatus, PAGE_SIZE, PERSONAL_FIELDS, STUDENT_STATUS_LABELS, type StudentStatus } from "../domain/students";
import { admissionError, PROCESS_TYPES, type ProcessType } from "../domain/settings";

// ================================================================ portas

export interface StudentListRow {
  id: string;
  number: number | null;
  fullName: string;
  birthDate: Date;
  status: StudentStatus;
  enrollmentNumber: string | null;
  yearName: string | null;
  grade: number | null;
  courseName: string | null;
  groupName: string | null;
  guardianName: string | null;
  guardianPhone: string | null;
  phone: string | null;
  photoId: string | null;
  hasAccount: boolean;
}

export interface StudentDetailRow {
  id: string;
  number: number | null;
  fullName: string;
  birthDate: string;
  gender: string | null;
  status: StudentStatus;
  data: Entry;
  accountId: string | null;
  createdAt: Date;
  photoId: string | null;
  guardians: { id: string; fullName: string; email: string | null; phone: string | null; relationship: string; relationshipOther: string | null; isPrimary: boolean; isEmergency: boolean; isFinancial: boolean; canManage: boolean; hasAccount: boolean; data: Entry }[];
  enrollments: { id: string; number: string; applicationId: string | null; yearName: string; grade: number; courseName: string | null; groupName: string | null; shift: Shift | null; status: "ACTIVE" | "CANCELLED"; byName: string | null; exceptionReason: string | null; enrolledAt: Date }[];
  applications: { id: string; number: string | null; processType: ProcessType; status: ApplicationStatus; yearName: string | null; grade: number | null; courseName: string | null; submittedAt: Date | null }[];
  files: { id: string; applicationId: string; applicationNumber: string | null; slot: "PHOTO" | "DOCUMENT" | "FIELD"; label: string; fileName: string; size: number; createdAt: Date }[];
}

export interface StudentsRepository {
  list(f: { q?: string; yearId?: string; classId?: string; status?: StudentStatus; page: number; pageSize: number }): Promise<{ total: number; rows: StudentListRow[] }>;
  filterYears(): Promise<{ id: string; name: string; classes: { id: string; grade: number; courseName: string | null }[] }[]>;
  detail(id: string): Promise<StudentDetailRow | null>;
  history(subjectIds: string[], types: string[]): Promise<{ type: string; details: Record<string, unknown> | null; at: Date; actorName: string | null }[]>;
  update(id: string, set: { fullName?: string; birthDate?: string; gender?: string | null; data: Entry }, now: Date): Promise<void>;
  file(studentId: string, fileId: string): Promise<{ storageKey: string; mimeType: string; fileName: string } | null>;
  /** Contas de família que podem ver o aluno (o próprio ou o encarregado que o gere). */
  accessFor(accountId: string, studentId: string): Promise<{ self: boolean; managingGuardian: boolean; birthDate: string } | null>;
  record(type: string, subjectId: string, actorId: string | null, details: Record<string, unknown>, now: Date): Promise<void>;
}

export interface StudentFileStore {
  read(key: string): Promise<Buffer>;
}

const classLabel = (grade: number | null, course: string | null) => (grade === null ? null : `${gradeLabel(grade)}${course ? ` — ${course}` : ""}`);
const value = (v: unknown) => (v === undefined || v === null || v === "" ? null : Array.isArray(v) ? v.join(", ") : typeof v === "boolean" ? (v ? "Sim" : "Não") : String(v));
const dmy = (iso: string) => iso.split("-").reverse().join("/");

/**
 * Alunos (fase F): lista e ficha para a secretaria (com edição dos dados pessoais e histórico),
 * e a ficha do educando (ou do próprio aluno maior) para a família, sem dados internos.
 */
export class Students {
  constructor(
    private readonly clock: Clock,
    private readonly countryCode: string,
  ) {}

  private today() {
    return luandaToday(this.clock.now());
  }

  async list(repo: StudentsRepository, input: { q?: string; yearId?: string; classId?: string; status?: string; page?: number }) {
    const page = Math.max(1, Math.floor(input.page ?? 1));
    const status = isStudentStatus(input.status) ? input.status : undefined;
    const [res, years] = await Promise.all([repo.list({ q: input.q?.trim().slice(0, 80) || undefined, yearId: input.yearId, classId: input.classId, status, page, pageSize: PAGE_SIZE }), repo.filterYears()]);
    return {
      page,
      pageSize: PAGE_SIZE,
      total: res.total,
      statuses: Object.entries(STUDENT_STATUS_LABELS).map(([v, label]) => ({ value: v, label })),
      years: years.map((y) => ({ id: y.id, name: y.name, classes: y.classes.map((c) => ({ id: c.id, label: classLabel(c.grade, c.courseName)! })) })),
      students: res.rows.map((r) => ({
        id: r.id,
        number: formatStudentNumber(r.number),
        fullName: r.fullName,
        age: ageOn(r.birthDate.toISOString().slice(0, 10), this.today()),
        status: r.status,
        statusLabel: STUDENT_STATUS_LABELS[r.status],
        enrollmentNumber: r.enrollmentNumber,
        yearName: r.yearName,
        classLabel: classLabel(r.grade, r.courseName),
        groupName: r.groupName,
        guardianName: r.guardianName,
        contact: r.guardianPhone ?? r.phone,
        photoId: r.photoId,
        hasAccount: r.hasAccount,
      })),
    };
  }

  /** A ficha (secretaria: com histórico e o que se pode editar; família: sem dados internos). */
  private view(s: StudentDetailRow) {
    const today = this.today();
    const data: Entry = { ...s.data, fullName: s.fullName, birthDate: s.birthDate, ...(s.gender ? { gender: s.gender } : {}) };
    const current = s.enrollments.find((e) => e.status === "ACTIVE") ?? null;
    return {
      id: s.id,
      number: formatStudentNumber(s.number),
      fullName: s.fullName,
      birthDate: s.birthDate,
      age: ageOn(s.birthDate, today),
      adult: isAdult(s.birthDate, today),
      gender: s.gender,
      status: s.status,
      statusLabel: STUDENT_STATUS_LABELS[s.status],
      photoId: s.photoId,
      hasAccount: !!s.accountId,
      createdAt: s.createdAt.toISOString(),
      current: current
        ? { number: current.number, yearName: current.yearName, classLabel: classLabel(current.grade, current.courseName), gradeLabel: gradeLabel(current.grade), courseName: current.courseName, groupName: current.groupName, shiftLabel: current.shift ? SHIFTS[current.shift] : null }
        : null,
      personal: PERSONAL_FIELDS.map((f) => ({ key: f.key, label: f.label, value: f.type === "DATE" && typeof data[f.key] === "string" ? dmy(data[f.key] as string) : value(data[f.key]) })).filter((r) => r.value),
      guardians: s.guardians.map((g) => ({
        id: g.id,
        fullName: g.fullName,
        relationship: g.relationship === "Outro" ? (g.relationshipOther ?? "Outro") : g.relationship,
        email: g.email,
        phone: g.phone,
        profession: value(g.data.profession),
        address: value(g.data.address),
        isPrimary: g.isPrimary,
        isEmergency: g.isEmergency,
        isFinancial: g.isFinancial,
        canManage: g.canManage,
        hasAccount: g.hasAccount,
      })),
      enrollments: s.enrollments.map((e) => ({
        id: e.id,
        number: e.number,
        applicationId: e.applicationId,
        yearName: e.yearName,
        classLabel: classLabel(e.grade, e.courseName),
        groupName: e.groupName,
        shiftLabel: e.shift ? SHIFTS[e.shift] : null,
        status: e.status,
        statusLabel: e.status === "ACTIVE" ? "Ativa" : "Anulada",
        byName: e.byName,
        exceptionReason: e.exceptionReason,
        enrolledAt: e.enrolledAt.toISOString(),
      })),
      applications: s.applications.map((a) => ({
        id: a.id,
        number: a.number,
        processLabel: PROCESS_TYPES[a.processType].label,
        status: a.status,
        statusLabel: APPLICATION_STATUS[a.status],
        yearName: a.yearName,
        classLabel: classLabel(a.grade, a.courseName),
        submittedAt: a.submittedAt?.toISOString() ?? null,
      })),
      documents: s.files
        .filter((f) => f.slot !== "PHOTO")
        .map((f) => ({ id: f.id, applicationId: f.applicationId, applicationNumber: f.applicationNumber, label: f.label, fileName: f.fileName, size: f.size, createdAt: f.createdAt.toISOString() })),
    };
  }

  async get(repo: StudentsRepository, id: string, canEdit: boolean) {
    const s = await repo.detail(id);
    if (!s) return fail(admissionError("STUDENT_NOT_FOUND", "Aluno não encontrado."));
    const ids = [s.id, ...s.applications.map((a) => a.id), ...s.enrollments.map((e) => e.id)];
    const history = await repo.history(ids, Object.keys(ACTIVITY_LABELS));
    const data: Entry = { ...s.data, fullName: s.fullName, birthDate: s.birthDate, ...(s.gender ? { gender: s.gender } : {}) };
    return ok({
      ...this.view(s),
      canEdit,
      // o que a secretaria pode editar: os dados pessoais (o formulário de inscrição, sem a fotografia)
      editable: canEdit ? { fields: PERSONAL_FIELDS.map((f) => ({ key: f.key, label: f.label, type: f.type, options: f.options ?? [], help: f.help ?? null, required: f.mode === "REQUIRED" })), values: data } : null,
      history: history.map((h) => ({
        type: h.type,
        label: ACTIVITY_LABELS[h.type] ?? h.type,
        at: h.at.toISOString(),
        actorName: h.actorName,
        details: h.type === "STUDENT_UPDATED" ? ((h.details?.changes as { label: string; from: string | null; to: string | null }[] | undefined) ?? []) : [],
        reference: typeof h.details?.number === "string" ? h.details.number : null,
      })),
    });
  }

  /** A secretaria altera os dados pessoais; fica no histórico o que mudou (antes → depois). */
  async update(repo: StudentsRepository, actor: { id: string | null }, id: string, raw: unknown) {
    const s = await repo.detail(id);
    if (!s) return fail(admissionError("STUDENT_NOT_FOUND", "Aluno não encontrado."));
    const before: Entry = { ...s.data, fullName: s.fullName, birthDate: s.birthDate, ...(s.gender ? { gender: s.gender } : {}) };
    // as mesmas regras do formulário (sem obrigar ao que o colégio não pede); a idade não decide aqui quem inscreve
    const checked = checkFixed("STUDENT", PERSONAL_FIELDS, raw, true, { countryCode: this.countryCode, today: this.today(), files: [], accountKind: "STUDENT", studentAdult: false });
    if (Object.keys(checked.errors).length) return fail(admissionError("INVALID_INPUT", "Há dados por corrigir.", { errors: checked.errors }));
    const next = checked.value;
    const changes = PERSONAL_FIELDS.filter((f) => value(before[f.key]) !== value(next[f.key])).map((f) => ({ key: f.key, label: f.label, from: value(before[f.key]), to: value(next[f.key]) }));
    if (!changes.length) return ok({ changed: 0 });
    const data: Entry = { ...s.data };
    for (const f of PERSONAL_FIELDS) {
      if ((CORE_KEYS as readonly string[]).includes(f.key)) continue;
      if (next[f.key] === undefined) delete data[f.key];
      else data[f.key] = next[f.key];
    }
    const now = this.clock.now();
    await repo.update(id, { fullName: String(next.fullName), birthDate: String(next.birthDate), gender: typeof next.gender === "string" ? next.gender : null, data }, now);
    await repo.record("STUDENT_UPDATED", id, actor.id, { changes }, now);
    return ok({ changed: changes.length });
  }

  async file(repo: StudentsRepository, store: StudentFileStore, studentId: string, fileId: string) {
    const f = await repo.file(studentId, fileId);
    if (!f) return fail(admissionError("FILE_NOT_FOUND", "Ficheiro não encontrado."));
    return ok({ content: await store.read(f.storageKey), mimeType: f.mimeType, fileName: f.fileName });
  }

  // ---------------------------------------------------------------- família

  /** A família só vê o próprio (aluno maior) ou o educando menor que gere. */
  private async canSee(repo: StudentsRepository, accountId: string, studentId: string) {
    const a = await repo.accessFor(accountId, studentId);
    return !!a && canAccessStudent(a, a.birthDate, this.today());
  }

  async familyGet(repo: StudentsRepository, accountId: string, studentId: string) {
    if (!(await this.canSee(repo, accountId, studentId))) return fail(admissionError("STUDENT_NOT_FOUND", "Aluno não encontrado."));
    const s = await repo.detail(studentId);
    if (!s) return fail(admissionError("STUDENT_NOT_FOUND", "Aluno não encontrado."));
    const v = this.view(s);
    // a família vê os encarregados sem as marcas internas (financeiro/gere)
    return ok({ ...v, guardians: v.guardians.map(({ isFinancial: _f, canManage: _c, hasAccount: _h, ...g }) => g), enrollments: v.enrollments.map(({ exceptionReason: _e, ...e }) => e) });
  }

  async familyFile(repo: StudentsRepository, store: StudentFileStore, accountId: string, studentId: string, fileId: string) {
    if (!(await this.canSee(repo, accountId, studentId))) return fail(admissionError("FILE_NOT_FOUND", "Ficheiro não encontrado."));
    return this.file(repo, store, studentId, fileId);
  }
}
