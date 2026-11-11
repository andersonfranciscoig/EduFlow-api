import { BACKUP_POLICY } from "../../../../../../../libs/kernel/src/domain/backup-policy";
import { fail, ok } from "../../../../../../../libs/kernel/src/domain/Result";
import { databaseError } from "../domain/errors";
import { toBackupDto } from "./database-dto";
import type { BackupRepository, DatabaseServerRepository } from "./ports";

const policy = {
  everyHours: BACKUP_POLICY.EVERY_HOURS,
  retentionDays: BACKUP_POLICY.RETENTION_DAYS,
  encryption: "AES-256-GCM (antes de sair do servidor)",
  label: `Automática a cada ${BACKUP_POLICY.EVERY_HOURS} h · guardadas ${BACKUP_POLICY.RETENTION_DAYS} dias · cifradas`,
};

/**
 * Cópias de segurança. A equipa pede; o provisioner faz (pg_dump → cifra → armazenamento).
 * A plataforma nunca vê os dados nem a chave das cópias.
 */
export class DatabaseBackups {
  constructor(
    private readonly backups: BackupRepository,
    private readonly servers: DatabaseServerRepository,
  ) {}

  async forServer(serverId: string) {
    if (!(await this.servers.findById(serverId))) return fail(databaseError("SERVER_NOT_FOUND", "Servidor não encontrado."));
    const list = await this.backups.forServer(serverId, 60);
    return ok({ policy, backups: list.map(toBackupDto) });
  }

  async forSchool(schoolId: string) {
    const list = await this.backups.forSchool(schoolId, 30);
    return { policy, backups: list.map(toBackupDto) };
  }

  /** Copiar agora todos os colégios deste servidor. */
  async requestForServer(serverId: string, staffId: string) {
    if (!(await this.servers.findById(serverId))) return fail(databaseError("SERVER_NOT_FOUND", "Servidor não encontrado."));
    const schools = await this.backups.schoolsOnServer(serverId);
    if (!schools.length) return fail(databaseError("INVALID_STATE", "Este servidor ainda não tem bases de dados de colégios para copiar."));
    const queued = await this.backups.request(schools, staffId);
    return ok({ queued, schools: schools.length });
  }

  async requestForSchool(schoolId: string, staffId: string) {
    if (!(await this.backups.hasDatabase(schoolId))) return fail(databaseError("INVALID_STATE", "A base de dados deste colégio ainda não foi criada."));
    const queued = await this.backups.request([schoolId], staffId);
    return ok({ queued, schools: 1 });
  }
}
