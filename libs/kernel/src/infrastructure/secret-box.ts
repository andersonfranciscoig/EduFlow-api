import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Cifra simétrica autenticada (AES-256-GCM) para segredos guardados na BD
 * (ex.: segredos TOTP). Formato: v1.<iv>.<tag>.<dados> em base64url.
 * Uma fuga só da base de dados (backup, SQL injection) não revela os segredos.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(keyMaterial: string) {
    this.key = Buffer.from(keyMaterial.trim(), "base64");
    if (this.key.length !== 32) throw new Error("A chave do SecretBox tem de ter 32 bytes (base64).");
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return ["v1", iv, cipher.getAuthTag(), data].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
  }

  decrypt(payload: string): string {
    const [version, iv, tag, data] = payload.split(".");
    if (version !== "v1" || !iv || !tag || !data) throw new Error("Segredo cifrado em formato inválido.");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  }
}
