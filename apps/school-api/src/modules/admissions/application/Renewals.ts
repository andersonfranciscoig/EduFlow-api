import type { Clock, IdGenerator } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok } from "../../../../../../libs/kernel/src/domain/Result";
import type { FamilyAccountRow } from "../../family/application/ports";
import { canAccessStudent, luandaToday } from "../../family/domain/family";
import { gradeLabel } from "../../pedagogy/domain/academic";
import { APPLICATION_STATUS, type ApplicationStatus, type Entry, SHIFTS, type Shift } from "../domain/applications";
import { formatStudentNumber } from "../domain/enrollment";
import { ACTIVE_RENEWAL, type CurrentEnrollment, nextWindow, RENEWAL_STATE_LABELS, type RenewalState, type RenewalWindow, windowState } from "../domain/renewals";
import { admissionError } from "../domain/settings";
import type { ApplicationsRepository } from "./applications-ports";
import type { AdmissionFormsRepository } from "./forms-ports";

// ================================================================ portas

export interface RenewalCandidateRow {
  id: string;
  fullName: string;
  birthDate: string;
  number: number | null;
  self: boolean;
  managing: boolean;
  current: CurrentEnrollment | null;
}

export interface RenewalAppRow {
  id: string;
  studentId: string;
  academicYearId: string;
  status: ApplicationStatus;
  number: string | null;
  enrollmentNumber: string | null;
}

export interface NextClassRow {
  id: string;
  grade: number;
  courseName: string | null;
  shifts: Shift[];
}

export interface StaffRenewalRow {
  studentId: string;
  fullName: string;
  number: number | null;
  grade: number;
  courseName: string | null;
  groupName: string | null;
  guardianName: string | null;
  guardianPhone: string | null;
  applicationId: string | null;
  applicationNumber: string | null;
  status: ApplicationStatus | null;
  enrollmentNumber: string | null;
}

export interface RenewalsRepository {
  /** Os anos letivos (não encerrados) e a janela de renovações de cada um. */
  windows(): Promise<RenewalWindow[]>;
  /** Os alunos ligados à conta (o próprio e os educandos que gere), com a matrícula ativa mais recente. */
  candidates(accountId: string): Promise<RenewalCandidateRow[]>;
  /** As renovações destes alunos (de qualquer ano), com o n.º de matrícula se já matriculados. */
  apps(studentIds: string[]): Promise<RenewalAppRow[]>;
  /** As classes desta classe (grade) no ano (mesmo curso, se o aluno já tiver curso). */
  nextClasses(yearId: string, grade: number, courseId: string | null): Promise<NextClassRow[]>;
  /** O aluno não transitou nesse ano (deliberação da direção, ou o resultado calculado)? */
  retained(studentId: string, yearId: string): Promise<boolean>;
  /** Os dados que o colégio já tem: o aluno e o encarregado (o da conta, ou o principal). */
  prefill(studentId: string, accountId: string): Promise<{ student: Entry; guardian: Entry }>;
  /** Secretaria: os alunos matriculados no ano anterior e a renovação de cada um para o ano. */
  staffRows(targetYearId: string, previousYearId: string): Promise<StaffRenewalRow[]>;
}

const classLabel = (grade: number, course: string | null) => `${gradeLabel(grade)}${course ? ` — ${course}` : ""}`;
const fmt = (iso: string | null) => (iso ? iso.split("-").reverse().join("/") : null);

/**
 * Renovações de matrícula (fase G). A renovação é uma inscrição RENOVACAO já ligada ao aluno e
 * preenchida; segue depois o caminho de sempre (análise, vaga, matrícula).
 */
export class Renewals {
  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  private today() {
    return luandaToday(this.clock.now());
  }

