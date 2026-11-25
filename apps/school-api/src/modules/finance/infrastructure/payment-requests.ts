import { Logger } from "@nestjs/common";
import { TenantDirectory } from "../../../tenancy/tenant-directory";

export interface PaymentRequestRow {
  method: "REFERENCIA" | "EXPRESS";
  status: string;
  requestedAt: Date;
}

/**
 * A lista de espera da EduFlow (pagamento por referência e Multicaixa Express). Vive na BD da plataforma:
 * o school-api só pode inserir/retirar pedidos e ler o estado deles (ver infra/db/grants.sql).
 * Se a plataforma não responder (ou ainda não tiver a tabela), devolve null: o resto dos pagamentos não para.
 */
export class PaymentRequests {
  private readonly logger = new Logger("PaymentRequests");

  constructor(private readonly directory: TenantDirectory) {}

  private async safe<T>(work: () => Promise<T>): Promise<T | null> {
    try {
      return await work();
    } catch (e) {
      this.logger.warn(`lista de espera da plataforma indisponível: ${(e as Error).message.split("\n").pop()}`);
      return null;
    }
  }

  list(schoolId: string) {
    return this.safe(
      () => this.directory.platform.$queryRaw<PaymentRequestRow[]>`SELECT method, status, requested_at AS "requestedAt" FROM payment_integration_requests WHERE school_id = ${schoolId}::uuid`,
    );
  }

  /** Entra na lista (ou volta a entrar, se tinha retirado ou sido recusado). Devolve o estado. */
  request(schoolId: string, method: "REFERENCIA" | "EXPRESS", note: string | null, by: string) {
    return this.safe(async () => {
      const r = await this.directory.platform.$queryRaw<{ status: string }[]>`
        INSERT INTO payment_integration_requests AS r (school_id, method, note, requested_by_name) VALUES (${schoolId}::uuid, ${method}, ${note}, ${by})
        ON CONFLICT (school_id, method) DO UPDATE
           SET status = CASE WHEN r.status IN ('CANCELLED', 'DECLINED') THEN 'WAITING' ELSE r.status END, note = EXCLUDED.note, requested_by_name = EXCLUDED.requested_by_name,
               requested_at = CASE WHEN r.status IN ('CANCELLED', 'DECLINED') THEN CURRENT_TIMESTAMP ELSE r.requested_at END, updated_at = CURRENT_TIMESTAMP
        RETURNING status`;
      return r[0].status;
    });
  }

  /** true = retirado; false = já está a ser tratado. */
  cancel(schoolId: string, method: "REFERENCIA" | "EXPRESS") {
    return this.safe(async () => (await this.directory.platform.$executeRaw`UPDATE payment_integration_requests SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE school_id = ${schoolId}::uuid AND method = ${method} AND status = 'WAITING'`) === 1);
  }
}
