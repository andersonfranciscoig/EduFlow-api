import type { Clock, IdGenerator } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import { sha256 } from "../../../../../../libs/kernel/src/infrastructure/backup-crypto";
import { luandaToday } from "../../family/domain/family";
import type { HrFileStore } from "../../hr/application/employee-ports";
import { FORMAT_MIME, MB, safeFileName, sniffFormat } from "../../hr/domain/employee";
import { checkExpense, checkPay, EXPENSE_LABELS, EXPENSE_METHODS, EXPENSE_SUGGESTIONS, type ExpenseInput, expenseNumber, type ExpenseStatus, MAX_CATEGORIES, type PayInput } from "../domain/expenses";
import { checkReason, clean, type PaymentError, paymentError, PROOF_FORMATS, PROOF_MAX_MB } from "../domain/payments";
import type { ExpenseRow, PrismaExpensesRepository } from "../infrastructure/prisma-expenses";

type R<T> = Promise<Result<T, PaymentError>>;
export interface ExpenseActor {
  id: string;
  canManage: boolean;
}
const HISTORY: Record<string, string> = { EXPENSE_CREATED: "Registada", EXPENSE_CHANGED: "Alterada", EXPENSE_PAID: "Paga", EXPENSE_UNPAID: "Pagamento reposto", EXPENSE_CANCELLED: "Anulada", EXPENSE_PROOF: "Comprovativo" };
const forbidden = () => fail(paymentError("FORBIDDEN", "Não tem permissão para gerir despesas."));
const missing = () => fail(paymentError("NOT_FOUND", "Despesa não encontrada."));
const moved = () => fail(paymentError("INVALID_STATE", "Esta despesa mudou entretanto. Atualize a página."));

export function expenseDto(e: ExpenseRow, today: string) {
  return {
    id: e.id,
    number: expenseNumber(e.number),
    category: { id: e.categoryId, name: e.categoryName },
    description: e.description,
    supplier: e.supplier,
    documentNumber: e.documentNumber,
    amount: e.amount,
    issuedOn: e.issuedOn,
    dueOn: e.dueOn,
    note: e.note,
    status: e.status,
    overdue: e.status === "PENDING" && !!e.dueOn && e.dueOn < today,
    statusLabel: e.status === "PENDING" && e.dueOn && e.dueOn < today ? "Em atraso" : EXPENSE_LABELS[e.status],
    paidOn: e.paidOn,
    method: e.method,
    methodLabel: e.method ? EXPENSE_METHODS[e.method] : null,
    bankName: e.bankName,
    transactionNumber: e.transactionNumber,
    proof: e.proofName ? { name: e.proofName, mimeType: e.proofMimeType, size: e.proofSize } : null,
    createdBy: e.createdByName,
    createdAt: e.createdAt.toISOString(),
    paidBy: e.paidByName,
    cancelReason: e.cancelReason,
  };
}

