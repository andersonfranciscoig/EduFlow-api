import { createHash } from "node:crypto";
import type { Clock } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import type { HrFileStore } from "../../hr/application/employee-ports";
import {
  CARD_MODEL_KEYS,
  CARD_MODELS,
  type CardModel,
  type CardSettings,
  cardValidity,
  checkCardSettings,
  DEFAULT_BACK_NOTE,
  formatCardCode,
  maskedName,
  newCardCode,
  normalizeCardCode,
  PRINTABLE_PHOTO,
  VALIDITY_LABELS,
} from "../domain/cards";
import { type DocumentsError, documentsError } from "../domain/documents";
import { sniff } from "../domain/issuing";
import { type CardPrint, renderCardsPdf } from "../infrastructure/card-pdf";
import type { CardData, CardRow, CardTarget, PrismaCardsRepository } from "../infrastructure/prisma-cards";
import type { Actor } from "../infrastructure/prisma-documents";
import { today } from "./DocumentRequests";
import type { FileOut, School } from "./DocumentIssuing";
import type { DocumentsViewer } from "./DocumentTypes";

type R<T> = Promise<Result<T, DocumentsError>>;
type Repo = PrismaCardsRepository;
type Upload = { originalname: string; mimetype: string; buffer: Buffer } | undefined;
export type CardsLayout = "CARD" | "SHEET";

/** Gerir os cartões (modelo, fotografias, emitir, imprimir, anular): só com esta permissão. */
export const CARDS_PERMISSION = "documents.cards.manage";
export const canCards = (v: DocumentsViewer) => v.permissions.includes("documents.access") && v.permissions.includes(CARDS_PERMISSION);
const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
const BATCH_MAX = 300;
const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const pad = (n: number) => String(n).padStart(6, "0");
const slugOf = (t: string) =>
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
const forbidden = () => fail(documentsError("FORBIDDEN", "Gerir os cartões de estudante exige a permissão “Gerir os cartões de estudante”. Peça-a ao responsável do colégio."));

/** Porque é que um aluno não leva cartão (dito à secretaria, para resolver). */
type Skip = { studentId: string; name: string; reason: string };

/**
 * CARTÕES DE ESTUDANTE — o modelo escolhido pelo colégio e a personalização, as fotografias, a
 * emissão (individual, em lote, segunda via, a partir de um pedido), a impressão (PDF do cartão ou
 * folha A4) e a verificação pública pelo QR / código (só a validade e o nome abreviado).
 */
export class StudentCards {
  constructor(
    private readonly clock: Clock,
    /** "https://{slug}.dominio" — o QR aponta para a página de verificação do portal do colégio */
    private readonly portalUrlTemplate: string,
  ) {}

  private verifyUrl(slug: string, code: string) {
    return `${this.portalUrlTemplate.replace("{slug}", slug)}/verificar/${code}`;
  }

  // ================================================================ configuração

  async overview(repo: Repo, v: DocumentsViewer, yearId?: string | null) {
    if (!canCards(v)) return forbidden();
    const [settings, current, years] = await Promise.all([repo.settings(), repo.currentYear(today(this.clock.now())), repo.openYears()]);
    const pick = yearId ? years.find((y) => y.id === yearId) : null;
    const year = pick ? { id: pick.id, name: pick.name, endsOn: pick.endsOn } : current;
    const groups = year ? await repo.yearGroups(year.id) : [];
    return ok({
      settings,
      defaults: { backNote: DEFAULT_BACK_NOTE },
      models: CARD_MODEL_KEYS.map((k) => ({ value: k, ...CARD_MODELS[k] })),
      year,
      years: years.map((y) => ({ id: y.id, name: y.name, current: y.id === current?.id })),
      groups: groups.map((g) => ({ ...g, covered: true })),
      totals: { students: groups.reduce((n, g) => n + g.students, 0), cards: groups.reduce((n, g) => n + g.cards, 0) },
    });
  }

