import type { Clock, IdGenerator } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import {
  canonical,
  checkDocumentType,
  checkEmployeeType,
  checkField,
  checkSection,
  describeChanges,
  FIELD_TYPES,
  FILE_FORMATS,
  type FieldSettings,
  type FormSnapshot,
  forEmployeeType,
  type HrError,
  hrError,
  isSectionKey,
  MAX_DOCUMENT_TYPES,
  MAX_EMPLOYEE_TYPES,
  MAX_FIELDS_PER_SECTION,
  PERSONAL_FIELDS,
  PERSONAL_SCHEMA,
  type SectionKey,
  SUGGESTED_DOCUMENTS,
  SUGGESTED_EMPLOYEE_TYPES,
  SUGGESTED_FIELDS,
} from "../domain/form";
import type { ConfigOutcome, DocumentRow, EmployeeTypeRow, FieldRow, HrSettingsRepository, SectionRow, VersionInfo } from "./ports";

type FieldBody = { label: string; type: string; required?: boolean; help?: string | null; options?: string[] | null; settings?: FieldSettings | null; employeeTypeIds?: string[] | null };
type DocumentBody = { name: string; description?: string | null; required?: boolean; formats: string[]; maxSizeMb: number; multiple?: boolean; employeeTypeIds?: string[] | null };

const fieldDto = (f: FieldRow) => ({ ...f, typeLabel: FIELD_TYPES[f.type].label });
const versionDto = (v: VersionInfo) => ({ number: v.number, publishedAt: v.publishedAt.toISOString(), publishedBy: v.publishedBy });

function outcomeError(r: Exclude<ConfigOutcome<unknown>, { ok: true }>, what: "field" | "document" | "section" | "type"): HrError {
  if (what === "section") return hrError("SECTION_NOT_FOUND", "Secção não encontrada.");
  if (what === "type") {
    if (r.reason === "exists") return hrError("EMPLOYEE_TYPE_EXISTS", "Já existe um tipo de funcionário com este nome.");
    if (r.reason === "limit") return hrError("LIMIT_REACHED", `No máximo ${MAX_EMPLOYEE_TYPES} tipos de funcionário.`);
    if (r.reason === "in_use") return hrError("EMPLOYEE_TYPE_IN_USE", "Há campos ou documentos só para este tipo: desative-o em vez de o eliminar.");
    return hrError("EMPLOYEE_TYPE_NOT_FOUND", "Tipo de funcionário não encontrado.");
  }
  if (what === "field") {
    if (r.reason === "exists") return hrError("FIELD_EXISTS", "Já existe um campo com este nome nesta secção.");
    if (r.reason === "limit") return hrError("LIMIT_REACHED", `Uma secção tem no máximo ${MAX_FIELDS_PER_SECTION} campos.`);
    return hrError("FIELD_NOT_FOUND", "Campo não encontrado.");
  }
  if (r.reason === "exists") return hrError("DOCUMENT_EXISTS", "Já existe um documento com este nome.");
  if (r.reason === "limit") return hrError("LIMIT_REACHED", `No máximo ${MAX_DOCUMENT_TYPES} documentos.`);
  return hrError("DOCUMENT_NOT_FOUND", "Documento não encontrado.");
}

/**
 * Fotografia da configuração atual: tipos, campos e documentos ATIVOS, pela ordem definida.
 * "Aplica-se a" só leva tipos ativos; um campo só para tipos desativados não entra (não serve ninguém).
 * Listas vazias não entram na fotografia (as versões antigas, sem tipos, comparam-se iguais).
 */
