import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBody, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { unwrap } from "../../../../../../libs/kernel/src/presentation/domain-http";
import { openApi } from "../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import { CurrentTenant, type TenantContext, TenantGuard } from "../../../tenancy/tenant-context";
import { notifyFamily } from "../../family/infrastructure/family-notify";
import { CurrentFamily, FamilyAuthGuard, type FamilyPrincipal } from "../../family/presentation/family-auth";
import { Notifier } from "../../notifications/infrastructure/notifier";
import { DocumentRequests, type Notices } from "../application/DocumentRequests";
import type { RequestStatus } from "../domain/documents";
import { PrismaDocumentsRepository } from "../infrastructure/prisma-documents";
import { cancelBody, DOCUMENTS_HTTP, requestBody } from "./documents.controller";

const id = new ZodValidationPipe(z.uuid({ error: "Identificador inválido." }));
const familyRequestBody = requestBody.extend({ studentId: z.uuid() }).meta({ title: "FamilyDocumentRequest", description: "O aluno (o próprio, ou um educando menor que a conta gere), o documento e as respostas." });
const listQuery = new ZodValidationPipe(
  z.object({
    aluno: z.uuid().optional(),
    estado: z.enum(["PENDING", "IN_REVIEW", "AWAITING_PAYMENT", "PROCESSING", "READY_PICKUP", "READY_DOWNLOAD", "COMPLETED", "REJECTED", "CANCELLED", "OPEN"]).optional(),
    q: z.string().max(120).optional(),
    pagina: z.coerce.number().int().min(1).max(1000).optional(),
  }),
);

/**
 * Família · documentos: o aluno maior pede os seus; o encarregado, os dos educandos menores que gere.
 * Quem pode representar cada aluno confirma-se aqui (nunca se confia no aluno que vem do portal).
 */
@ApiTags("Família · Documentos")
@ApiHeader({ name: "X-Tenant", required: false })
@Controller("v1/family/documents")
@UseGuards(TenantGuard, FamilyAuthGuard)
export class FamilyDocumentsController {
  constructor(
    private readonly requests: DocumentRequests,
    private readonly notifier: Notifier,
  ) {}

  private repo(t: TenantContext) {
    return PrismaDocumentsRepository.for(t.db);
  }
  private notices(t: TenantContext): Notices {
    return {
      staff: this.notifier.for(t.db, { slug: t.entry.slug, name: t.entry.schoolName }),
      family: { notify: (accountId, n) => notifyFamily(t.db, { accountId, ...n, now: new Date() }) },
    };
  }

  @Get("catalog")
  @ApiOperation({ summary: "Os documentos que se podem pedir e os alunos da conta (o próprio e os educandos menores que gere)" })
  async catalog(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal) {
    return this.requests.familyCatalog(this.repo(t), f.account.id);
  }

  @Post("requests")
  @ApiOperation({ summary: "Pedir um documento para um aluno da conta" })
  @ApiBody({ schema: openApi(familyRequestBody) })
  async create(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Body(new ZodValidationPipe(familyRequestBody)) body: z.infer<typeof familyRequestBody>) {
    return unwrap(await this.requests.familyCreate(this.repo(t), this.notices(t), f.account.id, body), DOCUMENTS_HTTP);
  }

  @Get("requests")
  @ApiOperation({ summary: "Os pedidos dos alunos da conta (?aluno=&estado=&q=&pagina=)" })
  async list(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Query(listQuery) q: { aluno?: string; estado?: RequestStatus | "OPEN"; q?: string; pagina?: number }) {
    return this.requests.familyList(this.repo(t), f.account.id, { studentId: q.aluno, status: q.estado, q: q.q, page: q.pagina });
  }

  @Get("requests/:id")
  @ApiOperation({ summary: "Um pedido, com o histórico (sem as notas internas do colégio)" })
  async detail(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Param("id", id) requestId: string) {
    return unwrap(await this.requests.familyDetail(this.repo(t), f.account.id, requestId), DOCUMENTS_HTTP);
  }

  @Post("requests/:id/cancel")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Cancelar um pedido (enquanto o colégio ainda não o começou a preparar)" })
  @ApiBody({ schema: openApi(cancelBody) })
  async cancel(@CurrentTenant() t: TenantContext, @CurrentFamily() f: FamilyPrincipal, @Param("id", id) requestId: string, @Body(new ZodValidationPipe(cancelBody)) body: z.infer<typeof cancelBody>) {
    return unwrap(await this.requests.familyCancel(this.repo(t), this.notices(t), f.account.id, requestId, body.reason ?? null), DOCUMENTS_HTTP);
  }
}