  async saveSettings(repo: Repo, v: DocumentsViewer, actor: Actor, input: Parameters<typeof checkCardSettings>[0]): R<{ saved: true }> {
    if (!canCards(v)) return forbidden();
    const c = checkCardSettings(input);
    if (!c.ok) return fail(documentsError("INVALID_INPUT", c.message));
    await repo.saveSettings(c.value, actor, this.clock.now());
    return ok({ saved: true as const });
  }

  /** Um cartão de exemplo (frente e verso) com a configuração enviada, mesmo por guardar. */
  async preview(repo: Repo, v: DocumentsViewer, input: Parameters<typeof checkCardSettings>[0], school: School): R<FileOut> {
    if (!canCards(v)) return forbidden();
    const c = checkCardSettings(input);
    if (!c.ok) return fail(documentsError("INVALID_INPUT", c.message));
    const year = await repo.currentYear(today(this.clock.now()));
    const code = formatCardCode("EXEMPLO2EDUF");
    const print = this.print(c.value, school, {
      model: c.value.model,
      student: { name: "Ana Beatriz Fernandes", number: "00042", classLabel: "8.ª Classe", groupName: "8.ª A", yearName: year?.name ?? "2026/2027" },
      photo: null,
      validUntil: year ? dmy(year.endsOn) : "31/07/2027",
      code,
      verifyUrl: c.value.showQr ? this.verifyUrl(school.slug, "EXEMPLO2EDUF") : null,
      footer: "Cartão n.º 000000 · exemplo",
      watermark: "EXEMPLO",
    });
    const pdf = await renderCardsPdf([print], "CARD", `Cartão de estudante — modelo ${CARD_MODELS[c.value.model].label}`);
    return ok({ fileName: `cartao-exemplo-${c.value.model.toLowerCase()}.pdf`, mimeType: "application/pdf", content: pdf });
  }

  private print(s: Pick<CardSettings, "primaryColor" | "accentColor" | "address" | "phone" | "email" | "backNote">, school: School, x: Omit<CardPrint, "primary" | "accent" | "school" | "logo" | "backNote">): CardPrint {
    return { ...x, primary: s.primaryColor, accent: s.accentColor, school: { name: school.name, address: s.address, phone: s.phone, email: s.email }, logo: school.logo, backNote: s.backNote || DEFAULT_BACK_NOTE };
  }

  // ================================================================ turmas e alunos

  async group(repo: Repo, v: DocumentsViewer, groupId: string) {
    if (!canCards(v)) return forbidden();
    const g = await repo.group(groupId);
    if (!g) return fail(documentsError("NOT_FOUND", "Turma não encontrada."));
    const students = await repo.groupStudents(groupId, g.yearId);
    return ok({
      group: g,
      students: students.map((s) => ({
        id: s.id,
        name: s.name,
        number: s.number,
        photo: !s.photoSource ? "MISSING" : PRINTABLE_PHOTO.includes(s.photoMime ?? "") ? "OK" : "UNSUPPORTED",
        photoSource: s.photoSource,
        card: s.cardId ? { id: s.cardId, number: pad(s.cardNumber!), version: s.cardVersion!, code: formatCardCode(s.cardCode!), at: s.cardAt!.toISOString(), model: s.cardModel, modelLabel: CARD_MODELS[s.cardModel as CardModel]?.label ?? s.cardModel } : null,
        cards: s.cards,
      })),
    });
  }

  /** O histórico de cartões de um aluno (todos os anos). */
  async history(repo: Repo, v: DocumentsViewer, studentId: string) {
    if (!canCards(v)) return forbidden();
    const t = await repo.target(studentId);
    if (!t) return fail(documentsError("NOT_FOUND", "Aluno não encontrado."));
    const cards = await repo.studentCards(studentId);
    const now = today(this.clock.now());
    return ok({
      student: { id: t.id, name: t.name, number: t.number, classLabel: t.classLabel, groupName: t.groupName, yearName: t.yearName },
      cards: cards.map((c) => this.cardView(c, now)),
    });
  }
  private cardView(c: CardRow, now: string) {
    const validity = cardValidity({ status: c.status, validUntil: c.validUntil, studentStatus: c.studentStatus }, now);
    return {
      id: c.id,
      number: pad(c.number),
      version: c.version,
      yearName: c.yearName,
      code: formatCardCode(c.code),
      model: c.model,
      modelLabel: CARD_MODELS[c.model].label,
      status: c.status,
      validity,
      validityLabel: VALIDITY_LABELS[validity],
      validUntil: c.validUntil,
      reason: c.reason,
      revokeReason: c.revokeReason,
      fromRequest: !!c.requestId,
      by: c.createdByName,
      at: c.createdAt.toISOString(),
      endedAt: c.endedAt?.toISOString() ?? null,
    };
  }

