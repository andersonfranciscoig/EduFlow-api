import type { Clock, IdGenerator, PasswordHasher } from "../../../../../../../libs/kernel/src/application/ports";
import type { DomainError } from "../../../../../../../libs/kernel/src/domain/DomainError";
import { fail, ok, type Result } from "../../../../../../../libs/kernel/src/domain/Result";
import type { EmailVerificationService } from "../../verification/application/EmailVerificationService";
import type { VerificationError } from "../../verification/domain/errors";
import { schoolError, type SchoolError } from "../domain/errors";
import { School } from "../domain/School";
import {
  CORPORATE_EMAIL_DEADLINE_DAYS,
  isPersonalEmail,
  normalizeCorporateEmail,
  normalizeOwnerEmail,
  slugify,
  validateOwner,
  validateOwnerPassword,
  validateSchoolData,
  type SchoolData,
} from "../domain/school-data";
import type { SchoolRepository } from "../domain/SchoolRepository";
import type { CodeGenerator, PlanCatalog, SchoolSettings, SchoolTokenService } from "./ports";

export interface RegisterSchoolInput {
  owner: { name: string; email: string; password: string; emailProof: string };
  school: SchoolData;
  subscription: {
    planId: string;
    cycle: { kind: "MONTHLY" | "QUARTERLY" | "ANNUAL" | "CUSTOM"; quantity?: number; unit?: "MONTHS" | "YEARS" };
  };
}

type Err = SchoolError | VerificationError;

