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
exports.TenantDirectory = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const platform_client_1 = require(".prisma/platform-client");
const TTL_MS = 60_000;
let TenantDirectory = class TenantDirectory {
    db;
    cache = new Map();
    constructor(config) {
        this.db = new platform_client_1.PrismaClient({
            datasources: { db: { url: config.get("DIRECTORY_DATABASE_URL", { infer: true }) } },
            log: ["warn", "error"],
        });
    }
    async findBySlug(slug) {
        const hit = this.cache.get(slug);
        if (hit && Date.now() - hit.at < TTL_MS)
            return hit.entry;
        const row = await this.db.tenantDatabase.findUnique({ where: { slug } });
        const entry = row && row.active ? row : null;
        this.cache.set(slug, { entry, at: Date.now() });
        return entry;
    }
    onModuleDestroy() {
        return this.db.$disconnect();
    }
};
exports.TenantDirectory = TenantDirectory;
exports.TenantDirectory = TenantDirectory = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService])
], TenantDirectory);
//# sourceMappingURL=tenant-directory.js.map