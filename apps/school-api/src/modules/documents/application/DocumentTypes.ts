import type { Clock } from "../../../../../../libs/kernel/src/application/ports";
import { fail, ok, type Result } from "../../../../../../libs/kernel/src/domain/Result";
import { AUDIENCES, type Audience, CATEGORIES, checkFields, type Department, DEPARTMENTS, type DocumentsError, documentsError, FEE_POLICIES, type FeePolicy, FIELD_KINDS, type Method, METHODS } from "../domain/documents";
import type { PrismaDocumentsRepository, TypeInput, TypeRow } from "../infrastructure/prisma-documents";

type R<T> = Promise<Result<T, DocumentsError>>;
type Repo = PrismaDocumentsRepository;

/** Quem pede e o que pode: as permissões efetivas (o responsável tem todas). */
export interface DocumentsViewer {
  userId: string;
  support: boolean;
  name: string;
  permissions: string[];
}

/** As permissões de cada público: os pedidos dos alunos são da secretaria; os dos funcionários, do RH. */
export const PERMS = {
  STUDENT: { access: "documents.access", settings: "documents.settings.manage", view: "documents.requests.view", process: "documents.requests.process", deliver: "documents.requests.deliver" },
  EMPLOYEE: { access: "hr.access", settings: "hr.doc_types.manage", view: "hr.doc_requests.view", process: "hr.doc_requests.process", deliver: "hr.doc_requests.deliver" },
} as const;
export type Ability = "settings" | "view" | "process" | "deliver";
export const can = (v: DocumentsViewer, a: Audience, what: Ability) => v.permissions.includes(PERMS[a].access) && (v.permissions.includes(PERMS[a][what]) || (what === "view" && (v.permissions.includes(PERMS[a].process) || v.permissions.includes(PERMS[a].deliver))));
export const audiencesFor = (v: DocumentsViewer, what: Ability) => (["STUDENT", "EMPLOYEE"] as Audience[]).filter((a) => can(v, a, what));

/** Os documentos sugeridos (o colégio escolhe os que quer; ficam “preparado pelo colégio” e para levantar). */
export const SUGGESTIONS: Record<Audience, { name: string; category: string }[]> = {
  STUDENT: [
    { name: "Declaração de matrícula", category: "Documentos de matrícula" },
    { name: "Declaração de frequência", category: "Documentos escolares" },
    { name: "Declaração de aproveitamento escolar", category: "Documentos académicos" },
    { name: "Declaração de conclusão de classe", category: "Documentos académicos" },
    { name: "Histórico académico", category: "Documentos académicos" },
    { name: "Certificado de conclusão", category: "Documentos académicos" },
    { name: "Declaração de transferência", category: "Documentos administrativos" },
    { name: "Declaração de comportamento", category: "Documentos escolares" },
    { name: "Segunda via de documento escolar", category: "Documentos administrativos" },
    { name: "Ficha de inscrição", category: "Documentos de matrícula" },
    { name: "Ficha de matrícula", category: "Documentos de matrícula" },
    { name: "Cartão de estudante", category: "Cartões de estudante" },
  ],
  EMPLOYEE: [
    { name: "Declaração de serviço", category: "Documentos de funcionários" },
    { name: "Declaração de vínculo laboral", category: "Documentos de funcionários" },
    { name: "Declaração de antiguidade", category: "Documentos de funcionários" },
    { name: "Declaração de remuneração", category: "Documentos de funcionários" },
    { name: "Declaração para efeitos bancários", category: "Documentos de funcionários" },
    { name: "Declaração para efeitos de visto", category: "Documentos de funcionários" },
    { name: "Cópia do contrato de trabalho", category: "Documentos de funcionários" },
    { name: "Comprovativo de férias", category: "Documentos de funcionários" },
  ],
};

const clean = (v: unknown, max: number) =>
  String(v ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max + 1);
const text = (v: unknown, max: number) => {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max + 1) : null;
};

