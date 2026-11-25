import { Body, Controller, Get, Inject, Param, Put } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { unwrap } from "../../../../../../../../libs/kernel/src/presentation/domain-http";
import { openApi } from "../../../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import { fail, ok } from "../../../../../../../../libs/kernel/src/domain/Result";
import type { StaffAccess } from "../../../identity/application/ports";
import { CurrentStaff, StaffAuth } from "../../../identity/presentation/http/staff-auth";
import { PlatformPrismaService } from "../../../infrastructure/platform-prisma.service";
import { SCHOOL_TOKENS, type SchoolNotifier } from "../../application/ports";
import { schoolError } from "../../domain/errors";
import { SCHOOL_HTTP } from "./school.schemas";

const METHODS = { REFERENCIA: "pagamento por referência", EXPRESS: "Multicaixa Express" } as const;
const STATUSES = { WAITING: "Em espera", CONTACTED: "Em contacto", DONE: "Concluído", DECLINED: "Recusado", CANCELLED: "Retirado pelo colégio" } as const;
const uuid = new ZodValidationPipe(z.uuid({ error: "Identificador inválido." }));
const updateBody = z
  .object({ status: z.enum(["WAITING", "CONTACTED", "DONE", "DECLINED"], { error: "Escolha o estado." }), note: z.string().trim().max(500).nullish() })
  .meta({ title: "PaymentRequestUpdate", description: "Novo estado na lista de espera; a nota segue no email ao responsável do colégio." });

/**
 * Lista de espera: os colégios que pediram, no seu portal, pagamento por referência ou Multicaixa Express
 * (cada um terá a sua chave de integração, em breve). Ver: billing.view · tratar: billing.manage.
 */
@ApiTags("Plataforma · Faturação · Lista de espera")
@ApiBearerAuth()
@Controller("v1/platform/payment-requests")
export class PaymentRequestsController {
  constructor(
    private readonly prisma: PlatformPrismaService,
    @Inject(SCHOOL_TOKENS.SchoolNotifier) private readonly notifier: SchoolNotifier,
  ) {}

  @Get()
  @StaffAuth("billing.view")
  @ApiOperation({ summary: "Pedidos de pagamento por referência e Express (por ordem de chegada)" })
  async list() {
    const rows = await this.prisma.paymentIntegrationRequest.findMany({ include: { school: { select: { id: true, name: true, logoUrl: true, province: true, ownerName: true, ownerEmail: true, phone: true } } }, orderBy: { requestedAt: "asc" } });
    const staff = await this.prisma.staffMember.findMany({ where: { id: { in: rows.map((r) => r.handledById).filter((x): x is string => !!x) } }, select: { id: true, fullName: true } });
    return {
      methods: Object.entries(METHODS).map(([value, label]) => ({ value, label })),
      statuses: Object.entries(STATUSES).map(([value, label]) => ({ value, label, count: rows.filter((r) => r.status === value).length })),
      items: rows.map((r) => ({
        id: r.id,
        school: r.school,
        method: r.method,
        methodLabel: METHODS[r.method as keyof typeof METHODS] ?? r.method,
        status: r.status,
        statusLabel: STATUSES[r.status as keyof typeof STATUSES] ?? r.status,
        note: r.note,
        requestedBy: r.requestedByName,
        requestedAt: r.requestedAt.toISOString(),
        staffNote: r.staffNote,
        handledBy: staff.find((s) => s.id === r.handledById)?.fullName ?? null,
        updatedAt: r.updatedAt.toISOString(),
      })),
    };
  }

  @Put(":id")
  @StaffAuth("billing.manage")
  @ApiOperation({ summary: "Mudar o estado de um pedido (o responsável do colégio é avisado por email)" })
  @ApiBody({ schema: openApi(updateBody) })
  async update(@Param("id", uuid) id: string, @Body(new ZodValidationPipe(updateBody)) body: z.infer<typeof updateBody>, @CurrentStaff() staff: StaffAccess) {
    const row = await this.prisma.paymentIntegrationRequest.findUnique({ where: { id }, include: { school: { select: { name: true, ownerName: true, ownerEmail: true } } } });
    if (!row) return unwrap(fail(schoolError("REQUEST_NOT_FOUND", "Pedido não encontrado.")), SCHOOL_HTTP);
    if (row.status === "CANCELLED") return unwrap(fail(schoolError("INVALID_STATE", "O colégio retirou este pedido.")), SCHOOL_HTTP);
    const note = body.note || null;
    const { count } = await this.prisma.paymentIntegrationRequest.updateMany({ where: { id, status: row.status }, data: { status: body.status, staffNote: note, handledById: staff.id, updatedAt: new Date() } });
    if (!count) return unwrap(fail(schoolError("INVALID_STATE", "Este pedido mudou entretanto. Atualize a página.")), SCHOOL_HTTP);
    if (body.status !== "WAITING" && body.status !== row.status) {
      void this.notifier
        .integrationUpdate({ to: { email: row.school.ownerEmail, name: row.school.ownerName }, schoolName: row.school.name, methodLabel: METHODS[row.method as keyof typeof METHODS], status: body.status, note })
        .catch(() => undefined);
    }
    return unwrap(ok({ status: body.status, statusLabel: STATUSES[body.status] }), SCHOOL_HTTP);
  }
}
