import { createHash } from "node:crypto";
import type { Clock } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import { checkUpload } from "../../documents/domain/issuing";
import type { HrFileStore } from "../../hr/application/employee-ports";
import type { StaffNotify } from "../../notifications/infrastructure/notifier";
import {
  allowedKinds,
  ATTACH_MAX,
  AUDIENCE_LABELS,
  checkAnnouncement,
  checkCategory,
  checkTargets,
  type CommunicationError,
  communicationError,
  PRIORITY_LABELS,
  type Scope,
  STATUS_LABELS,
  type Status,
  TARGET_LABELS,
  type Target,
} from "../domain/announcements";
import type { Actor, AnnouncementRow, CommunicationSettings, PrismaAnnouncementsRepository, RecipientKind } from "../infrastructure/prisma-announcements";

type R<T> = Promise<Result<T, CommunicationError>>;
type Repo = PrismaAnnouncementsRepository;
type Upload = { originalname: string; mimetype: string; buffer: Buffer } | undefined;

export interface StaffViewer {
  userId: string;
  name: string;
  support: boolean;
  permissions: string[];
}
export interface Who {
  kind: RecipientKind;
  id: string;
}
/** Os avisos que saem: a equipa (Notifier) e a família (área da família). */
export interface Notices {
  staff: StaffNotify;
  family: (accountId: string, n: { kind: string; title: string; body: string | null; link: string }) => Promise<void>;
}
export interface AnnouncementBody {
  title: string;
  body: string;
  categoryId: string;
  priority?: string | null;
  pinned?: boolean | null;
  requiresAck?: boolean | null;
  publishAt?: string | null;
  expiresAt?: string | null;
  targets: Target[];
  /** DRAFT = guardar rascunho; PUBLISH = publicar já (ou agendar, se tiver a data) */
  action: "DRAFT" | "PUBLISH";
}

const P = {
  access: "communication.access",
  all: "communication.announcements.publish",
  staff: "communication.announcements.staff",
  manage: "communication.announcements.manage",
  settings: "communication.settings.manage",
} as const;
const has = (v: StaffViewer, p: string) => v.permissions.includes(P.access) && v.permissions.includes(p);
const iso = (d: Date | null) => (d ? d.toISOString() : null);
const excerpt = (s: string, n = 220) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);

/**
 * AVISOS — comunicados do colégio. Publica quem tem a permissão (toda a comunidade, ou só a equipa) e,
 * se o colégio o permitir, o diretor de turma para as suas turmas (relação confirmada aqui, nunca a
 * do portal). Quem recebe calcula-se na publicação, sem repetidos; a leitura e a confirmação ficam
 * registadas por pessoa. Ler avisos não pede permissão: cada um vê só os que lhe foram destinados.
 */
export class Announcements {
  constructor(private readonly clock: Clock) {}

  /** O que o utilizador pode fazer como publicador. */
  private async authority(repo: Repo, v: StaffViewer) {
    const settings = await repo.settings();
    const groups = settings.classDirectorsPublish && !v.support ? await repo.coordinatedGroups(v.userId) : [];
    const scopes: Scope[] = [];
    if (has(v, P.all)) scopes.push("ALL");
    if (has(v, P.all) || has(v, P.staff)) scopes.push("STAFF");
    if (groups.length) scopes.push("CLASS");
    return { scopes, groups, manage: has(v, P.manage), settings: has(v, P.settings), classDirectorsPublish: settings.classDirectorsPublish };
  }

