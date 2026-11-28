import { createHash } from "node:crypto";
import type { Clock } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import { checkUpload } from "../../documents/domain/issuing";
import type { HrFileStore } from "../../hr/application/employee-ports";
import { type CommunicationError, communicationError } from "../domain/announcements";
import { checkGroup, checkMessage, directKey, GROUP_AUDIENCE_LABELS, GROUP_TYPE_LABELS, MESSAGE_FILES_MAX } from "../domain/messages";
import type { Contact, ConversationRow, MemberRow, Party, PrismaConversationsRepository } from "../infrastructure/prisma-conversations";
import type { Notices } from "./Announcements";

type R<T> = Promise<Result<T, CommunicationError>>;
type Repo = PrismaConversationsRepository;
type Upload = { originalname: string; mimetype: string; buffer: Buffer };

/** Quem está a usar: alguém da equipa (com as permissões) ou uma conta da família. */
export type Me =
  | { party: Party & { kind: "STAFF" }; name: string; permissions: string[]; support: boolean }
  | { party: Party & { kind: "FAMILY" }; name: string; familyKind: "GUARDIAN" | "STUDENT" };
export interface Settings {
  studentsMessage: boolean;
  staffMessage: boolean;
  teachersCreateGroups: boolean;
}

const perm = (me: Me, p: string) => me.party.kind === "STAFF" && "permissions" in me && me.permissions.includes("communication.access") && me.permissions.includes(p);
const same = (a: Party, b: Party) => a.kind === b.kind && a.id === b.id;
const iso = (d: Date | null) => (d ? d.toISOString() : null);
const excerpt = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);
const SYNC_EVERY_MS = 10 * 60_000;
const NOT_FOUND = () => fail(communicationError("NOT_FOUND", "Conversa não encontrada."));

/**
 * MENSAGENS E GRUPOS — conversas privadas entre quem pode falar (relações académicas e configuração do
 * colégio, confirmadas aqui em cada conversa nova e em cada pessoa juntada), e grupos manuais ou ligados
 * a turmas, classes, departamentos ou à equipa (membros sincronizados; quem sai deixa de ver as novas,
 * o histórico fica). Ninguém lê conversas de que não é membro — nem a direção, nem o suporte.
 */
export class Conversations {
  constructor(private readonly clock: Clock) {}

  private async guard(me: Me): R<true> {
    if (me.party.kind === "STAFF" && "support" in me && me.support) return fail(communicationError("FORBIDDEN", "As sessões de suporte não acedem às mensagens."));
    return ok(true as const);
  }

  // ================================================================ contactos

  /** Com quem a pessoa pode iniciar uma conversa (o que o colégio permite e as relações académicas). */
  async contacts(repo: Repo, settings: Settings, me: Me, q: string | null, onlyId: string | null = null): Promise<Contact[]> {
    const query = q?.trim() || null;
    const matches = (c: Contact) => !query || c.name.toLowerCase().includes(query.toLowerCase()) || c.label.toLowerCase().includes(query.toLowerCase());
    if (me.party.kind === "FAMILY") {
      if ("familyKind" in me && me.familyKind === "STUDENT" && !settings.studentsMessage) return [];
      return (await repo.familyContacts(me.party.id, onlyId)).filter(matches);
    }
    const out = new Map<string, Contact>();
    const add = (list: Contact[]) => {
      for (const c of list) if (!out.has(`${c.kind}|${c.id}`)) out.set(`${c.kind}|${c.id}`, c);
    };
    add(await repo.teacherFamilies(me.party.id, query, onlyId));
    if (settings.staffMessage) add(await repo.staffContacts(me.party.id, query, onlyId));
    if (perm(me, "communication.messages.families")) add(await repo.allFamilies(query, onlyId));
    return [...out.values()].slice(0, 80);
  }
  private async reach(repo: Repo, settings: Settings, me: Me, target: Party) {
    if (same(me.party, target)) return null;
    // quem gere grupos junta qualquer pessoa da equipa
    if (target.kind === "STAFF" && perm(me, "communication.groups.manage")) {
      const s = await repo.staffName(target.id);
      return s?.active ? ({ ...target, name: s.name, label: "Equipa" } as Contact) : null;
    }
    return (await this.contacts(repo, settings, me, null, target.id)).find((c) => same(c, target)) ?? null;
  }

