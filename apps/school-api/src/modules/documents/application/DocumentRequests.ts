import { Logger } from "@nestjs/common";
import type { Clock } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import { canAccessStudent, isAdult } from "../../family/domain/family";
import type { StaffNotify } from "../../notifications/infrastructure/notifier";
import {
  type Audience,
  canDeliver,
  checkAnswers,
  DEPARTMENTS,
  type DocumentsError,
  type ExtraField,
  documentsError,
  dueOn,
  METHODS,
  OPEN_STATUSES,
  type RequestStatus,
  requesterCanCancel,
  requestNumber,
  type StaffAction,
  staffTransition,
  STATUS_LABELS,
} from "../domain/documents";
import type { Actor, Beneficiary, ListFilter, PrismaDocumentsRepository, RequestRow, TypeRow } from "../infrastructure/prisma-documents";
import { audiencesFor, can, type DocumentsViewer } from "./DocumentTypes";

type R<T> = Promise<Result<T, DocumentsError>>;
type Repo = PrismaDocumentsRepository;
const today = (now: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Luanda" }).format(now);
const clean = (v: unknown, max: number) =>
  String(v ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
const notFound = () => fail(documentsError("NOT_FOUND", "Pedido não encontrado."));

/** Avisos à família (uma conta de cada vez) — a implementação grava na área da família. */
export interface FamilyNotify {
  notify(accountId: string, n: { kind: string; title: string; body?: string | null; link?: string | null; studentId?: string | null }): Promise<void>;
}
export interface Notices {
  staff: StaffNotify;
  family: FamilyNotify;
}

/** Quem levanta: o próprio, o encarregado (só para alunos) ou uma pessoa autorizada (com documento de identificação). */
export const RECEIVER_RELATIONSHIPS = { SELF: "O próprio", GUARDIAN: "Encarregado de educação", AUTHORIZED: "Pessoa autorizada" } as const;
export type ReceiverRelationship = keyof typeof RECEIVER_RELATIONSHIPS;

/**
 * PEDIDOS DE DOCUMENTOS — da família (o aluno maior ou o encarregado de um menor), do funcionário (os
 * seus) e da equipa (ao balcão, em nome de alguém). A máquina de estados está em domain/documents;
 * aqui confirma-se quem pode o quê, guarda-se o histórico e avisa-se quem deve saber.
 */
export class DocumentRequests {
  private readonly logger = new Logger("DocumentRequests");
  constructor(private readonly clock: Clock) {}

  private ref = (r: { year: number; number: number }) => requestNumber(r.year, r.number);
  private staffLink = (r: { id: string; audience: Audience }) => `${r.audience === "EMPLOYEE" ? "/rh/documentos" : "/documentos/pedidos"}/${r.id}`;
  private async quietly(what: string, fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (e) {
      this.logger.warn(`${what}: aviso falhou (${(e as Error).message})`);
    }
  }

  /** O pedido tal como a família ou o funcionário o vê (sem as notas internas). */
  private publicView(r: RequestRow, events: Awaited<ReturnType<Repo["events"]>>, delivery: Awaited<ReturnType<Repo["delivery"]>>, fields: ExtraField[]) {
    return {
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
      beneficiary: r.beneficiary,
      studentId: r.studentId,
      requesterName: r.requesterName,
      relationship: r.relationship,
      answers: r.answers,
      /** as respostas com o nome de cada campo (os campos do tipo; um campo que já não exista mostra a chave) */
      answerList: Object.entries(r.answers).map(([key, value]) => ({ key, label: fields.find((f) => f.key === key)?.label ?? key, value })),
      notes: r.notes,
      status: r.status,
      statusLabel: STATUS_LABELS[r.status],
      revision: r.revision,
      dueOn: r.dueOn,
      rejectReason: r.rejectReason,
      cancelReason: r.cancelReason,
      createdAt: r.createdAt.toISOString(),
      completedAt: r.completedAt?.toISOString() ?? null,
      canCancel: requesterCanCancel(r.status),
      delivery: delivery && { receivedBy: delivery.receivedBy, relationshipLabel: RECEIVER_RELATIONSHIPS[delivery.relationship as ReceiverRelationship] ?? delivery.relationship, at: delivery.deliveredAt.toISOString() },
      history: events.filter((e) => !e.internal).map((e) => ({ kind: e.kind, from: e.fromStatus, to: e.toStatus, toLabel: e.toStatus ? STATUS_LABELS[e.toStatus] : null, note: e.note, by: e.actorKind === "STAFF" ? "Colégio" : e.actorName, at: e.at.toISOString() })),
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
      pickup: r.pickup,
      download: r.download,
      dueOn: r.dueOn,
      overdue: !!r.dueOn && OPEN_STATUSES.includes(r.status) && r.status !== "READY_PICKUP" && r.status !== "READY_DOWNLOAD" && r.dueOn < today(this.clock.now()),
      createdAt: r.createdAt.toISOString(),
      canCancel: requesterCanCancel(r.status),
    };
  }

  // ================================================================ avisos

  /** Avisa quem pediu (a família do aluno, ou o funcionário) de uma mudança no pedido. */
  private async tellRequester(repo: Repo, notices: Notices, r: RequestRow, title: string, body: string | null) {
    const t = `${r.typeName}: ${title}`;
    if (r.audience === "STUDENT" && r.studentId) {
      const accounts = await repo.familyRecipients(r.studentId, today(this.clock.now()));
      for (const a of accounts) await notices.family.notify(a.accountId, { kind: "DOCUMENT_STATUS", title: `${t} · ${r.beneficiary.name.split(" ")[0]}`, body: `${this.ref(r)}${body ? `. ${body}` : ""}`, link: `/familia/documentos/${r.id}`, studentId: r.studentId });
    } else if (r.employeeId) {
      await notices.staff.notify({ kind: "MY_DOCUMENTS", employeeIds: [r.employeeId], title: t, body: `${this.ref(r)}${body ? `. ${body}` : ""}`, link: `/os-meus-documentos/${r.id}`, dedupeKey: `doc:${r.id}:${r.revision}:${r.status}` });
    }
  }
  /** Avisa quem trata os pedidos deste público (secretaria ou RH). */
  private async tellStaff(repo: Repo, notices: Notices, r: RequestRow, title: string, body: string | null, key: string) {
    const perms = r.audience === "EMPLOYEE" ? ["hr.doc_requests.process"] : ["documents.requests.process"];
    const users = await repo.usersWithAny(perms);
    if (users.length) await notices.staff.notify({ kind: "DOCUMENT_REQUESTS", userIds: users.map((u) => u.id), title, body, link: this.staffLink(r), dedupeKey: `doc:${r.id}:${key}` });
  }
  private async afterCreate(repo: Repo, notices: Notices, id: string, byStaff: boolean) {
    const r = await repo.request(id);
    if (!r) return;
    await this.quietly("pedido novo", async () => {
      if (!byStaff) await this.tellStaff(repo, notices, r, `Pedido de documento: ${r.typeName}`, `${this.ref(r)} · ${r.beneficiary.name}${r.beneficiary.kind === "STUDENT" && r.beneficiary.classLabel ? ` · ${r.beneficiary.classLabel}${r.beneficiary.groupName ? ` turma ${r.beneficiary.groupName}` : ""}` : ""}`, "new");
      await this.tellRequester(repo, notices, r, "pedido recebido", r.dueOn ? `Prazo previsto: ${r.dueOn.split("-").reverse().join("/")}.` : null);
    });
  }

  // ================================================================ criar (comum)

  private async create(repo: Repo, notices: Notices, input: { type: TypeRow; beneficiary: Beneficiary; studentId: string | null; employeeId: string | null; requester: { kind: "FAMILY" | "EMPLOYEE" | "STAFF"; accountId: string | null; userId: string | null; name: string; relationship: "SELF" | "GUARDIAN" | "STAFF" }; answers: Record<string, unknown> | null | undefined; notes: string | null | undefined }, actor: Actor): R<{ id: string; reference: string }> {
    const t = input.type;
    if (!t.active) return fail(documentsError("NOT_AVAILABLE", "Este documento já não se pode pedir."));
    const a = checkAnswers(t.fields, input.answers);
    if (!a.ok) return fail(documentsError("INVALID_INPUT", a.message));
    const notes = clean(input.notes, 600) || null;
    const now = this.clock.now();
    const day = today(now);
    // o mesmo documento, para o mesmo beneficiário, ainda em curso: não se pede duas vezes
    const open = await repo.list({ audiences: [t.audience], status: "OPEN", typeId: t.id, studentIds: input.studentId ? [input.studentId] : null, employeeId: input.employeeId, page: 1, pageSize: 1 });
    if (open.rows[0]) return fail(documentsError("INVALID_STATE", `Já há um pedido deste documento em curso (${this.ref(open.rows[0])}).`, { requestId: open.rows[0].id }));
    const { id, number } = await repo.transaction((tx) =>
      tx.createRequest(
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
          dueOn: dueOn(day, t.slaDays),
        },
        actor,
        now,
      ),
    );
    await this.afterCreate(repo, notices, id, input.requester.kind === "STAFF");
    return ok({ id, reference: requestNumber(Number(day.slice(0, 4)), number) });
  }

  // ================================================================ família

  /** Os alunos que a conta pode representar (o próprio, ou os menores que gere), já verificado aqui. */
  private async familyStudentIds(repo: Repo, accountId: string) {
    const day = today(this.clock.now());
    return (await repo.familyStudents(accountId)).filter((s) => canAccessStudent({ self: s.self, managingGuardian: s.managing }, s.birthDate, day)).map((s) => s.id);
  }

  /** O catálogo: os documentos que se podem pedir, para cada aluno da conta. */
  async familyCatalog(repo: Repo, accountId: string) {
    const ids = await this.familyStudentIds(repo, accountId);
    const [types, students] = await Promise.all([repo.types(["STUDENT"], true), Promise.all(ids.map(async (id) => ({ id, ...(await repo.studentSnapshot(id))! })))]);
    return { students, types: types.map((t) => ({ id: t.id, name: t.name, category: t.category, description: t.description, requirements: t.requirements, methodLabel: METHODS[t.method].label, pickup: t.pickup, download: t.download, fee: t.fee, slaDays: t.slaDays, requiresApproval: t.requiresApproval, fields: t.fields, departmentLabel: DEPARTMENTS[t.department] })) };
  }

  async familyCreate(repo: Repo, notices: Notices, accountId: string, body: { studentId: string; typeId: string; answers?: Record<string, unknown> | null; notes?: string | null }): R<{ id: string; reference: string }> {
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
      { type, beneficiary, studentId: body.studentId, employeeId: null, requester: { kind: "FAMILY", accountId, userId: null, name, relationship: link.self ? "SELF" : "GUARDIAN" }, answers: body.answers, notes: body.notes },
      { kind: "FAMILY", id: accountId, name },
    );
  }

  async familyList(repo: Repo, accountId: string, f: { studentId?: string; status?: RequestStatus | "OPEN"; q?: string; page?: number }) {
    const ids = await this.familyStudentIds(repo, accountId);
    const students = f.studentId ? ids.filter((i) => i === f.studentId) : ids;
    const filter: ListFilter = { audiences: ["STUDENT"], studentIds: students, status: f.status ?? null, q: f.q?.trim() || null, page: f.page ?? 1, pageSize: 30 };
    const [list, counts] = await Promise.all([repo.list(filter), repo.statusCounts(filter)]);
    return { total: list.total, page: filter.page, pageSize: filter.pageSize, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])), items: list.rows.map((r) => this.listItem(r)) };
  }

  private async familyOwned(repo: Repo, accountId: string, id: string) {
    const r = await repo.request(id);
    if (!r || !r.studentId) return null;
    return (await this.familyStudentIds(repo, accountId)).includes(r.studentId) ? r : null;
  }
  async familyDetail(repo: Repo, accountId: string, id: string) {
    const r = await this.familyOwned(repo, accountId, id);
    if (!r) return notFound();
    const [events, delivery, type] = await Promise.all([repo.events(id), repo.delivery(id), repo.type(r.typeId)]);
    return ok(this.publicView(r, events, delivery, type?.fields ?? []));
  }
  async familyCancel(repo: Repo, notices: Notices, accountId: string, id: string, reason: string | null): R<{ status: RequestStatus }> {
    const r = await this.familyOwned(repo, accountId, id);
    if (!r) return notFound();
    return this.requesterCancel(repo, notices, r, reason, { kind: "FAMILY", id: accountId, name: await repo.familyName(accountId) });
  }

  private async requesterCancel(repo: Repo, notices: Notices, r: RequestRow, reason: string | null, actor: Actor): R<{ status: RequestStatus }> {
    if (!requesterCanCancel(r.status)) return fail(documentsError("INVALID_STATE", `Já não se pode cancelar: o pedido está “${STATUS_LABELS[r.status]}”. Fale com o colégio.`));
    const why = clean(reason, 300) || null;
    const now = this.clock.now();
    const done = await repo.transaction(async (tx) => {
      if (!(await tx.move(r.id, r.status, "CANCELLED", r.revision, { cancelReason: why }, now))) return false;
      await tx.event(r.id, { kind: "STATUS", from: r.status, to: "CANCELLED", note: why, internal: false }, actor, now);
      return true;
    });
    if (!done) return fail(documentsError("CHANGED", "O pedido mudou entretanto: atualize a página."));
    await this.quietly("cancelado pelo requerente", () => this.tellStaff(repo, notices, r, `Pedido cancelado: ${r.typeName}`, `${this.ref(r)} · ${r.beneficiary.name}${why ? ` · ${why}` : ""}`, "cancel"));
    return ok({ status: "CANCELLED" as RequestStatus });
  }

  // ================================================================ o funcionário (os seus pedidos)

  private async me(repo: Repo, userId: string) {
    const e = await repo.employeeOfUser(userId);
    return e && ["APPROVED", "ACTIVE", "SUSPENDED"].includes(e.status) ? e : null;
  }
  async mineCatalog(repo: Repo, userId: string) {
    const e = await this.me(repo, userId);
    if (!e) return ok({ employee: null, types: [] });
    const [types, snap] = await Promise.all([repo.types(["EMPLOYEE"], true), repo.employeeSnapshot(e.id)]);
    return ok({ employee: snap && { id: e.id, name: snap.name, number: snap.number, jobTitle: snap.jobTitle, department: snap.department }, types: types.map((t) => ({ id: t.id, name: t.name, category: t.category, description: t.description, requirements: t.requirements, methodLabel: METHODS[t.method].label, pickup: t.pickup, download: t.download, fee: t.fee, slaDays: t.slaDays, requiresApproval: t.requiresApproval, fields: t.fields, departmentLabel: DEPARTMENTS[t.department] })) });
  }
  async mineCreate(repo: Repo, notices: Notices, v: DocumentsViewer, body: { typeId: string; answers?: Record<string, unknown> | null; notes?: string | null }): R<{ id: string; reference: string }> {
    const e = await this.me(repo, v.userId);
    if (!e) return fail(documentsError("FORBIDDEN", "Só os funcionários com a ficha no RH podem pedir documentos profissionais."));
    const type = await repo.type(body.typeId);
    if (!type || type.audience !== "EMPLOYEE") return fail(documentsError("NOT_FOUND", "Documento não encontrado."));
    const snap = await repo.employeeSnapshot(e.id);
    if (!snap) return fail(documentsError("NOT_FOUND", "Funcionário não encontrado."));
    const { status: _s, userId: _u, ...beneficiary } = snap;
    return this.create(repo, notices, { type, beneficiary, studentId: null, employeeId: e.id, requester: { kind: "EMPLOYEE", accountId: null, userId: v.userId, name: snap.name, relationship: "SELF" }, answers: body.answers, notes: body.notes }, { kind: "EMPLOYEE", id: v.userId, name: snap.name });
  }
  async mineList(repo: Repo, userId: string, f: { status?: RequestStatus | "OPEN"; q?: string; page?: number }) {
    const e = await repo.employeeOfUser(userId);
    if (!e) return { total: 0, page: 1, pageSize: 30, counts: {}, items: [] };
    const filter: ListFilter = { audiences: ["EMPLOYEE"], employeeId: e.id, status: f.status ?? null, q: f.q?.trim() || null, page: f.page ?? 1, pageSize: 30 };
    const [list, counts] = await Promise.all([repo.list(filter), repo.statusCounts(filter)]);
    return { total: list.total, page: filter.page, pageSize: filter.pageSize, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])), items: list.rows.map((r) => this.listItem(r)) };
  }
  private async mineOwned(repo: Repo, userId: string, id: string) {
    const [e, r] = await Promise.all([repo.employeeOfUser(userId), repo.request(id)]);
    return e && r && r.employeeId === e.id ? r : null;
  }
  async mineDetail(repo: Repo, userId: string, id: string) {
    const r = await this.mineOwned(repo, userId, id);
    if (!r) return notFound();
    const [events, delivery, type] = await Promise.all([repo.events(id), repo.delivery(id), repo.type(r.typeId)]);
    return ok(this.publicView(r, events, delivery, type?.fields ?? []));
  }
  async mineCancel(repo: Repo, notices: Notices, v: DocumentsViewer, id: string, reason: string | null): R<{ status: RequestStatus }> {
    const r = await this.mineOwned(repo, v.userId, id);
    if (!r) return notFound();
    return this.requesterCancel(repo, notices, r, reason, { kind: "EMPLOYEE", id: v.userId, name: v.name });
  }

  // ================================================================ a equipa (secretaria e RH)

  private actor(v: DocumentsViewer): Actor {
    return { kind: "STAFF", id: v.support ? null : v.userId, name: v.support ? "Suporte EduFlow" : v.name };
  }
  async staffList(repo: Repo, v: DocumentsViewer, f: Omit<ListFilter, "audiences" | "pageSize"> & { audience?: Audience | null }) {
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

  async staffDetail(repo: Repo, v: DocumentsViewer, id: string) {
    const r = await repo.request(id);
    if (!r || !can(v, r.audience, "view")) return notFound();
    const [events, delivery, type] = await Promise.all([repo.events(id), repo.delivery(id), repo.type(r.typeId)]);
    const base = this.publicView(r, events, delivery, type?.fields ?? []);
    const adult = r.beneficiary.kind === "STUDENT" ? isAdult(r.beneficiary.birthDate, today(this.clock.now())) : true;
    const act = (a: StaffAction) => can(v, r.audience, "process") && staffTransition(r, a).ok;
    return ok({
      ...base,
      requesterKind: r.requesterKind,
      handledByName: r.handledByName,
      fields: type?.fields ?? [],
      adult,
      receiverOptions: (Object.keys(RECEIVER_RELATIONSHIPS) as ReceiverRelationship[])
        .filter((k) => (r.audience === "EMPLOYEE" ? k !== "GUARDIAN" : adult ? k !== "GUARDIAN" : k !== "SELF"))
        .map((k) => ({ key: k, label: RECEIVER_RELATIONSHIPS[k] })),
      delivery: delivery && { ...base.delivery!, receivedByDocument: delivery.receivedByDocument, deliveredBy: delivery.deliveredByName, notes: delivery.notes },
      history: events.map((e) => ({ kind: e.kind, from: e.fromStatus, to: e.toStatus, toLabel: e.toStatus ? STATUS_LABELS[e.toStatus] : null, note: e.note, internal: e.internal, by: e.actorName, actorKind: e.actorKind, at: e.at.toISOString() })),
      can: {
        review: act("review"),
        process: act("process"),
        readyPickup: act("ready_pickup"),
        reject: act("reject"),
        cancel: act("cancel"),
        deliver: can(v, r.audience, "deliver") && canDeliver(r.status),
        note: can(v, r.audience, "process") || can(v, r.audience, "deliver"),
      },
    });
  }

  /** Uma transição pela equipa (com a revisão que estava a ver: duas pessoas não se pisam). */
  async staffMove(repo: Repo, notices: Notices, v: DocumentsViewer, id: string, action: StaffAction, input: { revision: number; reason?: string | null; note?: string | null; notify?: boolean }): R<{ status: RequestStatus }> {
    const r = await repo.request(id);
    if (!r || !can(v, r.audience, "view")) return notFound();
    if (!can(v, r.audience, "process")) return fail(documentsError("FORBIDDEN", r.audience === "EMPLOYEE" ? "Tratar os pedidos dos funcionários exige a permissão do RH." : "Tratar os pedidos exige a permissão “Tratar os pedidos de documentos”."));
    const t = staffTransition(r, action);
    if (!t.ok) return fail(documentsError("INVALID_STATE", t.message));
    const reason = clean(input.reason, 300);
    if ((action === "reject" || action === "cancel") && reason.length < 3) return fail(documentsError("INVALID_INPUT", action === "reject" ? "Indique o motivo da rejeição (3 a 300 caracteres): a família ou o funcionário vê-o." : "Indique o motivo do cancelamento (3 a 300 caracteres)."));
    const note = clean(input.note, 600) || null;
    const now = this.clock.now();
    const actor = this.actor(v);
    const done = await repo.transaction(async (tx) => {
      const set = action === "reject" ? { rejectReason: reason, handled: actor } : action === "cancel" ? { cancelReason: reason, handled: actor } : { handled: actor };
      if (!(await tx.move(r.id, r.status, t.to, input.revision, set, now))) return false;
      await tx.event(r.id, { kind: "STATUS", from: r.status, to: t.to, note: action === "reject" || action === "cancel" ? reason : note, internal: false }, actor, now);
      return true;
    });
    if (!done) return fail(documentsError("CHANGED", "O pedido mudou entretanto: atualize a página."));
    const fresh = (await repo.request(id))!;
    const where = fresh.audience === "EMPLOYEE" ? "nos Recursos Humanos" : "na secretaria";
    const say: Partial<Record<RequestStatus, [string, string | null]>> = {
      IN_REVIEW: ["pedido em análise", null],
      PROCESSING: ["documento em preparação", null],
      READY_PICKUP: ["pronto a levantar", `Pode levantar ${where}.${note ? ` ${note}` : ""}`],
      REJECTED: ["pedido rejeitado", `Motivo: ${reason}`],
      CANCELLED: ["pedido cancelado pelo colégio", `Motivo: ${reason}`],
    };
    const msg = say[t.to];
    // "em preparação" só se a equipa quiser avisar; os outros passos avisam sempre
    if (msg && (t.to !== "PROCESSING" || input.notify)) await this.quietly(`passo ${t.to}`, () => this.tellRequester(repo, notices, fresh, msg[0], msg[1]));
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

  /** Ao balcão: a equipa regista um pedido em nome de um aluno (secretaria) ou de um funcionário (RH). */
  async staffCreate(repo: Repo, notices: Notices, v: DocumentsViewer, body: { typeId: string; studentId?: string | null; employeeId?: string | null; answers?: Record<string, unknown> | null; notes?: string | null }): R<{ id: string; reference: string }> {
    const type = await repo.type(body.typeId);
    if (!type) return fail(documentsError("NOT_FOUND", "Documento não encontrado."));
    if (!can(v, type.audience, "process")) return fail(documentsError("FORBIDDEN", "Não tem permissão para registar pedidos deste documento."));
    const requester = { kind: "STAFF" as const, accountId: null, userId: v.support ? null : v.userId, name: v.name, relationship: "STAFF" as const };
    if (type.audience === "STUDENT") {
      if (!body.studentId) return fail(documentsError("INVALID_INPUT", "Escolha o aluno."));
      const s = await repo.studentSnapshot(body.studentId);
      if (!s) return fail(documentsError("NOT_FOUND", "Aluno não encontrado."));
      return this.create(repo, notices, { type, beneficiary: s, studentId: body.studentId, employeeId: null, requester, answers: body.answers, notes: body.notes }, this.actor(v));
    }
    if (!body.employeeId) return fail(documentsError("INVALID_INPUT", "Escolha o funcionário."));
    const e = await repo.employeeSnapshot(body.employeeId);
    if (!e || !["APPROVED", "ACTIVE", "SUSPENDED", "TERMINATED"].includes(e.status)) return fail(documentsError("NOT_FOUND", "Funcionário não encontrado."));
    const { status: _s, userId: _u, ...beneficiary } = e;
    return this.create(repo, notices, { type, beneficiary, studentId: null, employeeId: body.employeeId, requester, answers: body.answers, notes: body.notes }, this.actor(v));
  }
}
