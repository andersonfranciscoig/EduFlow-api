import type { Clock, FileStorage } from "../../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../../libs/kernel/src/domain/Result";
import { schoolError, type SchoolError } from "../domain/errors";
import type { PaymentMethod, School } from "../domain/School";
import type { SchoolRepository } from "../domain/SchoolRepository";
import type { CodeGenerator, PlanCatalog } from "./ports";
import { toPortalView, toSchoolDetail, toSchoolSummary } from "./school-dto";

const ALLOWED_PROOF_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
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
  ) {}

  private async load(id: string): Promise<Result<School, SchoolError>> {
    const school = await this.schools.findById(id);
    return school ? ok(school) : fail(schoolError("SCHOOL_NOT_FOUND", "Colégio não encontrado."));
  }

  private async persist(school: School) {
    await this.schools.save(school);
    return toSchoolDetail(school, await this.schools.activity(school.id));
  }

  // ================================================================ portal do colégio

  async portalView(schoolId: string) {
    const school = await this.load(schoolId);
    if (!school.ok) return school;
    const settings = await this.catalog.getSettings();
    return ok(
      toPortalView(school.value, await this.schools.activity(schoolId), {
        transferInstructions: settings.transferInstructions,
        referenceProvider: settings.referenceProvider,
      }),
    );
  }

  async submitTransferProof(
    schoolId: string,
    input: { transactionNumber: string; file: { fileName: string; mimeType: string; content: Buffer } },
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

    const stored = await this.storage.save(`proofs/${schoolId}`, input.file);
    const now = this.clock.now();
    const result = school.value.submitTransferProof(
      { transactionNumber: input.transactionNumber, fileKey: stored.key, fileName: stored.fileName, mimeType: stored.mimeType, submittedAt: now },
      now,
    );
    if (!result.ok) return result;
    await this.schools.save(school.value);
    return this.portalView(schoolId);
  }

  /**
   * Confirmação automática de um pagamento por referência.
   * Hoje é chamada pela simulação; amanhã pelo webhook do gateway real.
   */
  async confirmReferencePayment(reference: string, amount: number): Promise<Result<{ schoolId: string }, SchoolError>> {
    const school = await this.schools.findByReference(reference);
    if (!school) return fail(schoolError("REFERENCE_NOT_FOUND", "Referência não encontrada."));
    const result = school.confirmReferencePayment({ reference, amount }, this.clock.now());
    if (!result.ok) return result;
    await this.schools.save(school);
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
    const settings = await this.catalog.getSettings();
    if (method === "REFERENCE") {
      let reference = this.codes.referenceNumber();
      while (await this.schools.referenceExists(reference)) reference = this.codes.referenceNumber();
      const expiresAt = new Date(this.clock.now().getTime() + settings.referenceValidityDays * 86_400_000);
      return ok({ method: "REFERENCE" as const, entity: settings.referenceEntity, reference, expiresAt });
    }
    const account = bankAccountId ? await this.catalog.findBankAccount(bankAccountId) : null;
    if (!account || !account.active) {
      return fail(schoolError("INVALID_PAYMENT_METHOD", "Escolha uma conta bancária ativa para a transferência."));
    }
    return ok({ method: "TRANSFER" as const, bankName: account.bankName, holder: account.holder, iban: account.iban });
  }

  async approve(schoolId: string, staffId: string, input: { method: PaymentMethod; bankAccountId?: string }) {
    const school = await this.load(schoolId);
    if (!school.ok) return school;
    const ins = await this.instructions(input.method, input.bankAccountId);
    if (!ins.ok) return ins;
    const result = school.value.approve(ins.value, staffId, this.clock.now());
    if (!result.ok) return result;
    return ok(await this.persist(school.value));
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
    return ok(await this.persist(school.value));
  }

  async confirmTransfer(schoolId: string, staffId: string) {
    const school = await this.load(schoolId);
    if (!school.ok) return school;
    const result = school.value.confirmTransferPayment(staffId, this.clock.now());
    if (!result.ok) return result;
    return ok(await this.persist(school.value));
  }

  async rejectProof(schoolId: string, staffId: string, reason: string) {
    const school = await this.load(schoolId);
    if (!school.ok) return school;
    const result = school.value.rejectTransferProof(reason, staffId, this.clock.now());
    if (!result.ok) return result;
    return ok(await this.persist(school.value));
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
    return ok(toSchoolDetail(school.value, await this.schools.activity(schoolId)));
  }
}
