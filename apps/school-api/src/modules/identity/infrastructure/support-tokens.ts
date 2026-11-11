import { JwtService } from "@nestjs/jwt";
import type { SupportTicketClaims, SupportTicketVerifier, SupportTokenService } from "../application/ports";

/** Bilhetes da plataforma (o school-api só tem a chave PÚBLICA: não consegue criá-los). */
export const SUPPORT_TICKET = { ISSUER: "eduflow:platform", AUDIENCE: "eduflow:school-support-ticket", MAX_TTL_SECONDS: 120 } as const;

interface TicketPayload {
  jti?: string;
  sub?: string;
  tid?: string;
  name?: string;
  email?: string | null;
  mode?: string;
  emergency?: boolean;
  reason?: string;
  iat?: number;
  exp?: number;
}

export class JwtSupportTicketVerifier implements SupportTicketVerifier {
  private readonly jwt: JwtService;

  constructor(publicKey: string) {
    this.jwt = new JwtService({ publicKey, verifyOptions: { algorithms: ["ES256"] } });
  }

  async verify(ticket: string): Promise<SupportTicketClaims | null> {
    try {
      const p = await this.jwt.verifyAsync<TicketPayload>(ticket, { issuer: SUPPORT_TICKET.ISSUER, audience: SUPPORT_TICKET.AUDIENCE, algorithms: ["ES256"] });
      // bilhetes de curta duração: recusa um "exp" demasiado longo, mesmo que bem assinado
      if (!p.iat || !p.exp || p.exp - p.iat > SUPPORT_TICKET.MAX_TTL_SECONDS) return null;
      if (!p.jti || !p.sub || !p.tid || !p.name || !p.reason || (p.mode !== "READ" && p.mode !== "WRITE")) return null;
      return {
        ticketId: p.jti,
        staffId: p.sub,
        staffName: p.name.slice(0, 120),
        staffEmail: p.email ?? null,
        schoolId: p.tid,
        mode: p.mode,
        emergency: p.emergency === true,
        reason: p.reason.slice(0, 500),
      };
    } catch {
      return null;
    }
  }
}

const ISSUER = "eduflow:school";
const AUDIENCE = "eduflow:school-support";

/** Token da sessão de suporte — chave do school-api, audiência própria. */
export class JwtSupportTokenService implements SupportTokenService {
  constructor(private readonly jwt: JwtService) {}

  async issue(sessionId: string, schoolId: string, expiresInSeconds: number) {
    const accessToken = await this.jwt.signAsync({ sid: sessionId, tid: schoolId, typ: "support" }, { issuer: ISSUER, audience: AUDIENCE, expiresIn: expiresInSeconds });
    return { accessToken, expiresIn: expiresInSeconds };
  }

  async verify(token: string) {
    try {
      const p = await this.jwt.verifyAsync<{ sid?: string; tid?: string; typ?: string }>(token, { issuer: ISSUER, audience: AUDIENCE, algorithms: ["ES256"] });
      return p.sid && p.tid && p.typ === "support" ? { sessionId: p.sid, schoolId: p.tid } : null;
    } catch {
      return null;
    }
  }
}
