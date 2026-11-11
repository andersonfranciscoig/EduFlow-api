import type { Clock } from "../../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../../libs/kernel/src/domain/Result";
import { schoolError, type SchoolError } from "../domain/errors";
import type { SchoolRepository } from "../domain/SchoolRepository";
import type { SchoolDatabasePort, SchoolSettings, SupportTicketIssuer } from "./ports";

export const SUPPORT_TICKET_TTL_SECONDS = 60;

/**
 * Entrada da equipa EduFlow no portal de um colégio (suporte).
 *
 * A plataforma só emite um BILHETE (60 s, uso único, assinado com uma chave que
 * só ela tem). Quem decide se entra é o school-api, com a autorização que o
 * PRÓPRIO colégio guarda na sua BD. Uma emergência (sem autorização) só pode
 * ser pedida por um ADMIN e o colégio é avisado por email na mesma.
 */
export class SchoolSupport {
  constructor(
    private readonly schools: SchoolRepository,
    private readonly databases: SchoolDatabasePort,
    private readonly tickets: SupportTicketIssuer,
    private readonly settings: SchoolSettings,
    private readonly clock: Clock,
  ) {}

  async requestTicket(
    schoolId: string,
    staff: { id: string; fullName: string; role: string },
    input: { mode: "READ" | "WRITE"; emergency: boolean; reason: string },
  ): Promise<Result<{ url: string; expiresIn: number; mode: string; emergency: boolean }, SchoolError>> {
    if (input.emergency && staff.role !== "ADMIN") {
      return fail(schoolError("SUPPORT_FORBIDDEN", "Só um administrador pode pedir um acesso de emergência."));
    }
    const school = await this.schools.findById(schoolId);
    if (!school) return fail(schoolError("SCHOOL_NOT_FOUND", "Colégio não encontrado."));
    const database = (await this.databases.status(schoolId)) as { state?: string } | null;
    if (database?.state !== "READY") return fail(schoolError("INVALID_STATE", "O portal deste colégio ainda não está pronto."));

    const recorded = school.requestSupportAccess(staff.id, input, this.clock.now());
    if (!recorded.ok) return recorded;
    await this.schools.save(school);

    const ticket = await this.tickets.issue({
      staffId: staff.id,
      staffName: staff.fullName,
      schoolId,
      mode: input.mode,
      emergency: input.emergency,
      reason: input.reason.trim(),
      ttlSeconds: SUPPORT_TICKET_TTL_SECONDS,
    });
    // o bilhete vai no FRAGMENTO (#): o browser nunca o envia a nenhum servidor nem em "Referer"
    const portal = this.settings.portalUrlTemplate.replace("{slug}", school.slug!);
    return ok({ url: `${portal}/suporte#bilhete=${ticket}`, expiresIn: SUPPORT_TICKET_TTL_SECONDS, mode: input.mode, emergency: input.emergency });
  }
}