function snapshotOf(types: EmployeeTypeRow[], sections: SectionRow[], fields: FieldRow[], documents: DocumentRow[]): FormSnapshot {
  const activeTypes = types.filter((t) => t.active);
  const activeIds = new Set(activeTypes.map((t) => t.id));
  // [] = para todos; null = só para tipos desativados (fica de fora)
  const scope = (ids: string[]) => {
    if (!ids.length) return [];
    const kept = ids.filter((id) => activeIds.has(id));
    return kept.length ? kept : null;
  };
  const withScope = (ids: string[]) => {
    const s = scope(ids);
    return s?.length ? { employeeTypeIds: s } : {};
  };
  return {
    personalSchema: PERSONAL_SCHEMA,
    personal: PERSONAL_FIELDS,
    ...(activeTypes.length ? { employeeTypes: activeTypes.map((t) => ({ id: t.id, name: t.name, description: t.description })) } : {}),
    sections: sections.map((s) => ({
      key: s.key,
      title: s.title,
      description: s.description,
      repeatable: s.repeatable,
      entryLabel: s.entryLabel,
      maxEntries: s.maxEntries,
      fields: fields
        .filter((f) => f.sectionKey === s.key && f.active && scope(f.employeeTypeIds) !== null)
        .map((f) => ({ id: f.id, label: f.label, type: f.type, required: f.required, help: f.help, options: f.options, settings: f.settings, ...withScope(f.employeeTypeIds) })),
    })),
    documents: documents
      .filter((d) => d.active && scope(d.employeeTypeIds) !== null)
      .map((d) => ({ id: d.id, name: d.name, description: d.description, required: d.required, formats: d.formats, maxSizeMb: d.maxSizeMb, multiple: d.multiple, ...withScope(d.employeeTypeIds) })),
  };
}

export interface HrPermissions {
  manageForm: boolean;
  manageDocuments: boolean;
}

/**
 * Configuração do cadastro de funcionários: tipos de funcionário, campos das secções
 * dinâmicas, documentos pedidos e versões publicadas. As permissões são exigidas no
 * controller (guard); a publicação volta a vê-las aqui (serve aos dois tipos de alteração).
 */
export class HrSettings {
  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async view(repo: HrSettingsRepository, can: HrPermissions) {
    const [types, usage, sections, fields, documents, versions, latest] = await Promise.all([
      repo.employeeTypes(),
      repo.employeeTypeUsage(),
      repo.sections(),
      repo.fields(),
      repo.documents(),
      repo.versions(),
      repo.latest(),
    ]);
    const current = snapshotOf(types, sections, fields, documents);
    const pending = latest && canonical(latest.snapshot) === canonical(current) ? [] : describeChanges(latest?.snapshot ?? null, current);
    const taken = (s: SectionKey) => new Set(fields.filter((f) => f.sectionKey === s).map((f) => f.label.toLowerCase()));
    const docNames = new Set(documents.map((d) => d.name.toLowerCase()));
    const typeNames = new Set(types.map((t) => t.name.toLowerCase()));
    return {
      canManageForm: can.manageForm,
      canManageDocuments: can.manageDocuments,
      canPublish: can.manageForm || can.manageDocuments,
      fieldTypes: Object.entries(FIELD_TYPES).map(([value, t]) => ({ value, ...t })),
      fileFormats: FILE_FORMATS,
      employeeTypes: types.map((t) => ({ ...t, restrictedItems: usage[t.id] ?? 0 })),
      employeeTypeSuggestions: SUGGESTED_EMPLOYEE_TYPES.filter((t) => !typeNames.has(t.name.toLowerCase())),
      personal: PERSONAL_FIELDS.map((f) => ({ ...f, typeLabel: FIELD_TYPES[f.type].label, options: f.key === "province" ? [] : (f.options ?? []) })),
      sections: sections.map((s) => ({
        ...s,
        fields: fields.filter((f) => f.sectionKey === s.key).map(fieldDto),
        // sugestões que ainda não existem nesta secção (o colégio escolhe se as quer)
        suggestions: SUGGESTED_FIELDS[s.key]
          .filter((x) => !taken(s.key).has(x.label.toLowerCase()))
          .map((x) => ({ label: x.label, type: x.type, typeLabel: FIELD_TYPES[x.type].label, required: x.required, forTypes: x.forTypes ?? [] })),
      })),
      documents,
      documentSuggestions: SUGGESTED_DOCUMENTS.filter((d) => !docNames.has(d.name.toLowerCase())).map((d) => ({ name: d.name, required: d.required, forTypes: d.forTypes ?? [] })),
      latest: latest ? versionDto(latest) : null,
      /** tipos da versão publicada (para imprimir a ficha de cada um) */
      latestTypes: latest?.snapshot.employeeTypes ?? [],
      versions: versions.map(versionDto),
      /** frases do que muda ao publicar (vazio = nada por publicar) */
      pending,
    };
  }

