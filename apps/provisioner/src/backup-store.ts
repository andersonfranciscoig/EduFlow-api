import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { UTApi, UTFile } from "uploadthing/server";
import { redactSecrets, withoutSecrets } from "../../../libs/kernel/src/infrastructure/safe-errors";

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

/** Onde ficam as cópias (já cifradas). */
export interface BackupStore {
  readonly name: string;
  upload(fileName: string, data: Buffer): Promise<{ key: string; size: number }>;
  download(key: string): Promise<Buffer>;
  delete(keys: string[]): Promise<void>;
}

/**
 * UploadThing — o mesmo serviço do PASSA. Em produção, ficheiros PRIVADOS (sem URL público).
 * Seja qual for o ACL, o conteúdo já vai cifrado.
 */
export class UploadThingBackupStore implements BackupStore {
  readonly name: string;
  private readonly api: UTApi;

  constructor(
    token: string,
    private readonly acl: "private" | "public-read" = "private",
  ) {
    // "None": o SDK escreveria o pedido inteiro (URL de envio assinado) no log; o provisioner regista a falha
    this.api = new UTApi({ token: token.trim(), logLevel: "None" });
    this.name = `UploadThing (${acl})`;
  }

  upload(fileName: string, data: Buffer) {
    return retry(async () => {
      const file = new UTFile([new Uint8Array(data)], fileName, { type: "application/octet-stream", lastModified: Date.now() } as ConstructorParameters<typeof UTFile>[2]);
      const [result] = await withoutSecrets("UploadThing", () => this.api.uploadFiles([file], { acl: this.acl, contentDisposition: "attachment" }));
      if (!result?.data) {
        const detail = /private files are not allowed/i.test(result?.error?.message ?? "") ? " (o plano grátis não permite ficheiros privados — use UPLOADTHING_ACL=public-read em dev)" : "";
        throw new Error(`UploadThing: ${redactSecrets(result?.error?.message ?? "sem resposta")}${detail}`);
      }
      return { key: result.data.key, size: result.data.size };
    });
  }

  download(key: string) {
    return retry(async () => {
      // URL assinado e de curta duração (o ficheiro é privado)
      const { ufsUrl } = await withoutSecrets("UploadThing", () => this.api.generateSignedURL(key, { expiresIn: 60 }));
      const res = await fetch(ufsUrl, { signal: AbortSignal.timeout(120_000) }).catch((e: Error) => {
        throw new Error(`UploadThing: download falhou (${e.message})`);
      });
      if (!res.ok) throw new Error(`UploadThing: download falhou (${res.status})`);
      return Buffer.from(await res.arrayBuffer());
    });
  }

  async delete(keys: string[]) {
    if (keys.length) await withoutSecrets("UploadThing", () => this.api.deleteFiles(keys));
  }
}

/** Desenvolvimento sem token: uma pasta local. */
export class LocalBackupStore implements BackupStore {
  readonly name = "pasta local";

  constructor(private readonly dir: string) {}

  private file(key: string) {
    if (!/^[a-zA-Z0-9._-]+$/.test(key)) throw new Error("Chave inválida.");
    return path.resolve(this.dir, key);
  }

  async upload(fileName: string, data: Buffer) {
    await mkdir(path.resolve(this.dir), { recursive: true });
    await writeFile(this.file(fileName), data, { mode: 0o600 });
    return { key: fileName, size: data.length };
  }

  download(key: string) {
    return readFile(this.file(key));
  }

  async delete(keys: string[]) {
    for (const key of keys) await rm(this.file(key), { force: true });
  }
}