  // ================================================================ fotografias

  async photoFile(repo: Repo, store: HrFileStore, v: DocumentsViewer, studentId: string): R<FileOut> {
    if (!canCards(v)) return forbidden();
    const p = await repo.photo(studentId);
    if (!p) return fail(documentsError("NOT_FOUND", "Este aluno ainda não tem fotografia."));
    return ok({ fileName: p.fileName, mimeType: p.mimeType, content: await store.read(p.storageKey) });
  }

  /** A secretaria carrega a fotografia (JPG ou PNG até 5 MB, com o tipo real verificado). */
  async uploadPhoto(repo: Repo, store: HrFileStore, v: DocumentsViewer, actor: Actor, studentId: string, file: Upload): R<{ saved: true }> {
    if (!canCards(v)) return forbidden();
    const t = await repo.target(studentId);
    if (!t) return fail(documentsError("NOT_FOUND", "Aluno não encontrado."));
    if (!file?.buffer?.length) return fail(documentsError("INVALID_INPUT", "Escolha a fotografia (JPG ou PNG)."));
    if (file.buffer.length > PHOTO_MAX_BYTES) return fail(documentsError("INVALID_INPUT", "A fotografia tem mais de 5 MB."));
    const real = sniff(file.buffer);
    if (real !== "image/jpeg" && real !== "image/png") return fail(documentsError("INVALID_INPUT", "A fotografia tem de ser JPG ou PNG (o conteúdo do ficheiro não corresponde)."));
    if (!store.ready) return fail(documentsError("NOT_AVAILABLE", "O armazenamento de ficheiros deste colégio ainda não está configurado: fale com a EduFlow."));
    const fileName = `fotografia-${slugOf(t.name)}.${real === "image/png" ? "png" : "jpg"}`;
    const saved = await store.save(`students/${studentId}`, { fileName, mimeType: real, content: file.buffer });
    await repo.addPhoto(studentId, { fileName, mimeType: real, size: file.buffer.length, sha256: createHash("sha256").update(file.buffer).digest("hex"), storageKey: saved.key }, actor, this.clock.now());
    return ok({ saved: true as const });
  }

  // ================================================================ emitir

  /**
   * Prepara um cartão: matrícula ativa, fotografia que se imprime, e não haver já um válido (salvo
   * segunda via, com motivo). Não grava nada: devolve o que falta ou o que se vai gravar.
   */
  /** O logótipo dos cartões, copiado (uma vez, e outra vez só se mudar) para o armazenamento do colégio. */
  private async logoKey(repo: Repo, store: HrFileStore, school: School): Promise<string | null> {
    if (!school.logo) return null;
    const sha = createHash("sha256").update(school.logo).digest("hex");
    const cur = await repo.logo();
    if (cur.key && cur.sha === sha) return cur.key;
    const png = school.logo[0] === 0x89;
    const saved = await store.save("cards/logo", { fileName: `logotipo.${png ? "png" : "jpg"}`, mimeType: png ? "image/png" : "image/jpeg", content: school.logo });
    await repo.setLogo(saved.key, sha);
    return saved.key;
  }

