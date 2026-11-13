import type { Clock, IdGenerator, PasswordHasher } from "../../../../../../libs/kernel/src/application/ports";
import { sha256 } from "../../../../../../libs/kernel/src/infrastructure/backup-crypto";
import { fail, ok } from "../../../../../../libs/kernel/src/domain/Result";
import {
  adminFromProfessional,
  APPLICANT_EDITABLE,
  checkAll,
  checkDocuments,
  checkPersonal,
  checkSection,
  type DocRef,
  EMPLOYEE_STATUS_LABELS,
  EMPLOYEE_STATUSES,
  type EmployeeStatus,
  EMPLOYMENT_TRANSITIONS,
  type Errors,
  FORMAT_MIME,
  formatEmployeeNumber,
  isEmployeeStatus,
  luandaToday,
  MB,
  PHOTO_FORMATS,
  PHOTO_MAX_MB,
  safeFileName,
  sniffFormat,
  STEP_LABELS,
  STEP_SECTION,
  type StepKey,
  stepsFor,
  SUBMITTABLE,
} from "../domain/employee";
import { type FileFormat, forEmployeeType, type FormSnapshot, hrError } from "../domain/form";
import { checkReason, inviteExpiry, inviteState } from "../domain/registration";
import type { ApplicantAccessRepository, ApplicantSession, EmployeeDocumentRow, EmployeeMailer, EmployeeRepository, EmployeeRow, HrFileStore, StepPatch } from "./employee-ports";
import type { HrSettingsRepository } from "./ports";
import { type HrActor, hashInviteToken, newInviteToken } from "./Registration";
import type { HistoryRow, RegistrationRepository, School } from "./registration-ports";

export const EMPLOYEES_PAGE_SIZE = 20;
/** Sessão do formulário: 2 h, renovada enquanto a pessoa trabalha. */
export const SESSION_MINUTES = 120;
const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const MAX_FILES = 60;
const MAX_FILES_PER_DOCUMENT = 10;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Quem mexe no cadastro: o próprio (pelo convite) ou alguém do RH. */
export type Editor = { kind: "applicant" } | { kind: "hr"; actor: HrActor };

const minutes = (n: number) => n * 60_000;
const maskEmail = (email: string) => {
  const [user, domain] = email.split("@");
  return `${user.slice(0, 2)}${"•".repeat(Math.max(2, Math.min(6, user.length - 2)))}@${domain}`;
};

const documentDto = (d: EmployeeDocumentRow) => ({
  id: d.id,
  slot: d.slot,
  itemId: d.itemId,
  label: d.label,
  fileName: d.fileName,
  mimeType: d.mimeType,
  size: d.size,
  byHr: !!d.uploadedById,
  createdAt: d.createdAt.toISOString(),
});

const historyDto = (h: HistoryRow) => ({
  fromStatus: h.fromStatus,
  fromLabel: h.fromStatus && isEmployeeStatus(h.fromStatus) ? EMPLOYEE_STATUS_LABELS[h.fromStatus] : h.fromStatus,
  toStatus: h.toStatus,
  toLabel: isEmployeeStatus(h.toStatus) ? EMPLOYEE_STATUS_LABELS[h.toStatus] : h.toStatus,
  actorName: h.actorName,
  reason: h.reason,
  createdAt: h.createdAt.toISOString(),
});

/** A versão do formulário como a vê este funcionário (só o que se aplica ao seu tipo). */
const formOf = (e: Pick<EmployeeRow, "formVersion" | "employeeTypeId">): FormSnapshot => forEmployeeType(e.formVersion.snapshot, e.employeeTypeId);
const refs = (e: EmployeeRow): DocRef[] => e.documents.map((d) => ({ id: d.id, slot: d.slot, itemId: d.itemId }));

/**
 * Cadastros de funcionários: o formulário por passos (pelo convite ou pelo RH), os ficheiros
 * cifrados, a submissão e as decisões do RH. As permissões exigem-se no controller; as regras aqui.
 * Os emails nunca bloqueiam a operação.
 */
export class Employees {
  constructor(
   private readonly mailer: EmployeeMailer,
    private readonly hasher: PasswordHasher,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly countryCode: string,
  ) {}

  private async quietly(send: () => Promise<void>) {
    try {
      await send();
      return true;
    } catch {
      return false;
    }
  }

  private ctx(e: EmployeeRow) {
    return { countryCode: this.countryCode, today: luandaToday(this.clock.now()), docs: refs(e) };
  }

  // ================================================================ vista

