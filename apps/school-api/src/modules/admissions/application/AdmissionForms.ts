import type { Clock, IdGenerator } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok } from "../../../../../../libs/kernel/src/domain/Result";
import {
  BOOLEAN_VALUES,
  CONDITION_SOURCES,
  canonical,
  checkField,
  checkFixedMode,
  checkSection,
  describeChanges,
  FIELD_TYPES,
  type FieldInput,
  FIXED_FIELDS,
  FIXED_MODE_LABELS,
  FIXED_SCHEMA,
  type FixedMode,
  type FixedScope,
  fixedMode,
  type FormSnapshot,
  MAX_FIELDS_PER_SECTION,
  MAX_SECTIONS,
  SUGGESTED_SECTIONS,
} from "../domain/forms";
import { admissionError, PROCESS_TYPES } from "../domain/settings";
import type { AdmissionFormsRepository, FieldRow, SectionRow } from "./forms-ports";

export interface FormsAccess {
  manageForms: boolean;
  /** publicar: quem configura formulários ou documentos (os documentos também vão na versão) */
  publish: boolean;
}

type FieldBody = Parameters<typeof checkField>[0];
type SectionBody = Parameters<typeof checkSection>[0];

/**
 * Formulários das inscrições: dados fixos do aluno e do encarregado (modo de cada campo não
 * essencial), secções e campos do colégio com processos e condições, e as versões publicadas.
 * Ver: admissions.access · alterar: admissions.forms.manage · publicar: formulários ou documentos.
 */
export class AdmissionForms {
  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  /** A configuração atual como versão (só o que está ativo). */
  async snapshot(repo: AdmissionFormsRepository): Promise<FormSnapshot> {
    const [overrides, sections, documents] = await Promise.all([repo.overrides(), repo.sections(), repo.activeDocuments()]);
    const fixed = (scope: FixedScope) => {
      const mine = new Map(overrides.filter((o) => o.scope === scope).map((o) => [o.key, o.mode]));
      return FIXED_FIELDS[scope].map((f) => ({ ...f, mode: fixedMode(f, mine) }));
    };
    return {
      schema: FIXED_SCHEMA,
      student: fixed("STUDENT"),
      guardian: fixed("GUARDIAN"),
      sections: sections
        .filter((s) => s.active)
        .map(({ position: _p, active: _a, fields, ...s }) => ({
          ...s,
          fields: fields.filter((f) => f.active).map(({ sectionId: _s, position: _q, active: _b, ...f }) => f),
        }))
        .filter((s) => s.fields.length > 0),
      documents: documents.map(({ position: _p, active: _a, updatedAt: _u, ...d }) => d),
    };
  }

  private fieldDto(f: FieldRow, section: SectionRow) {
    const src = f.condition ? section.fields.find((x) => x.id === f.condition!.fieldId) : null;
    return {
      ...f,
      typeLabel: FIELD_TYPES[f.type].label,
      processLabels: f.processTypes.map((p) => PROCESS_TYPES[p].label),
      conditionLabel: f.condition && src ? `Só quando “${src.label}” = ${f.condition.values.join(" ou ")}` : null,
    };
  }

  async view(repo: AdmissionFormsRepository, access: FormsAccess) {
    const [overrides, sections, latest, versions, current] = await Promise.all([repo.overrides(), repo.sections(), repo.latestVersion(), repo.versions(), this.snapshot(repo)]);
    const fixed = (scope: FixedScope) => {
      const mine = new Map(overrides.filter((o) => o.scope === scope).map((o) => [o.key, o.mode]));
      return FIXED_FIELDS[scope].map((f) => {
        const mode = fixedMode(f, mine);
        return { ...f, options: f.options ? [...f.options] : undefined, essential: !!f.essential, mode, modeLabel: FIXED_MODE_LABELS[mode] };
      });
    };
    const titles = new Set(sections.map((s) => s.title.toLowerCase()));
    const changed = !latest || canonical(latest.snapshot) !== canonical(current);
    return {
      canManageForms: access.manageForms,
      canPublish: access.publish,
      fixed: { student: fixed("STUDENT"), guardian: fixed("GUARDIAN") },
      fixedModes: (Object.keys(FIXED_MODE_LABELS) as FixedMode[]).map((m) => ({ value: m, label: FIXED_MODE_LABELS[m] })),
      sections: sections.map((s) => ({
        ...s,
        processLabels: s.processTypes.map((p) => PROCESS_TYPES[p].label),
        fields: s.fields.map((f) => this.fieldDto(f, s)),
      })),
      fieldTypes: (Object.keys(FIELD_TYPES) as (keyof typeof FIELD_TYPES)[]).map((t) => ({ value: t, ...FIELD_TYPES[t], conditionSource: CONDITION_SOURCES.includes(t) })),
      booleanValues: [...BOOLEAN_VALUES],
      sectionSuggestions: SUGGESTED_SECTIONS.filter((s) => !titles.has(s.section.title.toLowerCase())).map((s) => ({ key: s.key, title: s.section.title, description: s.section.description, fields: s.fields.map((f) => f.label) })),
      versions: versions.map((v) => ({ number: v.number, publishedAt: v.publishedAt.toISOString(), publishedBy: v.publishedBy })),
      published: latest ? { number: latest.number, publishedAt: latest.publishedAt.toISOString(), publishedBy: latest.publishedBy } : null,
      pending: changed ? describeChanges(latest?.snapshot ?? null, current) : [],
    };
  }

