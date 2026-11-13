import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { decryptBackup, encryptBackup } from "../../../../../../libs/kernel/src/infrastructure/backup-crypto";
import { EncryptedUploadThingFileStorage } from "../../../../../../libs/kernel/src/infrastructure/encrypted-uploadthing-storage";
import type { HrFileStore } from "../application/employee-ports";

/** Produção: a app do UploadThing SÓ do RH, ficheiros cifrados (AES-256-GCM) antes de sair. */
export class UploadThingHrFiles implements HrFileStore {
  readonly name = "UploadThing do RH (cifrado)";
  private readonly storage: EncryptedUploadThingFileStorage;

  constructor(token: string, key: Buffer, acl: "private" | "public-read") {
    this.storage = new EncryptedUploadThingFileStorage(token, key, acl);
  }

  async save(folder: string, file: { fileName: string; mimeType: string; content: Buffer }) {
    const stored = await this.storage.save(folder, file);
    return { key: stored.key };
  }

  read(key: string) {
    return this.storage.read(key);
  }

  remove(key: string) {
    return this.storage.remove(key);
  }
}

/**
 * Desenvolvimento e testes: pasta local. Com chave, cifra como em produção;
 * sem chave (só fora de produção) guarda tal como vem.
 */
export class LocalHrFiles implements HrFileStore {
  readonly name: string;

  constructor(
    private readonly root: string,
    private readonly key: Buffer | null,
  ) {
    this.name = `pasta local ${key ? "(cifrado)" : "(sem cifra — só desenvolvimento)"}`;
  }

  async save(folder: string, file: { content: Buffer }) {
    const key = path.posix.join(folder.replace(/[^a-zA-Z0-9_-]/g, ""), `${randomUUID()}.bin`);
    const target = this.resolve(key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, this.key ? encryptBackup(file.content, this.key) : file.content);
    return { key };
  }

  async read(key: string) {
    const data = await readFile(this.resolve(key));
    return this.key ? decryptBackup(data, this.key) : data;
  }

  async remove(key: string) {
    await unlink(this.resolve(key)).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e;
    });
  }

  /** Impede sair da pasta raiz (path traversal). */
  private resolve(key: string) {
    const root = path.resolve(this.root);
    const full = path.resolve(root, key);
    if (!full.startsWith(root + path.sep)) throw new Error("Caminho de ficheiro inválido");
    return full;
  }
}