  /** Quem é `target` para `viewer` (a etiqueta que viewer vê). */
  private async labelFor(repo: Repo, viewer: Party, target: Party) {
    if (viewer.kind === "STAFF" && target.kind === "FAMILY") {
      const r = (await repo.teacherFamilies(viewer.id, null, target.id))[0];
      if (r) return r.label;
      return (await repo.familyAccount(target.id))?.kind === "STUDENT" ? "Aluno" : "Encarregado";
    }
    if (viewer.kind === "FAMILY" && target.kind === "STAFF") return (await repo.familyContacts(viewer.id, target.id))[0]?.label ?? "Colégio";
    if (viewer.kind === "STAFF" && target.kind === "STAFF") return (await repo.staffContacts(viewer.id, null, target.id))[0]?.label ?? "Equipa";
    return "";
  }

  async contactList(repo: Repo, settings: Settings, me: Me, q: string | null) {
    const g = await this.guard(me);
    if (!g.ok) return g;
    return ok({ contacts: await this.contacts(repo, settings, me, q), canCreateGroups: await this.canCreateGroups(repo, settings, me) });
  }

  // ================================================================ conversas individuais

  /** Abre (ou cria) a conversa com uma pessoa a quem se pode escrever. */
  async startDirect(repo: Repo, settings: Settings, me: Me, target: Party): R<{ id: string; created: boolean }> {
    const g = await this.guard(me);
    if (!g.ok) return g;
    if (same(me.party, target)) return fail(communicationError("INVALID_INPUT", "Não pode iniciar uma conversa consigo."));
    const key = directKey(me.party, target);
    const existing = await repo.directByKey(key);
    if (existing && (await repo.member(existing, me.party))) return ok({ id: existing, created: false });
    const other = await this.reach(repo, settings, me, target);
    if (!other) return fail(communicationError("FORBIDDEN", me.party.kind === "FAMILY" ? "Só pode escrever aos professores e ao diretor de turma dos seus educandos." : "Não pode iniciar uma conversa com esta pessoa."));
    const now = this.clock.now();
    // como o outro me vê (ex.: o professor vê "Encarregado de Pedro (7.ª B)")
    const myLabel = await this.labelFor(repo, other, me.party);
    const id = await repo.transaction(async (tx) => {
      const id = (await tx.createConversation({ kind: "DIRECT", directKey: key, by: me.party }, now)) ?? (await tx.directByKey(key))!;
      await tx.addMember(id, { ...me.party, name: me.name, label: myLabel }, "MEMBER", "MANUAL", now);
      await tx.addMember(id, other, "MEMBER", "MANUAL", now);
      await tx.activity("communication.conversation.created", id, me.party.kind === "STAFF" ? me.party.id : null, { kind: "DIRECT", by: me.party.kind, with: target.kind }, now);
      return id;
    });
    return ok({ id, created: !existing });
  }

  // ================================================================ lista, leitura, envio

  async list(repo: Repo, me: Me, f: { archived?: boolean; q?: string | null }) {
    const g = await this.guard(me);
    if (!g.ok) return g;
    await repo.markDelivered(me.party, this.clock.now());
    const rows = await repo.list(me.party, { archived: !!f.archived, q: f.q?.trim() || null });
    return ok({
      items: rows.map((c) => ({
        id: c.id,
        kind: c.kind,
        title: c.kind === "DIRECT" ? (c.other ?? "Conversa") : (c.title ?? "Grupo"),
        subtitle: c.kind === "DIRECT" ? c.otherLabel : `${c.groupType && c.groupType !== "MANUAL" ? `${GROUP_TYPE_LABELS[c.groupType]} · ` : ""}${c.members} membros`,
        with: c.otherParty ? { kind: c.otherParty.split(":")[0] as Party["kind"], id: c.otherParty.split(":")[1] } : null,
        groupType: c.groupType,
        unread: c.unread,
        left: !!c.leftAt,
        archived: c.archived,
        last: c.lastAt ? { body: c.lastKind === "SYSTEM" ? c.lastBody : excerpt(c.lastBody ?? ""), sender: c.lastSender, system: c.lastKind === "SYSTEM", at: iso(c.lastAt) } : null,
      })),
    });
  }

