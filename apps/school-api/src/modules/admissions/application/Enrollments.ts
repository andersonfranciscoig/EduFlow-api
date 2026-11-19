import type { Clock } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok } from "../../../../../../libs/kernel/src/domain/Result";
import type { FamilyAccountRow } from "../../family/application/ports";
import { luandaToday } from "../../family/domain/family";
import { gradeLabel } from "../../pedagogy/domain/academic";
import { SHIFTS } from "../domain/applications";
import { checkConfig, ENROLLMENT_BY, ENROLLMENT_MODES, type EnrollmentConfig, formatEnrollmentNumber, formatStudentNumber } from "../domain/enrollment";
import { admissionError } from "../domain/settings";
import type { ApplicationsMailer, ApplicationsRepository } from "./applications-ports";
import type { EnrollmentRow, EnrollmentsRepository, EnrollOutcome } from "./enrollments-ports";

type School = { name: string; slug: string };
const DAY = 86_400_000;
const classLabel = (grade: number, course: string | null) => `${gradeLabel(grade)}${course ? ` — ${course}` : ""}`;
const dtf = new Intl.DateTimeFormat("pt-PT", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Africa/Luanda" });

const ERRORS: Record<Extract<EnrollOutcome, { ok: false }>["reason"], { code: Parameters<typeof admissionError>[0]; message: string }> = {
  not_approved: { code: "NOT_EDITABLE", message: "Só se matricula uma inscrição aprovada." },
  already_enrolled: { code: "ALREADY_ENROLLED", message: "Este aluno já está matriculado neste ano letivo." },
  no_vacancy: { code: "NO_VACANCY", message: "Já não há vagas nesta classe. Só com uma exceção autorizada (e um motivo)." },
  group_full: { code: "NO_VACANCY", message: "Esta turma já não tem lugares. Escolha outra (ou deixe a escolha automática)." },
  invalid_group: { code: "INVALID_INPUT", message: "Esta turma não é desta classe." },
  year_closed: { code: "YEAR_CLOSED", message: "O ano letivo está encerrado." },
  no_groups: { code: "NO_GROUPS", message: "Esta classe ainda não tem turmas: crie-as em Pedagógico → Classes e turmas." },
};

/** A matrícula como se mostra (secretaria, família e comprovativo). */
export function enrollmentView(e: EnrollmentRow) {
  return {
    id: e.id,
    number: e.number,
    status: e.status,
    statusLabel: e.status === "ACTIVE" ? "Ativa" : "Anulada",
    studentName: e.studentName,
    studentNumber: formatStudentNumber(e.studentNumber),
    guardianName: e.guardianName,
    applicationNumber: e.applicationNumber,
    yearName: e.yearName,
    classLabel: classLabel(e.grade, e.courseName),
    gradeLabel: gradeLabel(e.grade),
    courseName: e.courseName,
    groupName: e.groupName,
    shift: e.shift,
    shiftLabel: e.shift ? SHIFTS[e.shift] : null,
    byKind: e.byKind,
    byLabel: ENROLLMENT_BY[e.byKind],
    byName: e.byName,
    exceptionReason: e.exceptionReason,
    enrolledAt: e.enrolledAt.toISOString(),
  };
}

/**
 * Matrículas (fase E): configuração, vaga guardada ao aprovar e a matrícula em si.
 * Quem confirma depende da configuração: a secretaria, a família, ou automático ao aprovar.
 */
export class Enrollments {
  constructor(
    private readonly clock: Clock,
    private readonly mailer: ApplicationsMailer,
  ) {}

  // ---------------------------------------------------------------- configuração

  async config(repo: EnrollmentsRepository, canManage: boolean) {
    const cfg = await repo.config();
    return {
      ...cfg,
      canManage,
      modes: Object.entries(ENROLLMENT_MODES).map(([value, m]) => ({ value, label: m.label, hint: m.hint })),
      example: formatEnrollmentNumber(cfg, `${luandaToday(this.clock.now()).slice(0, 4)}-01-01`, 1),
    };
  }

  async saveConfig(repo: EnrollmentsRepository, actorId: string | null, input: Partial<EnrollmentConfig>) {
    const cfg = checkConfig(input);
    if (!cfg.ok) return cfg;
    const now = this.clock.now();
    await repo.saveConfig(cfg.value, actorId, now);
    await repo.record("ENROLLMENT_CONFIG_UPDATED", actorId ?? "00000000-0000-0000-0000-000000000000", actorId, { ...cfg.value }, now);
    return ok({ ...cfg.value, example: formatEnrollmentNumber(cfg.value, `${luandaToday(now).slice(0, 4)}-01-01`, 1) });
  }

  // ---------------------------------------------------------------- ao aprovar

  /**
   * Depois de aprovar: guarda uma vaga até ao fim do período de matrículas (ou N dias) e, no modo
   * automático, matricula logo. Sem vaga, a inscrição fica aprovada sem vaga guardada.
   */
  async afterApproval(repo: EnrollmentsRepository, apps: ApplicationsRepository, school: School, applicationId: string, actor: { id: string; name: string }) {
    const app = await apps.byId(applicationId);
    if (!app?.classId || !app.academicYearId || !app.number) return { held: false, enrolled: null };
    const cfg = await repo.config();
    const now = this.clock.now();
    const end = await repo.enrollmentsEnd(app.academicYearId);
    const endAt = end ? new Date(`${end}T23:59:59+01:00`) : null;
    const expiresAt = endAt && endAt > now ? endAt : new Date(now.getTime() + cfg.holdDays * DAY);
    const hold = await repo.holdForApplication({ applicationId, classId: app.classId, reference: app.number, expiresAt, now });
    if (cfg.enrollmentMode !== "AUTO") return { held: hold.ok, enrolled: null };
    const r = await repo.enroll({ applicationId, groupId: null, exceptionReason: null, by: { kind: "AUTO", id: actor.id, name: actor.name }, cfg, now });
    if (!r.ok) return { held: hold.ok, enrolled: null };
    this.later(() => this.notify(repo, apps, school, r.enrollment));
    return { held: true, enrolled: enrollmentView(r.enrollment) };
  }

  // ---------------------------------------------------------------- confirmar a matrícula

  /** O que a secretaria vê para confirmar: vagas, turmas com lugares, a vaga guardada, o preçário. */
  async options(repo: EnrollmentsRepository, applicationId: string) {
    const [seats, cfg] = await Promise.all([repo.seats(applicationId, this.clock.now()), repo.config()]);
    if (!seats) return null;
    const fees = await repo.fees(seats.classId);
    return {
      mode: cfg.enrollmentMode,
      modeLabel: ENROLLMENT_MODES[cfg.enrollmentMode].label,
      vacancies: seats.vacancies,
      available: seats.available,
      held: seats.heldForApplication ? { expiresAt: seats.heldForApplication.expiresAt?.toISOString() ?? null, expired: seats.heldForApplication.expired } : null,
      groups: seats.groups.map((g) => ({ id: g.id, name: g.name, shift: g.shift, shiftLabel: SHIFTS[g.shift], capacity: g.capacity, confirmed: g.confirmed, free: Math.max(0, (g.capacity ?? 0) - g.confirmed) })),
      fees: fees.map((f) => ({ ...f, billingLabel: f.billing === "MENSAL" ? "Mensal" : "Única", appliesToLabel: { TODOS: "Todos", NOVOS: "Alunos novos", CONTINUANTES: "Continuantes" }[f.appliesTo] })),
    };
  }

  /** Depois da resposta: o que falhar aqui fica no log e não desfaz a matrícula. */
  private later(work: () => Promise<unknown>) {
    void work().catch((e: unknown) => console.error(`[matrículas] tarefa depois da matrícula falhou: ${e instanceof Error ? e.message : String(e)}`));
  }

  private async notify(repo: EnrollmentsRepository, apps: ApplicationsRepository, school: School, e: EnrollmentRow) {
    if (!e.accountId) return;
    const applicant = await apps.applicant(e.accountId);
    if (!applicant) return;
    try {
      await this.mailer.enrolled({
        to: { email: applicant.email, name: applicant.fullName },
        school,
        studentName: e.studentName,
        number: e.number,
        studentNumber: formatStudentNumber(e.studentNumber) ?? "",
        classLabel: classLabel(e.grade, e.courseName),
        groupName: e.groupName,
        yearName: e.yearName,
        date: dtf.format(e.enrolledAt),
      });
    } catch {
      /* a matrícula fica feita mesmo que o email falhe */
    }
    void repo;
  }

  /**
   * Matricular. Secretaria: pode escolher a turma; numa exceção (sem vaga), com a permissão própria e um
   * motivo. Família: só no modo "pela família", sem escolher turma nem exceções.
   */
  async enroll(
    repo: EnrollmentsRepository,
    apps: ApplicationsRepository,
    school: School,
    applicationId: string,
    by: { kind: "STAFF" | "FAMILY"; id: string; name: string },
    input: { groupId?: string | null; exceptionReason?: string | null },
    canOverride: boolean,
  ) {
    const cfg = await repo.config();
    if (by.kind === "FAMILY" && cfg.enrollmentMode !== "FAMILY") return fail(admissionError("FORBIDDEN", "Neste colégio a matrícula é confirmada pela secretaria."));
    const reason = input.exceptionReason?.replace(/\s+/g, " ").trim() || null;
    if (reason && !canOverride) return fail(admissionError("FORBIDDEN", "Matricular sem vaga exige a permissão de exceções."));
    if (reason && (reason.length < 5 || reason.length > 500)) return fail(admissionError("INVALID_INPUT", "Explique a exceção (5 a 500 caracteres)."));
    const r = await repo.enroll({ applicationId, groupId: by.kind === "FAMILY" ? null : (input.groupId ?? null), exceptionReason: by.kind === "FAMILY" ? null : reason, by, cfg, now: this.clock.now() });
    if (!r.ok) return fail(admissionError(ERRORS[r.reason].code, ERRORS[r.reason].message));
    // o registo e o email não atrasam a resposta (com a BD e o Brevo remotos, contam segundos)
    this.later(async () => {
      await repo.record("STUDENT_ENROLLED", r.enrollment.id, by.kind === "STAFF" ? by.id : null, { number: r.enrollment.number, applicationId, exception: reason }, this.clock.now());
      await this.notify(repo, apps, school, r.enrollment);
    });
    return ok(enrollmentView(r.enrollment));
  }

  async byApplication(repo: EnrollmentsRepository, applicationId: string) {
    const e = await repo.byApplication(applicationId);
    return e ? enrollmentView(e) : null;
  }

  /** Comprovativo (secretaria). */
  async receipt(repo: EnrollmentsRepository, id: string) {
    const e = await repo.byId(id);
    return e ? ok(enrollmentView(e)) : fail(admissionError("ENROLLMENT_NOT_FOUND", "Matrícula não encontrada."));
  }

  /** Comprovativo (família): só da própria inscrição. */
  async familyReceipt(repo: EnrollmentsRepository, apps: ApplicationsRepository, account: FamilyAccountRow, applicationId: string) {
    const app = await apps.byId(applicationId);
    if (!app || app.accountId !== account.id) return fail(admissionError("APPLICATION_NOT_FOUND", "Inscrição não encontrada."));
    const e = await repo.byApplication(applicationId);
    return e ? ok(enrollmentView(e)) : fail(admissionError("ENROLLMENT_NOT_FOUND", "Esta inscrição ainda não tem matrícula."));
  }
}