/** Despesas do colégio: registar, pagar, repor, anular (com motivo), comprovativo e categorias. */
export class Expenses {
  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}
  private today() {
    return luandaToday(this.clock.now());
  }

  async list(repo: PrismaExpensesRepository, actor: ExpenseActor, f: { status?: string; categoryId?: string; month?: string; q?: string; page?: number }) {
    const today = this.today();
    const page = Math.max(1, Math.floor(f.page ?? 1));
    const pageSize = 25;
    const status = f.status && (f.status === "OVERDUE" || f.status in EXPENSE_LABELS) ? f.status : undefined;
    const [r, categories, banks] = await Promise.all([repo.list({ ...f, status, q: clean(f.q).slice(0, 80) || undefined, page, pageSize, today }), repo.categories(), repo.banks()]);
    const by = (s: ExpenseStatus) => r.counts.find((c) => c.status === s);
    return {
      can: { manage: actor.canManage },
      today,
      page,
      pageSize,
      total: r.total,
      amount: r.amount,
      statuses: [
        { value: "PENDING", label: "Por pagar", count: by("PENDING")?.n ?? 0 },
        { value: "OVERDUE", label: "Em atraso", count: by("PENDING")?.overdue ?? 0 },
        { value: "PAID", label: "Pagas", count: by("PAID")?.n ?? 0 },
        { value: "CANCELLED", label: "Anuladas", count: by("CANCELLED")?.n ?? 0 },
      ],
      categories,
      suggestions: EXPENSE_SUGGESTIONS.filter((s) => !categories.some((c) => c.name.toLowerCase() === s.toLowerCase())),
      methods: Object.entries(EXPENSE_METHODS).map(([value, label]) => ({ value, label })),
      banks,
      items: r.items.map((e) => expenseDto(e, today)),
    };
  }

  async detail(repo: PrismaExpensesRepository, actor: ExpenseActor, id: string) {
    const e = await repo.byId(id);
    if (!e) return missing();
    const history = await repo.history(id);
    return ok({
      ...expenseDto(e, this.today()),
      can: { edit: actor.canManage && e.status !== "CANCELLED", pay: actor.canManage && e.status === "PENDING", unpay: actor.canManage && e.status === "PAID", cancel: actor.canManage && e.status === "PENDING" },
      history: history.map((h) => ({ at: h.at.toISOString(), label: HISTORY[h.type] ?? h.type, by: h.by, reason: typeof h.details?.reason === "string" ? h.details.reason : null })),
    });
  }

  private async check(repo: PrismaExpensesRepository, input: ExpenseInput, confirm: boolean, exceptId: string | null, keepCategory: string | null) {
    const d = checkExpense(input, this.today());
    if (!d.ok) return d;
    const cat = (await repo.categories()).find((c) => c.id === d.value.categoryId);
    if (!cat || (cat.archived && cat.id !== keepCategory)) return fail(paymentError("INVALID_INPUT", "Escolha uma categoria."));
    if (!confirm && d.value.supplier && d.value.documentNumber) {
      const n = await repo.duplicate(d.value.supplier, d.value.documentNumber, exceptId);
      if (n) return fail(paymentError("NEEDS_CONFIRMATION", `Já existe a ${expenseNumber(n)} com este fornecedor e este documento. Confirme se não é a mesma.`));
    }
    return d;
  }

  async create(repo: PrismaExpensesRepository, actor: ExpenseActor, input: ExpenseInput, confirm: boolean): R<{ id: string }> {
    if (!actor.canManage) return forbidden();
    const d = await this.check(repo, input, confirm, null, null);
    if (!d.ok) return d;
    const id = this.ids.next();
    await repo.create(id, d.value, actor.id, this.clock.now());
    return ok({ id });
  }

  /** Por pagar: tudo. Já paga: tudo menos o valor e a data da despesa (o que já conta nos relatórios). */
  async edit(repo: PrismaExpensesRepository, actor: ExpenseActor, id: string, input: ExpenseInput, confirm: boolean): R<{ saved: true }> {
    if (!actor.canManage) return forbidden();
    const e = await repo.byId(id);
    if (!e) return missing();
    if (e.status === "PAID" && (input.amount !== e.amount || input.issuedOn !== e.issuedOn)) return fail(paymentError("INVALID_STATE", "Esta despesa já está paga: para mudar o valor ou a data, reponha primeiro o pagamento."));
    const d = await this.check(repo, input, confirm, id, e.categoryId);
    if (!d.ok) return d;
    const before = { categoryId: e.categoryId, description: e.description, supplier: e.supplier, documentNumber: e.documentNumber, amount: e.amount, issuedOn: e.issuedOn, dueOn: e.dueOn, note: e.note };
    if (!(await repo.edit(id, d.value, [e.status === "PAID" ? "PAID" : "PENDING"], actor.id, before, this.clock.now()))) return moved();
    return ok({ saved: true as const });
  }

  async pay(repo: PrismaExpensesRepository, actor: ExpenseActor, id: string, input: PayInput): R<{ status: ExpenseStatus }> {
    if (!actor.canManage) return forbidden();
    const e = await repo.byId(id);
    if (!e) return missing();
    const p = checkPay(input, e.issuedOn, this.today());
    if (!p.ok) return p;
    const bank = p.value.bankAccountId ? (await repo.banks()).find((b) => b.id === p.value.bankAccountId) : null;
    if (p.value.bankAccountId && !bank) return fail(paymentError("INVALID_INPUT", "Escolha uma das contas do colégio."));
    if (!(await repo.pay(id, p.value, bank?.bankName ?? null, actor.id, this.clock.now()))) return moved();
    return ok({ status: "PAID" as const });
  }

  async unpay(repo: PrismaExpensesRepository, actor: ExpenseActor, id: string, rawReason: string): R<{ status: ExpenseStatus }> {
    if (!actor.canManage) return forbidden();
    const reason = checkReason(rawReason);
    if (!reason.ok) return reason;
    return (await repo.unpay(id, reason.value, actor.id, this.clock.now())) ? ok({ status: "PENDING" as const }) : moved();
  }

  async cancel(repo: PrismaExpensesRepository, actor: ExpenseActor, id: string, rawReason: string): R<{ status: ExpenseStatus }> {
    if (!actor.canManage) return forbidden();
    const reason = checkReason(rawReason);
    if (!reason.ok) return reason;
    return (await repo.cancel(id, reason.value, actor.id, this.clock.now())) ? ok({ status: "CANCELLED" as const }) : moved();
  }

  async attach(repo: PrismaExpensesRepository, files: HrFileStore, actor: ExpenseActor, id: string, file: { originalname: string; buffer: Buffer } | undefined): R<{ saved: true }> {
    if (!actor.canManage) return forbidden();
    const e = await repo.byId(id);
    if (!e) return missing();
    if (e.status === "CANCELLED") return moved();
    if (!file?.buffer?.length) return fail(paymentError("INVALID_FILE", "Junte o comprovativo (PDF, JPG ou PNG)."));
    if (file.buffer.length > PROOF_MAX_MB * MB) return fail(paymentError("INVALID_FILE", `O ficheiro tem mais de ${PROOF_MAX_MB} MB.`));
    const format = sniffFormat(file.buffer, file.originalname);
    if (!format || !PROOF_FORMATS.includes(format)) return fail(paymentError("INVALID_FILE", "Formato não aceite. Envie um PDF, JPG ou PNG."));
    if (!files.ready) return fail(paymentError("STORAGE_UNAVAILABLE", "O envio de ficheiros ainda não está disponível neste colégio."));
    const name = safeFileName(file.originalname, format);
    let key: string;
    try {
      key = (await files.save("despesas", { fileName: name, mimeType: FORMAT_MIME[format], content: file.buffer })).key;
    } catch {
      return fail(paymentError("STORAGE_UNAVAILABLE", "Não foi possível guardar o ficheiro agora. Tente de novo dentro de instantes."));
    }
    if (!(await repo.attach(id, { name, mimeType: FORMAT_MIME[format], size: file.buffer.length, sha256: sha256(file.buffer), storageKey: key }, actor.id, this.clock.now()))) {
      await files.remove(key).catch(() => undefined);
      return moved();
    }
    // o comprovativo anterior deixa de ser usado
    if (e.proofStorageKey) await files.remove(e.proofStorageKey).catch(() => undefined);
    return ok({ saved: true as const });
  }

  async proof(repo: PrismaExpensesRepository, files: HrFileStore, id: string) {
    const e = await repo.byId(id);
    if (!e?.proofStorageKey) return missing();
    return ok({ content: await files.read(e.proofStorageKey), mimeType: e.proofMimeType!, fileName: e.proofName! });
  }

  // ------------------------------------------------------------------ categorias

  async addCategories(repo: PrismaExpensesRepository, actor: ExpenseActor, raw: string[]): R<{ added: number }> {
    if (!actor.canManage) return forbidden();
    const names = [...new Map(raw.map(clean).map((n) => [n.toLowerCase(), n])).values()];
    if (!names.length || names.some((n) => n.length < 2 || n.length > 40)) return fail(paymentError("INVALID_INPUT", "O nome da categoria tem de 2 a 40 caracteres."));
    if ((await repo.categories()).length + names.length > MAX_CATEGORIES) return fail(paymentError("INVALID_INPUT", `No máximo ${MAX_CATEGORIES} categorias.`));
    const now = this.clock.now();
    await repo.addCategories(names, now);
    await repo.log("EXPENSE_CATEGORIES", "00000000-0000-0000-0000-00000000f1a2", actor.id, { names }, now);
    return ok({ added: names.length });
  }
  async renameCategory(repo: PrismaExpensesRepository, actor: ExpenseActor, id: string, raw: string): R<{ saved: true }> {
    if (!actor.canManage) return forbidden();
    const name = clean(raw);
    if (name.length < 2 || name.length > 40) return fail(paymentError("INVALID_INPUT", "O nome da categoria tem de 2 a 40 caracteres."));
    const r = await repo.renameCategory(id, name);
    if (r === "duplicate") return fail(paymentError("ACCOUNT_EXISTS", "Já existe uma categoria com este nome."));
    return r === "ok" ? ok({ saved: true as const }) : fail(paymentError("NOT_FOUND", "Categoria não encontrada."));
  }
  async removeCategory(repo: PrismaExpensesRepository, actor: ExpenseActor, id: string): R<{ result: "removed" | "archived" }> {
    if (!actor.canManage) return forbidden();
    const r = await repo.removeCategory(id, this.clock.now());
    return r === "missing" ? fail(paymentError("NOT_FOUND", "Categoria não encontrada.")) : ok({ result: r });
  }
  async restoreCategory(repo: PrismaExpensesRepository, actor: ExpenseActor, id: string): R<{ saved: true }> {
    if (!actor.canManage) return forbidden();
    return (await repo.restoreCategory(id)) ? ok({ saved: true as const }) : fail(paymentError("NOT_FOUND", "Categoria não encontrada."));
  }
}