  // ================================================================ dados fixos

  async setFixedMode(repo: AdmissionFormsRepository, actorId: string | null, input: { scope: string; key: string; mode: string }) {
    const c = checkFixedMode(input.scope, input.key, input.mode);
    if (!c.ok) return c;
    const now = this.clock.now();
    await repo.setOverride(c.value.scope, c.value.key, c.value.mode, now);
    await repo.record("ADMISSION_FIXED_FIELD_SET", "00000000-0000-0000-0000-000000000000", actorId, c.value, now);
    return ok({ ...c.value, modeLabel: FIXED_MODE_LABELS[c.value.mode] });
  }

  // ================================================================ secções

  private async section(repo: AdmissionFormsRepository, id: string) {
    const s = (await repo.sections()).find((x) => x.id === id);
    return s ? ok(s) : fail(admissionError("SECTION_NOT_FOUND", "Secção não encontrada."));
  }

  private async validSection(repo: AdmissionFormsRepository, input: SectionBody, exceptId: string | null) {
    const s = checkSection(input);
    if (!s.ok) return s;
    const all = await repo.sections();
    if (all.some((x) => x.id !== exceptId && x.title.toLowerCase() === s.value.title.toLowerCase())) return fail(admissionError("INVALID_INPUT", "Já existe uma secção com este título."));
    if (!exceptId && all.length >= MAX_SECTIONS) return fail(admissionError("LIMIT_REACHED", `No máximo ${MAX_SECTIONS} secções.`));
    return ok(s.value);
  }

  async createSection(repo: AdmissionFormsRepository, actorId: string | null, input: SectionBody) {
    const s = await this.validSection(repo, input, null);
    if (!s.ok) return s;
    const id = this.ids.next();
    const now = this.clock.now();
    await repo.createSection(id, s.value, now);
    await repo.record("ADMISSION_SECTION_CREATED", id, actorId, { title: s.value.title }, now);
    return ok({ id, ...s.value });
  }

  async updateSection(repo: AdmissionFormsRepository, actorId: string | null, id: string, input: SectionBody) {
    const s = await this.validSection(repo, input, id);
    if (!s.ok) return s;
    const now = this.clock.now();
    if (!(await repo.updateSection(id, s.value, now))) return fail(admissionError("SECTION_NOT_FOUND", "Secção não encontrada."));
    await repo.record("ADMISSION_SECTION_UPDATED", id, actorId, { title: s.value.title }, now);
    return ok({ id, ...s.value });
  }

  async setSectionActive(repo: AdmissionFormsRepository, actorId: string | null, id: string, active: boolean) {
    const now = this.clock.now();
    if (!(await repo.setSectionActive(id, active, now))) return fail(admissionError("SECTION_NOT_FOUND", "Secção não encontrada."));
    await repo.record(active ? "ADMISSION_SECTION_ACTIVATED" : "ADMISSION_SECTION_DEACTIVATED", id, actorId, {}, now);
    return ok({ active });
  }

  /** Eliminar uma secção leva os seus campos (as versões já publicadas mantêm-nos). */
  async deleteSection(repo: AdmissionFormsRepository, actorId: string | null, id: string) {
    if (!(await repo.deleteSection(id))) return fail(admissionError("SECTION_NOT_FOUND", "Secção não encontrada."));
    await repo.record("ADMISSION_SECTION_DELETED", id, actorId, {}, this.clock.now());
    return ok({ deleted: true });
  }

  async reorderSections(repo: AdmissionFormsRepository, ids: string[]) {
    const all = await repo.sections();
    if (ids.length !== all.length || new Set(ids).size !== ids.length || ids.some((id) => !all.some((s) => s.id === id))) return fail(admissionError("INVALID_INPUT", "A ordem tem de incluir todas as secções, uma vez cada."));
    await repo.reorderSections(ids);
    return ok({ order: ids });
  }

