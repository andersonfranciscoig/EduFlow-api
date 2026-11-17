import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query, Res, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { z } from "zod";
import { unwrap } from "../../../../../../libs/kernel/src/presentation/domain-http";
import { openApi } from "../../../../../../libs/kernel/src/presentation/openapi";
import { ZodValidationPipe } from "../../../../../../libs/kernel/src/presentation/zod-validation.pipe";
import { CurrentTenant, type TenantContext, TenantGuard } from "../../../tenancy/tenant-context";
import type { SchoolAccess } from "../../identity/application/ports";
import { permissionsOf, RequirePermission } from "../../identity/presentation/http/permissions";
import { CurrentUser, SchoolAuthGuard } from "../../identity/presentation/http/school-auth";
import { type ContractAccess, Contracts } from "../application/Contracts";
import { HrFileStores } from "../infrastructure/hr-file-store";
import { PrismaContractRepository } from "../infrastructure/prisma-contracts";
import { sendFile } from "./employees.controller";
import { HR_HTTP } from "./hr-settings.controller";

const id = new ZodValidationPipe(z.uuid({ error: "Identificador inválido." }));
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data no formato AAAA-MM-DD.");
const contractBody = z
  .object({
    kind: z.enum(["INDETERMINADO", "DETERMINADO", "PRESTACAO_SERVICOS", "ESTAGIO"], { error: "Escolha o tipo de contrato." }),
    regime: z.enum(["TEMPO_INTEIRO", "TEMPO_PARCIAL"], { error: "Escolha o regime." }),
    weeklyHours: z.number().int().min(1).max(60),
    jobTitle: z.string().max(120),
    department: z.string().max(120).nullish(),
    startsOn: isoDay,
    endsOn: isoDay.nullish(),
    trialEndsOn: isoDay.nullish(),
    notes: z.string().max(1000).nullish(),
    // kwanzas; só com hr.contracts.salary (sem a permissão, enviar este campo dá 403)
    baseSalary: z.number().int().min(0).max(1_000_000_000).nullish(),
  })
  .meta({ title: "HrContract", description: "Contrato: tipo, regime e horas, função, datas (fim conforme o tipo), período experimental, observações e salário base (permissão própria)." });
const createBody = contractBody.extend({ previousId: z.uuid().nullish() }).meta({ title: "HrContractCreate", description: "previousId = renovação do contrato indicado." });
const terminateBody = z.object({ terminatedOn: isoDay, reason: z.string().max(500) }).meta({ title: "HrContractTerminate" });
const listQuery = z.object({ view: z.enum(["vigentes", "a-terminar", "terminados", "sem-contrato"]).optional(), q: z.string().max(80).optional() });

type Upload = { originalname: string; mimetype: string; buffer: Buffer } | undefined;
const actorOf = (u: SchoolAccess) => (u.support ? { id: null, name: null } : { id: u.id, name: u.fullName });

/**
 * Contratos dos funcionários. Ver: hr.contracts.view · criar, alterar, renovar, rescindir e a
 * cópia assinada: hr.contracts.manage · o salário base (ver e definir): hr.contracts.salary.
 */
@ApiTags("Portal · Recursos Humanos · Contratos")
@ApiHeader({ name: "X-Tenant", required: false })
@ApiBearerAuth()
@Controller("v1/hr")
@UseGuards(TenantGuard, SchoolAuthGuard)
export class ContractsController {
  constructor(
    private readonly contracts: Contracts,
    private readonly stores: HrFileStores,
  ) {}

  private repo(t: TenantContext) {
    return new PrismaContractRepository(t.db);
  }

  private async access(t: TenantContext, u: SchoolAccess): Promise<ContractAccess> {
    const have = await permissionsOf(t.db, u);
    return { manage: have.includes("hr.contracts.manage"), salary: have.includes("hr.contracts.salary") };
  }

