"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.apiErrorSchema = void 0;
exports.openApi = openApi;
const zod_1 = require("zod");
function openApi(schema, io = "input") {
    const { $schema: _ignored, ...json } = zod_1.z.toJSONSchema(schema, {
        target: "openapi-3.0",
        io,
        unrepresentable: "any",
    });
    return json;
}
exports.apiErrorSchema = zod_1.z
    .object({
    code: zod_1.z.string().meta({ example: "INVALID_CREDENTIALS" }),
    message: zod_1.z.string().meta({ example: "Senha incorreta. Tente novamente." }),
    meta: zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()).nullable().optional(),
})
    .meta({ description: "Erro da API" });
//# sourceMappingURL=openapi.js.map