  /** O cadastro com o formulário da sua versão, os passos e o que ainda falta. */
  view(e: EmployeeRow) {
    const form = formOf(e);
    const issues = checkAll(form, { personal: e.personal, sections: e.sections }, this.ctx(e));
    return {
      id: e.id,
      number: formatEmployeeNumber(e.number),
      status: e.status,
      statusLabel: EMPLOYEE_STATUS_LABELS[e.status],
      progress: e.progress,
      lastStep: e.lastStep,
      completedSteps: e.completedSteps,
      revision: e.revision,
      employeeType: e.employeeTypeId ? { id: e.employeeTypeId, name: e.employeeTypeName } : null,
      formVersion: e.formVersion.number,
      fullName: e.fullName,
      email: e.email,
      phone: e.phone,
      jobTitle: e.jobTitle,
      department: e.department,
      correctionNote: e.correctionNote,
      fromRequest: !!e.requestId,
      submittedAt: e.submittedAt?.toISOString() ?? null,
      approvedAt: e.approvedAt?.toISOString() ?? null,
      activatedAt: e.activatedAt?.toISOString() ?? null,
      terminatedAt: e.terminatedAt?.toISOString() ?? null,
      createdAt: e.createdAt.toISOString(),
      updatedAt: e.updatedAt.toISOString(),
      form: { personal: form.personal, sections: form.sections.filter((s) => s.fields.length), documents: form.documents },
      steps: stepsFor(form).map((k) => ({ key: k, label: STEP_LABELS[k] })),
      data: { personal: e.personal, sections: e.sections },
      documents: e.documents.map(documentDto),
      photoId: e.documents.find((d) => d.slot === "PHOTO")?.id ?? null,
      issues,
      complete: Object.keys(issues).length === 0,
    };
  }

  // ================================================================ convite → sessão

  /** Valida o link (sem dados pessoais na resposta, além do primeiro nome e do email mascarado). */
  private async checkInvite(access: ApplicantAccessRepository, repo: EmployeeRepository, school: School, token: string) {
    if (!TOKEN.test(token)) return fail(hrError("INVITE_INVALID", "Este link não é válido."));
    const a = await access.inviteByTokenHash(hashInviteToken(token));
    if (!a || a.requestStatus !== "APPROVED" || a.revokedAt) {
      return fail(hrError("INVITE_INVALID", "Este link já não é válido. Use o link do email mais recente ou fale com os Recursos Humanos."));
    }
    const now = this.clock.now();
    if (inviteState(a, now) === "EXPIRED") {
      // o RH é avisado uma vez para reenviar
      if (await access.markExpiredNotified(a.inviteId, now)) {
        const to = await repo.recipients("hr.registration_requests.approve");
        if (to.length) await this.quietly(() => this.mailer.inviteExpiredForHr({ to, school, applicant: a.fullName }));
      }
      return fail(hrError("INVITE_EXPIRED", "Este link expirou. Os Recursos Humanos já foram avisados e podem enviar-lhe um novo."));
    }
    return ok(a);
  }

  async inviteInfo(access: ApplicantAccessRepository, repo: EmployeeRepository, school: School, token: string) {
    const a = await this.checkInvite(access, repo, school, token);
    if (!a.ok) return a;
    return ok({ school: school.name, firstName: a.value.fullName.split(" ")[0], email: maskEmail(a.value.email), employeeType: a.value.employeeTypeName, expiresAt: a.value.expiresAt.toISOString() });
  }

