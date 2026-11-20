import type { Clock } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok } from "../../../../../../libs/kernel/src/domain/Result";
import { ageOn, isAdult, luandaToday } from "../../family/domain/family";
import { gradeLabel } from "../../pedagogy/domain/academic";
import { APPLICATION_STATUS, type ApplicationStatus, type Entry, SHIFTS, type Shift } from "../domain/applications";
import { ENROLLMENT_BY, formatStudentNumber } from "../domain/enrollment";
import { admissionError, PROCESS_TYPES, type ProcessType } from "../domain/settings";
import { STUDENT_STATUS_LABELS, type StudentStatus } from "../domain/students";

// ================================================================ portas

export interface EnrollmentListRow {
  id: string;
  number: string;
  applicationId: string | null;
  studentId: string;
  studentName: string;
  studentNumber: number | null;
  yearName: string;
  grade: number;
  courseName: string | null;
  groupName: string | null;
  shift: Shift | null;
  status: "ACTIVE" | "CANCELLED";
  byKind: keyof typeof ENROLLMENT_BY;
  byName: string | null;
  processType: ProcessType | null;
  exception: boolean;
  enrolledAt: Date;
}

export interface GuardianListRow {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  hasAccount: boolean;
  students: { id: string; fullName: string; relationship: string; isPrimary: boolean }[];
  enrolled: number;
}

export interface GuardianDetailRow {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  data: Entry;
  createdAt: Date;
  account: { email: string; kind: string; createdAt: Date; lastLoginAt: Date | null } | null;
  students: {
    id: string;
    fullName: string;
    number: number | null;
    birthDate: string;
    status: StudentStatus;
    relationship: string;
    relationshipOther: string | null;
    isPrimary: boolean;
    isEmergency: boolean;
    isFinancial: boolean;
    canManage: boolean;
    current: { yearName: string; grade: number; courseName: string | null; groupName: string | null } | null;
  }[];
}

export interface StatsRow {
  years: { id: string; name: string; startsOn: string }[];
  byGrade: { grade: number; courseName: string | null; enrolled: number; capacity: number }[];
  byMonth: { month: string; fresh: number; renewals: number }[];
  byGender: { gender: string | null; count: number }[];
  applications: { status: ApplicationStatus; processType: ProcessType; count: number }[];
  /** alunos do ano anterior (para a renovação) e quantos já estão matriculados neste */
  renewal: { previous: number; renewed: number } | null;
}

export interface RegistryRepository {
  enrollments(f: { yearId?: string; classId?: string; status?: "ACTIVE" | "CANCELLED"; q?: string; page: number; pageSize: number }): Promise<{ total: number; rows: EnrollmentListRow[] }>;
  enrollmentYears(): Promise<{ id: string; name: string; classes: { id: string; grade: number; courseName: string | null }[] }[]>;
  guardians(f: { q?: string; page: number; pageSize: number }): Promise<{ total: number; rows: GuardianListRow[] }>;
  guardian(id: string): Promise<GuardianDetailRow | null>;
  /** os anos com matrículas e o pedido (ou o mais recente com matrículas, ou o ano em curso) */
  stats(yearId: string | null): Promise<(StatsRow & { year: { id: string; name: string } | null }) | null>;
}

const PAGE = 25;
const classLabel = (grade: number, course: string | null) => `${gradeLabel(grade)}${course ? ` — ${course}` : ""}`;
const value = (v: unknown) => (v === undefined || v === null || v === "" ? null : Array.isArray(v) ? v.join(", ") : String(v));

/**
 * Secretaria · registos: a lista das matrículas, os encarregados (lista e ficha) e os números da
 * secretaria para o Início (alunos por classe, matrículas por mês, inscrições, renovações).
 */
export class Registry {
  constructor(private readonly clock: Clock) {}

  private today() {
    return luandaToday(this.clock.now());
  }

  async enrollments(repo: RegistryRepository, input: { yearId?: string; classId?: string; status?: string; q?: string; page?: number }) {
    const page = Math.max(1, Math.floor(input.page ?? 1));
    const status = input.status === "ACTIVE" || input.status === "CANCELLED" ? input.status : undefined;
    const [res, years] = await Promise.all([repo.enrollments({ yearId: input.yearId, classId: input.classId, status, q: input.q?.trim().slice(0, 80) || undefined, page, pageSize: PAGE }), repo.enrollmentYears()]);
    return {
      page,
      pageSize: PAGE,
      total: res.total,
      years: years.map((y) => ({ id: y.id, name: y.name, classes: y.classes.map((c) => ({ id: c.id, label: classLabel(c.grade, c.courseName) })) })),
      enrollments: res.rows.map((r) => ({
        id: r.id,
        number: r.number,
        applicationId: r.applicationId,
        studentId: r.studentId,
        studentName: r.studentName,
        studentNumber: formatStudentNumber(r.studentNumber),
        yearName: r.yearName,
        classLabel: classLabel(r.grade, r.courseName),
        groupName: r.groupName,
        shiftLabel: r.shift ? SHIFTS[r.shift] : null,
        status: r.status,
        statusLabel: r.status === "ACTIVE" ? "Ativa" : "Anulada",
        byLabel: ENROLLMENT_BY[r.byKind] ?? r.byKind,
        byName: r.byName,
        processLabel: r.processType ? PROCESS_TYPES[r.processType].label : null,
        renewal: r.processType === "RENOVACAO",
        exception: r.exception,
        enrolledAt: r.enrolledAt.toISOString(),
      })),
    };
  }

