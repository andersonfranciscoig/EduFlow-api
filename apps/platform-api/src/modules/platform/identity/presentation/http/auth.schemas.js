"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.signUpResponseSchema = exports.sessionResponseSchema = exports.identifyResponseSchema = exports.signUpSchema = exports.signInSchema = exports.identifySchema = void 0;
const zod_1 = require("zod");
const access_control_1 = require("../../domain/access-control");
const identifier = zod_1.z
    .string({ error: "Indique o email ou telefone." })
    .trim()
    .min(1, "Indique o email ou telefone.")
    .max(254)
    .meta({ description: "Email ou número de telefone", example: "ana@eduflow.ao" });
const password = zod_1.z
    .string({ error: "Indique a senha." })
    .max(128)
    .meta({ description: "Senha", example: "Senha1234" });
exports.identifySchema = zod_1.z.object({ identifier }).meta({ title: "IdentifyRequest" });
exports.signInSchema = zod_1.z
    .object({ identifier, password: password.min(1, "Indique a senha.") })
    .meta({ title: "SignInRequest" });
exports.signUpSchema = zod_1.z
    .object({
    identifier,
    fullName: zod_1.z
        .string({ error: "Indique o seu nome." })
        .trim()
        .min(1, "Indique o seu nome.")
        .max(120)
        .meta({ example: "Ana Paula Domingos" }),
    password: password.meta({ description: "8+ caracteres, com letras e números", example: "Senha1234" }),
})
    .meta({ title: "SignUpRequest" });
const staffPrincipal = zod_1.z.object({
    id: zod_1.z.uuid(),
    fullName: zod_1.z.string().meta({ example: "Ana Paula Domingos" }),
    role: zod_1.z.enum(access_control_1.STAFF_ROLES),
});
exports.identifyResponseSchema = zod_1.z
    .object({
    exists: zod_1.z.boolean(),
    kind: zod_1.z.enum(["email", "phone"]),
    normalized: zod_1.z.string().meta({ description: "Email em minúsculas ou telefone E.164", example: "+244923456789" }),
    firstName: zod_1.z.string().nullable().meta({ example: "Ana" }),
})
    .meta({ title: "IdentifyResponse" });
exports.sessionResponseSchema = zod_1.z
    .object({
    staff: staffPrincipal,
    accessToken: zod_1.z.string().meta({ description: "JWT (Bearer)" }),
    expiresIn: zod_1.z.number().int().meta({ description: "Segundos até expirar", example: 28800 }),
})
    .meta({ title: "SessionResponse" });
exports.signUpResponseSchema = zod_1.z
    .object({
    staff: staffPrincipal,
    role: zod_1.z.enum(access_control_1.STAFF_ROLES),
    status: zod_1.z.enum(access_control_1.STAFF_STATUSES),
    accessToken: zod_1.z.string().optional().meta({ description: "Só quando a conta fica ATIVA (primeiro membro)" }),
    expiresIn: zod_1.z.number().int().optional(),
})
    .meta({ title: "SignUpResponse" });
//# sourceMappingURL=auth.schemas.js.map