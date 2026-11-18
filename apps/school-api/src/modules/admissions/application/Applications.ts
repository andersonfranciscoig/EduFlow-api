import { createHash } from "node:crypto";
import type { Clock, IdGenerator } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import type { FamilyAccountRow } from "../../family/application/ports";
import { isAdult, luandaToday } from "../../family/domain/family";
import { FORMAT_MIME, MB, safeFileName, sniffFormat } from "../../hr/domain/employee";
import { gradeLabel } from "../../pedagogy/domain/academic";
import {
  APPLICATION_STATUS,
  checkDocuments,
  checkFixed,
  checkSections,
  type CheckContext,
  type Entry,
  type Errors,
  type FileRef,
  hasGuardianData,
  isOnlineProcess,
  isShift,
  isStepKey,
  ONLINE_PROCESSES,
  SHIFTS,
  STEPS,
  type StepKey,
  stepsFor,
} from "../domain/applications";
import { type FormSnapshot, forProcess } from "../domain/forms";
import { type AdmissionError, admissionError, PROCESS_TYPES } from "../domain/settings";
import type { AdmissionFormsRepository } from "./forms-ports";
import type { ApplicationFileStore, ApplicationRow, ApplicationsMailer, ApplicationsRepository, OpenYear } from "./applications-ports";

const PHOTO_FORMATS = ["jpg", "png", "webp"] as const;
const PHOTO_MAX_MB = 5;
const MAX_FILES = 60;
/** O que a família pode alterar (a fase D acrescenta as correções pedidas). */
const EDITABLE = ["DRAFT"];

type School = { name: string; slug: string };
type Upload = { originalname: string; buffer: Buffer } | undefined;

const classLabelOf = (c: { grade: number; courseName: string | null }) => `${gradeLabel(c.grade)}${c.courseName ? ` — ${c.courseName}` : ""}`;

/**
 * Inscrições online (área da família). A conta só vê e altera as SUAS inscrições.
 *   começar   → rascunho preso à última versão publicada do formulário
 *   gravar    → por passo, com controlo de versão (duas janelas não se sobrepõem)
 *   ficheiros → cifrados no armazenamento do colégio; o formato confirma-se pelos bytes
 *   submeter  → valida tudo, cria o aluno (Candidato) e a relação com o encarregado, dá o n.º e avisa por email
 */
