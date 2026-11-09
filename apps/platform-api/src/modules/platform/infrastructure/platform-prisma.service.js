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
exports.PlatformPrismaService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const platform_client_1 = require(".prisma/platform-client");
let PlatformPrismaService = class PlatformPrismaService extends platform_client_1.PrismaClient {
    constructor(config) {
        super({
            datasources: { db: { url: config.get("PLATFORM_DATABASE_URL", { infer: true }) } },
            log: ["warn", "error"],
        });
    }
    async onModuleInit() {
        await this.$connect();
    }
    async onModuleDestroy() {
        await this.$disconnect();
    }
};
exports.PlatformPrismaService = PlatformPrismaService;
exports.PlatformPrismaService = PlatformPrismaService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService])
], PlatformPrismaService);
//# sourceMappingURL=platform-prisma.service.js.map