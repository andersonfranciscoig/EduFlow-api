import type { DocumentTypeInput, EmployeeTypeInput, FieldInput, FormSnapshot, SectionInput, SectionKey } from "../domain/form";

export interface SectionRow extends SectionInput {
  key: SectionKey;
  position: number;
}

export interface FieldRow extends FieldInput {
  id: string;
  sectionKey: SectionKey;
  position: number;
  active: boolean;
}

export interface EmployeeTypeRow extends EmployeeTypeInput {
  id: string;
  position: number;
  active: boolean;
}

export interface DocumentRow extends DocumentTypeInput {
  id: string;
  position: number;
  active: boolean;
}

export interface VersionInfo {
  id: string;
  number: number;
  publishedAt: Date;
  publishedBy: string | null;
}

export type ConfigOutcome<T> = { ok: true; value: T } | { ok: false; reason: "not_found" | "exists" | "limit" | "in_use" };

/** Configuração do cadastro de funcionários — na BD do PRÓPRIO colégio. */
export interface HrSettingsRepository {
  employeeTypes(): Promise<EmployeeTypeRow[]>;
  createEmployeeType(input: EmployeeTypeInput & { id: string; now: Date }): Promise<ConfigOutcome<EmployeeTypeRow>>;
  updateEmployeeType(id: string, input: EmployeeTypeInput, now: Date): Promise<ConfigOutcome<EmployeeTypeRow>>;
  setEmployeeTypeActive(id: string, active: boolean, now: Date): Promise<ConfigOutcome<EmployeeTypeRow>>;
  /** Só se nenhum campo nem documento o usar (senão desativa-se). */
  deleteEmployeeType(id: string): Promise<ConfigOutcome<EmployeeTypeRow>>;
  reorderEmployeeTypes(ids: string[], now: Date): Promise<ConfigOutcome<void>>;
  /** Quantos campos e documentos se aplicam (também) a cada tipo. */
  employeeTypeUsage(): Promise<Record<string, number>>;

  sections(): Promise<SectionRow[]>;
  /** Todos os campos (ativos e inativos), por secção e posição. */
  fields(): Promise<FieldRow[]>;
  documents(): Promise<DocumentRow[]>;
  versions(): Promise<VersionInfo[]>;
  latest(): Promise<(VersionInfo & { snapshot: FormSnapshot }) | null>;
  version(number: number): Promise<(VersionInfo & { snapshot: FormSnapshot }) | null>;

  updateSection(key: SectionKey, input: SectionInput, now: Date): Promise<ConfigOutcome<SectionRow>>;
  createField(input: FieldInput & { id: string; section: SectionKey; now: Date }): Promise<ConfigOutcome<FieldRow>>;
  updateField(id: string, input: FieldInput, now: Date): Promise<ConfigOutcome<FieldRow>>;
  setFieldActive(id: string, active: boolean, now: Date): Promise<ConfigOutcome<FieldRow>>;
  deleteField(id: string): Promise<ConfigOutcome<FieldRow>>;
  /** Nova ordem (todos os ids da secção, sem faltas nem a mais). */
  reorderFields(section: SectionKey, ids: string[], now: Date): Promise<ConfigOutcome<void>>;

  createDocument(input: DocumentTypeInput & { id: string; now: Date }): Promise<ConfigOutcome<DocumentRow>>;
  updateDocument(id: string, input: DocumentTypeInput, now: Date): Promise<ConfigOutcome<DocumentRow>>;
  setDocumentActive(id: string, active: boolean, now: Date): Promise<ConfigOutcome<DocumentRow>>;
  deleteDocument(id: string): Promise<ConfigOutcome<DocumentRow>>;
  reorderDocuments(ids: string[], now: Date): Promise<ConfigOutcome<void>>;

  /** Grava a versão seguinte (número único, com bloqueio contra publicações simultâneas). */
  publish(snapshot: FormSnapshot, actorId: string | null, now: Date): Promise<VersionInfo>;
  record(type: string, subjectId: string, actorId: string | null, details: Record<string, unknown>, now: Date): Promise<void>;
}
