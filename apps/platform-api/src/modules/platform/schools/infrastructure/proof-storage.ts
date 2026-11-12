import { randomUUID } from "node:crypto";
import { UTApi, UTFile } from "uploadthing/server";
import type { FileStorage, StoredFile } from "../../../../../../../libs/kernel/src/application/ports";
import { decryptBackup, encryptBackup } from "../../../../../../../libs/kernel/src/infrastructure/backup-crypto";
import { redactSecrets, withoutSecrets } from "../../../../../../../libs/kernel/src/infrastructure/safe-errors";

/** Chaves guardadas na BD: "ut:<chave no UploadThing>" (novos) ou caminho local (antigos). */
const UT_PREFIX = "ut:";

/** Redes lentas (ex.: 5G) falham às vezes a ligar: até 3 tentativas (logo, 2 s, 5 s). */
async function retry<T>(run: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (const wait of [0, 2_000, 5_000]) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      return await run();
    } catch (error) {
      last = error;
    }
  }
  throw last;
}

/**
 * Comprovativos de pagamento (dados pessoais e bancários) no UploadThing,
 * CIFRADOS com AES-256-GCM antes de saírem da API — a chave só existe aqui.
 * Mesmo com ficheiros "public-read" (plano grátis) o conteúdo é ilegível.
 *
 * Os comprovativos antigos (guardados em disco) continuam a ler-se pela `legacy`.
 */
export class EncryptedUploadThingFileStorage implements FileStorage {
  private readonly api: UTApi;

  constructor(
    token: string,
    private readonly key: Buffer,
    private readonly acl: "private" | "public-read",
    private readonly legacy: FileStorage,
  ) {
    // "None": o SDK escreveria o pedido inteiro (URL assinado) no log
    this.api = new UTApi({ token: token.trim(), logLevel: "None" });
  }

  async save(folder: string, file: { fileName: string; mimeType: string; content: Buffer }): Promise<StoredFile> {
    const sealed = encryptBackup(file.content, this.key);
    // nome sem dados pessoais (o nome original fica só na BD)
    const name = `${folder.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 40)}-${randomUUID()}.enc`;
    const key = await retry(async () => {
      const upload = new UTFile([new Uint8Array(sealed)], name, { type: "application/octet-stream", lastModified: Date.now() } as ConstructorParameters<typeof UTFile>[2]);
      const [result] = await withoutSecrets("UploadThing", () => this.api.uploadFiles([upload], { acl: this.acl, contentDisposition: "attachment" }));
      if (!result?.data) throw new Error(`UploadThing: ${redactSecrets(result?.error?.message ?? "sem resposta")}`);
      return result.data.key;
    });
    return { key: `${UT_PREFIX}${key}`, fileName: file.fileName, mimeType: file.mimeType, size: file.content.length };
  }

  async read(key: string): Promise<Buffer> {
    if (!key.startsWith(UT_PREFIX)) return this.legacy.read(key);
    const utKey = key.slice(UT_PREFIX.length);
    const sealed = await retry(async () => {
      const { ufsUrl } = await withoutSecrets("UploadThing", () => this.api.generateSignedURL(utKey, { expiresIn: 60 }));
      const res = await fetch(ufsUrl, { signal: AbortSignal.timeout(60_000) }).catch((e: Error) => {
        throw new Error(`UploadThing: download falhou (${e.message})`);
      });
      if (!res.ok) throw new Error(`UploadThing: download falhou (${res.status})`);
      return Buffer.from(await res.arrayBuffer());
    });
    return decryptBackup(sealed, this.key);
  }
}
