import type { Clock, IdGenerator } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok } from "../../../../../../libs/kernel/src/domain/Result";
import {
  canonical,
  checkDocumentType,
  checkField,
  checkSection,
  describeChanges,
  FIELD_TYPES,
  FILE_FORMATS,
  type FieldSettings,
  type FormSnapshot,
  type HrError,
  hrError,
  isSectionKey,
  MAX_DOCUMENT_TYPES,
  MAX_FIELDS_PER_SECTION,
  PERSONAL_FIELDS,
  PERSONAL_SCHEMA,
  type SectionKey,
  SUGGESTED_DOCUMENTS,
  SUGGESTED_FIELDS,
} from "../domain/form";
import type { ConfigOutcome, DocumentRow, FieldRow, HrSettingsRepository, SectionRow, VersionInfo } from "./ports";

const fieldDto = (f: FieldRow) => ({ ...f, typeLabel: FIELD_TYPES[f.type].label });
const versionDto = (v: VersionInfo) => ({ number: v.number, publishedAt: v.publishedAt.toISOString(), publishedBy: v.publishedBy });

function outcomeError(r: Exclude<ConfigOutcome<unknown>, { ok: true }>, what: "field" | "document" | "section"): HrError {
  if (what === "section") return hrError("SECTION_NOT_FOUND", "Secção não encontrada.");
  if (what === "field") {
    if (r.reason === "exists") return hrError("FIELD_EXISTS", "Já existe um campo com este nome nesta secção.");
    if (r.reason === "limit") return hrError("LIMIT_REACHED", `Uma secção tem no máximo ${MAX_FIELDS_PER_SECTION} campos.`);
    return hrError("FIELD_NOT_FOUND", "Campo não encontrado.");
  }
  if (r.reason === "exists") return hrError("DOCUMENT_EXISTS", "Já existe um documento com este nome.");
  if (r.reason === "limit") return hrError("LIMIT_REACHED", `No máximo ${MAX_DOCUMENT_TYPES} documentos.`);
  return hrError("DOCUMENT_NOT_FOUND", "Documento não encontrado.");
}

/** Fotografia da configuração atual: só campos e documentos ativos, pela ordem definida. */
function snapshotOf(sections: SectionRow[], fields: FieldRow[], documents: DocumentRow[]): FormSnapshot {
  return {
    personalSchema: PERSONAL_SCHEMA,
    personal: PERSONAL_FIELDS,
    sections: sections.map((s) => ({
      key: s.key,
      title: s.title,
      description: s.description,
      repeatable: s.repeatable,
      entryLabel: s.entryLabel,
      maxEntries: s.maxEntries,
      fields: fields
        .filter((f) => f.sectionKey === s.key && f.active)
        .map((f) => ({ id: f.id, label: f.label, type: f.type, required: f.required, help: f.help, options: f.options, settings: f.settings })),
    })),
    documents: documents
      .filter((d) => d.active)
      .map((d) => ({ id: d.id, name: d.name, description: d.description, required: d.required, formats: d.formats, maxSizeMb: d.maxSizeMb, multiple: d.multiple })),
  };
}

export interface HrPermissions {
  manageForm: boolean;
  manageDocuments: boolean;
}

/**
 * Configuração do cadastro de funcionários: campos das secções dinâmicas, documentos
 * pedidos e versões publicadas. As permissões são exigidas no controller (guard) e
 * voltam a ser vistas aqui para a publicação (que serve aos dois tipos de alteração).
 */
export class HrSettings {
  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async view(repo: HrSettingsRepository, can: HrPermissions) {
    const [sections, fields, documents, versions, latest] = await Promise.all([repo.sections(), repo.fields(), repo.documents(), repo.versions(), repo.latest()]);
    const current = snapshotOf(sections, fields, documents);
    const pending = latest && canonical(latest.snapshot) === canonical(current) ? [] : describeChanges(latest?.snapshot ?? null, current);
    const taken = (s: SectionKey) => new Set(fields.filter((f) => f.sectionKey === s).map((f) => f.label.toLowerCase()));
    const docNames = new Set(documents.map((d) => d.name.toLowerCase()));
    return {
      canManageForm: can.manageForm,
      canManageDocuments: can.manageDocuments,
      canPublish: can.manageForm || can.manageDocuments,
      fieldTypes: Object.entries(FIELD_TYPES).map(([value, t]) => ({ value, ...t })),
      fileFormats: FILE_FORMATS,
      personal: PERSONAL_FIELDS.map((f) => ({ ...f, typeLabel: FIELD_TYPES[f.type].label, options: f.key === "province" ? [] : (f.options ?? []) })),
      sections: sections.map((s) => ({
        ...s,
        fields: fields.filter((f) => f.sectionKey === s.key).map(fieldDto),
        // sugestões que ainda não existem nesta secção (o colégio escolhe se as quer)
        suggestions: SUGGESTED_FIELDS[s.key].filter((x) => !taken(s.key).has(x.label.toLowerCase())).map((x) => ({ label: x.label, type: x.type, typeLabel: FIELD_TYPES[x.type].label, required: x.required })),
      })),
      documents,
      documentSuggestions: SUGGESTED_DOCUMENTS.filter((d) => !docNames.has(d.name.toLowerCase())).map((d) => ({ name: d.name, required: d.required })),
      latest: latest ? versionDto(latest) : null,
      versions: versions.map(versionDto),
      /** frases do que muda ao publicar (vazio = nada por publicar) */
      pending,
    };
  }

