import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** Código de 6 dígitos (CSPRNG). */
export const generateOtpCode = () => randomInt(0, 1_000_000).toString().padStart(6, "0");

/** Hash ligado ao contexto (conta + finalidade): o mesmo código não serve noutro sítio. */
export const hashOtp = (scope: string, code: string) => createHash("sha256").update(`${scope}:${code}`).digest("hex");

/** Prova de verificação (token aleatório de 256 bits) e o seu hash para guardar. */
export function generateProof() {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashProof(token) };
}

export const hashProof = (token: string) => createHash("sha256").update(token).digest("hex");

/** Comparação em tempo constante de dois hashes hex. */
export function sameHash(a: string, b: string) {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
