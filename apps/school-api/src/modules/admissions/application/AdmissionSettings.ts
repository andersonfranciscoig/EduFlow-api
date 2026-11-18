import type { Clock, IdGenerator } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok } from "../../../../../../libs/kernel/src/domain/Result";
import {
  admissionError,
  checkDocumentType,
  checkPeriods,
  DOCUMENT_TARGETS,
  type DocumentTypeInput,
  FILE_FORMATS,
  MAX_DOCUMENT_TYPES,
  PERIOD_KIND_KEYS,
  PERIOD_KINDS,
  PERIOD_STATE_LABELS,
  periodState,
  PROCESS_TYPE_KEYS,
  PROCESS_TYPES,
  SUGGESTED_DOCUMENTS,
} from "../domain/settings";
import type { AdmissionSettingsRepository, DocumentTypeRow, YearRow } from "./settings-ports";

export interface AdmissionSettingsAccess {
  /** períodos */
  manageSettings: boolean;
  manageDocuments: boolean;
}

type DocumentBody = Parameters<typeof checkDocumentType>[0];

/** "AAAA-MM-DD" de hoje em Luanda. */
const luandaToday = (now: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Luanda", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
const YEAR_STATUS_LABELS = { PLANNED: "A preparar", ACTIVE: "Em curso", CLOSED: "Encerrado" } as const;

/**
 * Configuração das inscrições e matrículas (1.ª parte): os períodos de cada ano letivo e os
 * documentos pedidos. Ver: admissions.access · períodos: admissions.settings.manage ·
 * documentos: admissions.documents.manage.
 */
export class AdmissionSettings {
  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  private yearDto(y: YearRow, today: string) {
    return {
      id: y.id,
      name: y.name,
      startsOn: y.startsOn,
      endsOn: y.endsOn,
      status: y.status,
      statusLabel: YEAR_STATUS_LABELS[y.status],
      periods: PERIOD_KIND_KEYS.map((k) => {
        const w = y.periods[k];
        const state = periodState(w, today);
        return { kind: k, label: PERIOD_KINDS[k], from: w?.from ?? null, to: w?.to ?? null, state, stateLabel: PERIOD_STATE_LABELS[state] };
      }),
      updatedAt: y.periodsUpdatedAt?.toISOString() ?? null,
    };
  }

  private documentDto(d: DocumentTypeRow) {
    return {
      ...d,
      targetLabel: DOCUMENT_TARGETS[d.target].label,
      processLabels: d.processTypes.length ? d.processTypes.map((p) => PROCESS_TYPES[p].label) : ["Todos os processos"],
      updatedAt: d.updatedAt.toISOString(),
    };
  }

  async view(repo: AdmissionSettingsRepository, access: AdmissionSettingsAccess) {
    const today = luandaToday(this.clock.now());
    const [years, documents] = await Promise.all([repo.years(), repo.documents()]);
    const names = new Set(documents.map((d) => d.name.toLowerCase()));
    return {
      today,
      canManageSettings: access.manageSettings,
      canManageDocuments: access.manageDocuments,
      years: years.map((y) => this.yearDto(y, today)),
      documents: documents.map((d) => this.documentDto(d)),
      documentSuggestions: SUGGESTED_DOCUMENTS.filter((s) => !names.has(s.name.toLowerCase())),
      processTypes: PROCESS_TYPE_KEYS.map((k) => ({ value: k, ...PROCESS_TYPES[k] })),
      targets: (Object.keys(DOCUMENT_TARGETS) as (keyof typeof DOCUMENT_TARGETS)[]).map((k) => ({ value: k, ...DOCUMENT_TARGETS[k] })),
      fileFormats: FILE_FORMATS,
    };
  }

  // ================================================================ períodos

  async savePeriods(repo: AdmissionSettingsRepository, actorId: string | null, yearId: string, input: Parameters<typeof checkPeriods>[0]) {
    const y = await repo.year(yearId);
    if (!y) return fail(admissionError("YEAR_NOT_FOUND", "Ano letivo não encontrado."));
    if (y.status === "CLOSED") return fail(admissionError("YEAR_CLOSED", "Este ano letivo está encerrado: só de leitura."));
    const periods = checkPeriods(input, y);
    if (!periods.ok) return periods;
    const now = this.clock.now();
    await repo.savePeriods(yearId, periods.value, actorId, now);
    await repo.record("ADMISSION_PERIODS_SAVED", yearId, actorId, { periods: periods.value }, now);
    return ok(this.yearDto((await repo.year(yearId))!, luandaToday(now)));
  }

  // ================================================================ documentos

  private async validDocument(repo: AdmissionSettingsRepository, input: DocumentBody, exceptId: string | null) {
    const d = checkDocumentType(input);
    if (!d.ok) return d;
    const all = await repo.documents();
    if (all.some((x) => x.id !== exceptId && x.name.toLowerCase() === d.value.name.toLowerCase())) return fail(admissionError("DOCUMENT_EXISTS", "Já existe um documento com este nome."));
    if (!exceptId && all.length >= MAX_DOCUMENT_TYPES) return fail(admissionError("LIMIT_REACHED", `No máximo ${MAX_DOCUMENT_TYPES} documentos.`));
    return ok(d.value);
  }

  async createDocument(repo: AdmissionSettingsRepository, actorId: string | null, input: DocumentBody) {
    const d = await this.validDocument(repo, input, null);
    if (!d.ok) return d;
    const id = this.ids.next();
    const now = this.clock.now();
    await repo.createDocument({ ...d.value, id, now });
    await repo.record("ADMISSION_DOCUMENT_CREATED", id, actorId, { name: d.value.name }, now);
    return ok(this.documentDto((await repo.documents()).find((x) => x.id === id)!));
  }

  async updateDocument(repo: AdmissionSettingsRepository, actorId: string | null, id: string, input: DocumentBody) {
    const d = await this.validDocument(repo, input, id);
    if (!d.ok) return d;
    const now = this.clock.now();
    if (!(await repo.updateDocument(id, d.value, now))) return fail(admissionError("DOCUMENT_NOT_FOUND", "Documento não encontrado."));
    await repo.record("ADMISSION_DOCUMENT_UPDATED", id, actorId, { name: d.value.name }, now);
    return ok(this.documentDto((await repo.documents()).find((x) => x.id === id)!));
  }

  async setDocumentActive(repo: AdmissionSettingsRepository, actorId: string | null, id: string, active: boolean) {
    const now = this.clock.now();
    if (!(await repo.setDocumentActive(id, active, now))) return fail(admissionError("DOCUMENT_NOT_FOUND", "Documento não encontrado."));
    await repo.record(active ? "ADMISSION_DOCUMENT_ACTIVATED" : "ADMISSION_DOCUMENT_DEACTIVATED", id, actorId, {}, now);
    return ok({ active });
  }

  async deleteDocument(repo: AdmissionSettingsRepository, actorId: string | null, id: string) {
    if (!(await repo.deleteDocument(id))) return fail(admissionError("DOCUMENT_NOT_FOUND", "Documento não encontrado."));
    await repo.record("ADMISSION_DOCUMENT_DELETED", id, actorId, {}, this.clock.now());
    return ok({ deleted: true });
  }

  async reorderDocuments(repo: AdmissionSettingsRepository, ids: string[]) {
    const all = await repo.documents();
    if (ids.length !== all.length || new Set(ids).size !== ids.length || ids.some((id) => !all.some((d) => d.id === id))) {
      return fail(admissionError("INVALID_INPUT", "A ordem tem de incluir todos os documentos, uma vez cada."));
    }
    await repo.reorderDocuments(ids);
    return ok({ order: ids });
  }

  /** Junta os documentos sugeridos escolhidos (pelo nome); os que já existem são ignorados. */
  async addSuggestedDocuments(repo: AdmissionSettingsRepository, actorId: string | null, names: string[]) {
    const existing = new Set((await repo.documents()).map((d) => d.name.toLowerCase()));
    const picked: DocumentTypeInput[] = SUGGESTED_DOCUMENTS.filter((s) => names.includes(s.name) && !existing.has(s.name.toLowerCase()));
    if (!picked.length) return fail(admissionError("INVALID_INPUT", "Escolha pelo menos uma sugestão."));
    if (existing.size + picked.length > MAX_DOCUMENT_TYPES) return fail(admissionError("LIMIT_REACHED", `No máximo ${MAX_DOCUMENT_TYPES} documentos.`));
    const now = this.clock.now();
    for (const s of picked) {
      const id = this.ids.next();
      await repo.createDocument({ ...s, id, now });
      await repo.record("ADMISSION_DOCUMENT_CREATED", id, actorId, { name: s.name, suggested: true }, now);
    }
    return ok({ added: picked.length });
  }
}
