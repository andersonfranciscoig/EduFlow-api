import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * TOTP (RFC 6238) — compatível com Google Authenticator, Authy, 1Password…
 * HMAC-SHA1, 6 dígitos, intervalos de 30 s, tolerância de ±1 intervalo.
 */
const PERIOD = 30;
const DIGITS = 6;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const idx = ALPHABET.indexOf(char);
    if (idx === -1) throw new Error("Segredo base32 inválido.");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", secret).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return code.toString().padStart(DIGITS, "0");
}

export const totp = {
  generateSecret(): string {
    return base32Encode(randomBytes(20));
  },

  otpauthUrl(secret: string, account: string, issuer = "EduFlow"): string {
    const label = encodeURIComponent(`${issuer}:${account}`);
    return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${PERIOD}`;
  },

  /** Código atual (útil em testes). */
  now(secret: string, at = Date.now()): string {
    return hotp(base32Decode(secret), Math.floor(at / 1000 / PERIOD));
  },

  /**
   * Verifica um código. Devolve o intervalo (step) aceite, ou null.
   * O chamador deve rejeitar steps ≤ ao último usado (anti-reutilização).
   */
  verify(secret: string, code: string, at = Date.now()): number | null {
    if (!/^\d{6}$/.test(code)) return null;
    const key = base32Decode(secret);
    const current = Math.floor(at / 1000 / PERIOD);
    for (const step of [current, current - 1, current + 1]) {
      const expected = Buffer.from(hotp(key, step));
      if (timingSafeEqual(expected, Buffer.from(code))) return step;
    }
    return null;
  },
};

/** Códigos de recuperação: 10 × "xxxx-xxxx" (base32, ~40 bits cada). */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const raw = base32Encode(randomBytes(5)).toLowerCase().slice(0, 8);
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  });
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(code.trim().toLowerCase().replace(/\s+/g, "")).digest("hex");
}