export interface TypeBody {
  audience: Audience;
  department: Department;
  category: string;
  name: string;
  description?: string | null;
  requirements?: string | null;
  method: Method;
  pickup: boolean;
  download: boolean;
  fee?: number | null;
  feePolicy?: FeePolicy | null;
  slaDays: number;
  requiresApproval: boolean;
  fields: unknown[];
  active: boolean;
}

/** Os tipos de documento de cada colégio: o que se pode pedir, por quem e como se emite. */
export class DocumentTypes {
  constructor(private readonly clock: Clock) {}

  private view(t: TypeRow) {
    return { ...t, departmentLabel: DEPARTMENTS[t.department], methodLabel: METHODS[t.method].label, audienceLabel: AUDIENCES[t.audience] };
  }

  /** A configuração: os tipos de cada público que a pessoa pode ver ou configurar. */
  async overview(repo: Repo, v: DocumentsViewer) {
    const audiences = (["STUDENT", "EMPLOYEE"] as Audience[]).filter((a) => can(v, a, "settings") || can(v, a, "view"));
    const types = await repo.types(audiences);
    return {
      audiences: audiences.map((a) => ({
        key: a,
        label: AUDIENCES[a],
        manage: can(v, a, "settings"),
        departments: (a === "EMPLOYEE" ? ["RH"] : ["SECRETARIA", "PEDAGOGIA"]).map((d) => ({ key: d, label: DEPARTMENTS[d as Department] })),
        categories: CATEGORIES[a],
        suggestions: SUGGESTIONS[a].filter((s) => !types.some((t) => t.audience === a && t.name.toLowerCase() === s.name.toLowerCase())),
      })),
      methods: Object.entries(METHODS).map(([key, m]) => ({ key, ...m })),
      feePolicies: Object.entries(FEE_POLICIES).map(([key, p]) => ({ key, ...p })),
      fieldKinds: Object.entries(FIELD_KINDS).map(([key, label]) => ({ key, label })),
      types: types.map((t) => this.view(t)),
    };
  }

  private check(body: TypeBody): Result<TypeInput, DocumentsError> {
    const bad = (m: string) => fail(documentsError("INVALID_INPUT", m));
    if (!(body.audience in AUDIENCES)) return bad("Público desconhecido.");
    const name = clean(body.name, 120);
    if (name.length < 3 || name.length > 120) return bad("O nome do documento tem 3 a 120 caracteres.");
    const category = clean(body.category, 60);
    if (category.length < 2 || category.length > 60) return bad("Indique a categoria (2 a 60 caracteres).");
    if (!(body.department in DEPARTMENTS)) return bad("Departamento desconhecido.");
    if ((body.audience === "EMPLOYEE") !== (body.department === "RH")) return bad(body.audience === "EMPLOYEE" ? "Os documentos dos funcionários são tratados pelo RH." : "Os documentos dos alunos são tratados pela secretaria ou pela área pedagógica.");
    if (!(body.method in METHODS)) return bad("Método de emissão desconhecido.");
    if (!body.pickup && !body.download) return bad("Escolha pelo menos uma forma de entrega: levantamento no colégio ou download.");
    const fee = body.fee ?? null;
    if (fee !== null && (!Number.isInteger(fee) || fee < 1 || fee > 1_000_000)) return bad("A taxa é um valor em kwanzas, de 1 a 1 000 000 (vazio = gratuito).");
    if (fee !== null && body.audience === "EMPLOYEE") return bad("Os documentos dos funcionários não têm taxa.");
    const feePolicy = body.feePolicy ?? "BEFORE";
    if (!(feePolicy in FEE_POLICIES)) return bad("Escolha quando se paga a taxa.");
    if (!Number.isInteger(body.slaDays) || body.slaDays < 0 || body.slaDays > 90) return bad("O prazo é um número de dias, de 0 a 90.");
    const description = text(body.description, 1000);
    const requirements = text(body.requirements, 1000);
    if ((description?.length ?? 0) > 1000 || (requirements?.length ?? 0) > 1000) return bad("A descrição e as informações complementares têm no máximo 1000 caracteres.");
    const f = checkFields(body.fields ?? []);
    if (!f.ok) return bad(f.message);
    return ok({ audience: body.audience, department: body.department, category, name, description, requirements, method: body.method, pickup: !!body.pickup, download: !!body.download, fee, feePolicy, slaDays: body.slaDays, requiresApproval: !!body.requiresApproval, fields: f.fields, active: !!body.active });
  }

