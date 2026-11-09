import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Request } from "express";
import type { PrismaClient as TenantClient } from ".prisma/tenant-client";
import { TenantConnections } from "./tenant-connections";
import { TenantDirectory, type TenantEntry } from "./tenant-directory";

export interface TenantContext {
  entry: TenantEntry;
  db: TenantClient;
}

type TenantRequest = Request & { tenant?: TenantContext };

const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])?$/;

/**
 * Descobre o colégio do pedido:
 *   - produção: pelo subdomínio (colegio-x.eduflow.ao)
 *   - desenvolvimento/testes: cabeçalho "X-Tenant: colegio-x"
 * e associa ao pedido a ligação à BD desse colégio — nunca a de outro.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly directory: TenantDirectory,
    private readonly connections: TenantConnections,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<TenantRequest>();
    const header = request.header("x-tenant")?.trim().toLowerCase();
    const fromHost = request.hostname.split(".").length > 2 ? request.hostname.split(".")[0] : undefined;
    const slug = header || fromHost;

    const entry = slug && SLUG.test(slug) ? await this.directory.findBySlug(slug) : null;
    if (!entry) {
      // mesma resposta para "não existe" e "inválido": não revela que colégios existem
      throw new NotFoundException({ code: "TENANT_NOT_FOUND", message: "Colégio não encontrado." });
    }
    request.tenant = { entry, db: this.connections.get(entry) };
    return true;
  }
}

export const CurrentTenant = createParamDecorator(
  (_: unknown, context: ExecutionContext) => context.switchToHttp().getRequest<TenantRequest>().tenant!,
);