  /** Link + palavra-passe do pedido → sessão curta (o token da sessão só existe no cookie do portal). */
  async login(access: ApplicantAccessRepository, repo: EmployeeRepository, settings: HrSettingsRepository, school: School, input: { token: string; password: string }) {
    const checked = await this.checkInvite(access, repo, school, input.token);
    if (!checked.ok) return checked;
    const a = checked.value;
    const now = this.clock.now();
    if (a.lockedUntil && a.lockedUntil > now) {
      const wait = Math.ceil((a.lockedUntil.getTime() - now.getTime()) / 60_000);
      return fail(hrError("INVITE_LOCKED", `Demasiadas tentativas. Tente de novo dentro de ${wait} min.`));
    }
    if (!(await this.hasher.verify(input.password, a.passwordHash))) {
      const r = await access.registerFailure(a.inviteId, MAX_ATTEMPTS, new Date(now.getTime() + minutes(LOCK_MINUTES)));
      if (r.lockedUntil) return fail(hrError("INVITE_LOCKED", `Demasiadas tentativas. Tente de novo dentro de ${LOCK_MINUTES} min.`));
      return fail(hrError("INVALID_CREDENTIALS", `Palavra-passe errada. Restam ${MAX_ATTEMPTS - r.attempts} tentativas.`));
    }

    // o cadastro começa no primeiro acesso, com a versão publicada nesse momento
    let employee = await repo.findByRequest(a.requestId);
    if (!employee) {
      const latest = await settings.latest();
      if (!latest) return fail(hrError("FORM_NOT_PUBLISHED", "O formulário de cadastro ainda não está disponível. Fale com os Recursos Humanos."));
      const typeOk = !a.employeeTypeId || (latest.snapshot.employeeTypes ?? []).some((t) => t.id === a.employeeTypeId);
      const created = await repo.create({
        id: this.ids.next(),
        requestId: a.requestId,
        employeeTypeId: typeOk ? a.employeeTypeId : null,
        formVersionId: latest.id,
        fullName: a.fullName,
        email: a.email,
        phone: a.phone,
        personal: { fullName: a.fullName, email: a.email, ...(a.phone ? { phone: a.phone } : {}) },
        createdById: null,
        actorName: a.fullName,
        now,
      });
      employee = created.ok ? created.value : await repo.findByRequest(a.requestId);
      if (!employee) return fail(hrError("EMPLOYEE_NOT_FOUND", "Não foi possível abrir o cadastro. Tente de novo."));
      if (created.ok) await repo.record("HR_EMPLOYEE_STARTED", employee.id, null, { requestId: a.requestId, formVersion: latest.number }, now);
    }

    const session = newInviteToken();
    const expiresAt = new Date(now.getTime() + minutes(SESSION_MINUTES));
    await access.startSession(a.inviteId, hashInviteToken(session), expiresAt, now);
    return ok({ session, expiresAt: expiresAt.toISOString() });
  }

  /** Sessão do cabeçalho → o cadastro dessa pessoa (renova a sessão quando falta menos de 1 h). */
  async applicant(access: ApplicantAccessRepository, repo: EmployeeRepository, sessionToken: string | undefined) {
    if (!sessionToken || !TOKEN.test(sessionToken)) return fail(hrError("SESSION_EXPIRED", "A sessão terminou. Abra de novo o link do email."));
    const now = this.clock.now();
    const s: ApplicantSession | null = await access.session(hashInviteToken(sessionToken), now);
    if (!s) return fail(hrError("SESSION_EXPIRED", "A sessão terminou. Abra de novo o link do email."));
    if (s.expiresAt.getTime() - now.getTime() < minutes(60)) await access.extendSession(s.inviteId, new Date(now.getTime() + minutes(SESSION_MINUTES)));
    const e = await repo.findByRequest(s.requestId);
    if (!e) return fail(hrError("SESSION_EXPIRED", "A sessão terminou. Abra de novo o link do email."));
    return ok(e);
  }

  async logout(access: ApplicantAccessRepository, sessionToken: string | undefined) {
    if (sessionToken && TOKEN.test(sessionToken)) await access.endSession(hashInviteToken(sessionToken));
    return { ok: true };
  }

  // ================================================================ passos (gravação automática)