  /** A autoridade mais estreita que cobre todos os destinatários (as turmas do diretor confirmam-se aqui). */
  private async scopeFor(repo: Repo, v: StaffViewer, targets: Target[]): R<{ scope: Scope; targets: Target[] }> {
    const a = await this.authority(repo, v);
    if (!a.scopes.length) return fail(communicationError("FORBIDDEN", "Não pode publicar avisos. Peça a permissão ao responsável do colégio."));
    const order: Scope[] = (["CLASS", "STAFF", "ALL"] as Scope[]).filter((s) => a.scopes.includes(s));
    let lastError = "Não pode publicar para estes destinatários.";
    for (const scope of order) {
      const c = checkTargets(targets, scope);
      if (!c.ok) {
        lastError = c.message;
        continue;
      }
      if (scope === "CLASS") {
        const mine = new Set(a.groups.map((g) => g.id));
        if (c.value.some((t) => !mine.has(t.refId!))) {
          lastError = "Como diretor de turma, só pode publicar para as turmas que dirige.";
          continue;
        }
      }
      return ok({ scope, targets: c.value });
    }
    return fail(communicationError(a.scopes.length === 1 && a.scopes[0] === "CLASS" ? "FORBIDDEN" : "INVALID_INPUT", lastError));
  }

  private canEdit(v: StaffViewer, a: AnnouncementRow, manage: boolean) {
    return a.authorId === v.userId || manage;
  }

  // ================================================================ publicar (gestão)

  /** O que é preciso para escrever um aviso: autoridade, categorias, destinatários possíveis. */
  async options(repo: Repo, v: StaffViewer) {
    const a = await this.authority(repo, v);
    if (!a.scopes.length && !a.manage && !a.settings) return fail(communicationError("FORBIDDEN", "Não pode publicar avisos."));
    const [categories, opts] = await Promise.all([repo.categories(), a.scopes.includes("ALL") || a.scopes.includes("STAFF") ? repo.options() : Promise.resolve({ classes: [], groups: [], departments: [] })]);
    return ok({
      can: { publishAll: a.scopes.includes("ALL"), publishStaff: a.scopes.includes("STAFF"), publishClass: a.scopes.includes("CLASS"), manage: a.manage, settings: a.settings },
      kinds: [...new Set(a.scopes.flatMap((s) => allowedKinds(s)))].map((k) => ({ value: k, label: TARGET_LABELS[k] })),
      categories: categories.map((c) => ({ id: c.id, name: c.name })),
      classes: a.scopes.includes("ALL") ? opts.classes : [],
      groups: a.scopes.includes("ALL") ? opts.groups : [],
      departments: opts.departments,
      myGroups: a.groups,
      priorities: Object.entries(PRIORITY_LABELS).map(([value, label]) => ({ value, label })),
    });
  }

  async searchPeople(repo: Repo, v: StaffViewer, q: string) {
    const a = await this.authority(repo, v);
    if (!a.scopes.includes("ALL") && !a.scopes.includes("STAFF")) return fail(communicationError("FORBIDDEN", "Não pode escolher pessoas como destinatários."));
    if (q.trim().length < 2) return ok({ staff: [], family: [] });
    return ok(await repo.searchPeople(q.trim(), a.scopes.includes("ALL")));
  }

  async create(repo: Repo, notices: Notices, v: StaffViewer, input: AnnouncementBody): R<{ id: string; status: Status; recipients: number }> {
    const now = this.clock.now();
    const c = checkAnnouncement(input, now);
    if (!c.ok) return fail(communicationError("INVALID_INPUT", c.message));
    const cat = await repo.category(c.value.categoryId);
    if (!cat || cat.archived) return fail(communicationError("INVALID_INPUT", "Escolha uma categoria ativa."));
    const s = await this.scopeFor(repo, v, input.targets);
    if (!s.ok) return s;
    const status: Status = input.action === "DRAFT" ? "DRAFT" : c.value.publishAt ? "SCHEDULED" : "DRAFT";
    const actor = { id: v.userId, name: v.name };
    const id = await repo.transaction(async (tx) => {
      const id = await tx.create({ ...c.value, scope: s.value.scope, status }, s.value.targets, actor, now);
      await tx.activity("communication.announcement.created", id, v.userId, { title: c.value.title, scope: s.value.scope, status, targets: s.value.targets.length }, now);
      return id;
    });
    if (input.action === "PUBLISH" && !c.value.publishAt) {
      const n = await this.doPublish(repo, notices, id, v.userId);
      return ok({ id, status: "PUBLISHED" as Status, recipients: n });
    }
    return ok({ id, status, recipients: 0 });
  }

