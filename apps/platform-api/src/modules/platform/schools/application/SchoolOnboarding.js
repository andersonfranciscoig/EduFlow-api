"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SchoolOnboarding = void 0;
const Result_1 = require("../../../../../../../libs/kernel/src/domain/Result");
const errors_1 = require("../domain/errors");
const School_1 = require("../domain/School");
const school_data_1 = require("../domain/school-data");
class SchoolOnboarding {
    schools;
    catalog;
    hasher;
    tokens;
    ids;
    codes;
    clock;
    settings;
    dummyHash;
    constructor(schools, catalog, hasher, tokens, ids, codes, clock, settings) {
        this.schools = schools;
        this.catalog = catalog;
        this.hasher = hasher;
        this.tokens = tokens;
        this.ids = ids;
        this.codes = codes;
        this.clock = clock;
        this.settings = settings;
    }
    async checkEmail(raw) {
        const email = (0, school_data_1.normalizeCorporateEmail)(raw);
        if (!email.ok)
            return email;
        return (0, Result_1.ok)({ email: email.value, available: !(await this.schools.ownerEmailExists(email.value)) });
    }
    async checkNif(raw) {
        const nif = raw.replace(/[\s.-]/g, "").toUpperCase();
        return { available: !(await this.schools.nifExists(nif)) };
    }
    async register(input) {
        const owner = (0, school_data_1.validateOwner)(input.owner);
        if (!owner.ok)
            return owner;
        const data = (0, school_data_1.validateSchoolData)(input.school, this.settings.defaultPhoneCountryCode);
        if (!data.ok)
            return data;
        if (await this.schools.ownerEmailExists(owner.value.email)) {
            return (0, Result_1.fail)((0, errors_1.schoolError)("EMAIL_TAKEN", "Já existe um colégio registado com este email."));
        }
        if (await this.schools.nifExists(data.value.nif)) {
            return (0, Result_1.fail)((0, errors_1.schoolError)("NIF_TAKEN", "Já existe um colégio registado com este NIF."));
        }
        const quote = await this.catalog.quote(input.subscription.planId, input.subscription.cycle);
        if (!quote.ok)
            return quote;
        const now = this.clock.now();
        const q = quote.value;
        const base = (0, school_data_1.slugify)(data.value.name);
        let slug = base;
        for (let n = 2; await this.schools.slugExists(slug); n++)
            slug = `${base}-${n}`;
        const school = School_1.School.register({
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
        return (0, Result_1.ok)({ schoolId: school.id, ...(await this.tokens.issue(school.id)) });
    }
    async signIn(email, password) {
        const school = await this.schools.findByOwnerEmail(email.trim().toLowerCase());
        if (!school) {
            this.dummyHash ??= this.hasher.hash("eduflow-timing-equalizer");
            await this.hasher.verify(password, await this.dummyHash);
            return (0, Result_1.fail)((0, errors_1.schoolError)("INVALID_CREDENTIALS", "Email ou senha incorretos."));
        }
        if (!(await this.hasher.verify(password, school.ownerPasswordHash))) {
            return (0, Result_1.fail)((0, errors_1.schoolError)("INVALID_CREDENTIALS", "Email ou senha incorretos."));
        }
        return (0, Result_1.ok)(await this.tokens.issue(school.id));
    }
}
exports.SchoolOnboarding = SchoolOnboarding;
//# sourceMappingURL=SchoolOnboarding.js.map