  /**
   * Grava um passo. Sem `complete`: aceita o incompleto (gravação automática) e devolve os erros de formato.
   * Com `complete`: exige os obrigatórios; se estiver tudo certo, o passo fica concluído.
   * A revisão evita sobrescrever uma gravação mais recente (outro separador, outro aparelho).
   */
  async saveStep(repo: EmployeeRepository, e: EmployeeRow, editor: Editor, step: string, input: { revision: number; values?: unknown; complete?: boolean; lastStep?: string | null }) {
    const form = formOf(e);
    const steps = stepsFor(form);
    if (!(steps as string[]).includes(step)) return fail(hrError("STEP_NOT_FOUND", "Este passo não existe neste formulário."));
    const key = step as StepKey;
    const allowed = editor.kind === "applicant" ? APPLICANT_EDITABLE : EMPLOYEE_STATUSES.filter((s) => s !== "TERMINATED" && s !== "REJECTED");
    if (!allowed.includes(e.status)) return fail(hrError("INVALID_STATE", editor.kind === "applicant" ? "O cadastro já foi submetido: aguarde a análise do RH." : `Um cadastro ${EMPLOYEE_STATUS_LABELS[e.status].toLowerCase()} não se altera.`));

    const strict = !!input.complete;
    const ctx = this.ctx(e);
    const now = this.clock.now();
    const patch: Omit<StepPatch, "completedSteps" | "lastStep" | "progress"> = { now };
    let errors: Errors = {};
    if (key === "personal") {
      const r = checkPersonal(form, input.values, strict, ctx);
      patch.personal = r.value;
      errors = r.errors;
      // colunas da lista: só valores válidos
      if (r.value.fullName && !errors.fullName) patch.fullName = r.value.fullName;
      if (!errors.email) patch.email = r.value.email ?? null;
      if (!errors.phone) patch.phone = r.value.phone ?? null;
    } else if (key === "documents") {
      errors = strict ? checkDocuments(form, ctx.docs) : {};
    } else {
      const section = form.sections.find((s) => s.key === STEP_SECTION[key])!;
      const r = checkSection(section, input.values, strict, ctx);
      patch.section = { key: section.key, entries: r.value };
      errors = r.errors;
    }

    const hasErrors = Object.keys(errors).length > 0;
    const done = new Set(e.completedSteps.filter((s) => steps.includes(s)));
    if (strict && !hasErrors) done.add(key);
    if (hasErrors) done.delete(key);
    const completedSteps = steps.filter((s) => done.has(s));
    const lastStep = input.lastStep && (steps as string[]).includes(input.lastStep) ? (input.lastStep as StepKey) : key;
    const progress = APPLICANT_EDITABLE.includes(e.status) ? "IN_PROGRESS" : e.progress;

    const saved = await repo.saveStep(e.id, input.revision, allowed, { ...patch, completedSteps, lastStep, progress });
    if (!saved.ok) {
      if (saved.reason === "conflict") return fail(hrError("REVISION_CONFLICT", "Estes dados foram alterados noutro sítio entretanto. Recarregámos a versão mais recente."));
      if (saved.reason === "state") return fail(hrError("INVALID_STATE", "O estado do cadastro mudou. Recarregue a página."));
      return fail(hrError("EMPLOYEE_NOT_FOUND", "Cadastro não encontrado."));
    }
    // alterações do RH num cadastro já submetido ficam no histórico
    if (editor.kind === "hr" && strict && !hasErrors && e.status !== "DRAFT") {
      await repo.addHistory({ employeeId: e.id, from: e.status, to: e.status, actorId: editor.actor.id, actorName: editor.actor.name, reason: `Dados alterados: ${STEP_LABELS[key]}.`, now });
    }
    return ok({ revision: saved.revision, updatedAt: saved.updatedAt.toISOString(), completedSteps, lastStep, errors, stepComplete: strict && !hasErrors });
  }

  // ================================================================ ficheiros