  async update(repo: Repo, notices: Notices, v: StaffViewer, id: string, revision: number, input: AnnouncementBody): R<{ id: string; status: Status; recipients: number }> {
    const now = this.clock.now();
    const a = await repo.get(id);
    const auth = await this.authority(repo, v);
    if (!a || !this.canEdit(v, a, auth.manage)) return fail(communicationError("NOT_FOUND", "Aviso não encontrado."));
    if (a.status !== "DRAFT" && a.status !== "SCHEDULED") return fail(communicationError("INVALID_STATE", "Um aviso publicado já não se altera (pode arquivá-lo e publicar outro)."));
    const c = checkAnnouncement(input, now);
    if (!c.ok) return fail(communicationError("INVALID_INPUT", c.message));
    const cat = await repo.category(c.value.categoryId);
    if (!cat || (cat.archived && cat.id !== a.categoryId)) return fail(communicationError("INVALID_INPUT", "Escolha uma categoria ativa."));
    const s = await this.scopeFor(repo, v, input.targets);
    if (!s.ok) return s;
    const status: Status = input.action === "DRAFT" ? "DRAFT" : c.value.publishAt ? "SCHEDULED" : "DRAFT";
    const saved = await repo.transaction(async (tx) => {
      if (!(await tx.update(id, revision, { ...c.value, scope: s.value.scope, status }, s.value.targets, now))) return false;
      await tx.activity("communication.announcement.updated", id, v.userId, { title: c.value.title, scope: s.value.scope, status }, now);
      return true;
    });
    if (!saved) return fail(communicationError("CHANGED", "O aviso mudou entretanto (ou já foi publicado). Abra-o outra vez."));
    if (input.action === "PUBLISH" && !c.value.publishAt) return ok({ id, status: "PUBLISHED" as Status, recipients: await this.doPublish(repo, notices, id, v.userId) });
    return ok({ id, status, recipients: 0 });
  }

  /**
   * Publica: calcula quem recebe (sem repetidos), grava, e avisa cada pessoa uma vez (a chave da
   * notificação é o aviso). Devolve quantos o recebem (0 se outro processo já o publicou).
   */
  private async doPublish(repo: Repo, notices: Notices, id: string, actorId: string | null) {
    const now = this.clock.now();
    const a = await repo.get(id);
    if (!a || (a.status !== "DRAFT" && a.status !== "SCHEDULED")) return 0;
    const targets = await repo.targets(id);
    const recipients = await repo.expand(targets, await repo.targetLabels(targets));
    const done = await repo.transaction(async (tx) => {
      if (!(await tx.publish(id, recipients, now))) return false;
      await tx.activity("communication.announcement.published", id, actorId, { title: a.title, recipients: recipients.length, scheduled: a.status === "SCHEDULED" }, now);
      return true;
    });
    if (!done) return 0;
    const urgent = a.priority === "URGENT";
    const title = `${urgent ? "Aviso urgente" : "Aviso"}: ${a.title}`;
    const body = excerpt(a.body);
    const staff = recipients.filter((r) => r.kind === "STAFF").map((r) => r.id);
    if (staff.length) await notices.staff.notify({ kind: urgent ? "URGENT_ANNOUNCEMENTS" : "ANNOUNCEMENTS", userIds: staff, title, body, link: `/comunicacao/avisos/${id}`, dedupeKey: `announcement:${id}` });
    const fam = recipients.filter((r) => r.kind === "FAMILY");
    for (const r of fam) await notices.family(r.id, { kind: "FAMILY_ANNOUNCEMENTS", title, body, link: `/familia/avisos/${id}` });
    // entregue = a notificação chegou de facto à plataforma (o tipo pode estar desligado pelo colégio)
    await repo.markDeliveredFromNotifications(id, now);
    return recipients.length;
  }