/**
 * Registo de um colégio e autenticação do seu responsável.
 * O email corporativo é confirmado com um código ANTES do registo; a senha
 * esquecida repõe-se com um código enviado para esse email.
 */
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
    private readonly verification: EmailVerificationService,
  ) {}

  /**
   * Passo 1 do registo: o email é válido e está livre? Email pessoal é aceite,
   * mas com prazo de 30 dias para passar a corporativo (o frontend avisa).
   */
  async checkEmail(raw: string): Promise<Result<{ email: string; available: boolean; personal: boolean; deadlineDays: number }, SchoolError>> {
    const email = normalizeOwnerEmail(raw);
    if (!email.ok) return email;
    return ok({
      email: email.value,
      available: !(await this.schools.ownerEmailExists(email.value)),
      personal: isPersonalEmail(email.value),
      deadlineDays: CORPORATE_EMAIL_DEADLINE_DAYS,
    });
  }

  async checkNif(raw: string): Promise<{ available: boolean }> {
    const nif = raw.replace(/[\s.-]/g, "").toUpperCase();
    return { available: !(await this.schools.nifExists(nif)) };
  }

  // ================================================================ confirmar o email (registo)

  async sendSignUpCode(raw: string): Promise<Result<{ destination: string }, Err>> {
    const email = await this.checkEmail(raw);
    if (!email.ok) return email;
    if (!email.value.available) return fail(schoolError("EMAIL_TAKEN", "Já existe um colégio registado com este email. Entre na sua conta."));
    return this.verification.send({ purpose: "SCHOOL_SIGN_UP", email: email.value.email });
  }

  async verifySignUpCode(raw: string, code: string): Promise<Result<{ emailProof: string }, Err>> {
    const email = normalizeOwnerEmail(raw);
    if (!email.ok) return email;
    const verified = await this.verification.verify({ purpose: "SCHOOL_SIGN_UP", email: email.value, code });
    return verified.ok ? ok({ emailProof: verified.value.proof }) : verified;
  }

  async register(input: RegisterSchoolInput): Promise<Result<{ schoolId: string; accessToken: string; expiresIn: number }, Err | DomainError>> {
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

    // o email corporativo só conta como confirmado com a prova do código (uso único)
    const proof = await this.verification.consume({ purpose: "SCHOOL_SIGN_UP", email: owner.value.email, proof: input.owner.emailProof });
    if (!proof.ok) return proof;

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

  // ================================================================ trocar o email (pessoal → corporativo)

  async sendEmailChangeCode(schoolId: string, raw: string): Promise<Result<{ destination: string }, Err>> {
    const email = normalizeCorporateEmail(raw);
    if (!email.ok) return email;
    const school = await this.schools.findById(schoolId);
    if (!school) return fail(schoolError("SCHOOL_NOT_FOUND", "Colégio não encontrado."));
    if (email.value === school.ownerEmail) return fail(schoolError("INVALID_STATE", "Este já é o email da conta."));
    if (await this.schools.ownerEmailExists(email.value)) return fail(schoolError("EMAIL_TAKEN", "Este email já está associado a outro colégio."));
    return this.verification.send({ purpose: "SCHOOL_EMAIL_CHANGE", email: email.value, name: school.snapshot.ownerName });
  }

  /** Código certo → o email passa a ser o novo (e acaba o prazo do email pessoal). */
  async confirmEmailChange(schoolId: string, raw: string, code: string): Promise<Result<{ email: string }, Err>> {
    const email = normalizeCorporateEmail(raw);
    if (!email.ok) return email;
    const school = await this.schools.findById(schoolId);
    if (!school) return fail(schoolError("SCHOOL_NOT_FOUND", "Colégio não encontrado."));
    if (await this.schools.ownerEmailExists(email.value)) return fail(schoolError("EMAIL_TAKEN", "Este email já está associado a outro colégio."));

    const verified = await this.verification.verify({ purpose: "SCHOOL_EMAIL_CHANGE", email: email.value, code });
    if (!verified.ok) return verified;
    const consumed = await this.verification.consume({ purpose: "SCHOOL_EMAIL_CHANGE", email: email.value, proof: verified.value.proof });
    if (!consumed.ok) return consumed;

    const changed = school.changeOwnerEmail(email.value, this.clock.now());
    if (!changed.ok) return changed;
    await this.schools.save(school);
    return ok({ email: email.value });
  }

  // ================================================================ esqueci a senha

  /** Resposta igual exista ou não o colégio (destination = null). */
  async requestPasswordReset(raw: string): Promise<Result<{ destination: string | null }, Err>> {
    const school = await this.schools.findByOwnerEmail(raw.trim().toLowerCase());
    if (!school) return ok({ destination: null });
    const sent = await this.verification.send({ purpose: "SCHOOL_PASSWORD_RESET", email: school.ownerEmail, name: school.snapshot.ownerName });
    return sent.ok ? ok({ destination: sent.value.destination }) : sent;
  }

  async verifyPasswordReset(raw: string, code: string): Promise<Result<{ ticket: string }, Err>> {
    const email = raw.trim().toLowerCase();
    if (!(await this.schools.findByOwnerEmail(email))) {
      return fail(schoolError("INVALID_STATE", "Este código já não é válido. Peça um novo."));
    }
    const verified = await this.verification.verify({ purpose: "SCHOOL_PASSWORD_RESET", email, code });
    return verified.ok ? ok({ ticket: verified.value.proof }) : verified;
  }

  async resetPassword(input: { email: string; ticket: string; password: string }): Promise<Result<{ accessToken: string; expiresIn: number }, Err>> {
    const school = await this.schools.findByOwnerEmail(input.email.trim().toLowerCase());
    if (!school) return fail(schoolError("INVALID_STATE", "O pedido expirou. Peça um novo código."));
    const password = validateOwnerPassword(input.password);
    if (!password.ok) return password;

    const consumed = await this.verification.consume({ purpose: "SCHOOL_PASSWORD_RESET", email: school.ownerEmail, proof: input.ticket });
    if (!consumed.ok) return consumed;

    school.resetOwnerPassword(await this.hasher.hash(password.value), this.clock.now());
    await this.schools.save(school);
    return ok(await this.tokens.issue(school.id));
  }
}