  async unread(repo: Repo, me: Me) {
    if (me.party.kind === "STAFF" && "support" in me && me.support) return { messages: 0, conversations: 0 };
    const r = await repo.unreadTotal(me.party);
    return { messages: r.n, conversations: r.conversations };
  }

  private async load(repo: Repo, me: Me, id: string) {
    const c = await repo.conversation(id);
    const m = c ? await repo.member(id, me.party) : null;
    return c && m ? { c, m } : null;
  }

  private can(c: ConversationRow, m: MemberRow) {
    const active = !m.leftAt;
    const admin = active && m.role === "ADMIN";
    const group = c.kind === "GROUP";
    return {
      send: active && (!group || !c.onlyAdminsPost || admin),
      manage: group && admin,
      add: group && active && (admin || c.membersCanAdd),
      leave: group && active,
    };
  }

  /** A conversa: dados, membros e o que a pessoa pode fazer (os grupos ligados sincronizam-se se for tempo). */
  async view(repo: Repo, notices: Notices, me: Me, id: string) {
    const g = await this.guard(me);
    if (!g.ok) return g;
    const l = await this.load(repo, me, id);
    if (!l) return NOT_FOUND();
    if (l.c.kind === "GROUP" && l.c.groupType && l.c.groupType !== "MANUAL" && (!l.c.syncedAt || this.clock.now().getTime() - l.c.syncedAt.getTime() > SYNC_EVERY_MS)) await this.sync(repo, notices, id);
    const members = await repo.members(id);
    const c = l.c;
    const other = c.kind === "DIRECT" ? members.find((x) => !same(x, me.party)) : null;
    const linked = c.groupType && c.groupType !== "MANUAL" ? `${GROUP_TYPE_LABELS[c.groupType]}${c.refId ? ` ${(await repo.targetLabel(c.groupType, c.refId)) ?? ""}` : c.refText ? ` ${c.refText}` : ""}${c.audience && c.audience !== "STAFF" ? ` · ${GROUP_AUDIENCE_LABELS[c.audience]}` : ""}` : null;
    return ok({
      id: c.id,
      kind: c.kind,
      title: c.kind === "DIRECT" ? (other?.name ?? "Conversa") : (c.title ?? "Grupo"),
      subtitle: c.kind === "DIRECT" ? (other?.label ?? null) : (c.description ?? null),
      groupType: c.groupType,
      linked,
      onlyAdminsPost: c.onlyAdminsPost,
      membersCanAdd: c.membersCanAdd,
      me: { kind: me.party.kind, id: me.party.id, role: l.m.role, left: !!l.m.leftAt, archived: l.m.archived },
      members: members.filter((x) => !x.leftAt).map((x) => ({ kind: x.kind, id: x.id, name: x.name, label: x.label, role: x.role, source: x.source, me: same(x, me.party) })),
      can: this.can(c, l.m),
    });
  }

