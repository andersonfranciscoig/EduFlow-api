import type { FieldInput, FixedMode, FixedScope, FormSnapshot, SectionInput } from "../domain/forms";
import type { DocumentTypeRow } from "./settings-ports";

export interface FieldRow extends FieldInput {
  id: string;
  sectionId: string;
  position: number;
  active: boolean;
}

export interface SectionRow extends SectionInput {
  id: string;
  position: number;
  active: boolean;
  fields: FieldRow[];
}

export interface VersionRow {
  number: number;
  publishedAt: Date;
  publishedBy: string | null;
  snapshot: FormSnapshot;
}

/** Formulários das inscrições (na BD do PRÓPRIO colégio). */
export interface AdmissionFormsRepository {
  overrides(): Promise<{ scope: FixedScope; key: string; mode: FixedMode }[]>;
  setOverride(scope: FixedScope, key: string, mode: FixedMode, now: Date): Promise<void>;
  /** Secções (com os campos), pela ordem. */
  sections(): Promise<SectionRow[]>;
  createSection(id: string, input: SectionInput, now: Date): Promise<void>;
  updateSection(id: string, input: SectionInput, now: Date): Promise<boolean>;
  setSectionActive(id: string, active: boolean, now: Date): Promise<boolean>;
  deleteSection(id: string): Promise<boolean>;
  reorderSections(ids: string[]): Promise<void>;
  createField(id: string, sectionId: string, input: FieldInput, now: Date): Promise<void>;
  updateField(id: string, input: FieldInput, now: Date): Promise<boolean>;
  setFieldActive(id: string, active: boolean, now: Date): Promise<boolean>;
  deleteField(id: string): Promise<boolean>;
  reorderFields(sectionId: string, ids: string[]): Promise<void>;
  activeDocuments(): Promise<DocumentTypeRow[]>;
  latestVersion(): Promise<VersionRow | null>;
  versions(): Promise<Omit<VersionRow, "snapshot">[]>;
  version(number: number): Promise<VersionRow | null>;
  /** Grava a versão seguinte (número = último + 1, numa transação). */
  publish(id: string, snapshot: FormSnapshot, actorId: string | null, now: Date): Promise<number>;
  record(type: string, subjectId: string, actorId: string | null, details: Record<string, unknown>, now: Date): Promise<void>;
}
