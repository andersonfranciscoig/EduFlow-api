"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadEnv = loadEnv;
const node_fs_1 = require("node:fs");
const zod_1 = require("zod");
const schema = zod_1.z.object({
    NODE_ENV: zod_1.z.enum(["development", "production", "test"]).default("development"),
    PROVISIONER_DATABASE_URL: zod_1.z.string().min(1),
    TENANT_DB_HOST: zod_1.z.string().min(1),
    TENANT_DB_PORT: zod_1.z.coerce.number().int().positive(),
    TENANT_CREDENTIALS_PUBLIC_KEY_FILE: zod_1.z.string().min(1),
    POLL_INTERVAL_MS: zod_1.z.coerce.number().int().min(500).default(3000),
    MAX_ATTEMPTS: zod_1.z.coerce.number().int().min(1).default(5),
});
function loadEnv() {
    const file = "apps/provisioner/.env";
    if (process.env.NODE_ENV !== "production" && (0, node_fs_1.existsSync)(file))
        process.loadEnvFile(file);
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
        throw new Error(`[provisioner] Configuração inválida (${file}):\n${issues}`);
    }
    return parsed.data;
}
//# sourceMappingURL=env.js.map