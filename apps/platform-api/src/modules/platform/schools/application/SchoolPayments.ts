import type { Clock, FileStorage } from "../../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../../libs/kernel/src/domain/Result";
import { schoolError, type SchoolError } from "../domain/errors";
import { type PaymentMethod, type School, VALIDATION_HOURS } from "../domain/School";
import type { SchoolRepository } from "../domain/SchoolRepository";
import type { BillingTeam, CodeGenerator, PlanCatalog, SchoolDatabasePort, SchoolNotifier, SchoolSettings } from "./ports";
import { toPortalView, toSchoolDetail, toSchoolSummary } from "./school-dto";

const ALLOWED_PROOF_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
/** O dia em Luanda (AAAA-MM-DD). */
const luandaDay = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "Africa/Luanda" });
export const MAX_PROOF_BYTES = 5 * 1024 * 1024;

/**
 * Ciclo de pagamento da subscrição — usado pelo portal do colégio, pela equipa
 * e pelo gateway de pagamentos por referência (simulado por agora).
 */
export class SchoolPayments {
  constructor(
    private readonly schools: SchoolRepository,
    private readonly catalog: PlanCatalog,
    private readonly storage: FileStorage,
    private readonly codes: CodeGenerator,
    private readonly clock: Clock,
    private readonly databases: SchoolDatabasePort,
    private readonly notifier: SchoolNotifier,
    private readonly settings: SchoolSettings,
    private readonly team: BillingTeam,
  ) {}

  /** Avisa o colégio e a equipa que gere a faturação (melhor esforço: nunca falha a operação). */
  private announce(school: School, state: "OPEN" | "SUBMITTED" | "REJECTED" | "CONFIRMED", detail: string) {
    const s = school.snapshot;
    const order = school.currentOrder;
    if (!order) return;
    const base = { schoolName: s.name, orderNumber: order.number, total: order.total };
    void (async () => {
      await this.notifier.paymentUpdate({ ...base, to: { email: s.ownerEmail, name: s.ownerName }, state, reason: detail }).catch(() => undefined);
      if (state !== "OPEN") await this.notifier.teamPaymentUpdate({ ...base, to: await this.team.emails(), schoolId: school.id, state, detail }).catch(() => undefined);
    })().catch(() => undefined);
  }

  private async load(id: string): Promise<Result<School, SchoolError>> {
    const school = await this.schools.findById(id);
    return school ? ok(school) : fail(schoolError("SCHOOL_NOT_FOUND", "Colégio não encontrado."));
  }

  private portalUrl(school: School) {
    return school.slug ? this.settings.portalUrlTemplate.replace("{slug}", school.slug) : null;
  }

  private async view(school: School) {
    const [activity, database] = await Promise.all([this.schools.activity(school.id), this.databases.status(school.id)]);
    return { ...toSchoolDetail(school, activity), database, portalUrl: this.portalUrl(school) };
  }

  /**
   * Grava; se o colégio acabou de ficar ATIVO pela primeira vez, avisa o
   * responsável com o endereço do portal (melhor esforço).
   */
  private async saveAndNotify(school: School, wasActive: boolean) {
    await this.schools.save(school);
    const url = this.portalUrl(school);
    if (!wasActive && school.status === "ACTIVE" && url) {
      const s = school.snapshot;
      await this.notifier
        .schoolActivated({ to: { email: s.ownerEmail, name: s.ownerName }, schoolName: s.name, portalUrl: url, subscriptionEndsAt: s.subscriptionEndsAt })
        .catch(() => undefined);
    }
  }

  private async persist(school: School) {
    await this.schools.save(school);
    return this.view(school);
  }

  // ================================================================ portal do colégio

  async portalView(schoolId: string) {
    const school = await this.load(schoolId);
    if (!school.ok) return school;
    const [settings, database, accounts] = await Promise.all([this.catalog.getSettings(), this.databases.status(schoolId), this.catalog.listBankAccounts(true)]);
    const ready = (database as { state?: string } | null)?.state === "READY";
    const url = this.portalUrl(school.value);
    return ok({
      ...toPortalView(school.value, await this.schools.activity(schoolId), {
        transferInstructions: settings.transferInstructions,
        referenceProvider: settings.referenceProvider,
        bankAccounts: accounts.map(({ id, bankName, holder, iban }) => ({ id, bankName, holder, iban })),
        validationHours: VALIDATION_HOURS,
      }),
      // o portal do colégio (Módulo 2): endereço e se já está pronto a usar
      portal: url && school.value.status === "ACTIVE" ? { url, ready } : null,
    });
  }

