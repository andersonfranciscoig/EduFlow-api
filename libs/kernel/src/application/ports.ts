/** Portas transversais a todos os módulos (implementadas na infraestrutura). */

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(plain: string, hash: string): Promise<boolean>;
}

export interface StoredFile {
  /** Caminho/chave interna — nunca exposto ao cliente. */
  key: string;
  fileName: string;
  mimeType: string;
  size: number;
}

/** Armazenamento de ficheiros (local hoje; S3/MinIO amanhã, sem mexer no domínio). */
export interface FileStorage {
  save(folder: string, file: { fileName: string; mimeType: string; content: Buffer }): Promise<StoredFile>;
  read(key: string): Promise<Buffer>;
}

export const SHARED_TOKENS = {
  Clock: Symbol("Clock"),
  IdGenerator: Symbol("IdGenerator"),
  PasswordHasher: Symbol("PasswordHasher"),
  FileStorage: Symbol("FileStorage"),
} as const;