  async publish(repo: Repo, notices: Notices, v: StaffViewer, id: string): R<{ recipients: number }> {
    const a = await repo.get(id);
    const auth = await this.authority(repo, v);
    if (!a || !this.canEdit(v, a, auth.manage)) return fail(communicationError("NOT_FOUND", "Aviso não encontrado."));
    if (a.status !== "DRAFT" && a.status !== "SCHEDULED") return fail(communicationError("INVALID_STATE", `O aviso está “${STATUS_LABELS[a.status]}”.`));
    // a autoridade confirma-se outra vez no momento de publicar (as turmas do diretor podem ter mudado)
    const s = await this.scopeFor(repo, v, await repo.targets(id));
    if (!s.ok) return s;
    if (a.expiresAt && a.expiresAt <= this.clock.now()) return fail(communicationError("INVALID_STATE", "A data de expiração já passou: altere-a antes de publicar."));
    return ok({ recipients: await this.doPublish(repo, notices, id, v.userId) });
  }

  /** Os agendados cuja hora chegou (o ciclo das tarefas automáticas e, por precaução, as listas). */
  async publishDue(repo: Repo, notices: Notices) {
    let n = 0;
    for (const id of await repo.due(this.clock.now())) {
      const a = await repo.get(id);
      // um agendado cuja expiração já passou não se publica: volta a rascunho para o autor decidir
      if (a?.expiresAt && a.expiresAt <= this.clock.now()) {
        await repo.unschedule(id, this.clock.now());
        continue;
      }
      await this.doPublish(repo, notices, id, null);
      n++;
    }
    return n;
  }

  async archive(repo: Repo, v: StaffViewer, id: string): R<{ archived: true }> {
    const a = await repo.get(id);
    const auth = await this.authority(repo, v);
    if (!a || !this.canEdit(v, a, auth.manage)) return fail(communicationError("NOT_FOUND", "Aviso não encontrado."));
    if (a.status === "ARCHIVED") return fail(communicationError("INVALID_STATE", "O aviso já está arquivado."));
    const now = this.clock.now();
    await repo.transaction(async (tx) => {
      await tx.archive(id, now);
      await tx.activity("communication.announcement.archived", id, v.userId, { title: a.title, from: a.status }, now);
    });
    return ok({ archived: true as const });
  }

  async removeDraft(repo: Repo, v: StaffViewer, id: string): R<{ removed: true }> {
    const a = await repo.get(id);
    const auth = await this.authority(repo, v);
    if (!a || !this.canEdit(v, a, auth.manage)) return fail(communicationError("NOT_FOUND", "Aviso não encontrado."));
    if (a.status !== "DRAFT") return fail(communicationError("INVALID_STATE", "Só se apagam rascunhos (os outros arquivam-se)."));
    const now = this.clock.now();
    await repo.transaction(async (tx) => {
      await tx.remove(id);
      await tx.activity("communication.announcement.deleted", id, v.userId, { title: a.title }, now);
    });
    return ok({ removed: true as const });
  }

  /** Num publicado: fixar ou não, e a expiração. */
  async patch(repo: Repo, v: StaffViewer, id: string, p: { pinned?: boolean; expiresAt?: string | null }): R<{ saved: true }> {
    const a = await repo.get(id);
    const auth = await this.authority(repo, v);
    if (!a || !this.canEdit(v, a, auth.manage)) return fail(communicationError("NOT_FOUND", "Aviso não encontrado."));
    if (a.status !== "PUBLISHED") return fail(communicationError("INVALID_STATE", "Só nos avisos publicados."));
    const now = this.clock.now();
    if (p.expiresAt) {
      const d = new Date(p.expiresAt);
      if (Number.isNaN(d.getTime()) || d <= now) return fail(communicationError("INVALID_INPUT", "A expiração tem de ser no futuro."));
    }
    await repo.transaction(async (tx) => {
      await tx.patchPublished(id, p, now);
      await tx.activity("communication.announcement.updated", id, v.userId, { ...p }, now);
    });
    return ok({ saved: true as const });
  }

