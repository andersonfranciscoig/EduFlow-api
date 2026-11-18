import type { JwtService } from "@nestjs/jwt";
import type { FamilyTokens } from "../application/ports";

/**
 * Tokens das contas de família: o mesmo par ES256 do school-api, mas AUDIÊNCIAS PRÓPRIAS —
 * um token da família nunca entra numa rota da equipa (e vice-versa).
 */
const ISSUER = "eduflow:school";
const AUDIENCE = "eduflow:family";
const CHALLENGE_AUDIENCE = "eduflow:family-challenge";
const CHALLENGE_TTL_SECONDS = 10 * 60;

export class JwtFamilyTokens implements FamilyTokens {
  constructor(
    private readonly jwt: JwtService,
    private readonly expiresInSeconds: number,
  ) {}

  async issueAccess(input: { accountId: string; sessionId: string; schoolId: string }) {
    const accessToken = await this.jwt.signAsync({ sub: input.accountId, sid: input.sessionId, tid: input.schoolId }, { issuer: ISSUER, audience: AUDIENCE, expiresIn: this.expiresInSeconds });
    return { accessToken, expiresIn: this.expiresInSeconds };
  }

  async verifyAccess(token: string) {
    try {
      const p = await this.jwt.verifyAsync<{ sub: string; sid: string; tid: string }>(token, { issuer: ISSUER, audience: AUDIENCE, algorithms: ["ES256"] });
      return p.sub && p.sid && p.tid ? { accountId: p.sub, sessionId: p.sid, schoolId: p.tid } : null;
    } catch {
      return null;
    }
  }

  issueChallenge(input: { accountId: string; schoolId: string }) {
    return this.jwt.signAsync({ sub: input.accountId, tid: input.schoolId }, { issuer: ISSUER, audience: CHALLENGE_AUDIENCE, expiresIn: CHALLENGE_TTL_SECONDS });
  }

  async verifyChallenge(token: string, schoolId: string) {
    try {
      const p = await this.jwt.verifyAsync<{ sub: string; tid: string }>(token, { issuer: ISSUER, audience: CHALLENGE_AUDIENCE, algorithms: ["ES256"] });
      return p.tid === schoolId && p.sub ? { accountId: p.sub } : null;
    } catch {
      return null;
    }
  }
}