  async guardians(repo: RegistryRepository, input: { q?: string; page?: number }) {
    const page = Math.max(1, Math.floor(input.page ?? 1));
    const res = await repo.guardians({ q: input.q?.trim().slice(0, 80) || undefined, page, pageSize: PAGE });
    return { page, pageSize: PAGE, total: res.total, guardians: res.rows };
  }

  async guardian(repo: RegistryRepository, id: string) {
    const g = await repo.guardian(id);
    if (!g) return fail(admissionError("GUARDIAN_NOT_FOUND", "Encarregado não encontrado."));
    const today = this.today();
    return ok({
      id: g.id,
      fullName: g.fullName,
      email: g.email,
      phone: g.phone,
      createdAt: g.createdAt.toISOString(),
      details: [
        ["Profissão", value(g.data.profession)],
        ["Local de trabalho", value(g.data.workplace)],
        ["Telefone alternativo", value(g.data.phoneAlt)],
        ["N.º do Bilhete de Identidade", value(g.data.idNumber)],
        ["Endereço de residência", value(g.data.address)],
      ]
        .filter(([, v]) => v)
        .map(([label, v]) => ({ label: label as string, value: v as string })),
      account: g.account ? { email: g.account.email, kindLabel: g.account.kind === "STUDENT" ? "Aluno maior de idade" : "Encarregado de educação", createdAt: g.account.createdAt.toISOString(), lastLoginAt: g.account.lastLoginAt?.toISOString() ?? null } : null,
      students: g.students.map((s) => ({
        id: s.id,
        fullName: s.fullName,
        number: formatStudentNumber(s.number),
        age: ageOn(s.birthDate, today),
        adult: isAdult(s.birthDate, today),
        statusLabel: STUDENT_STATUS_LABELS[s.status],
        relationship: s.relationship === "Outro" ? (s.relationshipOther ?? "Outro") : s.relationship,
        isPrimary: s.isPrimary,
        isEmergency: s.isEmergency,
        isFinancial: s.isFinancial,
        canManage: s.canManage,
        current: s.current ? { yearName: s.current.yearName, classLabel: classLabel(s.current.grade, s.current.courseName), groupName: s.current.groupName } : null,
      })),
    });
  }

  /** Os números da secretaria (Início): o ano pedido, o mais recente com matrículas, ou o em curso. */
  async stats(repo: RegistryRepository, yearId: string | undefined) {
    const s = await repo.stats(yearId ?? null);
    if (!s || !s.year) return { year: null, years: s?.years ?? [] };
    const enrolled = s.byGrade.reduce((n, r) => n + r.enrolled, 0);
    const capacity = s.byGrade.reduce((n, r) => n + r.capacity, 0);
    const pending = s.applications.filter((a) => a.status === "SUBMITTED" || a.status === "UNDER_REVIEW" || a.status === "CORRECTION_REQUIRED").reduce((n, a) => n + a.count, 0);
    const statuses = (Object.keys(APPLICATION_STATUS) as ApplicationStatus[]).filter((x) => x !== "DRAFT");
    return {
      year: s.year,
      years: s.years.map(({ id, name }) => ({ id, name })),
      totals: { enrolled, capacity, pending, applications: s.applications.filter((a) => a.status !== "DRAFT").reduce((n, a) => n + a.count, 0) },
      byGrade: s.byGrade.map((r) => ({ grade: r.grade, label: classLabel(r.grade, r.courseName), shortLabel: r.grade === 0 ? "Inic." : `${r.grade}.ª`, enrolled: r.enrolled, capacity: r.capacity })),
      byMonth: s.byMonth,
      byGender: s.byGender.map((g) => ({ label: g.gender ?? "Por indicar", count: g.count })),
      applications: statuses.map((st) => ({ status: st, label: APPLICATION_STATUS[st], count: s.applications.filter((a) => a.status === st).reduce((n, a) => n + a.count, 0) })),
      byProcess: (Object.keys(PROCESS_TYPES) as ProcessType[]).map((p) => ({ label: PROCESS_TYPES[p].label, count: s.applications.filter((a) => a.processType === p && a.status !== "DRAFT").reduce((n, a) => n + a.count, 0) })),
      renewal: s.renewal,
    };
  }
}