  /** A gestão: os avisos (todos, com a permissão de gerir; senão os próprios). */
  async list(repo: Repo, notices: Notices, v: StaffViewer, f: { status?: Status | null; categoryId?: string | null; q?: string | null; page?: number }) {
    const auth = await this.authority(repo, v);
    if (!auth.scopes.length && !auth.manage) return fail(communicationError("FORBIDDEN", "Não pode publicar avisos."));
    await this.publishDue(repo, notices);
    const r = await repo.list({ authorId: auth.manage ? null : v.userId, status: f.status ?? null, categoryId: f.categoryId ?? null, q: f.q?.trim() || null, page: f.page ?? 1 }, this.clock.now());
    return ok({
      total: r.total,
      items: r.rows.map((a) => ({ ...this.summary(a), recipients: a.recipients, viewed: a.viewed, acknowledged: a.acknowledged, expired: a.expired })),
      can: { manage: auth.manage },
    });
  }

  /** O aviso para quem o gere: dados, destinatários escolhidos, anexos e os indicadores. */
  async manageView(repo: Repo, v: StaffViewer, id: string, filter: "ALL" | "VIEWED" | "NOT_VIEWED" | "ACK" | "NOT_ACK" = "ALL") {
    const a = await repo.get(id);
    const auth = await this.authority(repo, v);
    if (!a || !this.canEdit(v, a, auth.manage)) return fail(communicationError("NOT_FOUND", "Aviso não encontrado."));
    const targets = await repo.targets(id);
    const labels = await repo.targetLabels(targets);
    const [stats, files] = await Promise.all([repo.stats(id, filter), repo.files(id)]);
    return ok({
      ...this.summary(a),
      body: a.body,
      targets: targets.map((t) => ({ ...t, label: this.targetLabel(t, labels) })),
      files: files.map((f) => ({ id: f.id, fileName: f.fileName, mimeType: f.mimeType, size: f.size })),
      stats: { ...stats.totals, people: stats.people.map((p) => ({ ...p, deliveredAt: iso(p.deliveredAt), viewedAt: iso(p.viewedAt), acknowledgedAt: iso(p.acknowledgedAt) })) },
      can: { edit: a.status === "DRAFT" || a.status === "SCHEDULED", publish: a.status === "DRAFT" || a.status === "SCHEDULED", archive: a.status !== "ARCHIVED", remove: a.status === "DRAFT", attach: a.status !== "ARCHIVED" },
    });
  }

  private targetLabel(t: Target, labels: Map<string, string>) {
    if (t.kind === "CLASS" || t.kind === "GROUP") return `${TARGET_LABELS[t.kind]} ${labels.get(t.refId!) ?? "?"} (${AUDIENCE_LABELS[t.audience ?? "BOTH"]})`;
    if (t.kind === "DEPARTMENT") return `Departamento: ${t.refText}`;
    if (t.kind === "USER" || t.kind === "FAMILY") return labels.get(t.refId!) ?? "Pessoa";
    return TARGET_LABELS[t.kind];
  }

  private summary(a: AnnouncementRow) {
    return {
      id: a.id,
      number: a.number,
      title: a.title,
      excerpt: excerpt(a.body.replace(/\s+/g, " "), 160),
      category: { id: a.categoryId, name: a.categoryName },
      priority: a.priority,
      priorityLabel: PRIORITY_LABELS[a.priority],
      status: a.status,
      statusLabel: STATUS_LABELS[a.status],
      pinned: a.pinned,
      requiresAck: a.requiresAck,
      publishAt: iso(a.publishAt),
      publishedAt: iso(a.publishedAt),
      expiresAt: iso(a.expiresAt),
      author: a.authorName,
      revision: a.revision,
      updatedAt: a.updatedAt.toISOString(),
    };
  }

  // ================================================================ receber (equipa e família)

  async inbox(repo: Repo, notices: Notices, who: Who, f: { categoryId?: string | null; q?: string | null; unread?: boolean; page?: number }) {
    await this.publishDue(repo, notices);
    const now = this.clock.now();
    const r = await repo.inbox(who, { categoryId: f.categoryId ?? null, q: f.q?.trim() || null, unread: !!f.unread, page: f.page ?? 1 }, now);
    return {
      total: r.total,
      unread: r.unread,
      pendingAck: r.pending,
      categories: (await repo.categories()).map((c) => ({ id: c.id, name: c.name })),
      items: r.rows.map((a) => ({ ...this.summary(a), viewed: !!a.viewedAt, acknowledged: !!a.acknowledgedAt, files: a.files })),
    };
  }