  async submitTransferProof(
    schoolId: string,
    input: { transactionNumber: string; kind: "TRANSFERENCIA" | "DEPOSITO" | null; paidOn: string | null; bankAccountId?: string; file: { fileName: string; mimeType: string; content: Buffer } },
  ) {
    const school = await this.load(schoolId);
    if (!school.ok) return school;
    if (!ALLOWED_PROOF_TYPES.has(input.file.mimeType)) {
      return fail(schoolError("INVALID_PROOF", "O comprovativo tem de ser PDF ou imagem (JPG, PNG)."));
    }
    if (input.file.content.length === 0 || input.file.content.length > MAX_PROOF_BYTES) {
      return fail(schoolError("INVALID_PROOF", "O comprovativo tem de ter no máximo 5 MB."));
    }
    // valida o estado ANTES de gravar o ficheiro
    const order = school.value.currentOrder;
    if (order?.status !== "AWAITING_PAYMENT" || order.instructions?.method !== "TRANSFER") {
      return fail(schoolError("INVALID_STATE", "De momento não há nenhuma transferência por comprovar."));
    }

    const now = this.clock.now();
    if (input.transactionNumber.trim().length < 4) return fail(schoolError("INVALID_PROOF", "Indique o número da transação."));
    if (input.paidOn && input.paidOn > luandaDay(now)) return fail(schoolError("INVALID_PROOF", "A data do pagamento não pode ser no futuro."));
    // a conta onde o colégio pagou (uma das contas ativas da EduFlow)
    const account = input.bankAccountId ? await this.catalog.findBankAccount(input.bankAccountId) : null;
    if (input.bankAccountId && !account?.active) return fail(schoolError("INVALID_PAYMENT_METHOD", "Escolha uma das contas bancárias da EduFlow."));
    if (await this.schools.transactionUsed(account?.iban ?? order.instructions.iban, input.transactionNumber.trim(), order.id)) {
      return fail(schoolError("INVALID_PROOF", "Este número de transação já foi usado noutro pagamento. Confirme-o no comprovativo."));
    }

    const stored = await this.storage.save(`proofs/${schoolId}`, input.file).catch((e: unknown) => {
      console.error(`[comprovativos] não foi possível guardar: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
      return null;
    });
    if (!stored) return fail(schoolError("STORAGE_UNAVAILABLE", "Não foi possível guardar o comprovativo agora. Tente de novo dentro de instantes."));
    const result = school.value.submitTransferProof(
      { transactionNumber: input.transactionNumber, fileKey: stored.key, fileName: stored.fileName, mimeType: stored.mimeType, submittedAt: now, kind: input.kind, paidOn: input.paidOn },
      now,
      account ?? undefined,
    );
    if (!result.ok) return result;
    await this.schools.save(school.value);
    const ins = school.value.currentOrder!.instructions as { bankName: string };
    this.announce(school.value, "SUBMITTED", `${input.kind === "DEPOSITO" ? "Depósito" : "Transferência"} para ${ins.bankName}, transação ${input.transactionNumber.trim()}.`);
    return this.portalView(schoolId);
  }

  /**
   * Confirmação automática de um pagamento por referência.
   * Hoje é chamada pela simulação; amanhã pelo webhook do gateway real.
   */
  async confirmReferencePayment(reference: string, amount: number): Promise<Result<{ schoolId: string }, SchoolError>> {
    const school = await this.schools.findByReference(reference);
    if (!school) return fail(schoolError("REFERENCE_NOT_FOUND", "Referência não encontrada."));
    const wasActive = school.status === "ACTIVE";
    const result = school.confirmReferencePayment({ reference, amount }, this.clock.now());
    if (!result.ok) return result;
    await this.saveAndNotify(school, wasActive);
    return ok({ schoolId: school.id });
  }

  /** Ambiente de teste: o colégio "paga" a sua própria referência. */
  async simulateReferencePayment(schoolId: string) {
    const school = await this.load(schoolId);
    if (!school.ok) return school;
    const order = school.value.currentOrder;
    const ins = order?.instructions;
    if (!order || ins?.method !== "REFERENCE") {
      return fail(schoolError("INVALID_STATE", "Não há nenhuma referência por pagar."));
    }
    const paid = await this.confirmReferencePayment(ins.reference, order.total);
    if (!paid.ok) return paid;
    return this.portalView(schoolId);
  }

  // ================================================================ equipa

  private async instructions(method: PaymentMethod, bankAccountId?: string) {
    // por agora só transferência ou depósito; a referência (e o Express) chegam em breve
    if (method === "REFERENCE" && !this.settings.referencePayments) {
      return fail(schoolError("INVALID_PAYMENT_METHOD", "O pagamento por referência ainda não está disponível. Use a transferência ou o depósito."));
    }
    const settings = await this.catalog.getSettings();
    if (method === "REFERENCE") {
      let reference = this.codes.referenceNumber();
      while (await this.schools.referenceExists(reference)) reference = this.codes.referenceNumber();
      const expiresAt = new Date(this.clock.now().getTime() + settings.referenceValidityDays * 86_400_000);
      return ok({ method: "REFERENCE" as const, entity: settings.referenceEntity, reference, expiresAt });
    }
    // sem conta indicada: a primeira ativa (o colégio escolhe a que usa quando paga)
    const account = bankAccountId ? await this.catalog.findBankAccount(bankAccountId) : (await this.catalog.listBankAccounts(true))[0];
    if (!account || !account.active) {
      return fail(schoolError("INVALID_PAYMENT_METHOD", "Registe primeiro uma conta bancária ativa da EduFlow, em Faturação."));
    }
    return ok({ method: "TRANSFER" as const, bankName: account.bankName, holder: account.holder, iban: account.iban });
  }

  /**
   * Validar: forma de pagamento + reserva do servidor de BD.
   * databaseServerId: "auto" (omissão) | id | null (decidir depois).
   */
  async approve(
    schoolId: string,
    staffId: string,
    input: { method: PaymentMethod; bankAccountId?: string; databaseServerId?: string | null },
  ) {
    const school = await this.load(schoolId);
    if (!school.ok) return school;
    const ins = await this.instructions(input.method, input.bankAccountId);
    if (!ins.ok) return ins;
    const result = school.value.approve(ins.value, staffId, this.clock.now());
    if (!result.ok) return result;
    const reserved = await this.databases.reserveOnApproval(schoolId, input.databaseServerId === undefined ? "auto" : input.databaseServerId, staffId);
    if (!reserved.ok) return reserved;
    const view = await this.persist(school.value);
    this.announce(school.value, "OPEN", "");
    return ok(view);
  }

  async changePaymentMethod(schoolId: string, staffId: string, input: { method: PaymentMethod; bankAccountId?: string }) {
    const school = await this.load(schoolId);
    if (!school.ok) return school;
    const ins = await this.instructions(input.method, input.bankAccountId);
    if (!ins.ok) return ins;
    const result = school.value.changePaymentMethod(ins.value, staffId, this.clock.now());
    if (!result.ok) return result;
    return ok(await this.persist(school.value));
  }

  async reject(schoolId: string, staffId: string, reason: string) {
    const school = await this.load(schoolId);
    if (!school.ok) return school;
    const result = school.value.reject(reason, staffId, this.clock.now());
    if (!result.ok) return result;
    await this.schools.save(school.value);
    await this.databases.release(schoolId, "Pedido rejeitado", staffId);
    return ok(await this.view(school.value));
  }

  async confirmTransfer(schoolId: string, staffId: string) {
    const school = await this.load(schoolId);
    if (!school.ok) return school;
    const wasActive = school.value.status === "ACTIVE";
    const result = school.value.confirmTransferPayment(staffId, this.clock.now());
    if (!result.ok) return result;
    await this.saveAndNotify(school.value, wasActive);
    const order = school.value.currentOrder!;
    this.announce(school.value, "CONFIRMED", `Transação ${order.proof?.transactionNumber ?? "—"} validada.`);
    return ok(await this.view(school.value));
  }

  // ================================================================ desativar / reativar

  async suspend(schoolId: string, staffId: string, reason: string) {
    const school = await this.load(schoolId);
    if (!school.ok) return school;
    const result = school.value.suspend(reason, staffId, this.clock.now());
    if (!result.ok) return result;
    return ok(await this.persist(school.value));
  }

  async reactivate(schoolId: string, staffId: string) {
    const school = await this.load(schoolId);
    if (!school.ok) return school;
    const result = school.value.reactivate(staffId, this.clock.now());
    if (!result.ok) return result;
    return ok(await this.persist(school.value));
  }

  /**
   * Desativa os colégios que não passaram a um email corporativo no prazo de
   * 30 dias (corre periodicamente). Devolve quantos foram desativados.
   */
  async sweepEmailDeadlines(): Promise<number> {
    const now = this.clock.now();
    let count = 0;
    for (const school of await this.schools.listPastEmailDeadline(now)) {
      if (!school.emailDeadlinePassed(now)) continue;
      const result = school.suspend("Não passou a usar um email corporativo no prazo de 30 dias.", null, now);
      if (!result.ok) continue;
      await this.schools.save(school);
      const s = school.snapshot;
      await this.notifier.schoolSuspended({ to: { email: s.ownerEmail, name: s.ownerName }, schoolName: s.name, reason: s.suspensionReason! }).catch(() => undefined);
      count++;
    }
    return count;
  }

  async rejectProof(schoolId: string, staffId: string, reason: string) {
    const school = await this.load(schoolId);
    if (!school.ok) return school;
    const result = school.value.rejectTransferProof(reason, staffId, this.clock.now());
    if (!result.ok) return result;
    const view = await this.persist(school.value);
    this.announce(school.value, "REJECTED", reason.trim());
    return ok(view);
  }

  /** Ficheiro do comprovativo atual (só para a equipa). */
  async proofFile(schoolId: string) {
    const school = await this.load(schoolId);
    if (!school.ok) return school;
    const proof = school.value.currentOrder?.proof;
    if (!proof) return fail(schoolError("PROOF_NOT_FOUND", "Este colégio não tem comprovativo."));
    return ok({ content: await this.storage.read(proof.fileKey), fileName: proof.fileName, mimeType: proof.mimeType });
  }

  // ================================================================ consultas da equipa

  async list(status?: School["status"]) {
    const [schools, counts] = await Promise.all([this.schools.list({ status }), this.schools.countByStatus()]);
    return { schools: schools.map(toSchoolSummary), counts };
  }

  async detail(schoolId: string) {
    const school = await this.load(schoolId);
    if (!school.ok) return school;
    return ok(await this.view(school.value));
  }
}
