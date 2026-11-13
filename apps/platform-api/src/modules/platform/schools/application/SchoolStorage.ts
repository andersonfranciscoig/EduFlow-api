import type { Clock } from "../../../../../../../libs/kernel/src/application/ports";
import { fail, ok } from "../../../../../../../libs/kernel/src/domain/Result";
import { parseUploadThingToken, PLAN_LABELS, planFromLimit, type StoragePlan, storageError } from "../domain/storage";

export interface StorageRow {
  schoolId: string;
  appId: string;
  keyHint: string;
  tokenCiphertext: string;
  plan: StoragePlan;
  usedBytes: number | null;
  appBytes: number | null;
  limitBytes: number | null;
  filesCount: number | null;
  usageCheckedAt: Date | null;
  usageError: string | null;
  configuredBy: string | null;
  updatedAt: Date;
}

export interface Usage {
  totalBytes: number;
  appTotalBytes: number;
  filesUploaded: number;
  limitBytes: number;
}

export interface StorageRepository {
  schoolExists(id: string): Promise<boolean>;
  find(schoolId: string): Promise<StorageRow | null>;
  all(): Promise<StorageRow[]>;
  /** Falha "app_in_use" se a app já for de outro colégio. */
  save(input: { schoolId: string; appId: string; keyHint: string; tokenSealed: string; tokenCiphertext: string; staffId: string; now: Date }): Promise<{ ok: true } | { ok: false; reason: "app_in_use" }>;
  saveUsage(schoolId: string, usage: { plan: StoragePlan; usage: Usage | null; error: string | null; now: Date }): Promise<void>;
  remove(schoolId: string): Promise<boolean>;
  record(schoolId: string, type: string, staffId: string, details: Record<string, unknown>, now: Date): Promise<void>;
}

/** Os dois "cofres" do token: selado para o school-api, cifrado para a plataforma. */
export interface TokenVault {
  /** null = falta a chave pública das credenciais dos colégios nesta API */
  sealForSchoolApi(token: string): string | null;
  encrypt(token: string): string;
  decrypt(ciphertext: string): string;
}

/** Pergunta ao UploadThing quanto ocupa a conta (e, assim, se o token funciona). */
export interface UsageProbe {
  usage(token: string): Promise<Usage>;
}

const dto = (r: StorageRow | null) =>
  r && {
    configured: true as const,
    provider: "UPLOADTHING" as const,
    appId: r.appId,
    keyHint: r.keyHint,
    plan: r.plan,
    planLabel: PLAN_LABELS[r.plan],
    usedBytes: r.usedBytes,
    appBytes: r.appBytes,
    limitBytes: r.limitBytes,
    filesCount: r.filesCount,
    usagePct: r.usedBytes != null && r.limitBytes ? Math.min(100, Math.round((r.usedBytes / r.limitBytes) * 1000) / 10) : null,
    usageCheckedAt: r.usageCheckedAt?.toISOString() ?? null,
    usageError: r.usageError,
    configuredBy: r.configuredBy,
    updatedAt: r.updatedAt.toISOString(),
  };

/**
 * A app do UploadThing de cada colégio (a equipa EduFlow configura no painel).
 * O school-api envia para lá os ficheiros do colégio (cifrados); sem app, os envios ficam bloqueados.
 */
export class SchoolStorage {
  constructor(
    private readonly repo: StorageRepository,
    private readonly vault: TokenVault,
    private readonly probe: UsageProbe,
    private readonly clock: Clock,
    /** false só em testes (não chama o UploadThing ao guardar) */
    private readonly verify: boolean,
  ) {}

  async get(schoolId: string) {
    if (!(await this.repo.schoolExists(schoolId))) return fail(storageError("SCHOOL_NOT_FOUND", "Colégio não encontrado."));
    return ok({ storage: dto(await this.repo.find(schoolId)) });
  }

  /** Resumo de todos (lista de colégios: quem ainda não tem armazenamento). */
  async summaries() {
    const rows = await this.repo.all();
    return { storage: Object.fromEntries(rows.map((r) => [r.schoolId, dto(r)])) };
  }

  /** Guarda (ou troca) o token. Confirma-o junto do UploadThing antes de o aceitar. */
  async configure(schoolId: string, staffId: string, rawToken: string) {
    if (!(await this.repo.schoolExists(schoolId))) return fail(storageError("SCHOOL_NOT_FOUND", "Colégio não encontrado."));
    const parsed = parseUploadThingToken(rawToken);
    if (!parsed.ok) return parsed;
    const sealed = this.vault.sealForSchoolApi(parsed.value.token);
    if (!sealed) return fail(storageError("KEY_MISSING", "Falta configurar nesta API a chave pública das credenciais dos colégios (TENANT_CREDENTIALS_PUBLIC_KEY_FILE)."));

    let usage: Usage | null = null;
    if (this.verify) {
      try {
        usage = await this.probe.usage(parsed.value.token);
      } catch {
        return fail(storageError("TOKEN_REJECTED", "O UploadThing recusou este token (ou não respondeu). Confirme que copiou o token V7 da app certa."));
      }
    }
    const now = this.clock.now();
    const previous = await this.repo.find(schoolId);
    const saved = await this.repo.save({ schoolId, appId: parsed.value.appId, keyHint: parsed.value.keyHint, tokenSealed: sealed, tokenCiphertext: this.vault.encrypt(parsed.value.token), staffId, now });
    if (!saved.ok) return fail(storageError("APP_IN_USE", "Esta app do UploadThing já está ligada a outro colégio. Cada colégio tem a sua."));
    await this.repo.saveUsage(schoolId, { plan: planFromLimit(usage?.limitBytes), usage, error: null, now });
    await this.repo.record(schoolId, previous ? "STORAGE_CHANGED" : "STORAGE_CONFIGURED", staffId, { appId: parsed.value.appId, previousAppId: previous?.appId ?? null }, now);
    return ok({ storage: dto(await this.repo.find(schoolId)) });
  }

  /** Volta a medir o uso (bytes, ficheiros, limite → plano). */
  async refresh(schoolId: string) {
    const row = await this.repo.find(schoolId);
    if (!row) return fail(storageError("NOT_CONFIGURED", "Este colégio ainda não tem armazenamento configurado."));
    const now = this.clock.now();
    try {
      const usage = await this.probe.usage(this.vault.decrypt(row.tokenCiphertext));
      await this.repo.saveUsage(schoolId, { plan: planFromLimit(usage.limitBytes), usage, error: null, now });
    } catch (e) {
      await this.repo.saveUsage(schoolId, { plan: row.plan, usage: null, error: `Não foi possível consultar o UploadThing (${e instanceof Error ? e.message.slice(0, 120) : "erro"}).`, now });
    }
    return ok({ storage: dto(await this.repo.find(schoolId)) });
  }

  /** Desliga a app: os envios do colégio ficam bloqueados (os ficheiros continuam na conta dele). */
  async remove(schoolId: string, staffId: string) {
    const row = await this.repo.find(schoolId);
    if (!row) return fail(storageError("NOT_CONFIGURED", "Este colégio não tem armazenamento configurado."));
    await this.repo.remove(schoolId);
    await this.repo.record(schoolId, "STORAGE_REMOVED", staffId, { appId: row.appId }, this.clock.now());
    return ok({ storage: null });
  }
}
