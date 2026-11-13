import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { decryptBackup, encryptBackup } from "../../../../../../libs/kernel/src/infrastructure/backup-crypto";
import { EncryptedUploadThingFileStorage } from "../../../../../../libs/kernel/src/infrastructure/encrypted-uploadthing-storage";
import { openSealed } from "../../../../../../libs/kernel/src/infrastructure/keys";
import type { TenantEntry } from "../../../tenancy/tenant-directory";
import type { HrFileStore } from "../application/employee-ports";

/** Ficheiros na app do PRÓPRIO colégio. */
const SCHOOL_PREFIX = "uts:";
/** Ficheiros antigos, na app partilhada do RH (antes de cada colégio ter a sua). */
const SHARED_PREFIX = "ut:";

export class StorageNotConfiguredError extends Error {
  constructor() {
    super("O armazenamento de ficheiros deste colégio ainda não está configurado.");
    this.name = "StorageNotConfiguredError";
  }
}

/**
 * Desenvolvimento e testes: pasta local. Com chave, cifra como em produção;
 * sem chave (só fora de produção) guarda tal como vem.
 */
export class LocalHrFiles implements HrFileStore {
  readonly ready = true;

  constructor(
    private readonly root: string,
    private readonly key: Buffer | null,
  ) {}

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

/**
 * Produção: cada colégio guarda os ficheiros na SUA app do UploadThing (configurada pela
 * equipa EduFlow no painel), cifrados com AES-256-GCM antes de sair desta API.
 *   novos ficheiros  → app do colégio ("uts:…"); sem app, o envio é recusado
 *   ficheiros antigos → app partilhada do RH ("ut:…"), só para ler e apagar
 */
class TenantHrFiles implements HrFileStore {
  constructor(
    private readonly school: EncryptedUploadThingFileStorage | null,
    private readonly shared: EncryptedUploadThingFileStorage | null,
  ) {}

  get ready() {
    return !!this.school;
  }

  private route(key: string) {
    const store = key.startsWith(SCHOOL_PREFIX) ? this.school : key.startsWith(SHARED_PREFIX) ? this.shared : null;
    if (!store) throw new StorageNotConfiguredError();
    return store;
  }

  async save(folder: string, file: { fileName: string; mimeType: string; content: Buffer }) {
    if (!this.school) throw new StorageNotConfiguredError();
    return { key: (await this.school.save(folder, file)).key };
  }

  read(key: string) {
    return this.route(key).read(key);
  }

  remove(key: string) {
    return this.route(key).remove(key);
  }
}

/** Dá o armazenamento de ficheiros do RH de cada colégio (com cache das ligações por app). */
export class HrFileStores {
  private readonly apps = new Map<string, EncryptedUploadThingFileStorage>();
  private readonly shared: EncryptedUploadThingFileStorage | null;
  readonly name: string;

  constructor(
    private readonly mode: "uploadthing" | "local",
    private readonly opts: { localDir: string; key: Buffer | null; acl: "private" | "public-read"; sharedToken: string | null; tenantPrivateKeyPem: string },
  ) {
    this.shared = mode === "uploadthing" && opts.sharedToken && opts.key ? new EncryptedUploadThingFileStorage(opts.sharedToken, opts.key, opts.acl, undefined, SHARED_PREFIX) : null;
    this.name = mode === "local" ? `pasta local ${opts.key ? "(cifrado)" : "(sem cifra — só desenvolvimento)"}` : `app do UploadThing de cada colégio (cifrado)${this.shared ? " + app partilhada antiga (só leitura)" : ""}`;
  }

  private local?: LocalHrFiles;

  for(entry: TenantEntry): HrFileStore {
    if (this.mode === "local") return (this.local ??= new LocalHrFiles(this.opts.localDir, this.opts.key));
    return new TenantHrFiles(this.schoolApp(entry), this.shared);
  }

  private schoolApp(entry: TenantEntry) {
    if (!entry.storage || !this.opts.key) return null;
    // a cache troca sozinha quando o token muda (o diretório renova-se a cada minuto)
    const id = createHash("sha256").update(entry.storage.tokenSealed).digest("hex");
    let app = this.apps.get(id);
    if (!app) {
      const token = openSealed(this.opts.tenantPrivateKeyPem, entry.storage.tokenSealed);
      app = new EncryptedUploadThingFileStorage(token, this.opts.key, this.opts.acl, undefined, SCHOOL_PREFIX);
      if (this.apps.size > 500) this.apps.clear();
      this.apps.set(id, app);
    }
    return app;
  }
}
