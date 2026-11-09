"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateEnv = exports.envSchema = void 0;
const zod_1 = require("zod");
const env_1 = require("../../../../libs/kernel/src/infrastructure/env");
exports.envSchema = zod_1.z.object({
    NODE_ENV: zod_1.z.enum(["development", "production", "test"]).default("development"),
    PORT: zod_1.z.coerce.number().int().positive().default(4001),
    DIRECTORY_DATABASE_URL: zod_1.z.string().min(1),
    TENANT_CREDENTIALS_PRIVATE_KEY_FILE: zod_1.z.string().min(1),
    TENANT_POOL_SIZE: zod_1.z.coerce.number().int().min(1).default(50),
});
exports.validateEnv = (0, env_1.envValidator)(exports.envSchema, "school-api");
//# sourceMappingURL=env.js.map