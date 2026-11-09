"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateEnv = exports.envSchema = void 0;
const zod_1 = require("zod");
const env_1 = require("../../../../libs/kernel/src/infrastructure/env");
exports.envSchema = zod_1.z.object({
    NODE_ENV: zod_1.z.enum(["development", "production", "test"]).default("development"),
    PORT: zod_1.z.coerce.number().int().positive().default(4000),
    FRONTEND_URL: zod_1.z.string().url().default("http://localhost:3001"),
    PLATFORM_DATABASE_URL: zod_1.z.string().min(1),
    STAFF_JWT_PRIVATE_KEY_FILE: zod_1.z.string().min(1),
    STAFF_JWT_PUBLIC_KEY_FILE: zod_1.z.string().min(1),
    CUSTOMER_JWT_PRIVATE_KEY_FILE: zod_1.z.string().min(1),
    CUSTOMER_JWT_PUBLIC_KEY_FILE: zod_1.z.string().min(1),
    JWT_EXPIRES_IN_SECONDS: zod_1.z.coerce.number().int().positive().default(60 * 60 * 8),
    DEFAULT_PHONE_COUNTRY_CODE: zod_1.z.string().regex(/^\d{1,4}$/).default("244"),
    STORAGE_DIR: zod_1.z.string().default("./storage/platform"),
});
exports.validateEnv = (0, env_1.envValidator)(exports.envSchema, "platform-api");
//# sourceMappingURL=env.js.map