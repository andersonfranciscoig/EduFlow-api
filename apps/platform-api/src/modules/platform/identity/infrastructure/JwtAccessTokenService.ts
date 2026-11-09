import { JwtService } from "@nestjs/jwt";
import type { AccessTokenService, ChallengePurpose, ChallengeService, StaffPrincipal } from "../application/ports";

const ISSUER = "eduflow:platform";
const AUDIENCE = "eduflow:platform-staff";
const CHALLENGE_AUDIENCE = "eduflow:platform-staff-challenge";
const CHALLENGE_TTL_SECONDS = 10 * 60;

interface StaffTokenPayload {
  sub: string;
  sid: string;
  name: string;
  role: StaffPrincipal["role"];
}

/** Token de acesso da equipa — sempre ligado a uma sessão (sid). */
export class JwtAccessTokenService implements AccessTokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly expiresInSeconds: number,
  ) {}

  async issue(principal: StaffPrincipal, sessionId: string) {
    const payload: StaffTokenPayload = { sub: principal.id, sid: sessionId, name: principal.fullName, role: principal.role };
    const accessToken = await this.jwt.signAsync(payload, {
      issuer: ISSUER,
      audience: AUDIENCE,
      expiresIn: this.expiresInSeconds,
    });
    return { accessToken, expiresIn: this.expiresInSeconds };
  }

  async verify(token: string) {
    try {
      const payload = await this.jwt.verifyAsync<StaffTokenPayload>(token, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ["ES256"],
      });
      if (!payload.sub || !payload.sid || (payload.role !== "ADMIN" && payload.role !== "GESTOR")) return null;
      return { principal: { id: payload.sub, fullName: payload.name, role: payload.role }, sessionId: payload.sid };
    } catch {
      return null;
    }
  }
}

/**
 * "Bilhete" entre a senha e a 2FA (10 minutos). Audiência própria: nunca é
 * aceite como token de acesso, e só serve para o propósito com que foi emitido.
 */
export class JwtChallengeService implements ChallengeService {
  constructor(private readonly jwt: JwtService) {}

  issue(staffId: string, purpose: ChallengePurpose) {
    return this.jwt.signAsync({ sub: staffId, purpose }, { issuer: ISSUER, audience: CHALLENGE_AUDIENCE, expiresIn: CHALLENGE_TTL_SECONDS });
  }

  async verify(token: string, purpose: ChallengePurpose) {
    try {
      const payload = await this.jwt.verifyAsync<{ sub?: string; purpose?: string }>(token, {
        issuer: ISSUER,
        audience: CHALLENGE_AUDIENCE,
        algorithms: ["ES256"],
      });
      return payload.purpose === purpose && payload.sub ? payload.sub : null;
    } catch {
      return null;
    }
  }
}