  /** Recebe um ficheiro: confirma o formato pelos bytes, o tamanho e se o documento existe nesta versão. */
  async upload(repo: EmployeeRepository, files: HrFileStore, e: EmployeeRow, editor: Editor, input: { slot: string; itemId?: string | null; file?: { originalname: string; buffer: Buffer } | null }) {
    const editable = editor.kind === "applicant" ? APPLICANT_EDITABLE.includes(e.status) : e.status !== "TERMINATED" && e.status !== "REJECTED";
    if (!editable) return fail(hrError("INVALID_STATE", "Este cadastro já não aceita ficheiros."));
    if (!files.ready) return fail(hrError("STORAGE_NOT_CONFIGURED", "O envio de ficheiros ainda não está disponível neste colégio (falta configurar o armazenamento). Fale com a EduFlow."));
    if (!input.file?.buffer?.length) return fail(hrError("FILE_INVALID", "Escolha um ficheiro."));
    if (e.documents.length >= MAX_FILES) return fail(hrError("LIMIT_REACHED", `No máximo ${MAX_FILES} ficheiros por cadastro.`));

    const form = formOf(e);
    let rules: { formats: FileFormat[]; maxSizeMb: number; label: string; replace: EmployeeDocumentRow[] };
    const slot = input.slot;
    if (slot === "PHOTO") {
      rules = { formats: PHOTO_FORMATS, maxSizeMb: PHOTO_MAX_MB, label: "Fotografia", replace: e.documents.filter((d) => d.slot === "PHOTO") };
    } else if (slot === "DOCUMENT") {
      const d = form.documents.find((x) => x.id === input.itemId);
      if (!d) return fail(hrError("DOCUMENT_NOT_FOUND", "Documento não encontrado neste formulário."));
      const current = e.documents.filter((x) => x.slot === "DOCUMENT" && x.itemId === d.id);
      if (d.multiple && current.length >= MAX_FILES_PER_DOCUMENT) return fail(hrError("LIMIT_REACHED", `No máximo ${MAX_FILES_PER_DOCUMENT} ficheiros por documento.`));
      rules = { formats: d.formats, maxSizeMb: d.maxSizeMb, label: d.name, replace: d.multiple ? [] : current };
    } else if (slot === "FIELD") {
      const f = form.sections.flatMap((s) => s.fields).find((x) => x.id === input.itemId && x.type === "FILE");
      if (!f) return fail(hrError("FIELD_NOT_FOUND", "Campo não encontrado neste formulário."));
      rules = { formats: f.settings.formats ?? ["pdf", "jpg", "png"], maxSizeMb: f.settings.maxSizeMb ?? 5, label: f.label, replace: [] };
    } else {
      return fail(hrError("INVALID_INPUT", "Tipo de ficheiro inválido."));
    }

    const { buffer, originalname } = input.file;
    if (buffer.length > rules.maxSizeMb * MB) return fail(hrError("FILE_TOO_LARGE", `O ficheiro tem mais de ${rules.maxSizeMb} MB.`));
    const format = sniffFormat(buffer, originalname);
    if (!format || !rules.formats.includes(format)) {
      return fail(hrError("FILE_INVALID", `Formato não aceite. Envie ${rules.formats.map((f) => f.toUpperCase()).join(", ")}.`));
    }

    const fileName = safeFileName(originalname, format);
    let stored: { key: string };
    try {
      stored = await files.save(`hr-${e.id}`, { fileName, mimeType: FORMAT_MIME[format], content: buffer });
    } catch (err) {
      console.error(`[hr] não foi possível guardar um ficheiro do cadastro ${e.id}: ${err instanceof Error ? err.message.slice(0, 200) : "erro"}`);
      return fail(hrError("STORAGE_UNAVAILABLE", "Não foi possível guardar o ficheiro agora (ligação ao armazenamento). Tente de novo dentro de instantes."));
    }
    const now = this.clock.now();
    const doc = {
      id: this.ids.next(),
      slot: slot as EmployeeDocumentRow["slot"],
      itemId: slot === "PHOTO" ? null : (input.itemId ?? null),
      label: rules.label,
      fileName,
      mimeType: FORMAT_MIME[format],
      size: buffer.length,
      storageKey: stored.key,
      uploadedById: editor.kind === "hr" ? editor.actor.id : null,
      sha256: sha256(buffer),
      now,
    };
    // substitui (fotografia, documento de um só ficheiro): primeiro sai o antigo da BD
    for (const old of rules.replace) await this.dropDocument(repo, files, e.id, old.id);
    await repo.addDocument(e.id, doc);
    await repo.record("HR_EMPLOYEE_FILE_ADDED", e.id, editor.kind === "hr" ? editor.actor.id : null, { slot, itemId: doc.itemId, size: doc.size, format }, now);
    return ok(documentDto({ ...doc, createdAt: now }));
  }

  private async dropDocument(repo: EmployeeRepository, files: HrFileStore, employeeId: string, docId: string) {
    const removed = await repo.removeDocument(employeeId, docId);
    // o ficheiro externo sai depois; se falhar fica órfão mas ilegível (cifrado)
    if (removed) await this.quietly(() => files.remove(removed.storageKey));
    return removed;
  }

  async removeFile(repo: EmployeeRepository, files: HrFileStore, e: EmployeeRow, editor: Editor, docId: string) {
    const editable = editor.kind === "applicant" ? APPLICANT_EDITABLE.includes(e.status) : e.status !== "TERMINATED" && e.status !== "REJECTED";
    if (!editable) return fail(hrError("INVALID_STATE", "Este cadastro já não aceita alterações."));
    const removed = await this.dropDocument(repo, files, e.id, docId);
    if (!removed) return fail(hrError("FILE_NOT_FOUND", "Ficheiro não encontrado."));
    await repo.record("HR_EMPLOYEE_FILE_REMOVED", e.id, editor.kind === "hr" ? editor.actor.id : null, { slot: removed.slot, itemId: removed.itemId }, this.clock.now());
    return ok({ removed: true });
  }

