"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROVINCES = void 0;
exports.normalizeCorporateEmail = normalizeCorporateEmail;
exports.normalizePhone = normalizePhone;
exports.slugify = slugify;
exports.normalizeNif = normalizeNif;
exports.validateSchoolData = validateSchoolData;
exports.validateOwner = validateOwner;
const Result_1 = require("../../../../../../../libs/kernel/src/domain/Result");
const errors_1 = require("./errors");
exports.PROVINCES = [
    "Bengo",
    "Benguela",
    "Bié",
    "Cabinda",
    "Cuando",
    "Cuanza Norte",
    "Cuanza Sul",
    "Cubango",
    "Cunene",
    "Huambo",
    "Huíla",
    "Icolo e Bengo",
    "Luanda",
    "Lunda Norte",
    "Lunda Sul",
    "Malanje",
    "Moxico",
    "Moxico Leste",
    "Namibe",
    "Uíge",
    "Zaire",
];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PERSONAL_DOMAINS = new Set([
    "gmail.com",
    "hotmail.com",
    "outlook.com",
    "live.com",
    "yahoo.com",
    "yahoo.com.br",
    "icloud.com",
    "aol.com",
    "proton.me",
    "protonmail.com",
]);
function normalizeCorporateEmail(raw) {
    const email = raw.trim().toLowerCase();
    if (email.length > 254 || !EMAIL.test(email)) {
        return (0, Result_1.fail)((0, errors_1.schoolError)("INVALID_OWNER", "Este email não parece válido."));
    }
    if (PERSONAL_DOMAINS.has(email.split("@")[1])) {
        return (0, Result_1.fail)((0, errors_1.schoolError)("INVALID_OWNER", "Use o email corporativo do colégio (ex.: direcao@seucolegio.ao), não um email pessoal."));
    }
    return (0, Result_1.ok)(email);
}
function normalizePhone(raw, defaultCountryCode) {
    const compact = raw.trim().replace(/[\s().-]/g, "");
    const digits = compact.startsWith("+")
        ? compact.slice(1)
        : compact.startsWith("00")
            ? compact.slice(2)
            : `${defaultCountryCode}${compact.replace(/^0+/, "")}`;
    return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
}
function slugify(name) {
    const base = name
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40)
        .replace(/-+$/g, "");
    return base.length >= 3 ? base : `colegio-${base || "novo"}`;
}
function normalizeNif(raw) {
    const nif = raw.replace(/[\s.-]/g, "").toUpperCase();
    return /^[0-9A-Z]{9,14}$/.test(nif) && /\d{6,}/.test(nif) ? nif : null;
}
function validateSchoolData(input, defaultCountryCode) {
    const name = input.name.trim().replace(/\s+/g, " ");
    if (name.length < 3)
        return (0, Result_1.fail)((0, errors_1.schoolError)("INVALID_SCHOOL_DATA", "Indique o nome do colégio."));
    const nif = normalizeNif(input.nif);
    if (!nif)
        return (0, Result_1.fail)((0, errors_1.schoolError)("INVALID_SCHOOL_DATA", "NIF inválido."));
    const phone = normalizePhone(input.phone, defaultCountryCode);
    if (!phone)
        return (0, Result_1.fail)((0, errors_1.schoolError)("INVALID_SCHOOL_DATA", "Número de telefone inválido."));
    if (!exports.PROVINCES.includes(input.province)) {
        return (0, Result_1.fail)((0, errors_1.schoolError)("INVALID_SCHOOL_DATA", "Escolha a província."));
    }
    const municipality = input.municipality.trim();
    if (municipality.length < 2)
        return (0, Result_1.fail)((0, errors_1.schoolError)("INVALID_SCHOOL_DATA", "Indique o município."));
    const address = input.address.trim();
    if (address.length < 5)
        return (0, Result_1.fail)((0, errors_1.schoolError)("INVALID_SCHOOL_DATA", "Indique a morada do colégio."));
    return (0, Result_1.ok)({ name, nif, phone, province: input.province, municipality, address });
}
function validateOwner(input) {
    const name = input.name.trim().replace(/\s+/g, " ");
    if (name.length < 3 || !/\p{L}/u.test(name)) {
        return (0, Result_1.fail)((0, errors_1.schoolError)("INVALID_OWNER", "Indique o nome do responsável."));
    }
    const email = normalizeCorporateEmail(input.email);
    if (!email.ok)
        return email;
    const p = input.password;
    if (p.length < 8 || p.length > 128 || !/\p{L}/u.test(p) || !/\d/.test(p)) {
        return (0, Result_1.fail)((0, errors_1.schoolError)("INVALID_OWNER", "A senha precisa de 8+ caracteres, com letras e números."));
    }
    return (0, Result_1.ok)({ name, email: email.value });
}
//# sourceMappingURL=school-data.js.map