  /** As mensagens (desde que a pessoa entrou e até sair): ?antes= para trás, ?depois= as novas (consulta curta). */
  async messages(repo: Repo, me: Me, id: string, cursor: { before?: string | null; after?: string | null }) {
    const g = await this.guard(me);
    if (!g.ok) return g;
    const l = await this.load(repo, me, id);
    if (!l) return NOT_FOUND();
    const now = this.clock.now();
    if (!l.m.leftAt) await repo.markDelivered(me.party, now);
    const parse = (v: string | null | undefined) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v) : null);
    const rows = await repo.messages(id, { from: l.m.joinedAt, to: l.m.leftAt }, { before: parse(cursor.before), after: parse(cursor.after) }, cursor.after ? 200 : 50);
    const files = await repo.files(rows.map((r) => r.id));
    const members = await repo.members(id);
    // os outros (para os recibos: entregue e lido)
    const others = members.filter((x) => !same(x, me.party) && !x.leftAt).map((x) => ({ deliveredAt: iso(x.deliveredAt), readAt: iso(x.lastReadAt) }));
    return ok({
      items: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        sender: r.senderKind && r.senderId ? { kind: r.senderKind, id: r.senderId, name: r.senderName } : null,
        mine: r.senderKind === me.party.kind && r.senderId === me.party.id,
        body: r.body,
        at: r.createdAt.toISOString(),
        files: files.filter((f) => f.messageId === r.id).map((f) => ({ id: f.id, fileName: f.fileName, mimeType: f.mimeType, size: f.size })),
      })),
      hasMore: !cursor.after && rows.length === 50,
      others,
      serverTime: now.toISOString(),
    });
  }

  async send(repo: Repo, store: HrFileStore, notices: Notices, me: Me, id: string, body: unknown, files: Upload[]): R<{ id: string; at: string }> {
    const g = await this.guard(me);
    if (!g.ok) return g;
    const l = await this.load(repo, me, id);
    if (!l) return NOT_FOUND();
    const can = this.can(l.c, l.m);
    if (!can.send) return fail(communicationError(l.m.leftAt ? "INVALID_STATE" : "FORBIDDEN", l.m.leftAt ? "Já não faz parte deste grupo." : "Neste grupo só os administradores escrevem."));
    const c = checkMessage(body, files.length);
    if (!c.ok) return fail(communicationError("INVALID_INPUT", c.message));
    const checked = [];
    for (const f of files) {
      const u = checkUpload(f);
      if (!u.ok) return fail(communicationError("INVALID_INPUT", `“${f.originalname}”: ${u.message}`));
      checked.push({ f, u });
    }
    if (checked.length && !store.ready) return fail(communicationError("NOT_AVAILABLE", "O armazenamento de ficheiros deste colégio ainda não está configurado: fale com a EduFlow."));
    const saved: { key: string; name: string; mime: string; buffer: Buffer }[] = [];
    for (const { f, u } of checked) saved.push({ key: (await store.save(`communication/messages/${id}`, { fileName: u.name, mimeType: u.mime, content: f.buffer })).key, name: u.name, mime: u.mime, buffer: f.buffer });
    const now = this.clock.now();
    const notify = await repo.toNotify(id, me.party, now);
    const mid = await repo.transaction(async (tx) => {
      const mid = await tx.addMessage(id, { kind: "TEXT", sender: { ...me.party, name: me.name }, body: c.value }, now);
      for (const s of saved) await tx.addFile(id, mid, { fileName: s.name, mimeType: s.mime, size: s.buffer.length, sha256: createHash("sha256").update(s.buffer).digest("hex"), storageKey: s.key }, now);
      await tx.markRead(id, me.party, now);
      return mid;
    });
    // uma notificação por pessoa até ler a conversa (não uma por mensagem)
    const title = l.c.kind === "DIRECT" ? `Mensagem de ${me.name}` : `${l.c.title ?? "Grupo"}: ${me.name}`;
    const text = c.value ? excerpt(c.value) : `${saved.length} ficheiro(s)`;
    const staff = notify.filter((p) => p.kind === "STAFF").map((p) => p.id);
    if (staff.length) await notices.staff.notify({ kind: "MESSAGES", userIds: staff, title, body: text, link: `/comunicacao/mensagens/${id}`, dedupeKey: `message:${id}:${now.getTime()}` });
    for (const p of notify.filter((x) => x.kind === "FAMILY")) await notices.family(p.id, { kind: "FAMILY_MESSAGES", title, body: text, link: `/familia/mensagens/${id}` });
    return ok({ id: mid, at: now.toISOString() });
  }

  async read(repo: Repo, me: Me, id: string): R<{ read: true }> {
    const l = await this.load(repo, me, id);
    if (!l) return NOT_FOUND();
    await repo.markRead(id, me.party, this.clock.now());
    return ok({ read: true as const });
  }

  async archive(repo: Repo, me: Me, id: string, archived: boolean): R<{ archived: boolean }> {
    const l = await this.load(repo, me, id);
    if (!l) return NOT_FOUND();
    await repo.setArchived(id, me.party, archived);
    return ok({ archived });
  }

  /** Um anexo: só quem é (ou foi) membro e só das mensagens que podia ler. */
  async file(repo: Repo, store: HrFileStore, me: Me, id: string, fileId: string) {
    const g = await this.guard(me);
    if (!g.ok) return g;
    const l = await this.load(repo, me, id);
    const f = l ? await repo.file(id, fileId) : null;
    if (!l || !f || f.createdAt < l.m.joinedAt || (l.m.leftAt && f.createdAt > l.m.leftAt)) return fail(communicationError("NOT_FOUND", "Ficheiro não encontrado."));
    return ok({ fileName: f.fileName, mimeType: f.mimeType, content: await store.read(f.storageKey) });
  }

  // ================================================================ fotografias de perfil

  /** A fotografia de alguém: a própria, de quem partilha uma conversa comigo, ou de um contacto meu. */
  async avatar(repo: Repo, settings: Settings, store: HrFileStore, me: Me, target: Party) {
    const g = await this.guard(me);
    if (!g.ok) return g;
    const allowed = same(me.party, target) || (await repo.shareConversation(me.party, target)) || !!(await this.reach(repo, settings, me, target));
    const p = allowed ? await repo.photo(target) : null;
    if (!p) return fail(communicationError("NOT_FOUND", "Sem fotografia."));
    try {
      return ok({ fileName: p.mimeType === "image/png" ? "foto.png" : "foto.jpg", mimeType: p.mimeType, content: await store.read(p.storageKey) });
    } catch {
      return fail(communicationError("NOT_FOUND", "Sem fotografia."));
    }
  }

  async myPhoto(repo: Repo, me: Me) {
    const [own, any] = await Promise.all([repo.hasOwnPhoto(me.party), repo.photo(me.party)]);
    return { own, photo: !!any };
  }

  /** Escolher outra fotografia (JPG ou PNG até 5 MB, com o tipo real verificado); a anterior fica guardada. */
  async uploadPhoto(repo: Repo, store: HrFileStore, me: Me, file: Upload | undefined): R<{ saved: true }> {
    const g = await this.guard(me);
    if (!g.ok) return g;
    const u = checkUpload(file);
    if (!u.ok) return fail(communicationError("INVALID_INPUT", u.message));
    if (u.mime === "application/pdf") return fail(communicationError("INVALID_INPUT", "A fotografia tem de ser JPG ou PNG."));
    if (file!.buffer.length > 5 * 1024 * 1024) return fail(communicationError("INVALID_INPUT", "A fotografia tem mais de 5 MB."));
    if (!store.ready) return fail(communicationError("NOT_AVAILABLE", "O armazenamento de ficheiros deste colégio ainda não está configurado: fale com a EduFlow."));
    const saved = await store.save(`communication/profile/${me.party.kind.toLowerCase()}-${me.party.id}`, { fileName: u.name, mimeType: u.mime, content: file!.buffer });
    await repo.setPhoto(me.party, { storageKey: saved.key, mimeType: u.mime }, this.clock.now());
    return ok({ saved: true as const });
  }
  async removePhoto(repo: Repo, me: Me): R<{ removed: true }> {
    await repo.setPhoto(me.party, null, this.clock.now());
    return ok({ removed: true as const });
  }

  // ================================================================ grupos

  private async canCreateGroups(repo: Repo, settings: Settings, me: Me) {
    if (me.party.kind !== "STAFF") return { manual: false, linked: false, myGroups: [] as { id: string; label: string }[] };
    if (perm(me, "communication.groups.manage")) return { manual: true, linked: true, myGroups: [] as { id: string; label: string }[], ...(await repo.groupOptions()) };
    if (!settings.teachersCreateGroups) return { manual: false, linked: false, myGroups: [] };
    const groups = await repo.teachingGroups(me.party.id);
    return {
      manual: groups.length > 0,
      linked: false,
      myGroups: groups.filter((x) => x.coordinator).map((x) => {
        const [grade, course, name] = x.label.split("|");
        return { id: x.id, label: `${grade}.ª${course ? ` ${course}` : ""} · ${name}` };
      }),
    };
  }

  /** Criar um grupo: manual (com quem a pessoa pode falar) ou ligado (turma, classe, departamento, equipa). */
  async createGroup(repo: Repo, settings: Settings, notices: Notices, me: Me, input: Record<string, unknown>, members: Party[]): R<{ id: string; members: number }> {
    const g = await this.guard(me);
    if (!g.ok) return g;
    if (me.party.kind !== "STAFF") return fail(communicationError("FORBIDDEN", "As famílias não criam grupos."));
    const c = checkGroup(input);
    if (!c.ok) return fail(communicationError("INVALID_INPUT", c.message));
    const auth = await this.canCreateGroups(repo, settings, me);
    const v = c.value;
    const ownClass = v.groupType === "CLASS" && auth.myGroups.some((x) => x.id === v.refId);
    if (v.groupType === "MANUAL" ? !auth.manual : !(auth.linked || ownClass)) return fail(communicationError("FORBIDDEN", v.groupType === "CLASS" ? "Só cria o grupo das turmas que dirige (ou com a permissão de gerir grupos)." : "Não pode criar este grupo."));
    if (members.length > 300) return fail(communicationError("INVALID_INPUT", "No máximo 300 pessoas de cada vez."));
    const chosen: Contact[] = [];
    for (const p of members) {
      if (same(p, me.party)) continue;
      const r = await this.reach(repo, settings, me, p);
      if (!r) return fail(communicationError("FORBIDDEN", "Só pode juntar pessoas com quem pode falar."));
      chosen.push(r);
    }
    const linked = v.groupType !== "MANUAL" ? await repo.expected(v.groupType, v.refId, v.refText, v.audience) : [];
    if (v.groupType === "MANUAL" && !chosen.length) return fail(communicationError("INVALID_INPUT", "Escolha pelo menos uma pessoa."));
    const now = this.clock.now();
    const added: Contact[] = [];
    const id = await repo.transaction(async (tx) => {
      const id = (await tx.createConversation({ kind: "GROUP", ...v, by: me.party }, now))!;
      await tx.addMember(id, { ...me.party, name: me.name, label: "Criou o grupo" }, "ADMIN", "MANUAL", now);
      for (const x of linked) if (!same(x, me.party) && (await tx.addMember(id, x, "MEMBER", "SYNC", now))) added.push(x);
      for (const x of chosen) if (await tx.addMember(id, x, "MEMBER", "MANUAL", now)) added.push(x);
      await tx.addMessage(id, { kind: "SYSTEM", sender: null, body: `${me.name} criou o grupo “${v.title}”.` }, now);
      await tx.activity("communication.group.created", id, me.party.id, { title: v.title, groupType: v.groupType, members: added.length + 1 }, now);
      return id;
    });
    await this.notifyAdded(notices, id, v.title, added);
    return ok({ id, members: added.length + 1 });
  }

  private async notifyAdded(notices: Notices, id: string, title: string, added: Party[]) {
    const staff = added.filter((p) => p.kind === "STAFF").map((p) => p.id);
    if (staff.length) await notices.staff.notify({ kind: "GROUP_ADDED", userIds: staff, title: `Foi adicionado ao grupo “${title}”`, body: null, link: `/comunicacao/mensagens/${id}`, dedupeKey: `group:${id}:${Date.now()}` });
    for (const p of added.filter((x) => x.kind === "FAMILY")) await notices.family(p.id, { kind: "FAMILY_GROUP_ADDED", title: `Foi adicionado ao grupo “${title}”`, body: null, link: `/familia/mensagens/${id}` });
  }

  private async admin(repo: Repo, me: Me, id: string) {
    const l = await this.load(repo, me, id);
    if (!l || l.c.kind !== "GROUP") return null;
    return l;
  }

  async updateGroup(repo: Repo, me: Me, id: string, input: { title?: unknown; description?: unknown; onlyAdminsPost?: unknown; membersCanAdd?: unknown }): R<{ saved: true }> {
    const l = await this.admin(repo, me, id);
    if (!l) return NOT_FOUND();
    if (!this.can(l.c, l.m).manage) return fail(communicationError("FORBIDDEN", "Só os administradores do grupo o alteram."));
    const c = checkGroup({ ...input, groupType: "MANUAL" });
    if (!c.ok) return fail(communicationError("INVALID_INPUT", c.message));
    const now = this.clock.now();
    await repo.transaction(async (tx) => {
      await tx.updateGroup(id, { title: c.value.title, description: c.value.description, onlyAdminsPost: c.value.onlyAdminsPost, membersCanAdd: c.value.membersCanAdd }, now);
      if (c.value.title !== l.c.title) await tx.addMessage(id, { kind: "SYSTEM", sender: null, body: `${me.name} mudou o nome do grupo para “${c.value.title}”.` }, now);
      await tx.activity("communication.group.updated", id, me.party.kind === "STAFF" ? me.party.id : null, { title: c.value.title, onlyAdminsPost: c.value.onlyAdminsPost, membersCanAdd: c.value.membersCanAdd }, now);
    });
    return ok({ saved: true as const });
  }

  async addMembers(repo: Repo, settings: Settings, notices: Notices, me: Me, id: string, people: Party[]): R<{ added: number }> {
    const l = await this.admin(repo, me, id);
    if (!l) return NOT_FOUND();
    if (!this.can(l.c, l.m).add) return fail(communicationError("FORBIDDEN", "Só os administradores juntam pessoas a este grupo."));
    if (!people.length || people.length > 300) return fail(communicationError("INVALID_INPUT", "Escolha entre 1 e 300 pessoas."));
    const chosen: Contact[] = [];
    for (const p of people) {
      const r = await this.reach(repo, settings, me, p);
      if (!r) return fail(communicationError("FORBIDDEN", "Só pode juntar pessoas com quem pode falar."));
      chosen.push(r);
    }
    const now = this.clock.now();
    const added: Contact[] = [];
    await repo.transaction(async (tx) => {
      for (const x of chosen) if (await tx.addMember(id, x, "MEMBER", "MANUAL", now)) added.push(x);
      if (added.length) {
        await tx.addMessage(id, { kind: "SYSTEM", sender: null, body: `${me.name} adicionou ${added.map((x) => x.name).join(", ")}.` }, now);
        await tx.activity("communication.group.members_added", id, me.party.kind === "STAFF" ? me.party.id : null, { count: added.length }, now);
      }
    });
    await this.notifyAdded(notices, id, l.c.title ?? "Grupo", added);
    return ok({ added: added.length });
  }

  async removeMember(repo: Repo, me: Me, id: string, target: Party): R<{ removed: true }> {
    const l = await this.admin(repo, me, id);
    if (!l) return NOT_FOUND();
    if (!this.can(l.c, l.m).manage) return fail(communicationError("FORBIDDEN", "Só os administradores retiram pessoas."));
    if (same(target, me.party)) return fail(communicationError("INVALID_INPUT", "Para sair, use “Sair do grupo”."));
    const t = await repo.member(id, target);
    if (!t || t.leftAt) return fail(communicationError("NOT_FOUND", "Esta pessoa não está no grupo."));
    const now = this.clock.now();
    await repo.transaction(async (tx) => {
      await tx.removeMember(id, target, "MANUAL", now);
      await tx.addMessage(id, { kind: "SYSTEM", sender: null, body: `${me.name} retirou ${t.name}.` }, now);
      await tx.activity("communication.group.member_removed", id, me.party.kind === "STAFF" ? me.party.id : null, { member: target.kind }, now);
    });
    return ok({ removed: true as const });
  }

  async setAdmin(repo: Repo, me: Me, id: string, target: Party, admin: boolean): R<{ saved: true }> {
    const l = await this.admin(repo, me, id);
    if (!l) return NOT_FOUND();
    if (!this.can(l.c, l.m).manage) return fail(communicationError("FORBIDDEN", "Só os administradores mudam os administradores."));
    const t = await repo.member(id, target);
    if (!t || t.leftAt) return fail(communicationError("NOT_FOUND", "Esta pessoa não está no grupo."));
    if (!admin && (await repo.members(id)).filter((x) => !x.leftAt && x.role === "ADMIN").length <= 1) return fail(communicationError("INVALID_STATE", "O grupo tem de ficar com pelo menos um administrador."));
    const now = this.clock.now();
    await repo.transaction(async (tx) => {
      await tx.setRole(id, target, admin ? "ADMIN" : "MEMBER");
      await tx.activity("communication.group.role", id, me.party.kind === "STAFF" ? me.party.id : null, { admin }, now);
    });
    return ok({ saved: true as const });
  }

  /** Sair: deixa de ver as mensagens novas (o que já lá estava fica). O último administrador passa o papel a outro. */
  async leave(repo: Repo, me: Me, id: string): R<{ left: true }> {
    const l = await this.admin(repo, me, id);
    if (!l) return NOT_FOUND();
    if (l.m.leftAt) return fail(communicationError("INVALID_STATE", "Já saiu deste grupo."));
    const now = this.clock.now();
    await repo.transaction(async (tx) => {
      const others = (await tx.members(id)).filter((x) => !x.leftAt && !same(x, me.party));
      if (l.m.role === "ADMIN" && !others.some((x) => x.role === "ADMIN")) {
        const next = others.find((x) => x.kind === "STAFF") ?? others[0];
        if (next) await tx.setRole(id, next, "ADMIN");
      }
      await tx.removeMember(id, me.party, "MANUAL", now);
      await tx.addMessage(id, { kind: "SYSTEM", sender: null, body: `${me.name} saiu do grupo.` }, now);
      await tx.activity("communication.group.left", id, me.party.kind === "STAFF" ? me.party.id : null, { member: me.party.kind }, now);
    });
    return ok({ left: true as const });
  }

  /**
   * Sincroniza um grupo ligado com as relações do colégio: entra quem passou a pertencer (e quem saiu
   * só pela sincronização volta), sai quem deixou de pertencer. Quem saiu ou foi retirado à mão fica fora.
   */
  async sync(repo: Repo, notices: Notices, id: string) {
    const c = await repo.conversation(id);
    if (!c || c.kind !== "GROUP" || !c.groupType || c.groupType === "MANUAL") return { added: 0, removed: 0 };
    const now = this.clock.now();
    const expected = await repo.expected(c.groupType, c.refId, c.refText, c.audience);
    const current = await repo.members(id);
    const key = (p: Party) => `${p.kind}|${p.id}`;
    const want = new Map(expected.map((x) => [key(x), x]));
    const added: Contact[] = [];
    const removed: MemberRow[] = [];
    await repo.transaction(async (tx) => {
      for (const x of expected) {
        const cur = current.find((m) => key(m) === key(x));
        if (!cur || (cur.leftAt && cur.source === "SYNC")) {
          if (await tx.addMember(id, x, "MEMBER", "SYNC", now)) added.push(x);
        } else if (!cur.leftAt && x.label) await tx.refreshLabel(id, x, x.label);
      }
      for (const m of current) if (!m.leftAt && m.source === "SYNC" && !want.has(key(m))) {
        await tx.removeMember(id, m, "SYNC", now);
        removed.push(m);
      }
      if (added.length || removed.length) {
        const parts = [added.length ? `Entraram: ${added.slice(0, 8).map((x) => x.name).join(", ")}${added.length > 8 ? ` e mais ${added.length - 8}` : ""}` : null, removed.length ? `Saíram: ${removed.slice(0, 8).map((x) => x.name).join(", ")}${removed.length > 8 ? ` e mais ${removed.length - 8}` : ""}` : null];
        await tx.addMessage(id, { kind: "SYSTEM", sender: null, body: `${parts.filter(Boolean).join(" · ")} (atualizado pelo colégio).` }, now);
        await tx.activity("communication.group.synced", id, null, { added: added.length, removed: removed.length }, now);
      }
      await tx.markSynced(id, now);
    });
    if (added.length) await this.notifyAdded(notices, id, c.title ?? "Grupo", added);
    return { added: added.length, removed: removed.length };
  }

  /** O ciclo das tarefas automáticas: os grupos ligados que não se sincronizam há algum tempo. */
  async syncAll(repo: Repo, notices: Notices) {
    let n = 0;
    for (const g of await repo.linkedGroups()) {
      const c = await repo.conversation(g.id);
      if (c?.syncedAt && this.clock.now().getTime() - c.syncedAt.getTime() < SYNC_EVERY_MS) continue;
      const r = await this.sync(repo, notices, g.id);
      if (r.added || r.removed) n++;
    }
    return n;
  }
}

export { MESSAGE_FILES_MAX };