  /** O conteúdo de um ficheiro DESTE cadastro (decifrado aqui; nunca há link direto). */
  async readFile(files: HrFileStore, e: EmployeeRow, docId: string) {
    const d = e.documents.find((x) => x.id === docId);
    if (!d) return fail(hrError("FILE_NOT_FOUND", "Ficheiro não encontrado."));
    try {
      return ok({ fileName: d.fileName, mimeType: d.mimeType, content: await files.read(d.storageKey) });
    } catch (e) {
      // a app do colégio foi desligada (ou trocada): o ficheiro está lá, mas não há como o ler daqui
      if (e instanceof Error && e.name === "StorageNotConfiguredError") return fail(hrError("STORAGE_NOT_CONFIGURED", "Não é possível abrir este ficheiro: o armazenamento do colégio não está configurado. Fale com a EduFlow."));
      throw e;
    }
  }

  // ================================================================ submeter

  async submit(repo: EmployeeRepository, files: HrFileStore, e: EmployeeRow, editor: Editor, school: School, input: { revision: number }) {
    if (!SUBMITTABLE.includes(e.status)) return fail(hrError("INVALID_STATE", "Este cadastro já foi submetido."));
    const form = formOf(e);
    const issues = checkAll(form, { personal: e.personal, sections: e.sections }, this.ctx(e));
    if (Object.keys(issues).length) {
      const steps = Object.keys(issues).map((k) => STEP_LABELS[k as StepKey]);
      return fail(hrError("INCOMPLETE", `Falta completar: ${steps.join(", ")}.`, { issues }));
    }
    // ficheiros de campos que já não estão em nenhuma resposta (substituídos) saem
    const used = new Set(Object.values(e.sections).flatMap((entries) => (entries ?? []).flatMap((entry) => Object.values(entry))).filter((v): v is string => typeof v === "string"));
    for (const d of e.documents.filter((x) => x.slot === "FIELD" && !used.has(x.id))) await this.dropDocument(repo, files, e.id, d.id);

    const now = this.clock.now();
    const admin = adminFromProfessional(form, e.sections);
    const resubmitted = e.status === "CORRECTION_REQUIRED";
    const actor = editor.kind === "hr" ? editor.actor : { id: null, name: e.fullName };
    const r = await repo.transition({
      id: e.id,
      from: SUBMITTABLE,
      to: "PENDING_APPROVAL",
      actorId: actor.id,
      actorName: actor.name,
      reason: resubmitted ? "Correções feitas e cadastro submetido de novo." : null,
      now,
      revision: input.revision,
      set: { progress: "SUBMITTED", submittedAt: now, correctionNote: null, jobTitle: e.jobTitle ?? admin.jobTitle, department: e.department ?? admin.department },
    });
    if (!r.ok) return fail(this.transitionError(r));
    await repo.record("HR_EMPLOYEE_SUBMITTED", e.id, actor.id, { resubmitted }, now);
    const to = await repo.recipients("hr.employees.approve");
    if (to.length) await this.quietly(() => this.mailer.submittedForHr({ to, school, employee: e.fullName, employeeId: e.id, resubmitted }));
    if (editor.kind === "applicant" && e.email) await this.quietly(() => this.mailer.submittedConfirmation({ to: { email: e.email!, name: e.fullName }, school }));
    return ok(this.view(r.value));
  }

  private transitionError(r: { ok: false; reason: "not_found" | "state" | "conflict"; status?: EmployeeStatus }) {
    if (r.reason === "not_found") return hrError("EMPLOYEE_NOT_FOUND", "Cadastro não encontrado.");
    if (r.reason === "conflict") return hrError("REVISION_CONFLICT", "Os dados mudaram entretanto. Reveja e submeta de novo.");
    return hrError("INVALID_STATE", `O cadastro está ${r.status ? EMPLOYEE_STATUS_LABELS[r.status].toLowerCase() : "noutro estado"}. Recarregue a página.`);
  }

  // ================================================================ RH: consulta e criação

  async list(repo: EmployeeRepository, input: { status?: string | null; q?: string | null; type?: string | null; page?: number }) {
    const status = input.status && isEmployeeStatus(input.status) ? input.status : null;
    const page = Math.max(1, input.page ?? 1);
    const r = await repo.list({ status, q: input.q?.trim().slice(0, 80) || null, typeId: input.type || null, page, pageSize: EMPLOYEES_PAGE_SIZE });
    return {
      items: r.items.map((x) => ({
        id: x.id,
        number: formatEmployeeNumber(x.number),
        fullName: x.fullName,
        email: x.email,
        phone: x.phone,
        jobTitle: x.jobTitle,
        department: x.department,
        employeeType: x.employeeTypeName,
        status: x.status,
        statusLabel: EMPLOYEE_STATUS_LABELS[x.status],
        progress: x.progress,
        photoId: x.photoId,
        createdAt: x.createdAt.toISOString(),
        submittedAt: x.submittedAt?.toISOString() ?? null,
      })),
      total: r.total,
      page,
      pageSize: EMPLOYEES_PAGE_SIZE,
      counts: r.counts,
      statuses: EMPLOYEE_STATUSES.map((s) => ({ value: s, label: EMPLOYEE_STATUS_LABELS[s] })),
    };
  }