  /** Os tipos escolhidos têm de existir e estar ativos (um tipo desativado mantém-se onde já estava). */
  private async checkTypeIds(repo: HrSettingsRepository, ids: string[], keep: string[] = []): Promise<Result<string[], HrError>> {
    if (!ids.length) return ok([]);
    const types = await repo.employeeTypes();
    const valid = new Set(types.filter((t) => t.active || keep.includes(t.id)).map((t) => t.id));
    if (ids.some((id) => !valid.has(id))) return fail(hrError("INVALID_INPUT", "Escolha tipos de funcionário ativos."));
    return ok(ids);
  }

  /** Nomes de tipos das sugestões → ids dos tipos ativos do colégio (se não existirem, a sugestão fica para todos). */
  private async idsFor(repo: HrSettingsRepository, names: string[] = []) {
    if (!names.length) return [];
    const wanted = new Set(names.map((n) => n.toLowerCase()));
    return (await repo.employeeTypes()).filter((t) => t.active && wanted.has(t.name.toLowerCase())).map((t) => t.id);
  }

  // ================================================================ tipos de funcionário

  async createEmployeeType(repo: HrSettingsRepository, actorId: string | null, input: { name: string; description?: string | null }) {
    const t = checkEmployeeType(input);
    if (!t.ok) return t;
    const now = this.clock.now();
    const r = await repo.createEmployeeType({ ...t.value, id: this.ids.next(), now });
    if (!r.ok) return fail(outcomeError(r, "type"));
    await repo.record("HR_EMPLOYEE_TYPE_CREATED", r.value.id, actorId, { name: r.value.name }, now);
    return ok(r.value);
  }

  async updateEmployeeType(repo: HrSettingsRepository, actorId: string | null, id: string, input: { name: string; description?: string | null }) {
    const t = checkEmployeeType(input);
    if (!t.ok) return t;
    const now = this.clock.now();
    const r = await repo.updateEmployeeType(id, t.value, now);
    if (!r.ok) return fail(outcomeError(r, "type"));
    await repo.record("HR_EMPLOYEE_TYPE_UPDATED", id, actorId, { name: r.value.name }, now);
    return ok(r.value);
  }

  async setEmployeeTypeActive(repo: HrSettingsRepository, actorId: string | null, id: string, active: boolean) {
    const now = this.clock.now();
    const r = await repo.setEmployeeTypeActive(id, active, now);
    if (!r.ok) return fail(outcomeError(r, "type"));
    await repo.record(active ? "HR_EMPLOYEE_TYPE_ACTIVATED" : "HR_EMPLOYEE_TYPE_DEACTIVATED", id, actorId, { name: r.value.name }, now);
    return ok(r.value);
  }

  async deleteEmployeeType(repo: HrSettingsRepository, actorId: string | null, id: string) {
    const r = await repo.deleteEmployeeType(id);
    if (!r.ok) return fail(outcomeError(r, "type"));
    await repo.record("HR_EMPLOYEE_TYPE_DELETED", id, actorId, { name: r.value.name }, this.clock.now());
    return ok({ deleted: true });
  }

  async reorderEmployeeTypes(repo: HrSettingsRepository, ids: string[]) {
    const r = await repo.reorderEmployeeTypes(ids, this.clock.now());
    return r.ok ? ok({ reordered: true }) : fail(hrError("INVALID_INPUT", "A lista de tipos mudou entretanto. Recarregue a página."));
  }

