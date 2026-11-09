"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.envValidator = envValidator;
function envValidator(schema, service) {
    return (config) => {
        const parsed = schema.safeParse(config);
        if (!parsed.success) {
            const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
            throw new Error(`[${service}] Configuração inválida (apps/${service}/.env):\n${issues}`);
        }
        return parsed.data;
    };
}
//# sourceMappingURL=env.js.map