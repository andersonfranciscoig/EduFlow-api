"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TenantConnections = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const tenant_client_1 = require(".prisma/tenant-client");
const keys_1 = require("../../../../libs/kernel/src/infrastructure/keys");
let TenantConnections = class TenantConnections {
    privateKey;
    max;
    pool = new Map();
    constructor(config) {
        this.privateKey = (0, keys_1.readKeyFile)(config.get("TENANT_CREDENTIALS_PRIVATE_KEY_FILE", { infer: true }));
        this.max = config.get("TENANT_POOL_SIZE", { infer: true });
    }
    get(tenant) {
        const existing = this.pool.get(tenant.schoolId);
        if (existing) {
            this.pool.delete(tenant.schoolId);
            this.pool.set(tenant.schoolId, existing);
            return existing;
        }
        const password = encodeURIComponent((0, keys_1.decryptSecret)(this.privateKey, tenant.passwordCiphertext));
        const url = `postgresql://${tenant.dbUser}:${password}@${tenant.dbHost}:${tenant.dbPort}/${tenant.dbName}?schema=public&connection_limit=5`;
        const client = new tenant_client_1.PrismaClient({ datasources: { db: { url } }, log: ["warn", "error"] });
        this.pool.set(tenant.schoolId, client);
        if (this.pool.size > this.max) {
            const [oldestId, oldest] = this.pool.entries().next().value;
            this.pool.delete(oldestId);
            void oldest.$disconnect();
        }
        return client;
    }
    async onModuleDestroy() {
        await Promise.all([...this.pool.values()].map((c) => c.$disconnect()));
    }
};
exports.TenantConnections = TenantConnections;
exports.TenantConnections = TenantConnections = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService])
], TenantConnections);
//# sourceMappingURL=tenant-connections.js.map