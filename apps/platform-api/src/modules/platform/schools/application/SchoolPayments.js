"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SchoolPayments = exports.MAX_PROOF_BYTES = void 0;
const Result_1 = require("../../../../../../../libs/kernel/src/domain/Result");
const errors_1 = require("../domain/errors");
const school_dto_1 = require("./school-dto");
const ALLOWED_PROOF_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
exports.MAX_PROOF_BYTES = 5 * 1024 * 1024;
class SchoolPayments {
    schools;
    catalog;
    storage;
    codes;
    clock;
    constructor(schools, catalog, storage, codes, clock) {
        this.schools = schools;
        this.catalog = catalog;
        this.storage = storage;
        this.codes = codes;
        this.clock = clock;
    }
    async load(id) {
        const school = await this.schools.findById(id);
        return school ? (0, Result_1.ok)(school) : (0, Result_1.fail)((0, errors_1.schoolError)("SCHOOL_NOT_FOUND", "Colégio não encontrado."));
    }
    async persist(school) {
        await this.schools.save(school);
        return (0, school_dto_1.toSchoolDetail)(school, await this.schools.activity(school.id));
    }
    async portalView(schoolId) {
        const school = await this.load(schoolId);
        if (!school.ok)
            return school;
        const settings = await this.catalog.getSettings();
        return (0, Result_1.ok)((0, school_dto_1.toPortalView)(school.value, await this.schools.activity(schoolId), {
            transferInstructions: settings.transferInstructions,
            referenceProvider: settings.referenceProvider,
        }));
    }
    async submitTransferProof(schoolId, input) {
        const school = await this.load(schoolId);
        if (!school.ok)
            return school;
        if (!ALLOWED_PROOF_TYPES.has(input.file.mimeType)) {
            return (0, Result_1.fail)((0, errors_1.schoolError)("INVALID_PROOF", "O comprovativo tem de ser PDF ou imagem (JPG, PNG)."));
        }
        if (input.file.content.length === 0 || input.file.content.length > exports.MAX_PROOF_BYTES) {
            return (0, Result_1.fail)((0, errors_1.schoolError)("INVALID_PROOF", "O comprovativo tem de ter no máximo 5 MB."));
        }
        const order = school.value.currentOrder;
        if (order?.status !== "AWAITING_PAYMENT" || order.instructions?.method !== "TRANSFER") {
            return (0, Result_1.fail)((0, errors_1.schoolError)("INVALID_STATE", "De momento não há nenhuma transferência por comprovar."));
        }
        const stored = await this.storage.save(`proofs/${schoolId}`, input.file);
        const now = this.clock.now();
        const result = school.value.submitTransferProof({ transactionNumber: input.transactionNumber, fileKey: stored.key, fileName: stored.fileName, mimeType: stored.mimeType, submittedAt: now }, now);
        if (!result.ok)
            return result;
        await this.schools.save(school.value);
        return this.portalView(schoolId);
    }
    async confirmReferencePayment(reference, amount) {
        const school = await this.schools.findByReference(reference);
        if (!school)
            return (0, Result_1.fail)((0, errors_1.schoolError)("REFERENCE_NOT_FOUND", "Referência não encontrada."));
        const result = school.confirmReferencePayment({ reference, amount }, this.clock.now());
        if (!result.ok)
            return result;
        await this.schools.save(school);
        return (0, Result_1.ok)({ schoolId: school.id });
    }
    async simulateReferencePayment(schoolId) {
        const school = await this.load(schoolId);
        if (!school.ok)
            return school;
        const order = school.value.currentOrder;
        const ins = order?.instructions;
        if (!order || ins?.method !== "REFERENCE") {
            return (0, Result_1.fail)((0, errors_1.schoolError)("INVALID_STATE", "Não há nenhuma referência por pagar."));
        }
        const paid = await this.confirmReferencePayment(ins.reference, order.total);
        if (!paid.ok)
            return paid;
        return this.portalView(schoolId);
    }
    async instructions(method, bankAccountId) {
        const settings = await this.catalog.getSettings();
        if (method === "REFERENCE") {
            let reference = this.codes.referenceNumber();
            while (await this.schools.referenceExists(reference))
                reference = this.codes.referenceNumber();
            const expiresAt = new Date(this.clock.now().getTime() + settings.referenceValidityDays * 86_400_000);
            return (0, Result_1.ok)({ method: "REFERENCE", entity: settings.referenceEntity, reference, expiresAt });
        }
        const account = bankAccountId ? await this.catalog.findBankAccount(bankAccountId) : null;
        if (!account || !account.active) {
            return (0, Result_1.fail)((0, errors_1.schoolError)("INVALID_PAYMENT_METHOD", "Escolha uma conta bancária ativa para a transferência."));
        }
        return (0, Result_1.ok)({ method: "TRANSFER", bankName: account.bankName, holder: account.holder, iban: account.iban });
    }
    async approve(schoolId, staffId, input) {
        const school = await this.load(schoolId);
        if (!school.ok)
            return school;
        const ins = await this.instructions(input.method, input.bankAccountId);
        if (!ins.ok)
            return ins;
        const result = school.value.approve(ins.value, staffId, this.clock.now());
        if (!result.ok)
            return result;
        return (0, Result_1.ok)(await this.persist(school.value));
    }
    async changePaymentMethod(schoolId, staffId, input) {
        const school = await this.load(schoolId);
        if (!school.ok)
            return school;
        const ins = await this.instructions(input.method, input.bankAccountId);
        if (!ins.ok)
            return ins;
        const result = school.value.changePaymentMethod(ins.value, staffId, this.clock.now());
        if (!result.ok)
            return result;
        return (0, Result_1.ok)(await this.persist(school.value));
    }
    async reject(schoolId, staffId, reason) {
        const school = await this.load(schoolId);
        if (!school.ok)
            return school;
        const result = school.value.reject(reason, staffId, this.clock.now());
        if (!result.ok)
            return result;
        return (0, Result_1.ok)(await this.persist(school.value));
    }
    async confirmTransfer(schoolId, staffId) {
        const school = await this.load(schoolId);
        if (!school.ok)
            return school;
        const result = school.value.confirmTransferPayment(staffId, this.clock.now());
        if (!result.ok)
            return result;
        return (0, Result_1.ok)(await this.persist(school.value));
    }
    async rejectProof(schoolId, staffId, reason) {
        const school = await this.load(schoolId);
        if (!school.ok)
            return school;
        const result = school.value.rejectTransferProof(reason, staffId, this.clock.now());
        if (!result.ok)
            return result;
        return (0, Result_1.ok)(await this.persist(school.value));
    }
    async proofFile(schoolId) {
        const school = await this.load(schoolId);
        if (!school.ok)
            return school;
        const proof = school.value.currentOrder?.proof;
        if (!proof)
            return (0, Result_1.fail)((0, errors_1.schoolError)("PROOF_NOT_FOUND", "Este colégio não tem comprovativo."));
        return (0, Result_1.ok)({ content: await this.storage.read(proof.fileKey), fileName: proof.fileName, mimeType: proof.mimeType });
    }
    async list(status) {
        const [schools, counts] = await Promise.all([this.schools.list({ status }), this.schools.countByStatus()]);
        return { schools: schools.map(school_dto_1.toSchoolSummary), counts };
    }
    async detail(schoolId) {
        const school = await this.load(schoolId);
        if (!school.ok)
            return school;
        return (0, Result_1.ok)((0, school_dto_1.toSchoolDetail)(school.value, await this.schools.activity(schoolId)));
    }
}
exports.SchoolPayments = SchoolPayments;
//# sourceMappingURL=SchoolPayments.js.map