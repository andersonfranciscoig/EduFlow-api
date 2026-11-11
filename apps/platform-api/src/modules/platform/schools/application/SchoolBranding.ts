import type { Clock } from "../../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../../libs/kernel/src/domain/Result";
import { schoolError, type SchoolError } from "../domain/errors";
import { checkLogo } from "../domain/logo";
import type { School } from "../domain/School";
import type { SchoolRepository } from "../domain/SchoolRepository";
import type { LogoStorage } from "./ports";

/**
 * Identidade visual do colégio (hoje: o logótipo). Usado pelo responsável
 * (staffId null) e pela equipa EduFlow.
 */
export class SchoolBranding {
  constructor(
    private readonly schools: SchoolRepository,
    private readonly storage: LogoStorage,
    private readonly clock: Clock,
  ) {}

  private async load(id: string): Promise<Result<School, SchoolError>> {
    const school = await this.schools.findById(id);
    return school ? ok(school) : fail(schoolError("SCHOOL_NOT_FOUND", "Colégio não encontrado."));
  }

  /** Apagar um ficheiro antigo nunca faz falhar a operação. */
  private discard(key: string | null) {
    if (key) this.storage.remove(key).catch((e: unknown) => console.warn(`[logo] não foi possível apagar ${key}: ${(e as Error).message}`));
  }

  async changeLogo(schoolId: string, content: Buffer, staffId: string | null): Promise<Result<void, SchoolError>> {
    const school = await this.load(schoolId);
    if (!school.ok) return school;
    const image = checkLogo(content);
    if (!image.ok) return image;

    // valida o estado ANTES de enviar o ficheiro
    const now = this.clock.now();
    const allowed = school.value.canEditLogo(staffId);
    if (!allowed.ok) return allowed;

    let stored: { key: string; url: string };
    try {
      stored = await this.storage.put(schoolId, { mimeType: image.value.mimeType, content });
    } catch (error) {
      console.error(`[logo] não foi possível guardar o logótipo do colégio ${schoolId}: ${(error as Error).message}`);
      return fail(schoolError("STORAGE_UNAVAILABLE", "Não foi possível guardar o logótipo agora (ligação ao armazenamento). Tente novamente dentro de instantes."));
    }
    const changed = school.value.changeLogo({ key: stored.key, url: stored.url, updatedAt: now }, staffId, now);
    if (!changed.ok) {
      this.discard(stored.key);
      return changed;
    }
    try {
      await this.schools.save(school.value);
    } catch (error) {
      this.discard(stored.key);
      throw error;
    }
    this.discard(changed.value);
    return ok(undefined);
  }

  /** Ficheiro de um logótipo guardado localmente (rota pública; null = não existe). */
  async logoFile(key: string) {
    return (await this.storage.read?.(key)) ?? null;
  }

  async removeLogo(schoolId: string, staffId: string | null): Promise<Result<void, SchoolError>> {
    const school = await this.load(schoolId);
    if (!school.ok) return school;
    const removed = school.value.removeLogo(staffId, this.clock.now());
    if (!removed.ok) return removed;
    await this.schools.save(school.value);
    this.discard(removed.value);
    return ok(undefined);
  }
}
