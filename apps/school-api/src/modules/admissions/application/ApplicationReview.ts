import type { Clock } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok } from "../../../../../../libs/kernel/src/domain/Result";
import { isAdult, luandaToday } from "../../family/domain/family";
import { APPLICATION_STATUS, type ApplicationStatus, isStepKey, STEPS, type StepKey, stepsFor } from "../domain/applications";
import { admissionError, PROCESS_TYPES, type ProcessType } from "../domain/settings";
import { applicationView, classLabelOf, loadForm } from "./Applications";
import type { ApplicationFileStore, ApplicationsMailer, ApplicationsRepository } from "./applications-ports";
import type { AdmissionFormsRepository } from "./forms-ports";

type Actor = { id: string; name: string };
type School = { name: string; slug: string };

/** O que a secretaria pode fazer a partir de cada estado. */
const FROM: Record<"review" | "corrections" | "approve" | "reject", ApplicationStatus[]> = {
  review: ["SUBMITTED"],
  corrections: ["SUBMITTED", "UNDER_REVIEW"],
  approve: ["SUBMITTED", "UNDER_REVIEW"],
  reject: ["SUBMITTED", "UNDER_REVIEW", "CORRECTION_REQUIRED"],
};

const clean = (s: string | null | undefined) => s?.replace(/\s+/g, " ").trim() || null;

/**
 * Análise das inscrições pela secretaria (fase D).
 *   submetida → em análise (a família deixa de poder alterar) → aprovada / rejeitada
 *   submetida ou em análise → correções pedidas (motivo + passos) → a família corrige e reenvia
 * Cada decisão fica no histórico (quem, quando, de → para, motivo) e a família recebe um email.
 * A aprovação NÃO é a matrícula (fase E).
 */
export class ApplicationReview {
  constructor(
    private readonly clock: Clock,
    private readonly mailer: ApplicationsMailer,
  ) {}

  private today() {
    return luandaToday(this.clock.now());
  }

  async list(repo: ApplicationsRepository, input: { yearId?: string; classId?: string; status?: string; processType?: string; q?: string; page?: number }) {
    const status = input.status && input.status in APPLICATION_STATUS && input.status !== "DRAFT" ? (input.status as ApplicationStatus) : undefined;
    const processType = input.processType && input.processType in PROCESS_TYPES ? (input.processType as ProcessType) : undefined;
    const page = Math.max(1, Math.floor(input.page ?? 1));
    const pageSize = 25;
    const [res, years] = await Promise.all([repo.staffList({ yearId: input.yearId || undefined, classId: input.classId || undefined, status, processType, q: input.q?.slice(0, 80), page, pageSize }), repo.yearsWithApplications()]);
    return {
      page,
      pageSize,
      total: res.total,
      processes: Object.entries(PROCESS_TYPES).map(([value, p]) => ({ value, label: p.label })),
      statuses: (Object.keys(APPLICATION_STATUS) as ApplicationStatus[]).filter((s) => s !== "DRAFT").map((s) => ({ value: s, label: APPLICATION_STATUS[s], count: res.counts[s] ?? 0 })),
      years: years.map((y) => ({ id: y.id, name: y.name, classes: y.classes.map((c) => ({ id: c.id, label: classLabelOf(c) })) })),
      applications: res.rows.map((r) => ({
        id: r.id,
        number: r.number,
        processLabel: PROCESS_TYPES[r.processType].label,
        status: r.status,
        statusLabel: APPLICATION_STATUS[r.status],
        studentName: r.studentName,
        applicantName: r.applicantName,
        applicantKind: r.applicantKind,
        yearName: r.yearName,
        classLabel: r.grade === null ? null : classLabelOf({ grade: r.grade, courseName: r.courseName }),
        submittedAt: r.submittedAt?.toISOString() ?? null,
        updatedAt: r.updatedAt.toISOString(),
      })),
    };
  }

