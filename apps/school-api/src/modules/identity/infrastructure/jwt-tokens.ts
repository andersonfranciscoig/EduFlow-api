import type { JwtService } from "@nestjs/jwt";
import type { AccessTokenService, ChallengePurpose, ChallengeService, SchoolPrincipal } from "../application/ports";
import { SCHOOL_ROLES, type SchoolRole } from "../domain/SchoolUser";

const ISSUER = "eduflow:school";
const AUDIENCE = "eduflow:school-user";
const CHALLENGE_AUDIENCE = "eduflow:school-challenge";
const CHALLENGE_TTL_SECONDS = 10 * 60;

interface AccessPayload {
  sub: string;
  sid: string;
  /** Colégio para o qual o token foi emitido — nunca vale noutro. */
  tid: string;
  name: string;
  role: SchoolRole;
}

/** Token de acesso de um utilizador do colégio: ligado a uma sessão (sid) e a um colégio (tid). */
export class JwtAccessTokenService implements AccessTokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly expiresInSeconds: number,
  ) {}

  async issue(principal: SchoolPrincipal, sessionId: string, schoolId: string) {
    const payload: AccessPayload = { sub: principal.id, sid: sessionId, tid: schoolId, name: principal.fullName, role: principal.role };
    const accessToken = await this.jwt.signAsync(payload, { issuer: ISSUER, audience: AUDIENCE, expiresIn: this.expiresInSeconds });
    return { accessToken, expiresIn: this.expiresInSeconds };
  }

  async verify(token: string) {
    try {
      const p = await this.jwt.verifyAsync<AccessPayload>(token, { issuer: ISSUER, audience: AUDIENCE, algorithms: ["ES256"] });
      if (!p.sub || !p.sid || !p.tid || !(SCHOOL_ROLES as readonly string[]).includes(p.role)) return null;
      return { principal: { id: p.sub, fullName: p.name, role: p.role }, sessionId: p.sid, schoolId: p.tid };
    } catch {
      return null;
    }
  }
}

/**
 * Bilhetes entre passos (10 min). Audiência própria — nunca são aceites como
 * token de acesso — e ligados ao colégio e à finalidade com que foram emitidos.
 */
export class JwtChallengeService implements ChallengeService {
  constructor(private readonly jwt: JwtService) {}

  issue(userId: string, schoolId: string, purpose: ChallengePurpose) {
    return this.jwt.signAsync({ sub: userId, tid: schoolId, purpose }, { issuer: ISSUER, audience: CHALLENGE_AUDIENCE, expiresIn: CHALLENGE_TTL_SECONDS });
  }

  async verify(token: string, schoolId: string, purposes: ChallengePurpose[]) {
    try {
      const p = await this.jwt.verifyAsync<{ sub?: string; tid?: string; purpose?: ChallengePurpose }>(token, {
        issuer: ISSUER,
        audience: CHALLENGE_AUDIENCE,
        algorithms: ["ES256"],
      });
      if (!p.sub || p.tid !== schoolId || !p.purpose || !purposes.includes(p.purpose)) return null;
      return { userId: p.sub, purpose: p.purpose };
    } catch {
      return null;
    }
  }
}
