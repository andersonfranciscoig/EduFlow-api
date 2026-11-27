import { createHash } from "node:crypto";
import type { Clock } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import type { HrFileStore } from "../../hr/application/employee-ports";
import { type DocumentsError, documentsError } from "../domain/documents";
import { checkEmblem, checkHeader, HEADER_MAX_LINES, sniff } from "../domain/issuing";
import { type OfficialHeader, renderDocumentPdf } from "../infrastructure/pdf";
import type { Actor, HeaderImage, PrismaDocumentsRepository } from "../infrastructure/prisma-documents";
import type { FileOut, School } from "./DocumentIssuing";
import { audiencesFor, type DocumentsViewer } from "./DocumentTypes";

type R<T> = Promise<Result<T, DocumentsError>>;
type Repo = PrismaDocumentsRepository;
type Upload = { originalname: string; mimetype: string; buffer: Buffer } | undefined;

/** só PNG e JPG se imprimem nos PDFs (o WEBP da plataforma converte-se no navegador) */
export const printable = (b: Buffer | null) => {
  const m = b ? sniff(b) : null;
  return m === "image/png" || m === "image/jpeg";
};
const NONE: Record<HeaderImage, string> = { EMBLEM: "Não há insígnia carregada.", LOGO: "Não há logótipo carregado." };

// as imagens guardadas não mudam (cada envio tem uma chave nova): guardam-se em memória
const cache = new Map<string, Buffer>();
async function readImage(store: HrFileStore, key: string | null): Promise<Buffer | null> {
  if (!key) return null;
  const hit = cache.get(key);
  if (hit) return hit;
  try {
    const b = await store.read(key);
    if (cache.size > 100) cache.delete(cache.keys().next().value!);
    cache.set(key, b);
    return b;
  } catch {
    return null; // uma imagem que não se lê não impede o documento
  }
}

/**
 * O CABEÇALHO OFICIAL dos documentos e cartões (como nos documentos escolares angolanos): a insígnia da
 * República, "REPÚBLICA DE ANGOLA", o ministério e o colégio, com o logótipo do colégio. O colégio
 * pode retirá-lo, mudar a linha do ministério e carregar a insígnia e um logótipo próprio (PNG ou JPG).
 */
export class DocumentHeaders {
  constructor(private readonly clock: Clock) {}

  /** Configurar o cabeçalho: quem configura os documentos dos alunos ou dos funcionários. */
  private canManage(v: DocumentsViewer) {
    return audiencesFor(v, "settings").length > 0;
  }

  /** O colégio para os PDFs: o logótipo que se imprime (o carregado, ou o da plataforma se for PNG/JPG) e o cabeçalho oficial. */
  async school(repo: Repo, store: HrFileStore, base: { name: string; slug: string; platformLogo: Buffer | null }): Promise<School> {
    const h = await repo.header();
    const own = await readImage(store, h.logoKey);
    const logo = own ?? (printable(base.platformLogo) ? base.platformLogo : null);
    const header: OfficialHeader | null = h.enabled ? { lines: h.lines, emblem: h.showEmblem ? await readImage(store, h.emblemKey) : null, emblemKey: h.showEmblem ? h.emblemKey : null } : null;
    return { name: base.name, slug: base.slug, logo, header };
  }

  async view(repo: Repo, store: HrFileStore, v: DocumentsViewer, platformLogo: Buffer | null) {
    const h = await repo.header();
    return {
      settings: { enabled: h.enabled, lines: h.lines, showEmblem: h.showEmblem },
      maxLines: HEADER_MAX_LINES,
      emblem: h.emblemKey ? { name: h.emblemName, uploadedAt: h.emblemUploadedAt?.toISOString() ?? null } : null,
      logo: h.logoKey ? { name: h.logoName, uploadedAt: h.logoUploadedAt?.toISOString() ?? null } : null,
      /** o logótipo do colégio na plataforma: null = não tem; printable = false → converter (ex.: WEBP) */
      platformLogo: platformLogo ? { printable: printable(platformLogo), mimeType: sniff(platformLogo) ?? (platformLogo.subarray(8, 12).toString("latin1") === "WEBP" ? "image/webp" : null) } : null,
      storageReady: store.ready,
      updatedBy: h.updatedByName,
      updatedAt: h.updatedAt?.toISOString() ?? null,
      can: { manage: this.canManage(v) },
    };
  }