  /** O estado da renovação de cada aluno matriculado da conta. */
  private async familyState(repo: RenewalsRepository, accountId: string) {
    const today = this.today();
    const [windows, all] = await Promise.all([repo.windows(), repo.candidates(accountId)]);
    const students = all.filter((s) => s.current && canAccessStudent({ self: s.self, managingGuardian: s.managing }, s.birthDate, today));
    const apps = students.length ? await repo.apps(students.map((s) => s.id)) : [];
    return Promise.all(
      students.map(async (s) => {
        const cur = s.current!;
        const next = nextWindow(windows, cur);
        // já renovado: a matrícula atual veio de uma renovação e o ano a seguir ainda não tem período
        const renewed = apps.find((a) => a.studentId === s.id && a.academicYearId === cur.yearId && a.enrollmentNumber);
        if (renewed && windowState(next, today) === "NOT_SET") {
          const w = windows.find((x) => x.id === cur.yearId) ?? null;
          return { s, cur, w, app: renewed, classes: [] as NextClassRow[], state: "ENROLLED" as RenewalState, retained: false, target: cur.grade };
        }
        const w = next;
        const app = w ? apps.find((a) => a.studentId === s.id && a.academicYearId === w.id && (ACTIVE_RENEWAL.includes(a.status) || a.enrollmentNumber)) : undefined;
        // não transitou: propõe-se a mesma classe (sem impedir a renovação)
        const retained = await repo.retained(s.id, cur.yearId);
        const target = retained ? cur.grade : cur.grade + 1;
        const classes = w ? await repo.nextClasses(w.id, target, cur.courseId) : [];
        const wState = windowState(w, today);
        const state: RenewalState = app?.enrollmentNumber ? "ENROLLED" : app ? "STARTED" : wState === "OPEN" && !classes.length ? "NO_CLASS" : wState;
        return { s, cur, w, app, classes, state, retained, target };
      }),
    );
  }

  /** Família · a página das renovações: um cartão por aluno matriculado, com o que pode fazer. */
  async familyList(repo: RenewalsRepository, account: FamilyAccountRow) {
    const rows = await this.familyState(repo, account.id);
    return {
      students: rows.map(({ s, cur, w, app, classes, state, retained, target }) => ({
        id: s.id,
        fullName: s.fullName,
        number: formatStudentNumber(s.number),
        self: s.self,
        current: { yearName: cur.yearName, classLabel: classLabel(cur.grade, cur.courseName), groupName: cur.groupName, shiftLabel: cur.shift ? SHIFTS[cur.shift] : null },
        next: w ? { yearId: w.id, yearName: w.name, from: w.from, to: w.to, fromLabel: fmt(w.from), toLabel: fmt(w.to), classLabel: classes.length === 1 ? classLabel(classes[0].grade, classes[0].courseName) : classes.length ? `${gradeLabel(target)} (a escolher)` : null } : null,
        /** não transitou: a renovação propõe a mesma classe */
        retained,
        state,
        stateLabel: RENEWAL_STATE_LABELS[state],
        canStart: state === "OPEN",
        application: app ? { id: app.id, number: app.number, status: app.status, statusLabel: APPLICATION_STATUS[app.status], enrollmentNumber: app.enrollmentNumber } : null,
      })),
    };
  }

  /** Para o percurso no início: o estado da renovação por aluno. */
  async familyStates(repo: RenewalsRepository, accountId: string) {
    const rows = await this.familyState(repo, accountId);
    return new Map(
      rows.map(({ s, w, app, state }) => [
        s.id,
        { state, label: app ? (app.enrollmentNumber ? `Renovada · ${app.enrollmentNumber}` : APPLICATION_STATUS[app.status]) : state === "UPCOMING" && w?.from ? `Abre a ${fmt(w.from)}` : state === "OPEN" && w?.to ? `Até ${fmt(w.to)}` : RENEWAL_STATE_LABELS[state], yearName: w?.name ?? null, applicationId: app?.id ?? null },
      ]),
    );
  }