  async addSuggestedEmployeeTypes(repo: HrSettingsRepository, actorId: string | null, names: string[]) {
    const chosen = SUGGESTED_EMPLOYEE_TYPES.filter((t) => names.includes(t.name));
    if (!chosen.length) return fail(hrError("INVALID_INPUT", "Escolha pelo menos uma sugestão."));
    let added = 0;
    for (const t of chosen) {
      const r = await this.createEmployeeType(repo, actorId, t);
      if (r.ok) added++;
      else if (r.error.code === "LIMIT_REACHED") return r;
    }
    return ok({ added });
  }

  // ================================================================ secções e campos

  async updateSection(repo: HrSettingsRepository, key: string, input: { title: string; description?: string | null; repeatable: boolean; entryLabel: string; maxEntries: number }) {
    if (!isSectionKey(key)) return fail(hrError("SECTION_NOT_FOUND", "Secção não encontrada."));
    const s = checkSection(input);
    if (!s.ok) return s;
    const r = await repo.updateSection(key, s.value, this.clock.now());
    return r.ok ? ok(r.value) : fail(outcomeError(r, "section"));
  }

  async createField(repo: HrSettingsRepository, actorId: string | null, section: string, input: FieldBody) {
    if (!isSectionKey(section)) return fail(hrError("SECTION_NOT_FOUND", "Secção não encontrada."));
    const f = checkField(input);
    if (!f.ok) return f;
    const types = await this.checkTypeIds(repo, f.value.employeeTypeIds);
    if (!types.ok) return types;
    const now = this.clock.now();
    const r = await repo.createField({ ...f.value, id: this.ids.next(), section, now });
    if (!r.ok) return fail(outcomeError(r, "field"));
    await repo.record("HR_FIELD_CREATED", r.value.id, actorId, { section, label: r.value.label, type: r.value.type, employeeTypeIds: r.value.employeeTypeIds }, now);
    return ok(fieldDto(r.value));
  }

