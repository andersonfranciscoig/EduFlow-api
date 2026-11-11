import { BACKUP_POLICY } from "../../../../../../../libs/kernel/src/domain/backup-policy";
import { fail, ok } from "../../../../../../../libs/kernel/src/domain/Result";
import { databaseError } from "../domain/errors";
import { toBackupDto, toRestoreDto } from "./database-dto";
import type { BackupRepository, DatabaseServerRepository } from "./ports";

const policy = {
  everyHours: BACKUP_POLICY.EVERY_HOURS,
  retentionDays: BACKUP_POLICY.RETENTION_DAYS,
  encryption: "AES-256-GCM (antes de sair do servidor)",
  label: `Automática a cada ${BACKUP_POLICY.EVERY_HOURS} h · guardadas ${BACKUP_POLICY.RETENTION_DAYS} dias · cifradas`,
};

/**
 * Cópias de segurança e restauros. A equipa pede; o provisioner faz
 * (pg_dump/pg_restore + cifra). A plataforma nunca vê os dados nem a chave.
 */
export class DatabaseBackups {
  constructor(
    private readonly backups: BackupRepository,
    private readonly servers: DatabaseServerRepository,
  ) {}

  async forServer(serverId: string) {
    if (!(await this.servers.findById(serverId))) return fail(databaseError("SERVER_NOT_FOUND", "Servidor não encontrado."));
    const [list, restores] = await Promise.all([this.backups.forServer(serverId, 60), this.backups.restores({ serverId }, 20)]);
    return ok({ policy, backups: list.map(toBackupDto), restores: restores.map(toRestoreDto) });
  }

  async forSchool(schoolId: string) {
    const [list, restores] = await Promise.all([this.backups.forSchool(schoolId, 30), this.backups.restores({ schoolId }, 20)]);
    return { policy, backups: list.map(toBackupDto), restores: restores.map(toRestoreDto) };
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

  /**
   * Restaurar uma cópia na BD do colégio a que pertence. Exige 2FA recente
   * (controlador), motivo e a confirmação do identificador do colégio.
   */
  async requestRestore(backupId: string, staffId: string, input: { reason: string; confirm: string }) {
    const backup = await this.backups.findBackup(backupId);
    if (!backup) return fail(databaseError("BACKUP_NOT_FOUND", "Cópia não encontrada."));
    if (backup.status !== "DONE") return fail(databaseError("INVALID_STATE", "Só se pode restaurar uma cópia concluída e ainda guardada."));
    if (!(await this.backups.hasDatabase(backup.schoolId))) return fail(databaseError("INVALID_STATE", "A base de dados deste colégio não existe."));

    const slug = await this.backups.schoolSlug(backup.schoolId);
    if (!slug || input.confirm.trim().toLowerCase() !== slug) {
      return fail(databaseError("CONFIRMATION_MISMATCH", "Escreva exatamente o identificador do colégio para confirmar.", { expected: slug }));
    }
    const reason = input.reason.trim();
    if (reason.length < 10) return fail(databaseError("INVALID_STATE", "Explique o motivo do restauro (pelo menos 10 caracteres)."));

    const id = await this.backups.requestRestore({ schoolId: backup.schoolId, backupId, staffId, reason });
    if (!id) return fail(databaseError("INVALID_STATE", "Já há um restauro em curso para este colégio."));
    return ok({ restoreId: id, ...(await this.forSchool(backup.schoolId)) });
  }
}