  async detail(repo: EmployeeRepository, id: string) {
    const e = await repo.find(id);
    if (!e) return fail(hrError("EMPLOYEE_NOT_FOUND", "Funcionário não encontrado."));
    return ok({ employee: this.view(e), history: (await repo.history(id)).map(historyDto) });
  }

  /** Cadastro criado pelo RH (sem pedido): fica em rascunho para o RH preencher. */
  async create(repo: EmployeeRepository, settings: HrSettingsRepository, actor: HrActor, input: { fullName: string; email?: string | null; phone?: string | null; employeeTypeId?: string | null }) {
    const latest = await settings.latest();
    if (!latest) return fail(hrError("FORM_NOT_PUBLISHED", "Publique o formulário de cadastro primeiro."));
    const types = latest.snapshot.employeeTypes ?? [];
    const typeId = input.employeeTypeId ?? null;
    if (types.length && !types.some((t) => t.id === typeId)) return fail(hrError("INVALID_INPUT", "Escolha o tipo de funcionário."));
    if (!types.length && typeId) return fail(hrError("INVALID_INPUT", "Tipo de funcionário inválido."));
    const form = forEmployeeType(latest.snapshot, typeId);
    const checked = checkPersonal(form, { fullName: input.fullName, email: input.email, phone: input.phone }, false, { countryCode: this.countryCode, today: luandaToday(this.clock.now()), docs: [] });
    const errs = (["fullName", "email", "phone"] as const).map((k) => checked.errors[k]).filter(Boolean);
    if (!checked.value.fullName) return fail(hrError("INVALID_INPUT", "Escreva o nome completo."));
    if (errs.length) return fail(hrError("INVALID_INPUT", errs[0]!));
    const now = this.clock.now();
    const r = await repo.create({
      id: this.ids.next(),
      requestId: null,
      employeeTypeId: typeId,
      formVersionId: latest.id,
      fullName: checked.value.fullName,
      email: checked.value.email ?? null,
      phone: checked.value.phone ?? null,
      personal: checked.value,
      createdById: actor.id,
      actorName: actor.name,
      now,
    });
    if (!r.ok) return fail(hrError("INVALID_STATE", "Este pedido já tem cadastro."));
    await repo.record("HR_EMPLOYEE_CREATED", r.value.id, actor.id, { formVersion: latest.number }, now);
    return ok(this.view(r.value));
  }

  // ================================================================ RH: decisões

  async approve(repo: EmployeeRepository, school: School, actor: HrActor, id: string, input: { jobTitle?: string | null; department?: string | null }) {
    const now = this.clock.now();
    const clean = (s: string | null | undefined) => s?.replace(/\s+/g, " ").trim().slice(0, 120) || null;
    const current = await repo.find(id);
    if (!current) return fail(hrError("EMPLOYEE_NOT_FOUND", "Funcionário não encontrado."));
    const r = await repo.transition({
      id,
      from: ["PENDING_APPROVAL"],
      to: "APPROVED",
      actorId: actor.id,
      actorName: actor.name,
      reason: null,
      now,
      assignNumber: true,
      set: { approvedAt: now, jobTitle: input.jobTitle !== undefined ? clean(input.jobTitle) : current.jobTitle, department: input.department !== undefined ? clean(input.department) : current.department },
    });
    if (!r.ok) return fail(this.transitionError(r));
    await repo.record("HR_EMPLOYEE_APPROVED", id, actor.id, { number: r.value.number }, now);
    const e = r.value;
    const emailSent = e.email ? await this.quietly(() => this.mailer.approved({ to: { email: e.email!, name: e.fullName }, school, number: formatEmployeeNumber(e.number) })) : false;
    return ok({ employee: this.view(e), emailSent });
  }