  async updateField(repo: HrSettingsRepository, actorId: string | null, id: string, input: FieldBody) {
    const f = checkField(input);
    if (!f.ok) return f;
    const current = (await repo.fields()).find((x) => x.id === id);
    if (!current) return fail(hrError("FIELD_NOT_FOUND", "Campo não encontrado."));
    const types = await this.checkTypeIds(repo, f.value.employeeTypeIds, current.employeeTypeIds);
    if (!types.ok) return types;
    const now = this.clock.now();
    const r = await repo.updateField(id, f.value, now);
    if (!r.ok) return fail(outcomeError(r, "field"));
    await repo.record("HR_FIELD_UPDATED", id, actorId, { label: r.value.label, employeeTypeIds: r.value.employeeTypeIds }, now);
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

  /** Junta à secção os campos sugeridos escolhidos (pelo nome). As sugestões "só para Docente" usam o tipo Docente, se existir. */
  async addSuggestedFields(repo: HrSettingsRepository, actorId: string | null, section: string, labels: string[]) {
    if (!isSectionKey(section)) return fail(hrError("SECTION_NOT_FOUND", "Secção não encontrada."));
    const chosen = SUGGESTED_FIELDS[section].filter((s) => labels.includes(s.label));
    if (!chosen.length) return fail(hrError("INVALID_INPUT", "Escolha pelo menos uma sugestão."));
    let added = 0;
    for (const { forTypes, ...s } of chosen) {
      const r = await this.createField(repo, actorId, section, { ...s, help: s.help ?? null, settings: s.settings ?? null, employeeTypeIds: await this.idsFor(repo, forTypes) });
      if (r.ok) added++;
      else if (r.error.code === "LIMIT_REACHED") return r;
    }
    return ok({ added });
  }

  // ================================================================ documentos

  async createDocument(repo: HrSettingsRepository, actorId: string | null, input: DocumentBody) {
    const d = checkDocumentType(input);
    if (!d.ok) return d;
    const types = await this.checkTypeIds(repo, d.value.employeeTypeIds);
    if (!types.ok) return types;
    const now = this.clock.now();
    const r = await repo.createDocument({ ...d.value, id: this.ids.next(), now });
    if (!r.ok) return fail(outcomeError(r, "document"));
    await repo.record("HR_DOCUMENT_CREATED", r.value.id, actorId, { name: r.value.name, employeeTypeIds: r.value.employeeTypeIds }, now);
    return ok(r.value);
  }

  async updateDocument(repo: HrSettingsRepository, actorId: string | null, id: string, input: DocumentBody) {
    const d = checkDocumentType(input);
    if (!d.ok) return d;
    const current = (await repo.documents()).find((x) => x.id === id);
    if (!current) return fail(hrError("DOCUMENT_NOT_FOUND", "Documento não encontrado."));
    const types = await this.checkTypeIds(repo, d.value.employeeTypeIds, current.employeeTypeIds);
    if (!types.ok) return types;
    const now = this.clock.now();
    const r = await repo.updateDocument(id, d.value, now);
    if (!r.ok) return fail(outcomeError(r, "document"));
    await repo.record("HR_DOCUMENT_UPDATED", id, actorId, { name: r.value.name, employeeTypeIds: r.value.employeeTypeIds }, now);
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
    for (const { forTypes, ...d } of chosen) {
      const r = await this.createDocument(repo, actorId, { ...d, employeeTypeIds: await this.idsFor(repo, forTypes) });
      if (r.ok) added++;
      else if (r.error.code === "LIMIT_REACHED") return r;
    }
    return ok({ added });
  }

  // ================================================================ publicar e imprimir

  /** Publica a configuração atual como nova versão (os cadastros já começados mantêm a sua). */
  async publish(repo: HrSettingsRepository, actorId: string | null, can: HrPermissions) {
    if (!can.manageForm && !can.manageDocuments) return fail(hrError("FORBIDDEN", "Não tem permissão para publicar o formulário."));
    const [types, sections, fields, documents, latest] = await Promise.all([repo.employeeTypes(), repo.sections(), repo.fields(), repo.documents(), repo.latest()]);
    const snapshot = snapshotOf(types, sections, fields, documents);
    if (latest && canonical(latest.snapshot) === canonical(snapshot)) return fail(hrError("NOTHING_TO_PUBLISH", "Não há alterações por publicar."));
    const changes = describeChanges(latest?.snapshot ?? null, snapshot);
    const now = this.clock.now();
    const version = await repo.publish(snapshot, actorId, now);
    await repo.record("HR_FORM_PUBLISHED", version.id, actorId, { number: version.number, changes }, now);
    return ok({ ...versionDto(version), changes });
  }

  /**
   * Ficha de inscrição para imprimir: a versão publicada (a última, ou a pedida) como a vê
   * um funcionário do tipo escolhido. Sem versão publicada não há ficha.
   */
  async printableForm(repo: HrSettingsRepository, input: { version?: number | null; typeId?: string | null }) {
    const v = input.version ? await repo.version(input.version) : await repo.latest();
    if (!v) return fail(hrError("VERSION_NOT_FOUND", input.version ? "Versão não encontrada." : "Publique o formulário antes de imprimir a ficha."));
    const types = v.snapshot.employeeTypes ?? [];
    const type = input.typeId ? types.find((t) => t.id === input.typeId) : null;
    if (input.typeId && !type) return fail(hrError("EMPLOYEE_TYPE_NOT_FOUND", "Este tipo de funcionário não existe nesta versão do formulário."));
    return ok({ version: versionDto(v), employeeType: type ?? null, employeeTypes: types, form: forEmployeeType(v.snapshot, type?.id ?? null) });
  }
}
