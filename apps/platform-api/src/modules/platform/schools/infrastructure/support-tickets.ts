import { randomUUID } from "node:crypto";
import { JwtService } from "@nestjs/jwt";
import type { SupportTicketIssuer } from "../application/ports";

/** Tem de coincidir com o school-api (apps/school-api/.../support-tokens.ts). */
const ISSUER = "eduflow:platform";
const AUDIENCE = "eduflow:school-support-ticket";

/** Bilhete de suporte: ES256 com uma chave só da plataforma; uso único (jti); ligado ao colégio (tid). */
export class JwtSupportTicketIssuer implements SupportTicketIssuer {
  private readonly jwt: JwtService;

  constructor(privateKey: string) {
    this.jwt = new JwtService({ privateKey, signOptions: { algorithm: "ES256" } });
  }

  issue(input: Parameters<SupportTicketIssuer["issue"]>[0]) {
    return this.jwt.signAsync(
      { sub: input.staffId, tid: input.schoolId, name: input.staffName, mode: input.mode, emergency: input.emergency, reason: input.reason },
      { issuer: ISSUER, audience: AUDIENCE, expiresIn: input.ttlSeconds, jwtid: randomUUID() },
    );
  }
}