  /** Abrir um aviso destinado à pessoa: fica visto (não é o mesmo que a notificação entregue). */
  async read(repo: Repo, who: Who, id: string) {
    const a = await repo.get(id);
    const now = this.clock.now();
    const me = a && a.status === "PUBLISHED" ? await repo.recipient(id, who) : null;
    if (!a || !me) return fail(communicationError("NOT_FOUND", "Aviso não encontrado."));
    if (a.expiresAt && a.expiresAt <= now) return fail(communicationError("NOT_FOUND", "Este aviso já expirou."));
    if (!me.viewedAt) await repo.markViewed(id, who, now);
    const files = await repo.files(id);
    return ok({
      ...this.summary(a),
      body: a.body,
      files: files.map((f) => ({ id: f.id, fileName: f.fileName, mimeType: f.mimeType, size: f.size })),
      viewedAt: iso(me.viewedAt ?? now),
      acknowledgedAt: iso(me.acknowledgedAt),
    });
  }

  async acknowledge(repo: Repo, who: Who, id: string): R<{ acknowledged: true }> {
    const a = await repo.get(id);
    const me = a && a.status === "PUBLISHED" ? await repo.recipient(id, who) : null;
    if (!a || !me) return fail(communicationError("NOT_FOUND", "Aviso não encontrado."));
    if (!a.requiresAck) return fail(communicationError("INVALID_STATE", "Este aviso não pede confirmação de leitura."));
    await repo.acknowledge(id, who, this.clock.now());
    return ok({ acknowledged: true as const });
  }

  async unread(repo: Repo, who: Who) {
    return { unread: await repo.unread(who, this.clock.now()) };
  }

  // ================================================================ anexos

  async attach(repo: Repo, store: HrFileStore, v: StaffViewer, id: string, file: Upload): R<{ saved: true }> {
    const a = await repo.get(id);
    const auth = await this.authority(repo, v);
    if (!a || !this.canEdit(v, a, auth.manage)) return fail(communicationError("NOT_FOUND", "Aviso não encontrado."));
    if (a.status === "ARCHIVED") return fail(communicationError("INVALID_STATE", "O aviso está arquivado."));
    if ((await repo.files(id)).length >= ATTACH_MAX) return fail(communicationError("INVALID_INPUT", `No máximo ${ATTACH_MAX} anexos por aviso.`));
    const f = checkUpload(file);
    if (!f.ok) return fail(communicationError("INVALID_INPUT", f.message));
    if (!store.ready) return fail(communicationError("NOT_AVAILABLE", "O armazenamento de ficheiros deste colégio ainda não está configurado: fale com a EduFlow."));
    const saved = await store.save(`communication/announcements/${id}`, { fileName: f.name, mimeType: f.mime, content: file!.buffer });
    const now = this.clock.now();
    await repo.transaction(async (tx) => {
      await tx.addFile(id, { fileName: f.name, mimeType: f.mime, size: file!.buffer.length, sha256: createHash("sha256").update(file!.buffer).digest("hex"), storageKey: saved.key }, now);
      await tx.activity("communication.announcement.file", id, v.userId, { file: f.name }, now);
    });
    return ok({ saved: true as const });
  }

  async detach(repo: Repo, v: StaffViewer, id: string, fileId: string): R<{ removed: true }> {
    const a = await repo.get(id);
    const auth = await this.authority(repo, v);
    if (!a || !this.canEdit(v, a, auth.manage)) return fail(communicationError("NOT_FOUND", "Aviso não encontrado."));
    if (a.status !== "DRAFT" && a.status !== "SCHEDULED") return fail(communicationError("INVALID_STATE", "Os anexos de um aviso publicado já não se retiram."));
    // o ficheiro fica no armazenamento (nunca se apaga); só deixa de estar ligado ao aviso
    if (!(await repo.removeFile(id, fileId))) return fail(communicationError("NOT_FOUND", "Anexo não encontrado."));
    return ok({ removed: true as const });
  }