  async create(repo: Repo, v: DocumentsViewer, body: TypeBody): R<{ id: string }> {
    if (!can(v, body.audience, "settings")) return fail(documentsError("FORBIDDEN", body.audience === "EMPLOYEE" ? "Configurar os documentos dos funcionários exige a permissão do RH." : "Configurar os documentos dos alunos exige a permissão “Configurar os documentos dos alunos”."));
    const c = this.check(body);
    if (!c.ok) return c;
    if (await repo.nameTaken(c.value.audience, c.value.name, null)) return fail(documentsError("NAME_TAKEN", `Já existe o documento “${c.value.name}”.`));
    return ok({ id: await repo.createType(c.value, v.support ? null : v.userId, this.clock.now()) });
  }

  /** Junta documentos sugeridos (preparados pelo colégio, para levantar; depois afinam-se). */
  async addSuggested(repo: Repo, v: DocumentsViewer, audience: Audience, names: string[]): R<{ added: number }> {
    if (!can(v, audience, "settings")) return fail(documentsError("FORBIDDEN", "Não tem permissão para configurar estes documentos."));
    let added = 0;
    for (const n of names) {
      const s = SUGGESTIONS[audience].find((x) => x.name === n);
      if (!s || (await repo.nameTaken(audience, s.name, null))) continue;
      await repo.createType(
        { audience, department: audience === "EMPLOYEE" ? "RH" : "SECRETARIA", category: s.category, name: s.name, description: null, requirements: null, method: "EXTERNAL", pickup: true, download: false, fee: null, feePolicy: "BEFORE", slaDays: 3, requiresApproval: false, fields: [], active: true },
        v.support ? null : v.userId,
        this.clock.now(),
      );
      added++;
    }
    return ok({ added });
  }

  async update(repo: Repo, v: DocumentsViewer, id: string, body: TypeBody): R<{ saved: true }> {
    const t = await repo.type(id);
    if (!t) return fail(documentsError("NOT_FOUND", "Documento não encontrado."));
    if (!can(v, t.audience, "settings")) return fail(documentsError("FORBIDDEN", "Não tem permissão para configurar este documento."));
    const c = this.check({ ...body, audience: t.audience });
    if (!c.ok) return c;
    if (await repo.nameTaken(t.audience, c.value.name, id)) return fail(documentsError("NAME_TAKEN", `Já existe o documento “${c.value.name}”.`));
    // os pedidos guardam a cópia do tipo: mudar o tipo não mexe nos pedidos já feitos
    await repo.updateType(id, c.value, this.clock.now());
    return ok({ saved: true as const });
  }

  /** Apagar: só sem pedidos; com pedidos, desativa-se (deixa de se poder pedir; o histórico fica). */
  async remove(repo: Repo, v: DocumentsViewer, id: string): R<{ result: "deleted" | "deactivated" }> {
    const t = await repo.type(id);
    if (!t) return fail(documentsError("NOT_FOUND", "Documento não encontrado."));
    if (!can(v, t.audience, "settings")) return fail(documentsError("FORBIDDEN", "Não tem permissão para configurar este documento."));
    if (t.requests > 0) {
      await repo.setActive(id, false, this.clock.now());
      return ok({ result: "deactivated" as const });
    }
    await repo.deleteType(id);
    return ok({ result: "deleted" as const });
  }
}
