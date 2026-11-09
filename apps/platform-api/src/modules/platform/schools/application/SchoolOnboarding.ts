import type { Clock, IdGenerator, PasswordHasher } from "../../../../../../../libs/kernel/src/application/ports";
import type { DomainError } from "../../../../../../../libs/kernel/src/domain/DomainError";
import { fail, ok, type Result } from "../../../../../../../libs/kernel/src/domain/Result";
import { schoolError, type SchoolError } from "../domain/errors";
import { School } from "../domain/School";
import { normalizeCorporateEmail, slugify, validateOwner, validateSchoolData, type SchoolData } from "../domain/school-data";
import type { SchoolRepository } from "../domain/SchoolRepository";
import type { CodeGenerator, PlanCatalog, SchoolSettings, SchoolTokenService } from "./ports";

export interface RegisterSchoolInput {
  owner: { name: string; email: string; password: string };
  school: SchoolData;
  subscription: {
    planId: string;
    cycle: { kind: "MONTHLY" | "QUARTERLY" | "ANNUAL" | "CUSTOM"; quantity?: number; unit?: "MONTHS" | "YEARS" };
  };
}

/** Registo de um colégio e autenticação do seu responsável. */
export class SchoolOnboarding {
  private dummyHash?: Promise<string>;

  constructor(
    private readonly schools: SchoolRepository,
    private readonly catalog: PlanCatalog,
    private readonly hasher: PasswordHasher,
    private readonly tokens: SchoolTokenService,
    private readonly ids: IdGenerator,
    private readonly codes: CodeGenerator,
    private readonly clock: Clock,
    private readonly settings: SchoolSettings,
  ) {}

  /** Passo 1 do registo: o email corporativo é válido e está livre? */
  async checkEmail(raw: string): Promise<Result<{ email: string; available: boolean }, SchoolError>> {
    const email = normalizeCorporateEmail(raw);
    if (!email.ok) return email;
    return ok({ email: email.value, available: !(await this.schools.ownerEmailExists(email.value)) });
  }

  async checkNif(raw: string): Promise<{ available: boolean }> {
    const nif = raw.replace(/[\s.-]/g, "").toUpperCase();
    return { available: !(await this.schools.nifExists(nif)) };
  }

  async register(input: RegisterSchoolInput): Promise<Result<{ schoolId: string; accessToken: string; expiresIn: number }, SchoolError | DomainError>> {
    const owner = validateOwner(input.owner);
    if (!owner.ok) return owner;
    const data = validateSchoolData(input.school, this.settings.defaultPhoneCountryCode);
    if (!data.ok) return data;

    if (await this.schools.ownerEmailExists(owner.value.email)) {
      return fail(schoolError("EMAIL_TAKEN", "Já existe um colégio registado com este email."));
    }
    if (await this.schools.nifExists(data.value.nif)) {
      return fail(schoolError("NIF_TAKEN", "Já existe um colégio registado com este NIF."));
    }

    const quote = await this.catalog.quote(input.subscription.planId, input.subscription.cycle);
    if (!quote.ok) return quote;

    const now = this.clock.now();
    const q = quote.value;
    // slug único (futuro endereço do portal): nome-do-colegio, -2, -3…
    const base = slugify(data.value.name);
    let slug = base;
    for (let n = 2; await this.schools.slugExists(slug); n++) slug = `${base}-${n}`;

    const school = School.register({
      id: this.ids.next(),
      slug,
      data: data.value,
      owner: owner.value,
      ownerPasswordHash: await this.hasher.hash(input.owner.password),
      order: {
        id: this.ids.next(),
        number: this.codes.orderNumber(now),
        planId: q.plan.id,
        planName: q.plan.name,
        planMonthlyPrice: q.plan.monthlyPrice,
        cycle: q.cycle.kind,
        months: q.cycle.months,
        subtotal: q.subtotal,
        discountPct: q.discountPct,
        total: q.total,
        createdAt: now,
      },
      now,
    });

    await this.schools.save(school);
    return ok({ schoolId: school.id, ...(await this.tokens.issue(school.id)) });
  }

  /** Login do responsável (funciona em qualquer estado, para acompanhar o pedido). */
  async signIn(email: string, password: string): Promise<Result<{ accessToken: string; expiresIn: number }, SchoolError>> {
    const school = await this.schools.findByOwnerEmail(email.trim().toLowerCase());
    if (!school) {
      this.dummyHash ??= this.hasher.hash("eduflow-timing-equalizer");
      await this.hasher.verify(password, await this.dummyHash);
      return fail(schoolError("INVALID_CREDENTIALS", "Email ou senha incorretos."));
    }
    if (!(await this.hasher.verify(password, school.ownerPasswordHash))) {
      return fail(schoolError("INVALID_CREDENTIALS", "Email ou senha incorretos."));
    }
    return ok(await this.tokens.issue(school.id));
  }
}
