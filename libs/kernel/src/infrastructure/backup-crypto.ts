import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Cifra das cópias de segurança (AES-256-GCM). As cópias são cifradas ANTES
 * de sair do provisioner: o armazenamento externo só guarda bytes ilegíveis.
 * Formato: "EFB1" (4) | iv (12) | tag (16) | dados cifrados
 */
const MAGIC = Buffer.from("EFB1");

export function readBackupKey(base64: string): Buffer {
  const key = Buffer.from(base64.trim(), "base64");
  if (key.length !== 32) throw new Error("A chave das cópias tem de ter 32 bytes (base64).");
  return key;
}

export function encryptBackup(data: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

export function decryptBackup(sealed: Buffer, key: Buffer): Buffer {
  if (!sealed.subarray(0, 4).equals(MAGIC)) throw new Error("Não é uma cópia EduFlow.");
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(4, 16));
  decipher.setAuthTag(sealed.subarray(16, 32));
  return Buffer.concat([decipher.update(sealed.subarray(32)), decipher.final()]);
}

export const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