  async get(repo: ApplicationsRepository, forms: AdmissionFormsRepository, id: string, canReview: boolean) {
    const app = await repo.byId(id);
    // os rascunhos são só da família
    if (!app || app.status === "DRAFT") return fail(admissionError("APPLICATION_NOT_FOUND", "Inscrição não encontrada."));
    const form = await loadForm(forms, app);
    if (!form) return fail(admissionError("VERSION_NOT_FOUND", "O formulário desta inscrição já não existe."));
    const [files, yearName, cls, history, applicant, lastDecision] = await Promise.all([
      repo.files(app.id),
      app.academicYearId ? repo.yearName(app.academicYearId) : Promise.resolve(null),
      app.classId ? repo.classLabel(app.classId) : Promise.resolve(null),
      repo.history(app.id),
      repo.applicant(app.accountId),
      repo.lastDecision(app.id),
    ]);
    const kind = applicant?.kind ?? "GUARDIAN";
    const adult = kind === "STUDENT" || (typeof app.studentData.birthDate === "string" && isAdult(app.studentData.birthDate, this.today()));
    const view = applicationView({ app, form, files, years: [], yearName, cls, accountKind: kind, studentAdult: adult, student: app.studentData, problems: {}, lastDecision });
    const can = (k: keyof typeof FROM) => canReview && FROM[k].includes(app.status);
    return ok({
      ...view,
      // para a secretaria a inscrição nunca é "editável" (quem altera os dados é a família)
      editable: false,
      canDiscard: false,
      applicant: applicant ? { fullName: applicant.fullName, email: applicant.email, phone: applicant.phone, kind: applicant.kind, kindLabel: applicant.kind === "STUDENT" ? "Aluno maior de idade (o próprio)" : "Encarregado de educação" } : null,
      familyCanEdit: ["SUBMITTED", "CORRECTION_REQUIRED"].includes(app.status),
      actions: { review: can("review"), corrections: can("corrections"), approve: can("approve"), reject: can("reject") },
      correctionSteps: stepsFor(form)
        .filter((k) => k !== "revisao")
        .map((k) => ({ key: k, label: STEPS[k] })),
      history: history.map((h) => ({
        id: h.id,
        from: h.fromStatus,
        fromLabel: h.fromStatus ? APPLICATION_STATUS[h.fromStatus] : null,
        to: h.toStatus,
        toLabel: APPLICATION_STATUS[h.toStatus],
        actorKind: h.actorKind,
        actorName: h.actorName,
        reason: h.reason,
        notes: h.notes,
        steps: h.steps.map((k) => ({ key: k, label: STEPS[k] })),
        at: h.createdAt.toISOString(),
      })),
    });
  }

  async readFile(repo: ApplicationsRepository, store: ApplicationFileStore, id: string, fileId: string) {
    const app = await repo.byId(id);
    if (!app || app.status === "DRAFT") return fail(admissionError("APPLICATION_NOT_FOUND", "Inscrição não encontrada."));
    const f = (await repo.files(id)).find((x) => x.id === fileId);
    if (!f) return fail(admissionError("FILE_NOT_FOUND", "Ficheiro não encontrado."));
    return ok({ content: await store.read(f.storageKey), mimeType: f.mimeType, fileName: f.fileName });
  }

  /**
   * Uma decisão. `reason` obrigatório para pedir correções e rejeitar; `steps` (os passos a
   * corrigir) obrigatório para pedir correções.
   */
  async decide(
    repo: ApplicationsRepository,
    actor: Actor,
    school: School,
    id: string,
    action: keyof typeof FROM,
    input: { reason?: string | null; notes?: string | null; steps?: string[] },
  ) {
    const app = await repo.byId(id);
    if (!app || app.status === "DRAFT") return fail(admissionError("APPLICATION_NOT_FOUND", "Inscrição não encontrada."));
    const reason = clean(input.reason);
    const notes = clean(input.notes);
    if ((reason?.length ?? 0) > 1000 || (notes?.length ?? 0) > 1000) return fail(admissionError("INVALID_INPUT", "O texto tem no máximo 1000 caracteres."));
    const steps = [...new Set(input.steps ?? [])].filter(isStepKey).filter((k) => k !== "revisao") as StepKey[];
    if (action === "corrections") {
      if (!reason || reason.length < 5) return fail(admissionError("INVALID_INPUT", "Explique à família o que tem de corrigir (pelo menos 5 caracteres)."));
      if (!steps.length) return fail(admissionError("INVALID_INPUT", "Escolha os passos que a família tem de corrigir."));
    }
    if (action === "reject" && (!reason || reason.length < 5)) return fail(admissionError("INVALID_INPUT", "Indique o motivo da rejeição (pelo menos 5 caracteres)."));
    if (!FROM[action].includes(app.status)) return fail(admissionError("NOT_EDITABLE", `A inscrição está “${APPLICATION_STATUS[app.status]}”: esta ação já não se aplica.`));

    const to: ApplicationStatus = { review: "UNDER_REVIEW", corrections: "CORRECTION_REQUIRED", approve: "APPROVED", reject: "REJECTED" }[action] as ApplicationStatus;
    const now = this.clock.now();
    const done = await repo.decide({ applicationId: id, from: FROM[action], to, actorId: actor.id, actorName: actor.name, reason: action === "review" ? null : reason, notes, steps: action === "corrections" ? steps : [], now });
    if (!done) return fail(admissionError("STALE", "A inscrição mudou entretanto (a família reenviou ou outra pessoa decidiu). Recarregue a página."));
    await repo.record(`APPLICATION_${to}`, id, actor.id, { number: app.number, from: app.status, reason, steps }, now);

    if (to !== "UNDER_REVIEW") {
      const applicant = await repo.applicant(app.accountId);
      if (applicant) {
        try {
          await this.mailer.decision({
            to: { email: applicant.email, name: applicant.fullName },
            school,
            number: app.number ?? "",
            studentName: typeof app.studentData.fullName === "string" ? app.studentData.fullName : "o aluno",
            status: to as "CORRECTION_REQUIRED" | "APPROVED" | "REJECTED",
            reason,
            steps: steps.map((k) => STEPS[k]),
          });
        } catch {
          /* a decisão fica gravada mesmo que o email falhe (a família vê-a na área da família) */
        }
      }
    }
    return ok({ status: to, statusLabel: APPLICATION_STATUS[to] });
  }
}
