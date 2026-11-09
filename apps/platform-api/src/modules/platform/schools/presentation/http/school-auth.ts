import {
  applyDecorators,
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import type { Request } from "express";
import { SCHOOL_TOKENS, type SchoolTokenService } from "../../application/ports";

type SchoolRequest = Request & { schoolId?: string };

/** Autentica o responsável do colégio (token com audiência própria). */
@Injectable()
export class SchoolOwnerGuard implements CanActivate {
  constructor(@Inject(SCHOOL_TOKENS.SchoolTokenService) private readonly tokens: SchoolTokenService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<SchoolRequest>();
    const [scheme, token] = (request.headers.authorization ?? "").split(" ");
    const schoolId = scheme === "Bearer" && token ? await this.tokens.verify(token) : null;
    if (!schoolId) {
      throw new UnauthorizedException({ code: "UNAUTHENTICATED", message: "Sessão expirada. Entre novamente." });
    }
    request.schoolId = schoolId;
    return true;
  }
}

export const SchoolOwnerAuth = () => applyDecorators(ApiBearerAuth(), UseGuards(SchoolOwnerGuard));

export const CurrentSchoolId = createParamDecorator(
  (_: unknown, context: ExecutionContext) => context.switchToHttp().getRequest<SchoolRequest>().schoolId!,
);