  private async prepare(repo: Repo, store: HrFileStore, studentId: string, reason: string | null, settings: CardSettings, school: School, yearId: string | null = null, logoKey: string | null = null) {
    const t = await repo.target(studentId, yearId);
    if (!t) return { skip: "Aluno não encontrado." } as const;
    if (!t.yearId || !t.endsOn || !t.yearName) return { skip: yearId ? "Sem matrícula ativa neste ano letivo." : "Sem matrícula ativa: o cartão é do ano letivo da matrícula." } as const;
    const photo = await repo.photo(studentId);
    if (!photo) return { skip: "Sem fotografia: carregue uma (JPG ou PNG)." } as const;
    if (!PRINTABLE_PHOTO.includes(photo.mimeType)) return { skip: "A fotografia da inscrição está em WEBP, que não se imprime: converta-a para JPG (botão “Converter”) ou carregue outra." } as const;
    let bytes: Buffer;
    try {
      bytes = await store.read(photo.storageKey);
    } catch {
      return { skip: "Não foi possível ler a fotografia: carregue-a outra vez." } as const;
    }
    const active = await repo.active(studentId, t.yearId);
    if (active && !reason) return { skip: "Já tem um cartão válido: para outro, use a segunda via (com o motivo)." } as const;
    const data: CardData = {
      name: t.name,
      number: t.number,
      classLabel: t.classLabel,
      groupName: t.groupName,
      yearName: t.yearName,
      school: { name: school.name, address: settings.address, phone: settings.phone, email: settings.email },
      primary: settings.primaryColor,
      accent: settings.accentColor,
      showQr: settings.showQr,
      backNote: settings.backNote || DEFAULT_BACK_NOTE,
      photoKey: photo.storageKey,
      logoKey,
    };
    return { target: t as CardTarget & { yearId: string; endsOn: string; yearName: string }, data, photo: bytes, replaces: active } as const;
  }

  /** Emite cartões (um aluno ou vários): quem não pode levar cartão fica na lista, com o motivo. */
  async issue(repo: Repo, store: HrFileStore, v: DocumentsViewer, actor: Actor, input: { studentIds: string[]; reason?: string | null; yearId?: string | null }, school: School): R<{ issued: { cardId: string; studentId: string; name: string; version: number }[]; skipped: Skip[] }> {
    if (!canCards(v)) return forbidden();
    const ids = [...new Set(input.studentIds)];
    if (!ids.length) return fail(documentsError("INVALID_INPUT", "Escolha pelo menos um aluno."));
    if (ids.length > BATCH_MAX) return fail(documentsError("INVALID_INPUT", `No máximo ${BATCH_MAX} alunos de cada vez.`));
    const reason = clean(input.reason, 300) || null;
    if (input.reason != null && input.reason !== "" && (!reason || reason.length < 3)) return fail(documentsError("INVALID_INPUT", "Indique o motivo da segunda via (3 a 300 caracteres)."));
    if (!store.ready) return fail(documentsError("NOT_AVAILABLE", "O armazenamento de ficheiros deste colégio ainda não está configurado: fale com a EduFlow."));
    const settings = await repo.settings();
    const logoKey = await this.logoKey(repo, store, school);
    const issued: { cardId: string; studentId: string; name: string; version: number }[] = [];
    const skipped: Skip[] = [];
    for (const id of ids) {
      const p = await this.prepare(repo, store, id, reason, settings, school, input.yearId ?? null, logoKey);
      if ("skip" in p) {
        skipped.push({ studentId: id, name: (await repo.target(id))?.name ?? "—", reason: p.skip! });
        continue;
      }
      const card = await this.save(repo, p, settings.model, p.replaces ? reason : null, null, actor);
      issued.push({ cardId: card.id, studentId: id, name: p.target.name, version: card.version });
    }
    return ok({ issued, skipped });
  }

  private save(repo: Repo, p: { target: { id: string; yearId: string; endsOn: string }; data: CardData }, model: CardModel, reason: string | null, requestId: string | null, actor: Actor) {
    return repo.transaction((tx) => tx.add({ studentId: p.target.id, yearId: p.target.yearId, code: newCardCode(), model, data: p.data, validUntil: p.target.endsOn, reason, requestId }, actor, this.clock.now()));
  }