  // ================================================================ secções e campos

  async updateSection(repo: HrSettingsRepository, key: string, input: { title: string; description?: string | null; repeatable: boolean; entryLabel: string; maxEntries: number }) {
    if (!isSectionKey(key)) return fail(hrError("SECTION_NOT_FOUND", "Secção não encontrada."));
    const s = checkSection(input);
    if (!s.ok) return s;
    const r = await repo.updateSection(key, s.value, this.clock.now());
    return r.ok ? ok(r.value) : fail(outcomeError(r, "section"));
  }

  async createField(repo: HrSettingsRepository, actorId: string | null, section: string, input: { label: string; type: string; required?: boolean; help?: string | null; options?: string[] | null; settings?: FieldSettings | null }) {
    if (!isSectionKey(section)) return fail(hrError("SECTION_NOT_FOUND", "Secção não encontrada."));
    const f = checkField(input);
    if (!f.ok) return f;
    const now = this.clock.now();
    const r = await repo.createField({ ...f.value, id: this.ids.next(), section, now });
    if (!r.ok) return fail(outcomeError(r, "field"));
    await repo.record("HR_FIELD_CREATED", r.value.id, actorId, { section, label: r.value.label, type: r.value.type }, now);
    return ok(fieldDto(r.value));
  }

  async updateField(repo: HrSettingsRepository, actorId: string | null, id: string, input: { label: string; type: string; required?: boolean; help?: string | null; options?: string[] | null; settings?: FieldSettings | null }) {
    const f = checkField(input);
    if (!f.ok) return f;
    const now = this.clock.now();
    const r = await repo.updateField(id, f.value, now);
    if (!r.ok) return fail(outcomeError(r, "field"));
    await repo.record("HR_FIELD_UPDATED", id, actorId, { label: r.value.label }, now);
    return ok(fieldDto(r.value));
  }

  async setFieldActive(repo: HrSettingsRepository, actorId: string | null, id: string, active: boolean) {
    const now = this.clock.now();
    const r = await repo.setFieldActive(id, active, now);
    if (!r.ok) return fail(outcomeError(r, "field"));
    await repo.record(active ? "HR_FIELD_ACTIVATED" : "HR_FIELD_DEACTIVATED", id, actorId, { label: r.value.label }, now);
    return ok(fieldDto(r.value));
  }

  async deleteField(repo: HrSettingsRepository, actorId: string | null, id: string) {
    const now = this.clock.now();
    const r = await repo.deleteField(id);
    if (!r.ok) return fail(outcomeError(r, "field"));
    await repo.record("HR_FIELD_DELETED", id, actorId, { label: r.value.label, section: r.value.sectionKey }, now);
    return ok({ deleted: true });
  }

  async reorderFields(repo: HrSettingsRepository, section: string, ids: string[]) {
    if (!isSectionKey(section)) return fail(hrError("SECTION_NOT_FOUND", "Secção não encontrada."));
    const r = await repo.reorderFields(section, ids, this.clock.now());
    return r.ok ? ok({ reordered: true }) : fail(hrError("INVALID_INPUT", "A lista de campos mudou entretanto. Recarregue a página."));
  }

