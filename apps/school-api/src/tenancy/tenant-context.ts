import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request } from "express";
import type { PrismaClient as TenantClient } from ".prisma/tenant-client";
import type { Env } from "../config/env";
import { TenantConnections } from "./tenant-connections";
import { TenantDirectory, type TenantEntry } from "./tenant-directory";

export interface TenantContext {
  entry: TenantEntry;
  db: TenantClient;
}

export type TenantRequest = Request & { tenant?: TenantContext };

const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])?$/;

const notFound = () =>
  // mesma resposta para "não existe", "inválido" e "ambíguo": não revela que colégios existem
  new NotFoundException({ code: "TENANT_NOT_FOUND", message: "Colégio não encontrado." });

/**
 * Descobre o colégio do pedido e associa-lhe a ligação à BD desse colégio —
 * nunca a de outro:
 *   - Host "colegio-x.<TENANT_BASE_DOMAIN>" (só subdomínios diretos do domínio configurado);
 *   - cabeçalho "X-Tenant: colegio-x", enviado pelo servidor do portal (Next.js).
 * Se vierem os dois e não coincidirem, o pedido é recusado.
 *
 * Escolher o colégio NÃO dá acesso a nada: as rotas autenticadas confirmam que
 * o token foi emitido para ESTE colégio (claim "tid" — ver SchoolAuthGuard).
 */
@Injectable()
export class TenantGuard implements CanActivate {
  private readonly baseDomain?: string;

  constructor(
    private readonly directory: TenantDirectory,
    private readonly connections: TenantConnections,
    config: ConfigService<Env, true>,
  ) {
    this.baseDomain = config.get("TENANT_BASE_DOMAIN", { infer: true });
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<TenantRequest>();
    const fromHeader = request.header("x-tenant")?.trim().toLowerCase() || undefined;
    const fromHost = this.slugFromHost(request.hostname);

    if (fromHeader && fromHost && fromHeader !== fromHost) throw notFound();
    const slug = fromHeader ?? fromHost;

    const entry = slug && SLUG.test(slug) ? await this.directory.findBySlug(slug) : null;
    if (!entry) throw notFound();

    request.tenant = { entry, db: this.connections.get(entry) };
    return true;
  }

  /** "colegio-x.eduflow.ao" → "colegio-x" (só com o domínio base configurado e um único nível). */
  private slugFromHost(hostname: string | undefined): string | undefined {
    if (!this.baseDomain || !hostname) return undefined;
    const host = hostname.toLowerCase();
    const suffix = `.${this.baseDomain}`;
    if (!host.endsWith(suffix)) return undefined;
    const label = host.slice(0, -suffix.length);
    return label && !label.includes(".") ? label : undefined;
  }
}

export const CurrentTenant = createParamDecorator(
  (_: unknown, context: ExecutionContext) => context.switchToHttp().getRequest<TenantRequest>().tenant!,
);