export class Applications {
  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly mailer: ApplicationsMailer,
    private readonly countryCode: string,
  ) {}

  private today() {
    return luandaToday(this.clock.now());
  }

  private ctx(account: FamilyAccountRow, files: FileRef[]): CheckContext {
    return { countryCode: this.countryCode, today: this.today(), files, accountKind: account.kind };
  }

  /** O formulário do processo (da versão com que começou). */
  private async form(forms: AdmissionFormsRepository, app: Pick<ApplicationRow, "formVersion" | "processType">): Promise<FormSnapshot | null> {
    const v = await forms.version(app.formVersion);
    if (!v) return null;
    const form = forProcess(v.snapshot, app.processType);
    // "não pedir" = o campo não existe para a família
    return { ...form, student: form.student.filter((f) => f.mode !== "HIDDEN"), guardian: form.guardian.filter((f) => f.mode !== "HIDDEN") };
  }

  private async own(repo: ApplicationsRepository, account: FamilyAccountRow, id: string): Promise<Result<ApplicationRow, AdmissionError>> {
    const app = await repo.byId(id);
    // de outra conta = não existe (não se revela)
    if (!app || app.accountId !== account.id) return fail(admissionError("APPLICATION_NOT_FOUND", "Inscrição não encontrada."));
    return ok(app);
  }

  /** O aluno é maior? (conta STUDENT: é sempre o próprio; senão, pela data de nascimento indicada) */
  private studentAdult(account: FamilyAccountRow, studentData: Entry) {
    if (account.kind === "STUDENT") return true;
    return typeof studentData.birthDate === "string" && isAdult(studentData.birthDate, this.today());
  }

  /** Na conta de aluno maior, a data de nascimento e o nome são os da conta (confirmados ao criar). */
  private lockStudent(account: FamilyAccountRow, data: Entry): Entry {
    return account.kind === "STUDENT" && account.birthDate ? { ...data, birthDate: account.birthDate } : data;
  }

  // ---------------------------------------------------------------- consultar

  /** Público: períodos de inscrição abertos (página de entrada). */
  async publicInfo(repo: ApplicationsRepository) {
    const years = await repo.openYears(this.today());
    return {
      open: years.length > 0,
      years: years.map((y) => ({ id: y.id, name: y.name, from: y.from, to: y.to, classes: y.classes.length })),
      processes: ONLINE_PROCESSES.map((p) => ({ value: p, label: PROCESS_TYPES[p].label, hint: PROCESS_TYPES[p].hint })),
    };
  }

  async list(repo: ApplicationsRepository, account: FamilyAccountRow) {
    const [rows, years] = await Promise.all([repo.byAccount(account.id), repo.openYears(this.today())]);
    return {
      canStart: years.length > 0,
      processes: ONLINE_PROCESSES.map((p) => ({ value: p, label: PROCESS_TYPES[p].label, hint: PROCESS_TYPES[p].hint })),
      applications: rows.map((r) => ({
        id: r.id,
        number: r.number,
        processType: r.processType,
        processLabel: PROCESS_TYPES[r.processType].label,
        status: r.status,
        statusLabel: APPLICATION_STATUS[r.status],
        currentStep: r.currentStep,
        currentStepLabel: STEPS[r.currentStep],
        studentName: r.studentName,
        yearName: r.yearName,
        classLabel: r.grade === null ? null : classLabelOf({ grade: r.grade, courseName: r.courseName }),
        submittedAt: r.submittedAt?.toISOString() ?? null,
        updatedAt: r.updatedAt.toISOString(),
      })),
    };
  }

  async get(repo: ApplicationsRepository, forms: AdmissionFormsRepository, account: FamilyAccountRow, id: string) {
    const found = await this.own(repo, account, id);
    if (!found.ok) return found;
    const app = found.value;
    const form = await this.form(forms, app);
    if (!form) return fail(admissionError("VERSION_NOT_FOUND", "O formulário desta inscrição já não existe."));
    const [files, years, yearName, cls] = await Promise.all([
      repo.files(app.id),
      EDITABLE.includes(app.status) ? repo.openYears(this.today()) : Promise.resolve([] as OpenYear[]),
      app.academicYearId ? repo.yearName(app.academicYearId) : Promise.resolve(null),
      app.classId ? repo.classLabel(app.classId) : Promise.resolve(null),
    ]);
    const problems = EDITABLE.includes(app.status) ? this.problems(account, app, form, files, years) : {};
    return ok({
      id: app.id,
      number: app.number,
      status: app.status,
      statusLabel: APPLICATION_STATUS[app.status],
      editable: EDITABLE.includes(app.status),
      processType: app.processType,
      processLabel: PROCESS_TYPES[app.processType].label,
      formVersion: app.formVersion,
      version: app.version,
      currentStep: app.currentStep,
      steps: stepsFor(form).map((k) => ({ key: k, label: STEPS[k], problems: Object.keys(problems[k] ?? {}).length })),
      accountKind: account.kind,
      studentAdult: this.studentAdult(account, app.studentData),
      candidatura: { academicYearId: app.academicYearId, classId: app.classId, shift: app.shift },
      yearName,
      classLabel: cls ? classLabelOf(cls) : null,
      shiftLabel: app.shift ? SHIFTS[app.shift] : null,
      student: this.lockStudent(account, app.studentData),
      guardian: app.guardianData,
      sections: app.sectionsData,
      files: files.map((f) => ({ id: f.id, slot: f.slot, itemId: f.itemId, label: f.label, fileName: f.fileName, mimeType: f.mimeType, size: f.size, createdAt: f.createdAt.toISOString() })),
      form: { student: form.student, guardian: form.guardian, sections: form.sections, documents: form.documents },
      options: years.map((y) => ({ ...y, classes: y.classes.map((c) => ({ ...c, label: classLabelOf(c), shiftOptions: (c.shifts.length ? c.shifts : (Object.keys(SHIFTS) as (keyof typeof SHIFTS)[])).map((s) => ({ value: s, label: SHIFTS[s] })) })) })),
      problems,
      termsAcceptedAt: app.termsAcceptedAt?.toISOString() ?? null,
      submittedAt: app.submittedAt?.toISOString() ?? null,
      createdAt: app.createdAt.toISOString(),
      updatedAt: app.updatedAt.toISOString(),
    });
  }

  // ---------------------------------------------------------------- validar

  private checkCandidatura(app: Pick<ApplicationRow, "academicYearId" | "classId" | "shift">, years: OpenYear[]): Errors {
    const errors: Errors = {};
    const year = years.find((y) => y.id === app.academicYearId);
    if (!app.academicYearId) errors.academicYearId = "Escolha o ano letivo.";
    else if (!year) errors.academicYearId = "As inscrições para este ano letivo não estão abertas.";
    const cls = year?.classes.find((c) => c.id === app.classId);
    if (!app.classId) errors.classId = "Escolha a classe.";
    else if (year && !cls) errors.classId = "Esta classe não está disponível neste ano letivo.";
    if (app.shift && cls && cls.shifts.length && !cls.shifts.includes(app.shift)) errors.shift = "Este turno não existe nesta classe.";
    return errors;
  }

  /** Tudo o que falta ou está errado, por passo (submeter exige zero). */
  private problems(account: FamilyAccountRow, app: ApplicationRow, form: FormSnapshot, files: FileRef[], years: OpenYear[]): Partial<Record<StepKey, Errors>> {
    const ctx = this.ctx(account, files);
    const out: Partial<Record<StepKey, Errors>> = {};
    const add = (k: StepKey, e: Errors) => {
      if (Object.keys(e).length) out[k] = e;
    };
    const withGuardian = account.kind === "GUARDIAN" || hasGuardianData(app.guardianData);
    add("candidatura", this.checkCandidatura(app, years));
    add("aluno", checkFixed("STUDENT", form.student, this.lockStudent(account, app.studentData), true, { ...ctx, studentAdult: this.studentAdult(account, app.studentData) }).errors);
    if (withGuardian) add("encarregado", checkFixed("GUARDIAN", form.guardian, app.guardianData, true, ctx).errors);
    const sections = checkSections(form, app.sectionsData, true, ctx).errors;
    add("informacoes", Object.fromEntries(Object.entries(sections).flatMap(([sid, e]) => Object.entries(e).map(([k, v]) => [`${sid}:${k}`, v]))));
    add("documentos", checkDocuments(form, files, withGuardian));
    return out;
  }

  // ---------------------------------------------------------------- começar, gravar, desistir

  async start(repo: ApplicationsRepository, forms: AdmissionFormsRepository, account: FamilyAccountRow, processType: string) {
    if (!isOnlineProcess(processType)) return fail(admissionError("INVALID_INPUT", "Escolha o tipo de inscrição."));
    if (!(await repo.openYears(this.today())).length) return fail(admissionError("APPLICATIONS_CLOSED", "As inscrições não estão abertas neste momento."));
    const latest = await forms.latestVersion();
    if (!latest) return fail(admissionError("APPLICATIONS_CLOSED", "O colégio ainda não publicou o formulário de inscrição."));
    const now = this.clock.now();
    const id = this.ids.next();
    // o que já se sabe da conta entra preenchido (a pessoa pode corrigir o que não for fixo)
    const contact: Entry = { fullName: account.fullName, email: account.email, ...(account.phone ? { phone: account.phone } : {}) };
    await repo.create({
      id,
      accountId: account.id,
      processType,
      formVersion: latest.number,
      academicYearId: null,
      classId: null,
      shift: null,
      studentData: account.kind === "STUDENT" ? this.lockStudent(account, contact) : {},
      guardianData: account.kind === "GUARDIAN" ? contact : {},
      sectionsData: {},
      status: "DRAFT",
      currentStep: "candidatura",
      createdAt: now,
    });
    await repo.record("APPLICATION_STARTED", id, null, { accountId: account.id, processType, formVersion: latest.number }, now);
    return ok({ id });
  }

  /**
   * Grava um passo (sempre, mesmo incompleto) e devolve os erros desse passo. Com `advance`
   * e sem erros, o passo seguinte passa a ser o "atual" (para retomar mais tarde).
   */
  async save(repo: ApplicationsRepository, forms: AdmissionFormsRepository, account: FamilyAccountRow, id: string, input: { step: string; version: number; advance?: boolean; data?: unknown }) {
    const found = await this.own(repo, account, id);
    if (!found.ok) return found;
    const app = found.value;
    if (!EDITABLE.includes(app.status)) return fail(admissionError("NOT_EDITABLE", "Esta inscrição já foi submetida e não pode ser alterada."));
    if (!isStepKey(input.step)) return fail(admissionError("INVALID_INPUT", "Passo inválido."));
    const form = await this.form(forms, app);
    if (!form) return fail(admissionError("VERSION_NOT_FOUND", "O formulário desta inscrição já não existe."));
    const steps = stepsFor(form);
    if (!steps.includes(input.step)) return fail(admissionError("INVALID_INPUT", "Este passo não existe nesta inscrição."));
    // os passos fazem-se por ordem: não se grava um passo a que ainda não se chegou
    if (steps.indexOf(input.step) > steps.indexOf(app.currentStep)) return fail(admissionError("INVALID_INPUT", `Complete primeiro o passo “${STEPS[app.currentStep]}”.`));

    const files = await repo.files(app.id);
    const ctx = this.ctx(account, files);
    const data = input.data && typeof input.data === "object" && !Array.isArray(input.data) ? (input.data as Record<string, unknown>) : {};
    const set: Parameters<ApplicationsRepository["save"]>[2] = {};
    let errors: Errors = {};

    switch (input.step) {
      case "candidatura": {
        const yearId = typeof data.academicYearId === "string" && data.academicYearId ? data.academicYearId : null;
        const classId = typeof data.classId === "string" && data.classId ? data.classId : null;
        const shift = isShift(data.shift) ? data.shift : null;
        Object.assign(set, { academicYearId: yearId, classId, shift });
        errors = this.checkCandidatura({ academicYearId: yearId, classId, shift }, await repo.openYears(this.today()));
        // um id que não é de nenhum ano/classe aberto não se guarda (a FK recusaria)
        if (errors.academicYearId) set.academicYearId = set.classId = null;
        else if (errors.classId) set.classId = null;
        break;
      }
      case "aluno": {
        const raw = this.lockStudent(account, (data.student ?? {}) as Entry);
        const adult = account.kind === "STUDENT" || (typeof raw.birthDate === "string" && isAdult(raw.birthDate, this.today()));
        const loose = checkFixed("STUDENT", form.student, raw, false, { ...ctx, studentAdult: adult });
        set.studentData = this.lockStudent(account, loose.value);
        errors = checkFixed("STUDENT", form.student, raw, true, { ...ctx, studentAdult: adult }).errors;
        break;
      }
      case "encarregado": {
        const raw = data.guardian ?? {};
        set.guardianData = checkFixed("GUARDIAN", form.guardian, raw, false, ctx).value;
        // o aluno maior pode não indicar encarregado; se começar a preencher, tem de completar
        const needed = account.kind === "GUARDIAN" || hasGuardianData(set.guardianData);
        errors = needed ? checkFixed("GUARDIAN", form.guardian, raw, true, ctx).errors : {};
        break;
      }
      case "informacoes": {
        set.sectionsData = checkSections(form, data.sections, false, ctx).value;
        const strict = checkSections(form, data.sections, true, ctx).errors;
        errors = Object.fromEntries(Object.entries(strict).flatMap(([sid, e]) => Object.entries(e).map(([k, v]) => [`${sid}:${k}`, v])));
        break;
      }
      case "documentos":
        errors = checkDocuments(form, files, account.kind === "GUARDIAN" || hasGuardianData(app.guardianData));
        break;
      case "revisao":
        break;
    }

    if (input.advance && !Object.keys(errors).length) {
      const next = steps[Math.min(steps.indexOf(input.step) + 1, steps.length - 1)];
      if (steps.indexOf(next) > steps.indexOf(app.currentStep)) set.currentStep = next;
    }
    const version = await repo.save(app.id, input.version, set, this.clock.now());
    if (version === null) return fail(admissionError("STALE", "Esta inscrição foi alterada noutra janela. Recarregue a página para continuar."));
    return ok({ version, errors, currentStep: set.currentStep ?? app.currentStep });
  }

  async discard(repo: ApplicationsRepository, store: ApplicationFileStore, account: FamilyAccountRow, id: string) {
    const found = await this.own(repo, account, id);
    if (!found.ok) return found;
    if (found.value.status !== "DRAFT") return fail(admissionError("NOT_EDITABLE", "Só se pode apagar uma inscrição ainda não submetida."));
    const files = await repo.files(id);
    for (const f of files) await store.remove(f.storageKey).catch(() => undefined);
    await repo.remove(id);
    await repo.record("APPLICATION_DISCARDED", id, null, { accountId: account.id }, this.clock.now());
    return ok({ deleted: true as const });
  }

  // ---------------------------------------------------------------- ficheiros

  async upload(repo: ApplicationsRepository, forms: AdmissionFormsRepository, store: ApplicationFileStore, account: FamilyAccountRow, id: string, input: { slot: string; itemId?: string | null }, file: Upload) {
    const found = await this.own(repo, account, id);
    if (!found.ok) return found;
    const app = found.value;
    if (!EDITABLE.includes(app.status)) return fail(admissionError("NOT_EDITABLE", "Esta inscrição já foi submetida e não pode ser alterada."));
    if (!file?.buffer?.length) return fail(admissionError("INVALID_FILE", "Escolha um ficheiro."));
    if (!store.ready) return fail(admissionError("STORAGE_UNAVAILABLE", "O envio de ficheiros ainda não está disponível neste colégio. Contacte a secretaria."));
    const form = await this.form(forms, app);
    if (!form) return fail(admissionError("VERSION_NOT_FOUND", "O formulário desta inscrição já não existe."));
    const files = await repo.files(app.id);
    if (files.length >= MAX_FILES) return fail(admissionError("INVALID_FILE", `No máximo ${MAX_FILES} ficheiros por inscrição.`));

    // o que se pode entregar neste lugar (formatos, tamanho, quantos)
    let rule: { label: string; formats: readonly string[]; maxMb: number; maxFiles: number; itemId: string | null; slot: "PHOTO" | "DOCUMENT" | "FIELD" } | null = null;
    if (input.slot === "PHOTO") {
      const photo = form.student.find((f) => f.type === "FILE");
      if (photo) rule = { label: photo.label, formats: PHOTO_FORMATS, maxMb: PHOTO_MAX_MB, maxFiles: 1, itemId: null, slot: "PHOTO" };
    } else if (input.slot === "DOCUMENT") {
      const d = form.documents.find((x) => x.id === input.itemId);
      if (d) rule = { label: d.name, formats: d.formats, maxMb: d.maxSizeMb, maxFiles: d.maxFiles, itemId: d.id, slot: "DOCUMENT" };
    } else if (input.slot === "FIELD") {
      const f = form.sections.flatMap((s) => s.fields).find((x) => x.id === input.itemId && x.type === "FILE");
      if (f) rule = { label: f.label, formats: f.settings.formats ?? ["pdf", "jpg", "png"], maxMb: f.settings.maxSizeMb ?? 5, maxFiles: 10, itemId: f.id, slot: "FIELD" };
    }
    if (!rule) return fail(admissionError("INVALID_INPUT", "Este ficheiro não é pedido nesta inscrição."));

    const format = sniffFormat(file.buffer, file.originalname);
    if (!format || !rule.formats.includes(format)) return fail(admissionError("INVALID_FILE", `Formato não aceite. Envie ${rule.formats.map((f) => f.toUpperCase()).join(", ")}.`));
    if (file.buffer.length > rule.maxMb * MB) return fail(admissionError("INVALID_FILE", `O ficheiro tem mais de ${rule.maxMb} MB.`));
    const same = files.filter((f) => f.slot === rule.slot && f.itemId === rule.itemId);
    // a fotografia substitui a anterior; os outros têm um limite de ficheiros
    if (rule.slot !== "PHOTO" && same.length >= rule.maxFiles) return fail(admissionError("INVALID_FILE", `Já entregou ${rule.maxFiles} ficheiro${rule.maxFiles === 1 ? "" : "s"} para “${rule.label}”. Retire um para enviar outro.`));

    const now = this.clock.now();
    const fileName = safeFileName(file.originalname, format);
    const { key } = await store.save(`admissions/${app.id}`, { fileName, mimeType: FORMAT_MIME[format], content: file.buffer });
    const row = {
      id: this.ids.next(),
      applicationId: app.id,
      slot: rule.slot,
      itemId: rule.itemId,
      label: rule.label,
      fileName,
      mimeType: FORMAT_MIME[format],
      size: file.buffer.length,
      sha256: createHash("sha256").update(file.buffer).digest("hex"),
      storageKey: key,
      createdAt: now,
    };
    await repo.addFile(row);
    if (rule.slot === "PHOTO") {
      for (const old of same) {
        await repo.removeFile(old.id);
        await store.remove(old.storageKey).catch(() => undefined);
      }
    }
    return ok({ id: row.id, slot: row.slot, itemId: row.itemId, label: row.label, fileName, mimeType: row.mimeType, size: row.size, createdAt: now.toISOString() });
  }

  async readFile(repo: ApplicationsRepository, store: ApplicationFileStore, account: FamilyAccountRow, id: string, fileId: string) {
    const found = await this.own(repo, account, id);
    if (!found.ok) return found;
    const f = (await repo.files(id)).find((x) => x.id === fileId);
    if (!f) return fail(admissionError("FILE_NOT_FOUND", "Ficheiro não encontrado."));
    return ok({ content: await store.read(f.storageKey), mimeType: f.mimeType, fileName: f.fileName });
  }

  async removeFile(repo: ApplicationsRepository, store: ApplicationFileStore, account: FamilyAccountRow, id: string, fileId: string) {
    const found = await this.own(repo, account, id);
    if (!found.ok) return found;
    if (!EDITABLE.includes(found.value.status)) return fail(admissionError("NOT_EDITABLE", "Esta inscrição já foi submetida e não pode ser alterada."));
    const f = (await repo.files(id)).find((x) => x.id === fileId);
    if (!f) return fail(admissionError("FILE_NOT_FOUND", "Ficheiro não encontrado."));
    await repo.removeFile(f.id);
    await store.remove(f.storageKey).catch(() => undefined);
    return ok({ deleted: true as const });
  }

  // ---------------------------------------------------------------- submeter

  async submit(repo: ApplicationsRepository, forms: AdmissionFormsRepository, account: FamilyAccountRow, school: School, id: string, input: { version: number; acceptTerms: boolean; legitimacy?: boolean }) {
    const found = await this.own(repo, account, id);
    if (!found.ok) return found;
    const app = found.value;
    if (app.status !== "DRAFT") return fail(admissionError("NOT_EDITABLE", "Esta inscrição já foi submetida."));
    if (app.version !== input.version) return fail(admissionError("STALE", "Esta inscrição foi alterada noutra janela. Recarregue a página para continuar."));
    if (!input.acceptTerms) return fail(admissionError("INVALID_INPUT", "Para submeter, confirme os dados e aceite os termos e a política de privacidade."));
    if (account.kind === "GUARDIAN" && !input.legitimacy) return fail(admissionError("INVALID_INPUT", "Declare que é o encarregado de educação (ou tem legitimidade) para fazer esta inscrição."));
    const form = await this.form(forms, app);
    if (!form) return fail(admissionError("VERSION_NOT_FOUND", "O formulário desta inscrição já não existe."));

    const [files, years] = await Promise.all([repo.files(app.id), repo.openYears(this.today())]);
    const problems = this.problems(account, app, form, files, years);
    const steps = stepsFor(form).filter((k) => problems[k]);
    if (steps.length) {
      const first = steps[0];
      return fail(admissionError("INCOMPLETE", `Falta completar: ${steps.map((k) => STEPS[k]).join(", ")}.`, { steps: Object.fromEntries(steps.map((k) => [k, Object.keys(problems[k]!).length])), first }));
    }

    const student = this.lockStudent(account, app.studentData);
    const { fullName, birthDate, gender, ...rest } = student;
    const withGuardian = account.kind === "GUARDIAN" || hasGuardianData(app.guardianData);
    const g = app.guardianData;
    const now = this.clock.now();
    const yearName = (await repo.yearName(app.academicYearId!)) ?? "";
    const outcome = await repo.submit({
      applicationId: app.id,
      expectedVersion: app.version,
      accountId: account.id,
      accountKind: account.kind,
      year: this.today().slice(0, 4),
      now,
      student: { fullName: String(fullName), birthDate: String(birthDate), gender: typeof gender === "string" ? gender : null, data: rest },
      guardian: withGuardian
        ? {
            fullName: String(g.fullName),
            email: typeof g.email === "string" ? g.email : null,
            phone: typeof g.phone === "string" ? g.phone : null,
            relationship: String(g.relationship),
            relationshipOther: typeof g.relationshipOther === "string" ? g.relationshipOther : null,
            data: g,
          }
        : null,
      termsAcceptedAt: now,
      legitimacyDeclared: !!input.legitimacy,
      actorName: account.fullName,
    });
    if (!outcome.ok && outcome.reason === "STALE") return fail(admissionError("STALE", "Esta inscrição foi alterada noutra janela. Recarregue a página para continuar."));
    if (!outcome.ok) return fail(admissionError("DUPLICATE_APPLICATION", `Este aluno já tem uma inscrição em curso para este ano letivo (n.º ${outcome.number}).`, { number: outcome.number }));

    const cls = await repo.classLabel(app.classId!);
    await repo.record("APPLICATION_SUBMITTED", app.id, null, { accountId: account.id, number: outcome.number, studentId: outcome.studentId }, now);
    try {
      await this.mailer.submitted({ to: { email: account.email, name: account.fullName }, school, number: outcome.number, studentName: String(fullName), yearName, classLabel: cls ? classLabelOf(cls) : "" });
    } catch {
      /* o aviso não impede a submissão (fica no histórico e na área da família) */
    }
    return ok({ number: outcome.number, status: "SUBMITTED" as const, statusLabel: APPLICATION_STATUS.SUBMITTED });
  }
}