  /** Junta à secção os campos sugeridos escolhidos (pelo nome). */
  async addSuggestedFields(repo: HrSettingsRepository, actorId: string | null, section: string, labels: string[]) {
    if (!isSectionKey(section)) return fail(hrError("SECTION_NOT_FOUND", "Secção não encontrada."));
    const chosen = SUGGESTED_FIELDS[section].filter((s) => labels.includes(s.label));
    if (!chosen.length) return fail(hrError("INVALID_INPUT", "Escolha pelo menos uma sugestão."));
    let added = 0;
    for (const s of chosen) {
      const r = await this.createField(repo, actorId, section, { ...s, help: s.help ?? null, settings: s.settings ?? null });
      if (r.ok) added++;
      else if (r.error.code === "LIMIT_REACHED") return r;
    }
    return ok({ added });
  }

  // ================================================================ documentos

  async createDocument(repo: HrSettingsRepository, actorId: string | null, input: { name: string; description?: string | null; required?: boolean; formats: string[]; maxSizeMb: number; multiple?: boolean }) {
    const d = checkDocumentType(input);
    if (!d.ok) return d;
    const now = this.clock.now();
    const r = await repo.createDocument({ ...d.value, id: this.ids.next(), now });
    if (!r.ok) return fail(outcomeError(r, "document"));
    await repo.record("HR_DOCUMENT_CREATED", r.value.id, actorId, { name: r.value.name }, now);
    return ok(r.value);
  }

  async updateDocument(repo: HrSettingsRepository, actorId: string | null, id: string, input: { name: string; description?: string | null; required?: boolean; formats: string[]; maxSizeMb: number; multiple?: boolean }) {
    const d = checkDocumentType(input);
    if (!d.ok) return d;
    const now = this.clock.now();
    const r = await repo.updateDocument(id, d.value, now);
    if (!r.ok) return fail(outcomeError(r, "document"));
    await repo.record("HR_DOCUMENT_UPDATED", id, actorId, { name: r.value.name }, now);
    return ok(r.value);
  }

  async setDocumentActive(repo: HrSettingsRepository, actorId: string | null, id: string, active: boolean) {
    const now = this.clock.now();
    const r = await repo.setDocumentActive(id, active, now);
    if (!r.ok) return fail(outcomeError(r, "document"));
    await repo.record(active ? "HR_DOCUMENT_ACTIVATED" : "HR_DOCUMENT_DEACTIVATED", id, actorId, { name: r.value.name }, now);
    return ok(r.value);
  }

  async deleteDocument(repo: HrSettingsRepository, actorId: string | null, id: string) {
    const now = this.clock.now();
    const r = await repo.deleteDocument(id);
    if (!r.ok) return fail(outcomeError(r, "document"));
    await repo.record("HR_DOCUMENT_DELETED", id, actorId, { name: r.value.name }, now);
    return ok({ deleted: true });
  }

  async reorderDocuments(repo: HrSettingsRepository, ids: string[]) {
    const r = await repo.reorderDocuments(ids, this.clock.now());
    return r.ok ? ok({ reordered: true }) : fail(hrError("INVALID_INPUT", "A lista de documentos mudou entretanto. Recarregue a página."));
  }

  async addSuggestedDocuments(repo: HrSettingsRepository, actorId: string | null, names: string[]) {
    const chosen = SUGGESTED_DOCUMENTS.filter((d) => names.includes(d.name));
    if (!chosen.length) return fail(hrError("INVALID_INPUT", "Escolha pelo menos uma sugestão."));
    let added = 0;
    for (const d of chosen) {
      const r = await this.createDocument(repo, actorId, d);
      if (r.ok) added++;
      else if (r.error.code === "LIMIT_REACHED") return r;
    }
    return ok({ added });
  }

  // ================================================================ publicar

  /** Publica a configuração atual como nova versão (os cadastros já começados mantêm a sua). */
  async publish(repo: HrSettingsRepository, actorId: string | null, can: HrPermissions) {
    if (!can.manageForm && !can.manageDocuments) return fail(hrError("FORBIDDEN", "Não tem permissão para publicar o formulário."));
    const [sections, fields, documents, latest] = await Promise.all([repo.sections(), repo.fields(), repo.documents(), repo.latest()]);
    const snapshot = snapshotOf(sections, fields, documents);
    if (latest && canonical(latest.snapshot) === canonical(snapshot)) return fail(hrError("NOTHING_TO_PUBLISH", "Não há alterações por publicar."));
    const changes = describeChanges(latest?.snapshot ?? null, snapshot);
    const now = this.clock.now();
    const version = await repo.publish(snapshot, actorId, now);
    await repo.record("HR_FORM_PUBLISHED", version.id, actorId, { number: version.number, changes }, now);
    return ok({ ...versionDto(version), changes });
  }
}