  async save(repo: Repo, v: DocumentsViewer, actor: Actor, input: { enabled: boolean; lines?: (string | null)[] | null; showEmblem: boolean }): R<{ saved: true }> {
    if (!this.canManage(v)) return fail(documentsError("FORBIDDEN", "Configurar o cabeçalho dos documentos exige a permissão de configurar os documentos."));
    const c = checkHeader(input);
    if (!c.ok) return fail(documentsError("INVALID_INPUT", c.message));
    await repo.saveHeader(c.value, actor, this.clock.now());
    return ok({ saved: true as const });
  }

  /** Carregar a insígnia ou o logótipo (PNG ou JPG até 2 MB); o anterior fica no armazenamento (nunca se apaga). */
  async upload(repo: Repo, store: HrFileStore, v: DocumentsViewer, actor: Actor, slot: HeaderImage, file: Upload): R<{ saved: true }> {
    if (!this.canManage(v)) return fail(documentsError("FORBIDDEN", "Configurar o cabeçalho dos documentos exige a permissão de configurar os documentos."));
    const f = checkEmblem(file);
    if (!f.ok) return fail(documentsError("INVALID_INPUT", slot === "LOGO" ? f.message.replace("da insígnia", "do logótipo").replace("A insígnia", "O logótipo") : f.message));
    if (!store.ready) return fail(documentsError("NOT_AVAILABLE", "O armazenamento de ficheiros deste colégio ainda não está configurado: fale com a EduFlow."));
    const saved = await store.save(`documents/header/${slot === "EMBLEM" ? "insignia" : "logotipo"}`, { fileName: f.name, mimeType: f.mime, content: file!.buffer });
    await repo.setImage(slot, { key: saved.key, name: f.name, mime: f.mime, sha256: createHash("sha256").update(file!.buffer).digest("hex") }, actor, this.clock.now());
    return ok({ saved: true as const });
  }

  async remove(repo: Repo, v: DocumentsViewer, actor: Actor, slot: HeaderImage): R<{ saved: true }> {
    if (!this.canManage(v)) return fail(documentsError("FORBIDDEN", "Configurar o cabeçalho dos documentos exige a permissão de configurar os documentos."));
    const h = await repo.header();
    if (!(slot === "EMBLEM" ? h.emblemKey : h.logoKey)) return fail(documentsError("NOT_FOUND", NONE[slot]));
    await repo.setImage(slot, null, actor, this.clock.now());
    return ok({ saved: true as const });
  }

  /** A imagem carregada (para a mostrar na configuração). */
  async image(repo: Repo, store: HrFileStore, slot: HeaderImage): R<FileOut> {
    const h = await repo.header();
    const key = slot === "EMBLEM" ? h.emblemKey : h.logoKey;
    const content = await readImage(store, key);
    if (!key || !content) return fail(documentsError("NOT_FOUND", NONE[slot]));
    const name = (slot === "EMBLEM" ? h.emblemName : h.logoName) ?? "imagem.png";
    return ok({ fileName: name, mimeType: sniff(content) ?? "image/png", content });
  }

  /** Pré-visualizar o cabeçalho (o que está guardado) num documento de exemplo. */
  async preview(school: School): Promise<FileOut> {
    const pdf = await renderDocumentPdf({
      school: school.name,
      logo: school.logo,
      header: school.header,
      title: "Declaração",
      body: `Para os devidos efeitos, declara-se que este é um documento de exemplo emitido por ${school.name}, para ver o cabeçalho dos documentos.\n\nOs dados reais entram com o modelo de cada documento.`,
      signerName: "Nome de quem assina",
      signerRole: "Diretor(a) do colégio",
      footer: "Pré-visualização do cabeçalho · não é um documento válido",
      watermark: "PRÉ-VISUALIZAÇÃO",
    });
    return { fileName: "cabecalho-documentos.pdf", mimeType: "application/pdf", content: pdf };
  }
}