  async reject(repo: EmployeeRepository, school: School, actor: HrActor, id: string, input: { reason: string; notify?: boolean }) {
    const reason = checkReason(input.reason, true);
    if (!reason.ok) return reason;
    const now = this.clock.now();
    const r = await repo.transition({ id, from: ["PENDING_APPROVAL"], to: "REJECTED", actorId: actor.id, actorName: actor.name, reason: reason.value, now });
    if (!r.ok) return fail(this.transitionError(r));
    await repo.record("HR_EMPLOYEE_REJECTED", id, actor.id, { reason: reason.value }, now);
    const e = r.value;
    const emailSent = e.email ? await this.quietly(() => this.mailer.rejected({ to: { email: e.email!, name: e.fullName }, school, reason: input.notify ? reason.value : null })) : false;
    return ok({ employee: this.view(e), emailSent });
  }

  /**
   * Pede correções: o cadastro volta para quem o preencheu. Se veio de um pedido, segue um
   * novo convite (o anterior deixa de valer) com a nota do RH; senão é o RH que corrige.
   */
  async requestCorrection(repo: EmployeeRepository, registrations: RegistrationRepository, school: School, actor: HrActor, id: string, input: { reason: string }) {
    const reason = checkReason(input.reason, true);
    if (!reason.ok) return reason;
    const now = this.clock.now();
    const r = await repo.transition({ id, from: ["PENDING_APPROVAL"], to: "CORRECTION_REQUIRED", actorId: actor.id, actorName: actor.name, reason: reason.value, now, set: { progress: "IN_PROGRESS", correctionNote: reason.value } });
    if (!r.ok) return fail(this.transitionError(r));
    await repo.record("HR_EMPLOYEE_CORRECTION_REQUESTED", id, actor.id, { reason: reason.value }, now);
    const e = r.value;
    let emailSent = false;
    if (e.requestId && e.email) {
      const token = newInviteToken();
      const invite = { id: this.ids.next(), tokenHash: hashInviteToken(token), employeeTypeId: e.employeeTypeId, expiresAt: inviteExpiry(now) };
      const reissued = await registrations.reissueInvite({ requestId: e.requestId, actorId: actor.id, invite, now });
      if (reissued.ok) {
        try {
          await this.mailer.correctionRequested({ to: { email: e.email, name: e.fullName }, school, note: reason.value!, token, expiresAt: invite.expiresAt });
          await registrations.markInviteSent(invite.id, this.clock.now());
          emailSent = true;
        } catch (err) {
          await registrations.markInviteFailed(invite.id, (err instanceof Error ? err.message : "falha no envio").slice(0, 300));
        }
      }
    }
    return ok({ employee: this.view(e), emailSent });
  }

  /** Vínculo: ativar, suspender ou desligar (suspender e desligar exigem justificação). */
  async setEmployment(repo: EmployeeRepository, actor: HrActor, id: string, input: { status: string; reason?: string | null }) {
    if (!(input.status in EMPLOYMENT_TRANSITIONS)) return fail(hrError("INVALID_INPUT", "Estado inválido."));
    const to = input.status as keyof typeof EMPLOYMENT_TRANSITIONS;
    const reason = checkReason(input.reason, to !== "ACTIVE");
    if (!reason.ok) return reason;
    const now = this.clock.now();
    const set = to === "ACTIVE" ? { activatedAt: now } : to === "TERMINATED" ? { terminatedAt: now } : {};
    const r = await repo.transition({ id, from: EMPLOYMENT_TRANSITIONS[to], to, actorId: actor.id, actorName: actor.name, reason: reason.value, now, set });
    if (!r.ok) return fail(this.transitionError(r));
    await repo.record(`HR_EMPLOYEE_${to}`, id, actor.id, { reason: reason.value }, now);
    return ok({ employee: this.view(r.value) });
  }

  async updateAdmin(repo: EmployeeRepository, actor: HrActor, id: string, input: { jobTitle?: string | null; department?: string | null }) {
    const clean = (s: string | null | undefined) => s?.replace(/\s+/g, " ").trim().slice(0, 120) || null;
    const e = await repo.find(id);
    if (!e) return fail(hrError("EMPLOYEE_NOT_FOUND", "Funcionário não encontrado."));
    const jobTitle = input.jobTitle !== undefined ? clean(input.jobTitle) : e.jobTitle;
    const department = input.department !== undefined ? clean(input.department) : e.department;
    const now = this.clock.now();
    await repo.updateAdmin(id, { jobTitle, department, now });
    if (jobTitle !== e.jobTitle || department !== e.department) {
      await repo.addHistory({ employeeId: id, from: e.status, to: e.status, actorId: actor.id, actorName: actor.name, reason: `Cargo/departamento: ${jobTitle ?? "—"} · ${department ?? "—"}.`, now });
    }
    return this.detail(repo, id);
  }
}