  /**
   * O cartão de um pedido ("Cartão de estudante" com emissão automática): emite-o (segunda via se
   * o aluno já tem um válido) e devolve o PDF do cartão para ficar como documento do pedido.
   */
  async forRequest(repo: Repo, store: HrFileStore, studentId: string, request: { id: string; ref: string; reason: string | null }, actor: Actor, school: School): R<{ cardNumber: string; version: number; pdf: Buffer; name: string }> {
    if (!store.ready) return fail(documentsError("NOT_AVAILABLE", "O armazenamento de ficheiros deste colégio ainda não está configurado: fale com a EduFlow."));
    const settings = await repo.settings();
    const p = await this.prepare(repo, store, studentId, request.reason || `Pedido ${request.ref}`, settings, school, null, await this.logoKey(repo, store, school));
    if ("skip" in p) return fail(documentsError("INCOMPLETE", `O cartão não se emite: ${p.skip}`, { missing: [p.skip] }));
    const saved = await this.save(repo, p, settings.model, p.replaces ? request.reason || `Segunda via pedida (${request.ref})` : null, request.id, actor);
    const card = (await repo.card(saved.id))!;
    const pdf = await renderCardsPdf([this.fromRow(card, p.photo, school, school.logo)], "CARD", `Cartão de estudante — ${card.data.name}`);
    return ok({ cardNumber: pad(saved.number), version: saved.version, pdf, name: card.data.name });
  }

  /** Pré-visualizar o cartão de um pedido (dados e fotografia reais, com marca; não fica guardado). */
  async previewForRequest(repo: Repo, store: HrFileStore, studentId: string, school: School): R<FileOut> {
    const settings = await repo.settings();
    const p = await this.prepare(repo, store, studentId, "pré-visualização", settings, school);
    if ("skip" in p) return fail(documentsError("INCOMPLETE", `O cartão não se emite: ${p.skip}`, { missing: [p.skip] }));
    const print = this.print(settings, school, {
      model: settings.model,
      student: { name: p.data.name, number: p.data.number, classLabel: p.data.classLabel, groupName: p.data.groupName, yearName: p.data.yearName },
      photo: p.photo,
      validUntil: dmy(p.target.endsOn),
      code: formatCardCode("PREVISUALIZA"),
      verifyUrl: settings.showQr ? this.verifyUrl(school.slug, "PREVISUALIZA") : null,
      footer: "Pré-visualização · ainda não emitido",
      watermark: "PRÉ-VISUALIZAÇÃO",
    });
    return ok({ fileName: `previsualizacao-cartao-${slugOf(p.data.name)}.pdf`, mimeType: "application/pdf", content: await renderCardsPdf([print], "CARD") });
  }

  // ================================================================ imprimir

  private fromRow(c: CardRow, photo: Buffer, school: School, logo: Buffer | null): CardPrint {
    const d = c.data;
    return {
      model: c.model,
      primary: d.primary,
      accent: d.accent,
      school: { ...d.school, name: d.school.name || school.name },
      logo,
      student: { name: d.name, number: d.number, classLabel: d.classLabel, groupName: d.groupName, yearName: d.yearName },
      photo,
      validUntil: dmy(c.validUntil),
      code: formatCardCode(c.code),
      verifyUrl: d.showQr ? this.verifyUrl(school.slug, c.code) : null,
      backNote: d.backNote,
      footer: `Cartão n.º ${pad(c.number)}${c.version > 1 ? ` · ${c.version}.ª via` : ""} · ${c.yearName}`,
      // um cartão que já não vale (reimpresso do histórico) leva a marca
      watermark: c.status === "REPLACED" ? "SUBSTITUÍDO" : c.status === "REVOKED" ? "ANULADO" : null,
    };
  }

  /** O PDF dos cartões pedidos: do tamanho do cartão (impressora PVC) ou em folhas A4 de 10. */
  async pdf(repo: Repo, store: HrFileStore, v: DocumentsViewer, ids: string[], layout: CardsLayout, school: School): R<FileOut> {
    if (!canCards(v)) return forbidden();
    const unique = [...new Set(ids)];
    if (!unique.length) return fail(documentsError("INVALID_INPUT", "Escolha os cartões a imprimir."));
    if (unique.length > BATCH_MAX) return fail(documentsError("INVALID_INPUT", `No máximo ${BATCH_MAX} cartões de cada vez.`));
    const rows = await repo.cards(unique);
    if (rows.length !== unique.length) return fail(documentsError("NOT_FOUND", "Cartão não encontrado."));
    return this.render(store, rows, layout, school);
  }