  /** Junta secções sugeridas, já com os campos e as condições entre eles. */
  async addSuggestedSections(repo: AdmissionFormsRepository, actorId: string | null, keys: string[]) {
    const existing = new Set((await repo.sections()).map((s) => s.title.toLowerCase()));
    const picked = SUGGESTED_SECTIONS.filter((s) => keys.includes(s.key) && !existing.has(s.section.title.toLowerCase()));
    if (!picked.length) return fail(admissionError("INVALID_INPUT", "Escolha pelo menos uma sugestão."));
    if (existing.size + picked.length > MAX_SECTIONS) return fail(admissionError("LIMIT_REACHED", `No máximo ${MAX_SECTIONS} secções.`));
    const now = this.clock.now();
    for (const s of picked) {
      const sectionId = this.ids.next();
      await repo.createSection(sectionId, s.section, now);
      const byLabel = new Map<string, string>();
      for (const f of s.fields) {
        const id = this.ids.next();
        const source = f.showWhen ? byLabel.get(f.showWhen.label) : undefined;
        await repo.createField(id, sectionId, { label: f.label, type: f.type, required: f.required, help: f.help ?? null, options: f.options, settings: f.settings ?? {}, processTypes: f.processTypes ?? [], condition: source ? { fieldId: source, values: f.showWhen!.values } : null }, now);
        byLabel.set(f.label, id);
      }
      await repo.record("ADMISSION_SECTION_CREATED", sectionId, actorId, { title: s.section.title, suggested: true }, now);
    }
    return ok({ added: picked.length });
  }

  // ================================================================ campos

  /** Campos de que este depende ou que dependem dele (para não partir condições). */
  private dependents(section: SectionRow, fieldId: string) {
    return section.fields.filter((f) => f.condition?.fieldId === fieldId);
  }

  private async validField(repo: AdmissionFormsRepository, sectionId: string, input: FieldBody, selfId: string | null) {
    const s = await this.section(repo, sectionId);
    if (!s.ok) return s;
    const section = s.value;
    if (!selfId && section.fields.length >= MAX_FIELDS_PER_SECTION) return fail(admissionError("LIMIT_REACHED", `No máximo ${MAX_FIELDS_PER_SECTION} campos por secção.`));
    const self = selfId ? section.fields.find((f) => f.id === selfId) : null;
    const f = checkField(input, {
      selfId,
      siblings: section.fields.filter((x) => x.active),
      // um campo novo fica no fim
      selfPosition: self ? self.position : Number.MAX_SAFE_INTEGER,
    });
    if (!f.ok) return f;
    if (section.fields.some((x) => x.id !== selfId && x.label.toLowerCase() === f.value.label.toLowerCase())) return fail(admissionError("INVALID_INPUT", "Já existe um campo com esta pergunta nesta secção."));
    // quem depende deste campo continua a poder depender dele?
    if (selfId) {
      for (const d of this.dependents(section, selfId)) {
        const values = f.value.type === "BOOLEAN" ? [...BOOLEAN_VALUES] : f.value.options;
        if (!CONDITION_SOURCES.includes(f.value.type) || d.condition!.values.some((v) => !values.includes(v))) {
          return fail(admissionError("FIELD_IN_USE", `“${d.label}” depende deste campo (${d.condition!.values.join(", ")}). Ajuste primeiro a condição desse campo.`));
        }
      }
    }
    return ok({ section, field: f.value });
  }

  async createField(repo: AdmissionFormsRepository, actorId: string | null, sectionId: string, input: FieldBody) {
    const v = await this.validField(repo, sectionId, input, null);
    if (!v.ok) return v;
    const id = this.ids.next();
    const now = this.clock.now();
    await repo.createField(id, sectionId, v.value.field, now);
    await repo.record("ADMISSION_FIELD_CREATED", id, actorId, { sectionId, label: v.value.field.label }, now);
    return ok({ id, ...v.value.field });
  }

  async updateField(repo: AdmissionFormsRepository, actorId: string | null, fieldId: string, input: FieldBody) {
    const section = (await repo.sections()).find((s) => s.fields.some((f) => f.id === fieldId));
    if (!section) return fail(admissionError("FIELD_NOT_FOUND", "Campo não encontrado."));
    const v = await this.validField(repo, section.id, input, fieldId);
    if (!v.ok) return v;
    const now = this.clock.now();
    await repo.updateField(fieldId, v.value.field, now);
    await repo.record("ADMISSION_FIELD_UPDATED", fieldId, actorId, { label: v.value.field.label }, now);
    return ok({ id: fieldId, ...v.value.field });
  }

