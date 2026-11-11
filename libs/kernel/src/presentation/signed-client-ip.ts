import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { NextFunction, Request, Response } from "express";

/**
 * IP real do utilizador quando há proxies de terceiros pelo meio
 * (browser → Vercel → Render → API).
 *
 * O "X-Forwarded-For" não chega: a API só confia nos proxies da rede local, por
 * isso veria o IP da Vercel — e todos os utilizadores partilhariam o mesmo limite
 * de pedidos. O servidor do frontend envia então o IP do utilizador ASSINADO
 * (HMAC-SHA256 com um segredo partilhado só entre frontend e API, mais uma hora
 * que caduca em 60 s). O segredo nunca viaja; sem assinatura válida, nada muda.
 *
 * Cabeçalhos (o frontend tem de usar exatamente estes):
 *   x-eduflow-client-ip   IP do utilizador
 *   x-eduflow-client-ts   segundos desde 1970 (UTC)
 *   x-eduflow-client-sig  hex(HMAC_SHA256(segredo, `${ip}|${ts}`))
 */
export const CLIENT_IP_HEADERS = { ip: "x-eduflow-client-ip", ts: "x-eduflow-client-ts", sig: "x-eduflow-client-sig" } as const;
const MAX_SKEW_SECONDS = 60;

export function signClientIp(secret: string, ip: string, ts: number) {
  return createHmac("sha256", secret).update(`${ip}|${ts}`).digest("hex");
}

/** IP assinado e válido, ou null. */
export function verifiedClientIp(secret: string, headers: Record<string, string | string[] | undefined>, nowSeconds = Math.floor(Date.now() / 1000)): string | null {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim();
  const ip = one(headers[CLIENT_IP_HEADERS.ip]);
  const ts = Number(one(headers[CLIENT_IP_HEADERS.ts]));
  const sig = one(headers[CLIENT_IP_HEADERS.sig]);
  if (!ip || !sig || !Number.isInteger(ts) || !isIP(ip)) return null;
  if (Math.abs(nowSeconds - ts) > MAX_SKEW_SECONDS) return null;
  const expected = Buffer.from(signClientIp(secret, ip, ts), "hex");
  const given = Buffer.from(sig, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected) ? ip : null;
}

/**
 * Middleware Express: com assinatura válida, `req.ip` passa a ser o IP do
 * utilizador (limites de pedidos, sessões, registos). Sem segredo configurado
 * ou sem assinatura, fica tudo como antes.
 */
export function signedClientIp(secret: string | undefined) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (secret) {
      const ip = verifiedClientIp(secret, req.headers);
      if (ip) Object.defineProperty(req, "ip", { value: ip, configurable: true, enumerable: true });
    }
    next();
  };
}