  /** Os cartões válidos de uma turma, para imprimir de uma vez. */
  async groupPdf(repo: Repo, store: HrFileStore, v: DocumentsViewer, groupId: string, layout: CardsLayout, school: School): R<FileOut> {
    if (!canCards(v)) return forbidden();
    const g = await repo.group(groupId);
    if (!g) return fail(documentsError("NOT_FOUND", "Turma não encontrada."));
    const rows = await repo.groupActive(groupId, g.yearId);
    if (!rows.length) return fail(documentsError("INVALID_STATE", "Nenhum aluno desta turma tem cartão válido: emita-os primeiro."));
    return this.render(store, rows, layout, school, `cartoes-${slugOf(g.label)}`);
  }

  private async render(store: HrFileStore, rows: CardRow[], layout: CardsLayout, school: School, base?: string): R<FileOut> {
    const prints: CardPrint[] = [];
    // o logótipo com que cada cartão foi emitido (os anteriores a guardar o logótipo usam o atual)
    const logos = new Map<string, Buffer | null>();
    const logoOf = async (key: string | null | undefined) => {
      if (key === undefined) return school.logo;
      if (key === null) return null;
      if (!logos.has(key)) logos.set(key, await store.read(key).catch(() => school.logo));
      return logos.get(key) ?? null;
    };
    for (const c of rows) {
      let photo: Buffer;
      try {
        photo = await store.read(c.data.photoKey);
      } catch {
        return fail(documentsError("NOT_AVAILABLE", `A fotografia do cartão n.º ${pad(c.number)} (${c.data.name}) já não está disponível.`));
      }
      prints.push(this.fromRow(c, photo, school, await logoOf(c.data.logoKey)));
    }
    const pdf = await renderCardsPdf(prints, layout, rows.length === 1 ? `Cartão de estudante — ${rows[0].data.name}` : "Cartões de estudante");
    const name = base ?? (rows.length === 1 ? `cartao-${slugOf(rows[0].data.name)}-${pad(rows[0].number)}` : `cartoes-${today(this.clock.now())}`);
    return ok({ fileName: `${name}${layout === "SHEET" ? "-folha-a4" : ""}.pdf`, mimeType: "application/pdf", content: pdf });
  }

  // ================================================================ anular

  async revoke(repo: Repo, v: DocumentsViewer, id: string, reason: string | null | undefined): R<{ revoked: true }> {
    if (!canCards(v)) return forbidden();
    const why = clean(reason, 300);
    if (why.length < 3) return fail(documentsError("INVALID_INPUT", "Indique o motivo (3 a 300 caracteres): ex. cartão perdido."));
    const c = await repo.card(id);
    if (!c) return fail(documentsError("NOT_FOUND", "Cartão não encontrado."));
    if (!(await repo.revoke(id, why, this.clock.now()))) return fail(documentsError("INVALID_STATE", "Este cartão já não estava válido."));
    return ok({ revoked: true as const });
  }

  // ================================================================ verificação pública (QR / código)

  /** Quem lê o QR ou escreve o código vê só a validade, o colégio, o ano e o nome abreviado. */
  async verify(repo: Repo, raw: string, schoolName: string) {
    const code = normalizeCardCode(raw);
    const c = code ? await repo.byCode(code) : null;
    if (!c) return { status: "NOT_FOUND" as const, label: "Código não encontrado neste colégio", school: schoolName, name: null, yearName: null, validUntil: null };
    const validity = cardValidity({ status: c.status, validUntil: c.validUntil, studentStatus: c.studentStatus }, today(this.clock.now()));
    return { status: validity, label: VALIDITY_LABELS[validity], school: schoolName, name: maskedName(c.data.name), yearName: c.yearName, validUntil: c.validUntil };
  }
}