  @Get("contracts")
  @RequirePermission("hr.contracts.view")
  @ApiOperation({ summary: "Contratos do colégio (?view=vigentes|a-terminar|terminados|sem-contrato, ?q=) com contagens e massa salarial (com permissão)" })
  async list(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Query(new ZodValidationPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return unwrap(await this.contracts.list(this.repo(t), await this.access(t, u), q), HR_HTTP);
  }

  @Get("employees/:id/contracts")
  @RequirePermission("hr.contracts.view")
  @ApiOperation({ summary: "Contratos de um funcionário (histórico, o vigente e o que se pode fazer)" })
  async ofEmployee(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) employeeId: string) {
    return unwrap(await this.contracts.employeeContracts(this.repo(t), await this.access(t, u), employeeId), HR_HTTP);
  }

  @Post("employees/:id/contracts")
  @RequirePermission("hr.contracts.manage")
  @ApiOperation({ summary: "Novo contrato (ou renovação, com previousId)", description: "409 CONTRACT_OVERLAP se as datas se sobrepõem a outro contrato do funcionário." })
  @ApiBody({ schema: openApi(createBody) })
  async create(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) employeeId: string, @Body(new ZodValidationPipe(createBody)) body: z.infer<typeof createBody>) {
    return unwrap(await this.contracts.create(this.repo(t), actorOf(u), await this.access(t, u), employeeId, body), HR_HTTP);
  }

  @Put("contracts/:id")
  @RequirePermission("hr.contracts.manage")
  @ApiOperation({ summary: "Corrigir um contrato (não acabado nem rescindido)", description: "Sem baseSalary no corpo, o salário fica como está." })
  @ApiBody({ schema: openApi(contractBody) })
  async update(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) contractId: string, @Body(new ZodValidationPipe(contractBody)) body: z.infer<typeof contractBody>) {
    return unwrap(await this.contracts.update(this.repo(t), actorOf(u), await this.access(t, u), contractId, body), HR_HTTP);
  }

  @Post("contracts/:id/terminate")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("hr.contracts.manage")
  @ApiOperation({ summary: "Rescindir (data dentro do contrato e motivo)" })
  @ApiBody({ schema: openApi(terminateBody) })
  async terminate(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) contractId: string, @Body(new ZodValidationPipe(terminateBody)) body: z.infer<typeof terminateBody>) {
    return unwrap(await this.contracts.terminate(this.repo(t), actorOf(u), await this.access(t, u), contractId, body), HR_HTTP);
  }

  @Delete("contracts/:id")
  @RequirePermission("hr.contracts.manage")
  @ApiOperation({ summary: "Apagar um contrato que ainda não começou (criado por engano)" })
  async remove(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) contractId: string) {
    return unwrap(await this.contracts.remove(this.repo(t), this.stores.for(t.entry), actorOf(u), contractId), HR_HTTP);
  }

  @Post("contracts/:id/file")
  @RequirePermission("hr.contracts.manage")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 2 } }))
  @ApiConsumes("multipart/form-data")
  @ApiOperation({ summary: "Juntar a cópia assinada (PDF, JPG ou PNG até 10 MB; substitui a anterior)", description: "Cifrada antes de ir para o armazenamento do colégio." })
  async upload(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) contractId: string, @UploadedFile() file: Upload) {
    return unwrap(await this.contracts.uploadFile(this.repo(t), this.stores.for(t.entry), actorOf(u), await this.access(t, u), contractId, file), HR_HTTP);
  }

  @Get("contracts/:id/file")
  @RequirePermission("hr.contracts.view")
  @ApiOperation({ summary: "Ver a cópia assinada (decifrada pela API; nunca há link direto)" })
  async file(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) contractId: string, @Res({ passthrough: true }) res: Response) {
    const repo = this.repo(t);
    const f = unwrap(await this.contracts.readFile(repo, this.stores.for(t.entry), contractId), HR_HTTP);
    await repo.record("HR_CONTRACT_FILE_VIEWED", f.employeeId, u.support ? null : u.id, { contractId }, new Date());
    return sendFile(res, f);
  }

  @Delete("contracts/:id/file")
  @RequirePermission("hr.contracts.manage")
  @ApiOperation({ summary: "Retirar a cópia assinada" })
  async removeFile(@CurrentTenant() t: TenantContext, @CurrentUser() u: SchoolAccess, @Param("id", id) contractId: string) {
    return unwrap(await this.contracts.removeFile(this.repo(t), this.stores.for(t.entry), actorOf(u), contractId), HR_HTTP);
  }
}
