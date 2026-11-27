import { createHash, randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import type { Clock } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import { canAccessStudent, isAdult } from "../../family/domain/family";
import type { StaffNotify } from "../../notifications/infrastructure/notifier";
import type { HrFileStore } from "../../hr/application/employee-ports";
import { isCardCategory } from "../domain/cards";
import { checkAttachments } from "../domain/issuing";
import {
  type AttachmentItem,
  type Audience,
  canAttach,
  canDeliver,
  canDownload,
  canIssue,
  checkAnswers,
  DEPARTMENTS,
  type DocumentsError,
  documentsError,
  dueOn,
  type ExtraField,
  FEE_POLICIES,
  feeSettled,
  METHODS,
  OPEN_STATUSES,
  releaseAllowed,
  type RequestStatus,
  requesterCanCancel,
  requestNumber,
  type Snapshot,
  type StaffAction,
  staffTransition,
  STATUS_LABELS,
} from "../domain/documents";
import type { Actor, AttachmentRow, Beneficiary, IssuedRow, ListFilter, PrismaDocumentsRepository, RequestRow, TypeRow } from "../infrastructure/prisma-documents";
import { audiencesFor, can, type DocumentsViewer } from "./DocumentTypes";

type R<T> = Promise<Result<T, DocumentsError>>;
type Repo = PrismaDocumentsRepository;
export const today = (now: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Luanda" }).format(now);
const clean = (v: unknown, max: number) =>
  String(v ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
const notFound = () => fail(documentsError("NOT_FOUND", "Pedido não encontrado."));
const kz = (n: number) => `${n.toLocaleString("pt-PT")} Kz`;

/** Avisos à família (uma conta de cada vez) — a implementação grava na área da família. */
export interface FamilyNotify {
  notify(accountId: string, n: { kind: string; title: string; body?: string | null; link?: string | null; studentId?: string | null }): Promise<void>;
}
export interface Notices {
  staff: StaffNotify;
  family: FamilyNotify;
}
type UploadFile = { originalname: string; mimetype: string; buffer: Buffer };
/** Os documentos que quem pede junta ao pedido (um ficheiro por documento pedido pelo tipo). */
/** Quem junta ou abre um documento do pedido. */
export type Who = { kind: "FAMILY"; accountId: string } | { kind: "EMPLOYEE"; userId: string; name: string } | { kind: "STAFF"; viewer: DocumentsViewer };
export interface Uploads {
  store: HrFileStore;
  files: { itemKey: string; file: UploadFile }[];
}

/** Quem levanta: o próprio, o encarregado (só para alunos) ou uma pessoa autorizada (com documento de identificação). */
export const RECEIVER_RELATIONSHIPS = { SELF: "O próprio", GUARDIAN: "Encarregado de educação", AUTHORIZED: "Pessoa autorizada" } as const;
export type ReceiverRelationship = keyof typeof RECEIVER_RELATIONSHIPS;

/** O estado do pedido para a máquina de estados (com o ficheiro emitido e a taxa). */
export const snapshotOf = (r: RequestRow, file: IssuedRow | null): Snapshot => ({
  status: r.status,
  requiresApproval: r.requiresApproval,
  pickup: r.pickup,
  download: r.download,
  method: r.method,
  hasFile: !!file,
  fee: r.fee,
  feePolicy: r.feePolicy,
  chargeStatus: r.chargeStatus,
});

/**
 * PEDIDOS DE DOCUMENTOS — da família (o aluno maior ou o encarregado de um menor), do funcionário (os
 * seus) e da equipa (ao balcão, em nome de alguém). A máquina de estados está em domain/documents;
 * aqui confirma-se quem pode o quê, cria-se a cobrança da taxa, guarda-se o histórico e avisa-se.
 */
export class DocumentRequests {
  private readonly logger = new Logger("DocumentRequests");
  constructor(private readonly clock: Clock) {}

  ref = (r: { year: number; number: number }) => requestNumber(r.year, r.number);
  private staffLink = (r: { id: string; audience: Audience }) => `${r.audience === "EMPLOYEE" ? "/rh/documentos" : "/documentos/pedidos"}/${r.id}`;
  async quietly(what: string, fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (e) {
      this.logger.warn(`${what}: aviso falhou (${(e as Error).message})`);
    }
  }

  /** A taxa do pedido, para quem pede e para a equipa. */
  private feeView(r: RequestRow) {
    if (!r.fee) return null;
    const settled = feeSettled(r);
    return {
      amount: r.fee,
      policy: r.feePolicy ?? "BEFORE",
      policyLabel: FEE_POLICIES[r.feePolicy ?? "BEFORE"].label,
      status: r.chargeStatus,
      statusLabel: r.chargeStatus === "PAID" ? "Paga" : r.chargeStatus === "WAIVED" ? "Isenta" : r.chargeStatus === "VOID" ? "Anulada" : r.chargeInValidation ? "Pagamento em validação" : "Por pagar",
      settled,
      inValidation: r.chargeInValidation,
      chargeId: r.chargeId,
    };
  }

  /** O pedido tal como a família ou o funcionário o vê (sem as notas internas). */
  /** Os documentos juntos: por documento pedido, o ficheiro mais recente (os anteriores ficam no histórico). */
  attachmentsView(r: RequestRow, items: AttachmentItem[], rows: AttachmentRow[]) {
    const view = (a: AttachmentRow) => ({ id: a.id, itemKey: a.itemKey, label: a.label, name: a.fileName, size: a.size, mimeType: a.mimeType, by: a.uploadedByName, byKind: a.uploadedByKind, at: a.createdAt.toISOString() });
    const known = items.map((i) => ({ ...i, file: rows.find((a) => a.itemKey === i.key) ? view(rows.find((a) => a.itemKey === i.key)!) : null }));
    // ficheiros de documentos que o tipo já não pede (o tipo mudou depois do pedido)
    const others = rows.filter((a) => !items.some((i) => i.key === a.itemKey) && rows.find((x) => x.itemKey === a.itemKey) === a).map((a) => ({ key: a.itemKey, label: a.label, required: false, hint: null, file: view(a) }));
    return { attachmentItems: [...known, ...others], attachmentsCount: rows.length, canAttach: canAttach(r.status) && items.length > 0 };
  }

  private publicView(r: RequestRow, events: Awaited<ReturnType<Repo["events"]>>, delivery: Awaited<ReturnType<Repo["delivery"]>>, type: TypeRow | null, file: IssuedRow | null, attachments: AttachmentRow[]) {
    const fields: ExtraField[] = type?.fields ?? [];
    const snap = snapshotOf(r, file);
    return {
      ...this.attachmentsView(r, type?.attachments ?? [], attachments),
      id: r.id,
      reference: this.ref(r),
      typeName: r.typeName,
      category: r.category,
      audience: r.audience,
      departmentLabel: DEPARTMENTS[r.department],
      methodLabel: METHODS[r.method].label,
      pickup: r.pickup,
      download: r.download,
      fee: r.fee,
      feeInfo: this.feeView(r),
      beneficiary: r.beneficiary,
      studentId: r.studentId,
      requesterName: r.requesterName,
      relationship: r.relationship,
      answers: r.answers,
      /** as respostas com o nome de cada campo, pela ordem dos campos do documento */
      answerList: [
        ...fields.filter((f) => r.answers[f.key]).map((f) => ({ key: f.key, label: f.label, value: r.answers[f.key] })),
        ...Object.entries(r.answers)
          .filter(([key]) => !fields.some((f) => f.key === key))
          .map(([key, value]) => ({ key, label: key, value })),
      ],
      notes: r.notes,
      status: r.status,
      statusLabel: STATUS_LABELS[r.status],
      revision: r.revision,
      dueOn: r.dueOn,
      rejectReason: r.rejectReason,
      cancelReason: r.cancelReason,
      createdAt: r.createdAt.toISOString(),
      completedAt: r.completedAt?.toISOString() ?? null,
      canCancel: requesterCanCancel(r.status) && !r.chargeInValidation,
      /** o ficheiro que quem pediu pode descarregar (quando pode) */
      file: canDownload(snap) && file ? { version: file.version, name: file.fileName, size: file.size, mimeType: file.mimeType } : null,
      waitingPayment: !!r.fee && !releaseAllowed(r) && (r.status === "READY_PICKUP" || r.status === "READY_DOWNLOAD"),
      delivery: delivery && { receivedBy: delivery.receivedBy, relationshipLabel: RECEIVER_RELATIONSHIPS[delivery.relationship as ReceiverRelationship] ?? delivery.relationship, at: delivery.deliveredAt.toISOString() },
      history: events.filter((e) => !e.internal).map((e) => ({ kind: e.kind, from: e.fromStatus, to: e.toStatus, toLabel: e.toStatus ? STATUS_LABELS[e.toStatus] : null, note: e.note, by: e.actorKind === "STAFF" ? "Colégio" : e.actorKind === "SYSTEM" ? "Sistema" : e.actorName, at: e.at.toISOString() })),
    };
  }
  private listItem(r: RequestRow) {
    return {
      id: r.id,
      reference: this.ref(r),
      typeName: r.typeName,
      category: r.category,
      audience: r.audience,
      department: r.department,
      departmentLabel: DEPARTMENTS[r.department],
      beneficiary: r.beneficiary,
      requesterName: r.requesterName,
      relationship: r.relationship,
      status: r.status,
      statusLabel: STATUS_LABELS[r.status],
      fee: r.fee,
      feeStatusLabel: this.feeView(r)?.statusLabel ?? null,
      pickup: r.pickup,
      download: r.download,
      dueOn: r.dueOn,
      overdue: !!r.dueOn && OPEN_STATUSES.includes(r.status) && r.status !== "READY_PICKUP" && r.status !== "READY_DOWNLOAD" && r.dueOn < today(this.clock.now()),
      createdAt: r.createdAt.toISOString(),
      canCancel: requesterCanCancel(r.status) && !r.chargeInValidation,
    };
  }

  // ================================================================ avisos

  /** Avisa quem pediu (a família do aluno, ou o funcionário) de uma mudança no pedido. */
  async tellRequester(repo: Repo, notices: Notices, r: RequestRow, title: string, body: string | null, link?: string) {
    const t = `${r.typeName}: ${title}`;
    if (r.audience === "STUDENT" && r.studentId) {
      const accounts = await repo.familyRecipients(r.studentId, today(this.clock.now()));
      for (const a of accounts) await notices.family.notify(a.accountId, { kind: "DOCUMENT_STATUS", title: `${t} · ${r.beneficiary.name.split(" ")[0]}`, body: `${this.ref(r)}${body ? `. ${body}` : ""}`, link: link ?? `/familia/documentos/${r.id}`, studentId: r.studentId });
    } else if (r.employeeId) {
      await notices.staff.notify({ kind: "MY_DOCUMENTS", employeeIds: [r.employeeId], title: t, body: `${this.ref(r)}${body ? `. ${body}` : ""}`, link: `/os-meus-documentos/${r.id}`, dedupeKey: `doc:${r.id}:${r.revision}:${r.status}:${title}` });
    }
  }
  /** Avisa quem trata os pedidos deste público (secretaria ou RH). */
  async tellStaff(repo: Repo, notices: Notices, r: RequestRow, title: string, body: string | null, key: string) {
    const perms = r.audience === "EMPLOYEE" ? ["hr.doc_requests.process"] : ["documents.requests.process"];
    const users = await repo.usersWithAny(perms);
    if (users.length) await notices.staff.notify({ kind: "DOCUMENT_REQUESTS", userIds: users.map((u) => u.id), title, body, link: this.staffLink(r), dedupeKey: `doc:${r.id}:${key}` });
  }
  private async afterCreate(repo: Repo, notices: Notices, id: string, byStaff: boolean) {
    const r = await repo.request(id);
    if (!r) return;
    await this.quietly("pedido novo", async () => {
      if (!byStaff) await this.tellStaff(repo, notices, r, `Pedido de documento: ${r.typeName}`, `${this.ref(r)} · ${r.beneficiary.name}${r.beneficiary.kind === "STUDENT" && r.beneficiary.classLabel ? ` · ${r.beneficiary.classLabel}${r.beneficiary.groupName ? ` turma ${r.beneficiary.groupName}` : ""}` : ""}`, "new");
      const fee = r.fee ? ` Taxa: ${kz(r.fee)} (em Pagamentos).` : "";
      await this.tellRequester(repo, notices, r, "pedido recebido", `${r.dueOn ? `Prazo previsto: ${r.dueOn.split("-").reverse().join("/")}.` : ""}${fee}`.trim() || null);
    });
  }

  // ================================================================ taxas: o pagamento confirmado faz avançar o pedido

  /**
   * Os pedidos à espera do pagamento cuja cobrança as Finanças já deram como paga (ou isentaram)
   * passam a "Em processamento". Corre depois de validar um pagamento ou isentar uma cobrança, e ao
   * abrir os pedidos (se alguma coisa escapou).
   */
  async syncPayments(repo: Repo, notices: Notices) {
    const ids = await repo.paidWhileWaiting();
    let moved = 0;
    for (const { id } of ids) {
      const r = await repo.request(id);
      if (!r || r.status !== "AWAITING_PAYMENT") continue;
      const now = this.clock.now();
      const done = await repo.transaction(async (tx) => {
        if (!(await tx.move(r.id, "AWAITING_PAYMENT", "PROCESSING", r.revision, {}, now))) return false;
        await tx.event(r.id, { kind: "PAYMENT", from: "AWAITING_PAYMENT", to: "PROCESSING", note: r.chargeStatus === "WAIVED" ? "Taxa isentada pelas Finanças" : "Pagamento confirmado pelas Finanças", internal: false }, { kind: "SYSTEM", id: null, name: "Sistema" }, now);
        return true;
      });
      if (!done) continue;
      moved++;
      const fresh = (await repo.request(id))!;
      await this.quietly("pagamento confirmado", async () => {
        await this.tellRequester(repo, notices, fresh, "pagamento confirmado", "O documento vai ser preparado.");
        await this.tellStaff(repo, notices, fresh, `Pagamento confirmado: ${fresh.typeName}`, `${this.ref(fresh)} · ${fresh.beneficiary.name}: pode preparar o documento.`, `paid`);
      });
    }
    return moved;
  }

  /** Cancelar ou rejeitar com taxa: a cobrança por pagar anula-se; com um pagamento em validação, espera-se. */
  private feeBlocksClosing(r: RequestRow) {
    return r.chargeInValidation ? "Há um pagamento desta taxa à espera das Finanças: aguarde a decisão antes de cancelar ou rejeitar." : null;
  }
  private feeClosingNote(r: RequestRow) {
    return r.chargeStatus === "PAID" ? " A taxa já estava paga: o reembolso trata-se com as Finanças." : "";
  }

  // ================================================================ criar (comum)

  private async create(repo: Repo, notices: Notices, input: { type: TypeRow; beneficiary: Beneficiary; studentId: string | null; employeeId: string | null; requester: { kind: "FAMILY" | "EMPLOYEE" | "STAFF"; accountId: string | null; userId: string | null; name: string; relationship: "SELF" | "GUARDIAN" | "STAFF" }; answers: Record<string, unknown> | null | undefined; notes: string | null | undefined; uploads?: Uploads | null }, actor: Actor): R<{ id: string; reference: string }> {
    const t = input.type;
    if (!t.active) return fail(documentsError("NOT_AVAILABLE", "Este documento já não se pode pedir."));
    const a = checkAnswers(t.fields, input.answers);
    if (!a.ok) return fail(documentsError("INVALID_INPUT", a.message));
    // os documentos a juntar (ao balcão o colégio vê-os em papel: os obrigatórios não se exigem)
    const att = checkAttachments(t.attachments ?? [], input.uploads?.files ?? [], input.requester.kind !== "STAFF");
    if (!att.ok) return fail(documentsError("INVALID_INPUT", att.message));
    if (att.files.length && !input.uploads?.store.ready) return fail(documentsError("NOT_AVAILABLE", "O armazenamento de ficheiros deste colégio ainda não está configurado: fale com a EduFlow."));
    const notes = clean(input.notes, 600) || null;
    const now = this.clock.now();
    const day = today(now);
    // o mesmo documento, para o mesmo beneficiário, ainda em curso: não se pede duas vezes
    const open = await repo.list({ audiences: [t.audience], status: "OPEN", typeId: t.id, studentIds: input.studentId ? [input.studentId] : null, employeeId: input.employeeId, page: 1, pageSize: 1 });
    if (open.rows[0]) return fail(documentsError("INVALID_STATE", `Já há um pedido deste documento em curso (${this.ref(open.rows[0])}).`, { requestId: open.rows[0].id }));
    // a taxa: uma cobrança nas Finanças (no ano letivo do aluno)
    const year = t.fee && input.studentId ? await repo.chargeYear(input.studentId, day) : null;
    if (t.fee && !year) return fail(documentsError("NOT_AVAILABLE", "O colégio ainda não tem ano letivo: este documento (com taxa) não se pode pedir por agora."));
    const due = dueOn(day, t.slaDays);
    const chargeId = t.fee ? randomUUID() : null;
    const id = randomUUID();
    // os ficheiros guardam-se (cifrados) só depois de tudo validado
    const stored: { itemKey: string; label: string; fileName: string; mimeType: string; size: number; sha256: string; storageKey: string }[] = [];
    for (const f of att.files) {
      const saved = await input.uploads!.store.save(`documents/${id}/anexos`, { fileName: f.name, mimeType: f.mime, content: f.content });
      stored.push({ itemKey: f.item.key, label: f.item.label, fileName: f.name, mimeType: f.mime, size: f.content.length, sha256: createHash("sha256").update(f.content).digest("hex"), storageKey: saved.key });
    }
    const { number } = await repo.transaction(async (tx) => {
      if (chargeId && year && input.studentId) await tx.createCharge({ id: chargeId, label: `Documento: ${t.name}`, amount: t.fee!, yearId: year.yearId, enrollmentId: year.enrollmentId, studentId: input.studentId, dueOn: day }, now);
      const created = await tx.createRequest(
        {
          year: Number(day.slice(0, 4)),
          typeId: t.id,
          typeName: t.name,
          category: t.category,
          audience: t.audience,
          department: t.department,
          method: t.method,
          pickup: t.pickup,
          download: t.download,
          requiresApproval: t.requiresApproval,
          fee: t.fee,
          feePolicy: t.fee ? t.feePolicy : null,
          chargeId,
          studentId: input.studentId,
          employeeId: input.employeeId,
          beneficiary: input.beneficiary,
          requesterKind: input.requester.kind,
          requesterAccountId: input.requester.accountId,
          requesterUserId: input.requester.userId,
          requesterName: input.requester.name,
          relationship: input.requester.relationship,
          answers: a.answers,
          notes,
          dueOn: due,
        },
        actor,
        now,
        id,
      );
      if (chargeId) await tx.renameCharge(chargeId, `Documento: ${t.name} (${requestNumber(Number(day.slice(0, 4)), created.number)})`, now);
      for (const s of stored) await tx.addAttachment(id, s, actor, now);
      return created;
    });
    await this.afterCreate(repo, notices, id, input.requester.kind === "STAFF");
    return ok({ id, reference: requestNumber(Number(day.slice(0, 4)), number) });
  }

  // ================================================================ família

  /** Os alunos que a conta pode representar (o próprio, ou os menores que gere), já verificado aqui. */
  async familyStudentIds(repo: Repo, accountId: string) {
    const day = today(this.clock.now());
    return (await repo.familyStudents(accountId)).filter((s) => canAccessStudent({ self: s.self, managingGuardian: s.managing }, s.birthDate, day)).map((s) => s.id);
  }

  /** O catálogo: os documentos que se podem pedir, para cada aluno da conta. */
  async familyCatalog(repo: Repo, accountId: string) {
    const ids = await this.familyStudentIds(repo, accountId);
    const [types, students] = await Promise.all([repo.types(["STUDENT"], true), Promise.all(ids.map(async (id) => ({ id, ...(await repo.studentSnapshot(id))! })))]);
    return { students, types: types.map((t) => this.catalogType(t)) };
  }
  private catalogType(t: TypeRow) {
    return { id: t.id, name: t.name, category: t.category, description: t.description, requirements: t.requirements, methodLabel: METHODS[t.method].label, pickup: t.pickup, download: t.download, fee: t.fee, feePolicyLabel: t.fee ? FEE_POLICIES[t.feePolicy].hint : null, slaDays: t.slaDays, requiresApproval: t.requiresApproval, fields: t.fields, attachments: t.attachments ?? [], departmentLabel: DEPARTMENTS[t.department] };
  }

  async familyCreate(repo: Repo, notices: Notices, accountId: string, body: { studentId: string; typeId: string; answers?: Record<string, unknown> | null; notes?: string | null }, uploads?: Uploads | null): R<{ id: string; reference: string }> {
    const link = await repo.familyLink(accountId, body.studentId);
    // o aluno tem de ser da conta: o próprio (maior) ou um menor que o encarregado gere
    if (!link || !canAccessStudent({ self: link.self, managingGuardian: link.managing }, link.birthDate, today(this.clock.now()))) return fail(documentsError("NOT_FOUND", "Aluno não encontrado."));
    const type = await repo.type(body.typeId);
    if (!type || type.audience !== "STUDENT") return fail(documentsError("NOT_FOUND", "Documento não encontrado."));
    const beneficiary = await repo.studentSnapshot(body.studentId);
    if (!beneficiary) return fail(documentsError("NOT_FOUND", "Aluno não encontrado."));
    const name = await repo.familyName(accountId);
    return this.create(
      repo,
      notices,
      { type, beneficiary, studentId: body.studentId, employeeId: null, requester: { kind: "FAMILY", accountId, userId: null, name, relationship: link.self ? "SELF" : "GUARDIAN" }, answers: body.answers, notes: body.notes, uploads },
      { kind: "FAMILY", id: accountId, name },
    );
  }

  async familyList(repo: Repo, notices: Notices, accountId: string, f: { studentId?: string; status?: RequestStatus | "OPEN"; q?: string; page?: number }) {
    await this.syncPayments(repo, notices);
    const ids = await this.familyStudentIds(repo, accountId);
    const students = f.studentId ? ids.filter((i) => i === f.studentId) : ids;
    const filter: ListFilter = { audiences: ["STUDENT"], studentIds: students, status: f.status ?? null, q: f.q?.trim() || null, page: f.page ?? 1, pageSize: 30 };
    const [list, counts] = await Promise.all([repo.list(filter), repo.statusCounts(filter)]);
    return { total: list.total, page: filter.page, pageSize: filter.pageSize, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])), items: list.rows.map((r) => this.listItem(r)) };
  }

  async familyOwned(repo: Repo, accountId: string, id: string) {
    const r = await repo.request(id);
    if (!r || !r.studentId) return null;
    return (await this.familyStudentIds(repo, accountId)).includes(r.studentId) ? r : null;
  }
  async familyDetail(repo: Repo, notices: Notices, accountId: string, id: string) {
    await this.syncPayments(repo, notices);
    const r = await this.familyOwned(repo, accountId, id);
    if (!r) return notFound();
    const [events, delivery, type, file, attachments] = await Promise.all([repo.events(id), repo.delivery(id), repo.type(r.typeId), repo.activeIssued(id), repo.attachments(id)]);
    return ok(this.publicView(r, events, delivery, type, file, attachments));
  }
  async familyCancel(repo: Repo, notices: Notices, accountId: string, id: string, reason: string | null): R<{ status: RequestStatus }> {
    const r = await this.familyOwned(repo, accountId, id);
    if (!r) return notFound();
    return this.requesterCancel(repo, notices, r, reason, { kind: "FAMILY", id: accountId, name: await repo.familyName(accountId) });
  }

  private async requesterCancel(repo: Repo, notices: Notices, r: RequestRow, reason: string | null, actor: Actor): R<{ status: RequestStatus }> {
    if (!requesterCanCancel(r.status)) return fail(documentsError("INVALID_STATE", `Já não se pode cancelar: o pedido está “${STATUS_LABELS[r.status]}”. Fale com o colégio.`));
    const blocked = this.feeBlocksClosing(r);
    if (blocked) return fail(documentsError("INVALID_STATE", blocked));
    const why = clean(reason, 300) || null;
    const now = this.clock.now();
    const done = await repo.transaction(async (tx) => {
      if (!(await tx.move(r.id, r.status, "CANCELLED", r.revision, { cancelReason: why }, now))) return false;
      if (r.chargeId) await tx.voidCharge(r.chargeId, now);
      await tx.event(r.id, { kind: "STATUS", from: r.status, to: "CANCELLED", note: `${why ?? ""}${this.feeClosingNote(r)}`.trim() || null, internal: false }, actor, now);
      return true;
    });
    if (!done) return fail(documentsError("CHANGED", "O pedido mudou entretanto: atualize a página."));
    await this.quietly("cancelado pelo requerente", () => this.tellStaff(repo, notices, r, `Pedido cancelado: ${r.typeName}`, `${this.ref(r)} · ${r.beneficiary.name}${why ? ` · ${why}` : ""}`, "cancel"));
    return ok({ status: "CANCELLED" as RequestStatus });
  }

  // ================================================================ o funcionário (os seus pedidos)

  async me(repo: Repo, userId: string) {
    const e = await repo.employeeOfUser(userId);
    return e && ["APPROVED", "ACTIVE", "SUSPENDED"].includes(e.status) ? e : null;
  }
  async mineCatalog(repo: Repo, userId: string) {
    const e = await this.me(repo, userId);
    if (!e) return ok({ employee: null, types: [] });
    const [types, snap] = await Promise.all([repo.types(["EMPLOYEE"], true), repo.employeeSnapshot(e.id)]);
    return ok({ employee: snap && { id: e.id, name: snap.name, number: snap.number, jobTitle: snap.jobTitle, department: snap.department }, types: types.map((t) => this.catalogType(t)) });
  }
  async mineCreate(repo: Repo, notices: Notices, v: DocumentsViewer, body: { typeId: string; answers?: Record<string, unknown> | null; notes?: string | null }, uploads?: Uploads | null): R<{ id: string; reference: string }> {
    const e = await this.me(repo, v.userId);
    if (!e) return fail(documentsError("FORBIDDEN", "Só os funcionários com a ficha no RH podem pedir documentos profissionais."));
    const type = await repo.type(body.typeId);
    if (!type || type.audience !== "EMPLOYEE") return fail(documentsError("NOT_FOUND", "Documento não encontrado."));
    const snap = await repo.employeeSnapshot(e.id);
    if (!snap) return fail(documentsError("NOT_FOUND", "Funcionário não encontrado."));
    const { status: _s, userId: _u, ...beneficiary } = snap;
    return this.create(repo, notices, { type, beneficiary, studentId: null, employeeId: e.id, requester: { kind: "EMPLOYEE", accountId: null, userId: v.userId, name: snap.name, relationship: "SELF" }, answers: body.answers, notes: body.notes, uploads }, { kind: "EMPLOYEE", id: v.userId, name: snap.name });
  }
  async mineList(repo: Repo, userId: string, f: { status?: RequestStatus | "OPEN"; q?: string; page?: number }) {
    const e = await repo.employeeOfUser(userId);
    if (!e) return { total: 0, page: 1, pageSize: 30, counts: {}, items: [] };
    const filter: ListFilter = { audiences: ["EMPLOYEE"], employeeId: e.id, status: f.status ?? null, q: f.q?.trim() || null, page: f.page ?? 1, pageSize: 30 };
    const [list, counts] = await Promise.all([repo.list(filter), repo.statusCounts(filter)]);
    return { total: list.total, page: filter.page, pageSize: filter.pageSize, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])), items: list.rows.map((r) => this.listItem(r)) };
  }
  async mineOwned(repo: Repo, userId: string, id: string) {
    const [e, r] = await Promise.all([repo.employeeOfUser(userId), repo.request(id)]);
    return e && r && r.employeeId === e.id ? r : null;
  }
  async mineDetail(repo: Repo, userId: string, id: string) {
    const r = await this.mineOwned(repo, userId, id);
    if (!r) return notFound();
    const [events, delivery, type, file, attachments] = await Promise.all([repo.events(id), repo.delivery(id), repo.type(r.typeId), repo.activeIssued(id), repo.attachments(id)]);
    return ok(this.publicView(r, events, delivery, type, file, attachments));
  }
  async mineCancel(repo: Repo, notices: Notices, v: DocumentsViewer, id: string, reason: string | null): R<{ status: RequestStatus }> {
    const r = await this.mineOwned(repo, v.userId, id);
    if (!r) return notFound();
    return this.requesterCancel(repo, notices, r, reason, { kind: "EMPLOYEE", id: v.userId, name: v.name });
  }

  // ================================================================ a equipa (secretaria e RH)

  actor(v: DocumentsViewer): Actor {
    return { kind: "STAFF", id: v.support ? null : v.userId, name: v.support ? "Suporte EduFlow" : v.name };
  }
  async staffList(repo: Repo, notices: Notices, v: DocumentsViewer, f: Omit<ListFilter, "audiences" | "pageSize"> & { audience?: Audience | null }) {
    await this.syncPayments(repo, notices);
    const allowed = audiencesFor(v, "view");
    const audiences = f.audience ? allowed.filter((a) => a === f.audience) : allowed;
    const filter: ListFilter = { ...f, audiences, page: f.page || 1, pageSize: 30 };
    const [list, counts, types] = await Promise.all([repo.list(filter), repo.statusCounts(filter), repo.types(audiences)]);
    return {
      audiences: allowed,
      total: list.total,
      page: filter.page,
      pageSize: filter.pageSize,
      statuses: (Object.keys(STATUS_LABELS) as RequestStatus[]).map((s) => ({ key: s, label: STATUS_LABELS[s], count: counts.find((c) => c.status === s)?.n ?? 0 })),
      types: types.map((t) => ({ id: t.id, name: t.name, audience: t.audience })),
      items: list.rows.map((r) => this.listItem(r)),
    };
  }

  async staffDetail(repo: Repo, notices: Notices, v: DocumentsViewer, id: string) {
    await this.syncPayments(repo, notices);
    const r = await repo.request(id);
    if (!r || !can(v, r.audience, "view")) return notFound();
    const [events, delivery, type, files, attachments] = await Promise.all([repo.events(id), repo.delivery(id), repo.type(r.typeId), repo.issued(id), repo.attachments(id)]);
    const file = files.find((f) => f.status === "ACTIVE") ?? null;
    const base = this.publicView(r, events, delivery, type, file, attachments);
    const snap = snapshotOf(r, file);
    const adult = r.beneficiary.kind === "STUDENT" ? isAdult(r.beneficiary.birthDate, today(this.clock.now())) : true;
    const process = can(v, r.audience, "process");
    const act = (a: StaffAction) => process && staffTransition(snap, a).ok;
    return ok({
      ...base,
      method: r.method,
      requesterKind: r.requesterKind,
      handledByName: r.handledByName,
      fields: type?.fields ?? [],
      adult,
      templateVersion: type?.templateVersion ?? null,
      /** um cartão de estudante: emite-se com o modelo do cartão (Documentos › Cartões de estudante) */
      isCard: isCardCategory(r.category),
      files: files.map((f) => ({ id: f.id, version: f.version, method: f.method, methodLabel: f.method === "AUTO" ? (isCardCategory(r.category) ? "Cartão gerado" : "Gerado com o modelo") : "Carregado", templateVersion: f.templateVersion, name: f.fileName, size: f.size, mimeType: f.mimeType, status: f.status, reason: f.reason, by: f.createdByName, at: f.createdAt.toISOString() })),
      receiverOptions: (Object.keys(RECEIVER_RELATIONSHIPS) as ReceiverRelationship[])
        .filter((k) => (r.audience === "EMPLOYEE" ? k !== "GUARDIAN" : adult ? k !== "GUARDIAN" : k !== "SELF"))
        .map((k) => ({ key: k, label: RECEIVER_RELATIONSHIPS[k] })),
      delivery: delivery && { ...base.delivery!, receivedByDocument: delivery.receivedByDocument, deliveredBy: delivery.deliveredByName, notes: delivery.notes },
      history: events.map((e) => ({ kind: e.kind, from: e.fromStatus, to: e.toStatus, toLabel: e.toStatus ? STATUS_LABELS[e.toStatus] : null, note: e.note, internal: e.internal, by: e.actorName, actorKind: e.actorKind, at: e.at.toISOString() })),
      can: {
        review: act("review"),
        process: act("process"),
        readyPickup: act("ready_pickup"),
        readyDownload: act("ready_download"),
        reject: act("reject") && !r.chargeInValidation,
        cancel: act("cancel") && !r.chargeInValidation,
        deliver: can(v, r.audience, "deliver") && canDeliver(r.status) && releaseAllowed(r),
        note: process || can(v, r.audience, "deliver"),
        // emitir com o modelo (só documentos automáticos com modelo) ou carregar o ficheiro preparado fora
        generate: process && canIssue(r.status) && r.method === "AUTO" && (!!type?.templateVersion || isCardCategory(r.category)),
        upload: process && canIssue(r.status),
        // o balcão junta os documentos que a pessoa trouxe em papel
        attach: process && canAttach(r.status) && (type?.attachments.length ?? 0) > 0,
      },
      deliverBlocked: canDeliver(r.status) && !releaseAllowed(r) ? "A taxa ainda não foi paga: só se entrega depois de as Finanças confirmarem o pagamento." : null,
    });
  }

  /** Uma transição pela equipa (com a revisão que estava a ver: duas pessoas não se pisam). */
  async staffMove(repo: Repo, notices: Notices, v: DocumentsViewer, id: string, action: StaffAction, input: { revision: number; reason?: string | null; note?: string | null; notify?: boolean }): R<{ status: RequestStatus }> {
    const r = await repo.request(id);
    if (!r || !can(v, r.audience, "view")) return notFound();
    if (!can(v, r.audience, "process")) return fail(documentsError("FORBIDDEN", r.audience === "EMPLOYEE" ? "Tratar os pedidos dos funcionários exige a permissão do RH." : "Tratar os pedidos exige a permissão “Tratar os pedidos de documentos”."));
    const t = staffTransition(snapshotOf(r, await repo.activeIssued(id)), action);
    if (!t.ok) return fail(documentsError("INVALID_STATE", t.message));
    const reason = clean(input.reason, 300);
    const closing = action === "reject" || action === "cancel";
    if (closing && reason.length < 3) return fail(documentsError("INVALID_INPUT", action === "reject" ? "Indique o motivo da rejeição (3 a 300 caracteres): a família ou o funcionário vê-o." : "Indique o motivo do cancelamento (3 a 300 caracteres)."));
    if (closing) {
      const blocked = this.feeBlocksClosing(r);
      if (blocked) return fail(documentsError("INVALID_STATE", blocked));
    }
    const note = clean(input.note, 600) || null;
    const now = this.clock.now();
    const actor = this.actor(v);
    const done = await repo.transaction(async (tx) => {
      const set = action === "reject" ? { rejectReason: reason, handled: actor } : action === "cancel" ? { cancelReason: reason, handled: actor } : { handled: actor };
      if (!(await tx.move(r.id, r.status, t.to, input.revision, set, now))) return false;
      if (closing && r.chargeId) await tx.voidCharge(r.chargeId, now);
      await tx.event(r.id, { kind: "STATUS", from: r.status, to: t.to, note: closing ? `${reason}${this.feeClosingNote(r)}` : note, internal: false }, actor, now);
      return true;
    });
    if (!done) return fail(documentsError("CHANGED", "O pedido mudou entretanto: atualize a página."));
    const fresh = (await repo.request(id))!;
    const where = fresh.audience === "EMPLOYEE" ? "nos Recursos Humanos" : "na secretaria";
    const say: Partial<Record<RequestStatus, [string, string | null, string?]>> = {
      IN_REVIEW: ["pedido em análise", null],
      AWAITING_PAYMENT: ["aguarda o pagamento", `Taxa de ${kz(fresh.fee ?? 0)}: pague em Pagamentos. O documento prepara-se depois de as Finanças confirmarem o pagamento.`, `/familia/pagamentos?aluno=${fresh.studentId}&servico=documento`],
      PROCESSING: ["documento em preparação", null],
      READY_PICKUP: ["pronto a levantar", `Pode levantar ${where}.${note ? ` ${note}` : ""}${fresh.fee && !releaseAllowed(fresh) ? ` Antes, pague a taxa de ${kz(fresh.fee)}.` : ""}`],
      READY_DOWNLOAD: ["disponível para descarregar", `${note ? `${note} ` : ""}Descarregue-o na plataforma.${fresh.fee && !releaseAllowed(fresh) ? ` Antes, pague a taxa de ${kz(fresh.fee)}.` : ""}`],
      REJECTED: ["pedido rejeitado", `Motivo: ${reason}`],
      CANCELLED: ["pedido cancelado pelo colégio", `Motivo: ${reason}`],
    };
    const msg = say[t.to];
    // "em preparação" só se a equipa quiser avisar; os outros passos avisam sempre
    if (msg && (t.to !== "PROCESSING" || input.notify)) await this.quietly(`passo ${t.to}`, () => this.tellRequester(repo, notices, fresh, msg[0], msg[1], msg[2]));
    return ok({ status: t.to });
  }

  /** Uma nota no pedido: interna (só a equipa) ou para quem pediu. */
  async staffNote(repo: Repo, notices: Notices, v: DocumentsViewer, id: string, input: { note: string; internal: boolean }): R<{ saved: true }> {
    const r = await repo.request(id);
    if (!r || !can(v, r.audience, "view")) return notFound();
    if (!can(v, r.audience, "process") && !can(v, r.audience, "deliver")) return fail(documentsError("FORBIDDEN", "Não tem permissão para tratar este pedido."));
    const note = clean(input.note, 600);
    if (note.length < 2) return fail(documentsError("INVALID_INPUT", "Escreva a nota."));
    await repo.event(id, { kind: "NOTE", from: null, to: null, note, internal: !!input.internal }, this.actor(v), this.clock.now());
    if (!input.internal) await this.quietly("nota", () => this.tellRequester(repo, notices, r, "mensagem do colégio", note));
    return ok({ saved: true as const });
  }

  /** A entrega física: quem recebeu (obrigatório), a relação com o beneficiário e quem entregou. */
  async staffDeliver(repo: Repo, notices: Notices, v: DocumentsViewer, id: string, input: { revision: number; receivedBy?: string | null; receivedByDocument?: string | null; relationship: string; notes?: string | null }): R<{ status: RequestStatus }> {
    const r = await repo.request(id);
    if (!r || !can(v, r.audience, "view")) return notFound();
    if (!can(v, r.audience, "deliver")) return fail(documentsError("FORBIDDEN", "Confirmar entregas exige a permissão de entregar documentos."));
    if (!canDeliver(r.status)) return fail(documentsError("INVALID_STATE", `Só se entrega um documento disponível para levantamento (este está “${STATUS_LABELS[r.status]}”).`));
    if (!releaseAllowed(r)) return fail(documentsError("INVALID_STATE", "A taxa ainda não foi paga: só se entrega depois de as Finanças confirmarem o pagamento."));
    const rel = input.relationship as ReceiverRelationship;
    const adult = r.beneficiary.kind === "STUDENT" ? isAdult(r.beneficiary.birthDate, today(this.clock.now())) : true;
    if (!(rel in RECEIVER_RELATIONSHIPS)) return fail(documentsError("INVALID_INPUT", "Indique quem levanta: o próprio, o encarregado ou uma pessoa autorizada."));
    if (r.audience === "EMPLOYEE" && rel === "GUARDIAN") return fail(documentsError("INVALID_INPUT", "Os documentos dos funcionários levanta-os o próprio ou uma pessoa autorizada."));
    if (r.audience === "STUDENT" && !adult && rel === "SELF") return fail(documentsError("INVALID_INPUT", "O aluno é menor: levanta o encarregado de educação ou uma pessoa autorizada."));
    if (r.audience === "STUDENT" && adult && rel === "GUARDIAN") return fail(documentsError("INVALID_INPUT", "O aluno é maior: levanta o próprio ou uma pessoa autorizada por ele."));
    const receivedBy = rel === "SELF" ? clean(input.receivedBy, 120) || r.beneficiary.name : clean(input.receivedBy, 120);
    if (receivedBy.length < 3) return fail(documentsError("INVALID_INPUT", "Indique o nome de quem recebeu o documento."));
    const doc = clean(input.receivedByDocument, 40) || null;
    if (rel === "AUTHORIZED" && (!doc || doc.length < 4)) return fail(documentsError("INVALID_INPUT", "Uma pessoa autorizada identifica-se: indique o n.º do documento de identificação."));
    const notes = clean(input.notes, 300) || null;
    const now = this.clock.now();
    const actor = this.actor(v);
    const done = await repo.transaction(async (tx) => {
      if (!(await tx.move(r.id, r.status, "COMPLETED", input.revision, { handled: actor, completed: true }, now))) return false;
      await tx.deliver(r.id, { receivedBy, receivedByDocument: doc, relationship: rel, notes }, actor, now);
      await tx.event(r.id, { kind: "STATUS", from: r.status, to: "COMPLETED", note: `Entregue a ${receivedBy} (${RECEIVER_RELATIONSHIPS[rel].toLowerCase()})${notes ? ` · ${notes}` : ""}`, internal: false }, actor, now);
      return true;
    });
    if (!done) return fail(documentsError("CHANGED", "O pedido mudou entretanto: atualize a página."));
    const fresh = (await repo.request(id))!;
    await this.quietly("entregue", () => this.tellRequester(repo, notices, fresh, "documento entregue", `Entregue a ${receivedBy}.`));
    return ok({ status: "COMPLETED" as RequestStatus });
  }

  // ================================================================ documentos juntos (depois de pedir)

  /** O pedido, se quem está a ver o pode ver: a família (os seus alunos), o funcionário (os seus) ou a equipa. */
  private async reach(repo: Repo, who: Who, id: string) {
    if (who.kind === "FAMILY") return this.familyOwned(repo, who.accountId, id);
    if (who.kind === "EMPLOYEE") return this.mineOwned(repo, who.userId, id);
    const r = await repo.request(id);
    return r && can(who.viewer, r.audience, "view") ? r : null;
  }
  private async whoActor(repo: Repo, who: Who): Promise<Actor> {
    if (who.kind === "FAMILY") return { kind: "FAMILY", id: who.accountId, name: await repo.familyName(who.accountId) };
    if (who.kind === "EMPLOYEE") return { kind: "EMPLOYEE", id: who.userId, name: who.name };
    return this.actor(who.viewer);
  }

  /** Juntar um documento ao pedido (quem pediu, ou o balcão) enquanto o colégio ainda o está a tratar. */
  async addAttachment(repo: Repo, store: HrFileStore, notices: Notices, who: Who, id: string, itemKey: string, file: UploadFile | undefined): R<{ saved: true }> {
    const r = await this.reach(repo, who, id);
    if (!r) return notFound();
    if (who.kind === "STAFF" && !can(who.viewer, r.audience, "process")) return fail(documentsError("FORBIDDEN", "Juntar documentos exige a permissão de tratar os pedidos."));
    if (!canAttach(r.status)) return fail(documentsError("INVALID_STATE", `Já não se juntam documentos: o pedido está “${STATUS_LABELS[r.status]}”.`));
    const type = await repo.type(r.typeId);
    if (!file) return fail(documentsError("INVALID_INPUT", "Escolha o ficheiro (PDF, JPG ou PNG)."));
    const c = checkAttachments(type?.attachments ?? [], [{ itemKey, file }], false);
    if (!c.ok) return fail(documentsError("INVALID_INPUT", c.message));
    if (!store.ready) return fail(documentsError("NOT_AVAILABLE", "O armazenamento de ficheiros deste colégio ainda não está configurado: fale com a EduFlow."));
    const f = c.files[0];
    const saved = await store.save(`documents/${r.id}/anexos`, { fileName: f.name, mimeType: f.mime, content: f.content });
    const actor = await this.whoActor(repo, who);
    const now = this.clock.now();
    await repo.transaction(async (tx) => {
      await tx.addAttachment(r.id, { itemKey: f.item.key, label: f.item.label, fileName: f.name, mimeType: f.mime, size: f.content.length, sha256: createHash("sha256").update(f.content).digest("hex"), storageKey: saved.key }, actor, now);
      await tx.event(r.id, { kind: "FILE", from: null, to: null, note: `Documento junto: ${f.item.label}`, internal: false }, actor, now);
    });
    if (who.kind !== "STAFF") await this.quietly("documento junto", () => this.tellStaff(repo, notices, r, `Documento junto ao pedido: ${r.typeName}`, `${this.ref(r)} · ${r.beneficiary.name}: ${f.item.label}`, `att:${now.getTime()}`));
    return ok({ saved: true as const });
  }

  /** Abrir um documento junto (quem pediu ou a equipa); quando a equipa o abre, fica no histórico interno. */
  async attachmentFile(repo: Repo, store: HrFileStore, who: Who, id: string, fileId: string): R<{ fileName: string; mimeType: string; content: Buffer }> {
    const r = await this.reach(repo, who, id);
    if (!r) return notFound();
    const a = (await repo.attachments(id)).find((x) => x.id === fileId);
    if (!a) return fail(documentsError("NOT_FOUND", "Ficheiro não encontrado."));
    const content = await store.read(a.storageKey);
    if (who.kind === "STAFF") await repo.event(id, { kind: "FILE", from: null, to: null, note: `Documento junto aberto pela equipa: ${a.label}`, internal: true }, this.actor(who.viewer), this.clock.now());
    return ok({ fileName: a.fileName, mimeType: a.mimeType, content });
  }

  /** Ao balcão: a equipa regista um pedido em nome de um aluno (secretaria) ou de um funcionário (RH). */
  async staffCreate(repo: Repo, notices: Notices, v: DocumentsViewer, body: { typeId: string; studentId?: string | null; employeeId?: string | null; answers?: Record<string, unknown> | null; notes?: string | null }, uploads?: Uploads | null): R<{ id: string; reference: string }> {
    const type = await repo.type(body.typeId);
    if (!type) return fail(documentsError("NOT_FOUND", "Documento não encontrado."));
    if (!can(v, type.audience, "process")) return fail(documentsError("FORBIDDEN", "Não tem permissão para registar pedidos deste documento."));
    const requester = { kind: "STAFF" as const, accountId: null, userId: v.support ? null : v.userId, name: v.name, relationship: "STAFF" as const };
    if (type.audience === "STUDENT") {
      if (!body.studentId) return fail(documentsError("INVALID_INPUT", "Escolha o aluno."));
      const s = await repo.studentSnapshot(body.studentId);
      if (!s) return fail(documentsError("NOT_FOUND", "Aluno não encontrado."));
      return this.create(repo, notices, { type, beneficiary: s, studentId: body.studentId, employeeId: null, requester, answers: body.answers, notes: body.notes, uploads }, this.actor(v));
    }
    if (!body.employeeId) return fail(documentsError("INVALID_INPUT", "Escolha o funcionário."));
    const e = await repo.employeeSnapshot(body.employeeId);
    if (!e || !["APPROVED", "ACTIVE", "SUSPENDED", "TERMINATED"].includes(e.status)) return fail(documentsError("NOT_FOUND", "Funcionário não encontrado."));
    const { status: _s, userId: _u, ...beneficiary } = e;
    return this.create(repo, notices, { type, beneficiary, studentId: null, employeeId: body.employeeId, requester, answers: body.answers, notes: body.notes, uploads }, this.actor(v));
  }
}
