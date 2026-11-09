import { randomInt } from "node:crypto";
import { JwtService } from "@nestjs/jwt";
import type { CodeGenerator, SchoolTokenService } from "../application/ports";

const ISSUER = "eduflow:platform";
const AUDIENCE = "eduflow:school-owner";

/** Tokens do responsável do colégio — audiência diferente da equipa interna. */
export class JwtSchoolTokenService implements SchoolTokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly expiresInSeconds: number,
  ) {}

  async issue(schoolId: string) {
    const accessToken = await this.jwt.signAsync(
      { sub: schoolId, kind: "school-owner" },
      { issuer: ISSUER, audience: AUDIENCE, expiresIn: this.expiresInSeconds },
    );
    return { accessToken, expiresIn: this.expiresInSeconds };
  }

  async verify(token: string) {
    try {
      const payload = await this.jwt.verifyAsync<{ sub?: string; kind?: string }>(token, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ["ES256"],
      });
      return payload.kind === "school-owner" && payload.sub ? payload.sub : null;
    } catch {
      return null;
    }
  }
}

export const randomCodes: CodeGenerator = {
  orderNumber(now: Date) {
    const ymd = now.toISOString().slice(2, 10).replace(/-/g, "");
    return `EF-${ymd}-${String(randomInt(0, 100_000)).padStart(5, "0")}`;
  },
  referenceNumber() {
    return String(randomInt(100_000_000, 1_000_000_000));
  },
};