  private blocked(section: SectionRow, fieldId: string, action: string) {
    const deps = this.dependents(section, fieldId).filter((d) => d.active);
    return deps.length ? fail(admissionError("FIELD_IN_USE", `Não se pode ${action}: ${deps.map((d) => `“${d.label}”`).join(", ")} depende${deps.length > 1 ? "m" : ""} deste campo.`)) : null;
  }

  async setFieldActive(repo: AdmissionFormsRepository, actorId: string | null, fieldId: string, active: boolean) {
    const section = (await repo.sections()).find((s) => s.fields.some((f) => f.id === fieldId));
    if (!section) return fail(admissionError("FIELD_NOT_FOUND", "Campo não encontrado."));
    if (!active) {
      const b = this.blocked(section, fieldId, "desativar");
      if (b) return b;
    } else {
      // reativar um campo cuja condição usa um campo desativado
      const f = section.fields.find((x) => x.id === fieldId)!;
      const src = f.condition ? section.fields.find((x) => x.id === f.condition!.fieldId) : null;
      if (f.condition && !src?.active) return fail(admissionError("FIELD_IN_USE", `Ative primeiro “${src?.label ?? "o campo da condição"}”, de que este campo depende.`));
    }
    const now = this.clock.now();
    await repo.setFieldActive(fieldId, active, now);
    await repo.record(active ? "ADMISSION_FIELD_ACTIVATED" : "ADMISSION_FIELD_DEACTIVATED", fieldId, actorId, {}, now);
    return ok({ active });
  }

  async deleteField(repo: AdmissionFormsRepository, actorId: string | null, fieldId: string) {
    const section = (await repo.sections()).find((s) => s.fields.some((f) => f.id === fieldId));
    if (!section) return fail(admissionError("FIELD_NOT_FOUND", "Campo não encontrado."));
    const deps = this.dependents(section, fieldId);
    if (deps.length) return fail(admissionError("FIELD_IN_USE", `Não se pode eliminar: ${deps.map((d) => `“${d.label}”`).join(", ")} depende${deps.length > 1 ? "m" : ""} deste campo.`));
    await repo.deleteField(fieldId);
    await repo.record("ADMISSION_FIELD_DELETED", fieldId, actorId, {}, this.clock.now());
    return ok({ deleted: true });
  }

  /** Nova ordem: cada condição continua a usar um campo que vem antes. */
  async reorderFields(repo: AdmissionFormsRepository, sectionId: string, ids: string[]) {
    const s = await this.section(repo, sectionId);
    if (!s.ok) return s;
    const fields = s.value.fields;
    if (ids.length !== fields.length || new Set(ids).size !== ids.length || ids.some((id) => !fields.some((f) => f.id === id))) return fail(admissionError("INVALID_INPUT", "A ordem tem de incluir todos os campos da secção, uma vez cada."));
    const pos = new Map(ids.map((id, i) => [id, i]));
    for (const f of fields) {
      if (f.condition && (pos.get(f.condition.fieldId) ?? -1) >= pos.get(f.id)!) {
        const src = fields.find((x) => x.id === f.condition!.fieldId);
        return fail(admissionError("FIELD_IN_USE", `“${f.label}” depende de “${src?.label}”, que tem de vir antes.`));
      }
    }
    await repo.reorderFields(sectionId, ids);
    return ok({ order: ids });
  }

  // ================================================================ versões

  async publish(repo: AdmissionFormsRepository, actorId: string | null) {
    const [current, latest] = await Promise.all([this.snapshot(repo), repo.latestVersion()]);
    if (latest && canonical(latest.snapshot) === canonical(current)) return fail(admissionError("NOTHING_TO_PUBLISH", "Não há alterações por publicar."));
    const changes = describeChanges(latest?.snapshot ?? null, current);
    const now = this.clock.now();
    const id = this.ids.next();
    const number = await repo.publish(id, current, actorId, now);
    await repo.record("ADMISSION_FORMS_PUBLISHED", id, actorId, { number, changes }, now);
    return ok({ number, changes });
  }

  async version(repo: AdmissionFormsRepository, number: number) {
    const v = await repo.version(number);
    if (!v) return fail(admissionError("VERSION_NOT_FOUND", "Versão não encontrada."));
    return ok({ number: v.number, publishedAt: v.publishedAt.toISOString(), publishedBy: v.publishedBy, snapshot: v.snapshot });
  }
}

export type { FieldInput };
