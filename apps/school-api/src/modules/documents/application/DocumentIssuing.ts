import { createHash } from "node:crypto";
import type { Clock } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import type { HrFileStore } from "../../hr/application/employee-ports";
import { isCardCategory } from "../domain/cards";
import { canDownload, canIssue, type DocumentsError, documentsError, STATUS_LABELS } from "../domain/documents";
import { allowedFor, checkTemplate, fieldKey, fill, longDate, placeholderLabel, SHIFTS, type TemplateInput, checkUpload } from "../domain/issuing";
import { type OfficialHeader, renderDocumentPdf } from "../infrastructure/pdf";
import type { Actor, PrismaDocumentsRepository, RequestRow, TypeRow } from "../infrastructure/prisma-documents";
import { type DocumentRequests, type Notices, snapshotOf, today } from "./DocumentRequests";
import { can, type DocumentsViewer } from "./DocumentTypes";
import type { StudentCards } from "./StudentCards";

type R<T> = Promise<Result<T, DocumentsError>>;
type Repo = PrismaDocumentsRepository;
export interface School {
  name: string;
  /** o logótipo que se imprime (PNG ou JPG) */
  logo: Buffer | null;
  /** o cabeçalho oficial (null = o colégio retirou-o) */
  header: OfficialHeader | null;
  /** o colégio no endereço do portal (o QR dos cartões aponta para lá) */
  slug: string;
}
export interface FileOut {
  fileName: string;
  mimeType: string;
  content: Buffer;
}
type Upload = { originalname: string; mimetype: string; buffer: Buffer } | undefined;
const dmy = (iso: string | null | undefined) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : null);
const slug = (t: string) =>
  t
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
const clean = (v: unknown, max: number) =>
  String(v ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

/**
 * EMISSÃO DE DOCUMENTOS — os modelos (com versões) de cada tipo, a geração automática do PDF com os
 * dados que o colégio já tem, o documento preparado fora e carregado, e os downloads protegidos.
 * Os ficheiros ficam cifrados no armazenamento do próprio colégio; só a API os entrega.
 */
export class DocumentIssuing {
  constructor(
    private readonly clock: Clock,
    private readonly requests: DocumentRequests,
    private readonly cards: StudentCards,
  ) {}

  // ================================================================ modelos

  async templateView(repo: Repo, v: DocumentsViewer, typeId: string) {
    const t = await repo.type(typeId);
    if (!t || !(can(v, t.audience, "settings") || can(v, t.audience, "view"))) return fail(documentsError("NOT_FOUND", "Documento não encontrado."));
    const versions = await repo.templates(typeId);
    return ok({
      type: { id: t.id, name: t.name, audience: t.audience, method: t.method, fields: t.fields },
      can: { manage: can(v, t.audience, "settings") },
      placeholders: allowedFor(t.audience, t.fields),
      current: versions[0] ?? null,
      versions: versions.map((x) => ({ version: x.version, title: x.title, signerName: x.signerName, signerRole: x.signerRole, by: x.createdByName, at: x.createdAt.toISOString() })),
    });
  }

  async saveTemplate(repo: Repo, v: DocumentsViewer, actor: Actor, typeId: string, input: TemplateInput): R<{ version: number }> {
    const t = await repo.type(typeId);
    if (!t) return fail(documentsError("NOT_FOUND", "Documento não encontrado."));
    if (!can(v, t.audience, "settings")) return fail(documentsError("FORBIDDEN", "Configurar os modelos exige a permissão de configurar estes documentos."));
    const c = checkTemplate(input, t.audience, t.fields);
    if (!c.ok) return fail(documentsError("INVALID_INPUT", c.message));
    const cur = await repo.latestTemplate(typeId);
    if (cur && cur.title === c.value.title && cur.body === c.value.body && cur.signerName === c.value.signerName && cur.signerRole === c.value.signerRole && cur.showLogo === c.value.showLogo) return ok({ version: cur.version });
    return ok({ version: await repo.addTemplate(typeId, c.value, actor, this.clock.now()) });
  }

  /** Pré-visualizar um modelo (mesmo por guardar) com dados de exemplo. */
  async previewTemplate(repo: Repo, v: DocumentsViewer, typeId: string, input: TemplateInput, school: School): R<FileOut> {
    const t = await repo.type(typeId);
    if (!t || !(can(v, t.audience, "settings") || can(v, t.audience, "view"))) return fail(documentsError("NOT_FOUND", "Documento não encontrado."));
    const c = checkTemplate(input, t.audience, t.fields);
    if (!c.ok) return fail(documentsError("INVALID_INPUT", c.message));
    const example = Object.fromEntries(allowedFor(t.audience, t.fields).map((p) => [p.key, p.example]));
    example.institution_name = school.name;
    example.issue_date = longDate(today(this.clock.now()));
    const pdf = await renderDocumentPdf({
      school: school.name,
      logo: c.value.showLogo ? school.logo : null,
      header: school.header,
      title: fill(c.value.title, example).text,
      body: fill(c.value.body, example).text,
      signerName: c.value.signerName,
      signerRole: c.value.signerRole,
      footer: "Pré-visualização com dados de exemplo · não é um documento válido",
      watermark: "PRÉ-VISUALIZAÇÃO",
    });
    return ok({ fileName: `modelo-${slug(t.name)}.pdf`, mimeType: "application/pdf", content: pdf });
  }

  // ================================================================ os dados do documento

  /** Os valores dos campos com os dados ATUAIS do colégio (o aluno ou o funcionário de hoje). */
  private async values(repo: Repo, r: RequestRow, school: School) {
    const v: Record<string, string | null> = {
      institution_name: school.name,
      document_number: this.requests.ref(r),
      issue_date: longDate(today(this.clock.now())),
      requester_name: r.requesterName,
    };
    if (r.studentId) {
      const s = await repo.studentSnapshot(r.studentId);
      Object.assign(v, { student_name: s?.name ?? null, student_number: s?.number ?? null, student_id_number: await repo.idNumber("STUDENT", r.studentId), birth_date: dmy(s?.birthDate), class_name: s?.classLabel ?? null, group_name: s?.groupName ?? null, academic_year: s?.yearName ?? null, shift: s?.shift ? (SHIFTS[s.shift] ?? s.shift) : null });
    }
    if (r.employeeId) {
      const e = await repo.employeeSnapshot(r.employeeId);
      Object.assign(v, { employee_name: e?.name ?? null, employee_number: e?.number ?? null, employee_id_number: await repo.idNumber("EMPLOYEE", r.employeeId), employee_position: e?.jobTitle ?? null, employee_department: e?.department ?? null });
    }
    for (const [k, value] of Object.entries(r.answers)) v[fieldKey(k)] = value;
    return v;
  }

  /** Preenche o modelo; se faltar algum dado, não emite (diz o que falta). */
  private async compose(repo: Repo, r: RequestRow, type: TypeRow, school: School) {
    const tpl = await repo.latestTemplate(type.id);
    if (!tpl) return fail(documentsError("INVALID_STATE", "Este documento ainda não tem modelo: configure-o em “Documentos que se podem pedir”."));
    const values = await this.values(repo, r, school);
    const title = fill(tpl.title, values);
    const body = fill(tpl.body, values);
    const missing = [...new Set([...title.missing, ...body.missing])];
    if (missing.length) {
      const labels = missing.map((k) => placeholderLabel(k, type.fields));
      return fail(documentsError("INCOMPLETE", `Faltam dados para emitir este documento: ${labels.join(", ")}. Complete-os (na ficha ou no pedido) antes de emitir.`, { missing: labels }));
    }
    return ok({ tpl, title: title.text, body: body.text });
  }

  private async load(repo: Repo, v: DocumentsViewer, id: string) {
    const r = await repo.request(id);
    if (!r || !can(v, r.audience, "view")) return null;
    return r;
  }

  /** Pré-visualizar o documento do pedido (não fica guardado). */
  async previewRequest(repo: Repo, store: HrFileStore, v: DocumentsViewer, id: string, school: School): R<FileOut> {
    const r = await this.load(repo, v, id);
    if (!r) return fail(documentsError("NOT_FOUND", "Pedido não encontrado."));
    // um cartão de estudante pré-visualiza-se com o modelo do cartão
    if (isCardCategory(r.category)) return r.studentId ? this.cards.previewForRequest(repo.cards(), store, r.studentId, school) : fail(documentsError("INVALID_STATE", "Os cartões são só de alunos."));
    const type = await repo.type(r.typeId);
    if (!type) return fail(documentsError("NOT_FOUND", "Documento não encontrado."));
    const c = await this.compose(repo, r, type, school);
    if (!c.ok) return c;
    const pdf = await renderDocumentPdf({ school: school.name, logo: c.value.tpl.showLogo ? school.logo : null, header: school.header, title: c.value.title, body: c.value.body, signerName: c.value.tpl.signerName, signerRole: c.value.tpl.signerRole, footer: `Pré-visualização do pedido ${this.requests.ref(r)} · ainda não emitido`, watermark: "PRÉ-VISUALIZAÇÃO" });
    return ok({ fileName: `previsualizacao-${this.requests.ref(r)}.pdf`, mimeType: "application/pdf", content: pdf });
  }

  private replaceCheck(r: RequestRow, hasFile: boolean, reason: string) {
    if (!canIssue(r.status)) return `Só se emite um documento em processamento, pronto ou concluído (este está “${STATUS_LABELS[r.status]}”).`;
    if (hasFile && reason.length < 3) return r.status === "COMPLETED" ? "Indique o motivo da segunda via (3 a 300 caracteres)." : "Já há um documento emitido: indique porque o substitui (3 a 300 caracteres).";
    return null;
  }

  /** Gera o PDF com o modelo e guarda-o (nova versão; a anterior fica substituída). */
  async generate(repo: Repo, store: HrFileStore, notices: Notices, v: DocumentsViewer, id: string, input: { reason?: string | null }, school: School): R<{ version: number }> {
    const r = await this.load(repo, v, id);
    if (!r) return fail(documentsError("NOT_FOUND", "Pedido não encontrado."));
    if (!can(v, r.audience, "process")) return fail(documentsError("FORBIDDEN", "Emitir documentos exige a permissão de tratar os pedidos."));
    if (r.method !== "AUTO") return fail(documentsError("INVALID_STATE", "Este documento é preparado pelo colégio: junte o ficheiro em vez de o gerar."));
    const type = await repo.type(r.typeId);
    if (!type) return fail(documentsError("NOT_FOUND", "Documento não encontrado."));
    const active = await repo.activeIssued(id);
    const reason = clean(input.reason, 300);
    const blocked = this.replaceCheck(r, !!active, reason);
    if (blocked) return fail(documentsError("INVALID_STATE", blocked));
    if (!store.ready) return fail(documentsError("NOT_AVAILABLE", "O armazenamento de ficheiros deste colégio ainda não está configurado: fale com a EduFlow."));
    if (isCardCategory(r.category)) return this.generateCard(repo, store, v, r, reason, school, active?.version ?? (await repo.issued(id)).length);
    const c = await this.compose(repo, r, type, school);
    if (!c.ok) return c;
    const version = (active?.version ?? (await repo.issued(id)).length) + 1;
    const pdf = await renderDocumentPdf({
      school: school.name,
      logo: c.value.tpl.showLogo ? school.logo : null,
      header: school.header,
      title: c.value.title,
      body: c.value.body,
      signerName: c.value.tpl.signerName,
      signerRole: c.value.tpl.signerRole,
      footer: `Documento n.º ${this.requests.ref(r)} · versão ${version} · emitido a ${dmy(today(this.clock.now()))} · ${school.name} · a autenticidade confirma-se junto do colégio`,
    });
    const fileName = `${slug(r.typeName)}-${this.requests.ref(r)}-v${version}.pdf`;
    return this.store(repo, store, v, r, { method: "AUTO", templateVersion: c.value.tpl.version, fileName, mimeType: "application/pdf", content: pdf, reason: reason || null }, `Documento emitido com o modelo (versão ${version} do documento, modelo v${c.value.tpl.version})`);
  }

  /** Um pedido de cartão: emite o cartão (com o modelo escolhido pelo colégio) e junta o PDF ao pedido. */
  private async generateCard(repo: Repo, store: HrFileStore, v: DocumentsViewer, r: RequestRow, reason: string, school: School, last: number): R<{ version: number }> {
    if (r.audience !== "STUDENT" || !r.studentId) return fail(documentsError("INVALID_STATE", "Os cartões são só de alunos."));
    const ref = this.requests.ref(r);
    const res = await this.cards.forRequest(repo.cards(), store, r.studentId, { id: r.id, ref, reason: reason || null }, this.requests.actor(v), school);
    if (!res.ok) return res;
    const c = res.value;
    return this.store(repo, store, v, r, { method: "AUTO", templateVersion: null, fileName: `cartao-${slug(c.name)}-${ref}-v${last + 1}.pdf`, mimeType: "application/pdf", content: c.pdf, reason: reason || null }, `Cartão de estudante emitido (n.º ${c.cardNumber}${c.version > 1 ? `, ${c.version}.ª via` : ""})`);
  }

  /** Junta o documento preparado fora (PDF, JPG ou PNG até 10 MB, com o tipo real verificado). */
  async upload(repo: Repo, store: HrFileStore, notices: Notices, v: DocumentsViewer, id: string, input: { reason?: string | null }, file: Upload): R<{ version: number }> {
    const r = await this.load(repo, v, id);
    if (!r) return fail(documentsError("NOT_FOUND", "Pedido não encontrado."));
    if (!can(v, r.audience, "process")) return fail(documentsError("FORBIDDEN", "Juntar documentos exige a permissão de tratar os pedidos."));
    const active = await repo.activeIssued(id);
    const reason = clean(input.reason, 300);
    const blocked = this.replaceCheck(r, !!active, reason);
    if (blocked) return fail(documentsError("INVALID_STATE", blocked));
    const f = checkUpload(file);
    if (!f.ok) return fail(documentsError("INVALID_INPUT", f.message));
    if (!store.ready) return fail(documentsError("NOT_AVAILABLE", "O armazenamento de ficheiros deste colégio ainda não está configurado: fale com a EduFlow."));
    const version = (active?.version ?? (await repo.issued(id)).length) + 1;
    return this.store(repo, store, v, r, { method: "EXTERNAL", templateVersion: null, fileName: `${slug(r.typeName)}-${this.requests.ref(r)}-v${version}.${f.name.split(".").pop()}`, mimeType: f.mime, content: file!.buffer, reason: reason || null }, `Documento carregado (versão ${version}: ${f.name})`);
  }

  private async store(repo: Repo, store: HrFileStore, v: DocumentsViewer, r: RequestRow, d: { method: "AUTO" | "EXTERNAL"; templateVersion: number | null; fileName: string; mimeType: string; content: Buffer; reason: string | null }, note: string): R<{ version: number }> {
    const saved = await store.save(`documents/${r.id}`, { fileName: d.fileName, mimeType: d.mimeType, content: d.content });
    const now = this.clock.now();
    const actor = this.requests.actor(v);
    const version = await repo.transaction(async (tx) => {
      const n = await tx.addIssued(r.id, { method: d.method, templateVersion: d.templateVersion, fileKey: saved.key, fileName: d.fileName, mimeType: d.mimeType, size: d.content.length, sha256: createHash("sha256").update(d.content).digest("hex"), reason: d.reason }, actor, now);
      await tx.event(r.id, { kind: "FILE", from: null, to: null, note: `${note}${d.reason ? ` · ${d.reason}` : ""}`, internal: false }, actor, now);
      return n;
    });
    return ok({ version });
  }

  // ================================================================ downloads

  /** A equipa descarrega (qualquer versão); fica no histórico interno. */
  async staffFile(repo: Repo, store: HrFileStore, v: DocumentsViewer, id: string, fileId: string | null): R<FileOut> {
    const r = await this.load(repo, v, id);
    if (!r) return fail(documentsError("NOT_FOUND", "Pedido não encontrado."));
    const files = await repo.issued(id);
    const f = fileId ? files.find((x) => x.id === fileId) : files.find((x) => x.status === "ACTIVE");
    if (!f) return fail(documentsError("NOT_FOUND", "Ficheiro não encontrado."));
    const content = await store.read(f.fileKey);
    await repo.event(id, { kind: "FILE", from: null, to: null, note: `Descarregado pela equipa (versão ${f.version})`, internal: true }, this.requests.actor(v), this.clock.now());
    return ok({ fileName: f.fileName, mimeType: f.mimeType, content });
  }

  /**
   * Quem pediu descarrega o documento (só o seu, só quando está pronto e, com taxa "paga até à
   * entrega", só depois de pago). O primeiro download de um documento "disponível para download" conclui-o.
   */
  async requesterFile(repo: Repo, store: HrFileStore, notices: Notices, who: { kind: "FAMILY"; accountId: string } | { kind: "EMPLOYEE"; userId: string; name: string }, id: string): R<FileOut> {
    const r = who.kind === "FAMILY" ? await this.requests.familyOwned(repo, who.accountId, id) : await this.requests.mineOwned(repo, who.userId, id);
    if (!r) return fail(documentsError("NOT_FOUND", "Pedido não encontrado."));
    const f = await repo.activeIssued(id);
    if (!canDownload(snapshotOf(r, f)) || !f) return fail(documentsError("INVALID_STATE", r.fee && r.chargeStatus !== "PAID" && r.chargeStatus !== "WAIVED" ? "O documento descarrega-se depois de as Finanças confirmarem o pagamento da taxa." : "O documento ainda não está disponível para descarregar."));
    const content = await store.read(f.fileKey);
    const now = this.clock.now();
    const actor: Actor = who.kind === "FAMILY" ? { kind: "FAMILY", id: who.accountId, name: await repo.familyName(who.accountId) } : { kind: "EMPLOYEE", id: who.userId, name: who.name };
    await repo.transaction(async (tx) => {
      await tx.event(id, { kind: "FILE", from: null, to: null, note: `Descarregado por ${actor.name} (versão ${f.version})`, internal: true }, actor, now);
      // o processo digital termina no primeiro download
      if (r.status === "READY_DOWNLOAD" && (await tx.move(id, "READY_DOWNLOAD", "COMPLETED", r.revision, { completed: true }, now))) {
        await tx.event(id, { kind: "STATUS", from: "READY_DOWNLOAD", to: "COMPLETED", note: `Descarregado por ${actor.name}`, internal: false }, actor, now);
      }
    });
    return ok({ fileName: f.fileName, mimeType: f.mimeType, content });
  }
}