  /**
   * Começar a renovação: uma inscrição RENOVACAO ligada ao aluno, preenchida com o que o colégio
   * já tem (aluno, encarregado), o ano seguinte e a classe seguinte. Se já existir, devolve-a.
   */
  async start(repo: RenewalsRepository, applications: ApplicationsRepository, forms: AdmissionFormsRepository, account: FamilyAccountRow, studentId: string) {
    const row = (await this.familyState(repo, account.id)).find((r) => r.s.id === studentId);
    if (!row) return fail(admissionError("STUDENT_NOT_FOUND", "Aluno não encontrado."));
    if (row.app) return ok({ id: row.app.id, existing: true });
    if (row.state !== "OPEN") return fail(admissionError("RENEWALS_CLOSED", row.state === "NO_CLASS" ? "O colégio ainda não abriu a classe seguinte para o próximo ano letivo." : "A renovação deste aluno não está aberta neste momento."));
    const latest = await forms.latestVersion();
    if (!latest) return fail(admissionError("RENEWALS_CLOSED", "O colégio ainda não publicou o formulário."));
    const { student, guardian } = await repo.prefill(studentId, account.id);
    const cls = row.classes.length === 1 ? row.classes[0] : null;
    const shift = cls && row.cur.shift && (!cls.shifts.length || cls.shifts.includes(row.cur.shift)) ? row.cur.shift : null;
    const now = this.clock.now();
    const id = this.ids.next();
    await applications.create({
      id,
      accountId: account.id,
      studentId,
      processType: "RENOVACAO",
      formVersion: latest.number,
      academicYearId: row.w!.id,
      classId: cls?.id ?? null,
      shift,
      studentData: account.kind === "STUDENT" && account.birthDate ? { ...student, birthDate: account.birthDate } : student,
      guardianData: account.kind === "GUARDIAN" ? { ...guardian, fullName: guardian.fullName ?? account.fullName, email: guardian.email ?? account.email } : guardian,
      sectionsData: {},
      status: "DRAFT",
      currentStep: "candidatura",
      createdAt: now,
    });
    await applications.record("APPLICATION_STARTED", id, null, { accountId: account.id, processType: "RENOVACAO", studentId, formVersion: latest.number }, now);
    return ok({ id, existing: false });
  }

  /**
   * Secretaria · as renovações de um ano: os alunos matriculados no ano anterior e o ponto em que
   * está a renovação de cada um (por iniciar, rascunho, submetida, aprovada, matriculado).
   */
  async staff(repo: RenewalsRepository, yearId: string | undefined) {
    const today = this.today();
    const windows = (await repo.windows()).sort((a, b) => a.startsOn.localeCompare(b.startsOn));
    // anos com um ano anterior (há de onde renovar)
    const targets = windows.filter((w) => windows.some((p) => p.startsOn < w.startsOn));
    const target = targets.find((w) => w.id === yearId) ?? targets.find((w) => windowState(w, today) === "OPEN") ?? targets.find((w) => w.from) ?? null;
    const years = targets.map((w) => ({ id: w.id, name: w.name, state: windowState(w, today), from: fmt(w.from), to: fmt(w.to) }));
    if (!target) return { years, year: null, previousYear: null, totals: null, rows: [] };
    const previous = [...windows].filter((w) => w.startsOn < target.startsOn).pop() ?? null;
    const rows = previous ? await repo.staffRows(target.id, previous.id) : [];
    const stage = (r: StaffRenewalRow) => (r.enrollmentNumber ? "ENROLLED" : !r.status || r.status === "CANCELLED" ? "NOT_STARTED" : r.status === "DRAFT" ? "DRAFT" : r.status === "APPROVED" ? "APPROVED" : r.status === "REJECTED" ? "REJECTED" : "SUBMITTED");
    const STAGES = { NOT_STARTED: "Por iniciar", DRAFT: "Em preenchimento", SUBMITTED: "Submetida", APPROVED: "Aprovada", REJECTED: "Rejeitada", ENROLLED: "Matriculado" } as const;
    const out = rows.map((r) => {
      const st = stage(r);
      return {
        studentId: r.studentId,
        fullName: r.fullName,
        number: formatStudentNumber(r.number),
        classLabel: classLabel(r.grade, r.courseName),
        groupName: r.groupName,
        guardianName: r.guardianName,
        guardianPhone: r.guardianPhone,
        stage: st,
        stageLabel: STAGES[st],
        application: r.applicationId ? { id: r.applicationId, number: r.applicationNumber, statusLabel: r.status ? APPLICATION_STATUS[r.status] : null } : null,
        enrollmentNumber: r.enrollmentNumber,
      };
    });
    const totals = Object.fromEntries(Object.keys(STAGES).map((k) => [k, out.filter((r) => r.stage === k).length])) as Record<keyof typeof STAGES, number>;
    return {
      years,
      year: { id: target.id, name: target.name, state: windowState(target, today), stateLabel: RENEWAL_STATE_LABELS[windowState(target, today)], from: fmt(target.from), to: fmt(target.to) },
      previousYear: previous ? { id: previous.id, name: previous.name } : null,
      stages: Object.entries(STAGES).map(([value, label]) => ({ value, label, count: totals[value as keyof typeof STAGES] })),
      totals,
      rows: out,
    };
  }
}