  /** Abrir um anexo: quem gere o aviso, ou quem o recebeu (só pela API, nunca por URL pública). */
  async file(repo: Repo, store: HrFileStore, id: string, fileId: string, who: { staff: StaffViewer } | { recipient: Who }) {
    const a = await repo.get(id);
    if (!a) return fail(communicationError("NOT_FOUND", "Anexo não encontrado."));
    if ("staff" in who) {
      const auth = await this.authority(repo, who.staff);
      const mine = this.canEdit(who.staff, a, auth.manage);
      const received = a.status === "PUBLISHED" && !!(await repo.recipient(id, { kind: "STAFF", id: who.staff.userId }));
      if (!mine && !received) return fail(communicationError("NOT_FOUND", "Anexo não encontrado."));
    } else if (a.status !== "PUBLISHED" || !(await repo.recipient(id, who.recipient))) return fail(communicationError("NOT_FOUND", "Anexo não encontrado."));
    const f = (await repo.files(id)).find((x) => x.id === fileId);
    if (!f) return fail(communicationError("NOT_FOUND", "Anexo não encontrado."));
    return ok({ fileName: f.fileName, mimeType: f.mimeType, content: await store.read(f.storageKey) });
  }

  // ================================================================ configuração

  async settingsView(repo: Repo, v: StaffViewer) {
    if (!has(v, P.settings)) return fail(communicationError("FORBIDDEN", "Configurar a comunicação exige a permissão de configurar a comunicação."));
    const [s, categories] = await Promise.all([repo.settings(), repo.categories(true)]);
    return ok({ classDirectorsPublish: s.classDirectorsPublish, studentsMessage: s.studentsMessage, staffMessage: s.staffMessage, teachersCreateGroups: s.teachersCreateGroups, updatedBy: s.updatedByName, updatedAt: iso(s.updatedAt), categories });
  }
  /** Guarda o que vier (o resto fica como está). */
  async saveSettings(repo: Repo, v: StaffViewer, s: Partial<CommunicationSettings>): R<{ saved: true }> {
    if (!has(v, P.settings)) return fail(communicationError("FORBIDDEN", "Configurar a comunicação exige a permissão de configurar a comunicação."));
    const cur = await repo.settings();
    const next: CommunicationSettings = {
      classDirectorsPublish: s.classDirectorsPublish ?? cur.classDirectorsPublish,
      studentsMessage: s.studentsMessage ?? cur.studentsMessage,
      staffMessage: s.staffMessage ?? cur.staffMessage,
      teachersCreateGroups: s.teachersCreateGroups ?? cur.teachersCreateGroups,
    };
    await repo.saveSettings(next, { id: v.userId, name: v.name }, this.clock.now());
    return ok({ saved: true as const });
  }
  async saveCategory(repo: Repo, v: StaffViewer, id: string | null, input: { name: string; archived?: boolean }): R<{ id: string }> {
    if (!has(v, P.settings)) return fail(communicationError("FORBIDDEN", "Configurar a comunicação exige a permissão de configurar a comunicação."));
    const c = checkCategory(input.name);
    if (!c.ok) return fail(communicationError("INVALID_INPUT", c.message));
    const same = await repo.categoryByName(c.value);
    if (same && same !== id) return fail(communicationError("NAME_TAKEN", "Já existe uma categoria com esse nome."));
    const now = this.clock.now();
    if (!id) {
      const nid = await repo.addCategory(c.value, now);
      await repo.activity("communication.category.created", nid, v.userId, { name: c.value }, now);
      return ok({ id: nid });
    }
    if (!(await repo.category(id))) return fail(communicationError("NOT_FOUND", "Categoria não encontrada."));
    if (input.archived && (await repo.categories()).length <= 1) return fail(communicationError("INVALID_STATE", "Tem de ficar pelo menos uma categoria ativa."));
    await repo.updateCategory(id, { name: c.value, archived: !!input.archived }, now);
    await repo.activity("communication.category.updated", id, v.userId, { name: c.value, archived: !!input.archived }, now);
    return ok({ id });
  }
}
