import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FileStorage, StoredFile } from "../application/ports";

const EXTENSIONS: Record<string, string> = {
  "application/pdf": ".pdf",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

/** Guarda ficheiros no disco local (pasta configurável). */
export class LocalFileStorage implements FileStorage {
  constructor(private readonly root: string) {}

  async save(folder: string, file: { fileName: string; mimeType: string; content: Buffer }): Promise<StoredFile> {
    const safeFolder = folder.replace(/[^a-zA-Z0-9/_-]/g, "");
    const key = path.posix.join(safeFolder, `${randomUUID()}${EXTENSIONS[file.mimeType] ?? ""}`);
    const target = this.resolve(key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content);
    return { key, fileName: file.fileName, mimeType: file.mimeType, size: file.content.length };
  }

  read(key: string) {
    return readFile(this.resolve(key));
  }

  /** Impede sair da pasta raiz (path traversal). */
  private resolve(key: string) {
    const root = path.resolve(this.root);
    const full = path.resolve(root, key);
    if (!full.startsWith(root + path.sep)) throw new Error("Caminho de ficheiro inválido");
    return full;
  }
}
