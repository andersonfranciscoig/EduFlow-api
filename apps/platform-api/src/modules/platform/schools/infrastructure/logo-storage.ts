import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { UTApi, UTFile } from "uploadthing/server";
import { redactSecrets, withoutSecrets } from "../../../../../../../libs/kernel/src/infrastructure/safe-errors";
import type { LogoStorage } from "../application/ports";

const EXTENSIONS: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };
const TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp" };

/**
 * UploadThing (o mesmo serviço das cópias de segurança), com ficheiros
 * públicos: o logótipo aparece no portal do colégio sem autenticação.
 * Em produção use uma app do UploadThing SÓ para ficheiros públicos (outro
 * token) — este serviço não deve conseguir mexer nas cópias de segurança.
 */
export class UploadThingLogoStorage implements LogoStorage {
  readonly name = "UploadThing (público)";
  private readonly api: UTApi;

  constructor(token: string) {
    // "None": o SDK escreveria o pedido inteiro (URL de envio assinado) no log; registamos nós, sem segredos
    this.api = new UTApi({ token: token.trim(), logLevel: "None" });
  }

  /** Redes lentas (ex.: 5G) falham às vezes a ligar: tenta até 3 vezes (1 s, 3 s). */
  async put(schoolId: string, file: { mimeType: string; content: Buffer }) {
    const name = `logo-${schoolId.slice(0, 8)}-${randomUUID()}${EXTENSIONS[file.mimeType] ?? ""}`;
    let lastError = "sem resposta";
    for (const [attempt, wait] of [0, 1_000, 3_000].entries()) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      const upload = new UTFile([new Uint8Array(file.content)], name, { type: file.mimeType, lastModified: Date.now() } as ConstructorParameters<typeof UTFile>[2]);
      try {
        const [result] = await withoutSecrets("UploadThing", () => this.api.uploadFiles([upload], { acl: "public-read", contentDisposition: "inline" }));
        if (result?.data) return { key: result.data.key, url: result.data.ufsUrl };
        lastError = redactSecrets(result?.error?.message ?? "sem resposta");
      } catch (error) {
        lastError = (error as Error).message;
      }
      console.warn(`[logo] envio para o UploadThing falhou (tentativa ${attempt + 1}/3): ${lastError}`);
    }
    throw new Error(`UploadThing: ${lastError}`);
  }

  async remove(key: string) {
    await withoutSecrets("UploadThing", () => this.api.deleteFiles([key]));
  }
}

/**
 * Desenvolvimento sem token: pasta local, servida pelo platform-api em
 * GET /api/v1/public/schools/logos/:file.
 */
export class LocalLogoStorage implements LogoStorage {
  readonly name = "pasta local";

  constructor(
    private readonly dir: string,
    private readonly publicApiUrl: string,
  ) {}

  private file(key: string) {
    if (!/^[a-f0-9-]{36}\.(png|jpg|webp)$/.test(key)) throw new Error("Chave inválida.");
    return path.resolve(this.dir, key);
  }

  async put(_schoolId: string, file: { mimeType: string; content: Buffer }) {
    const key = `${randomUUID()}${EXTENSIONS[file.mimeType] ?? ""}`;
    await mkdir(path.resolve(this.dir), { recursive: true });
    await writeFile(this.file(key), file.content);
    return { key, url: `${this.publicApiUrl.replace(/\/$/, "")}/v1/public/schools/logos/${key}` };
  }

  async remove(key: string) {
    await rm(this.file(key), { force: true });
  }

  /** Para a rota pública; null se não existir (ou a chave for inválida). */
  async read(key: string): Promise<{ content: Buffer; mimeType: string } | null> {
    try {
      const content = await readFile(this.file(key));
      return { content, mimeType: TYPES[path.extname(key)]! };
    } catch {
      return null;
    }
  }
}
