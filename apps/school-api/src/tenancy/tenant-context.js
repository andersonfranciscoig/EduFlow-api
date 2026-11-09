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
exports.CurrentTenant = exports.TenantGuard = void 0;
const common_1 = require("@nestjs/common");
const tenant_connections_1 = require("./tenant-connections");
const tenant_directory_1 = require("./tenant-directory");
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])?$/;
let TenantGuard = class TenantGuard {
    directory;
    connections;
    constructor(directory, connections) {
        this.directory = directory;
        this.connections = connections;
    }
    async canActivate(context) {
        const request = context.switchToHttp().getRequest();
        const header = request.header("x-tenant")?.trim().toLowerCase();
        const fromHost = request.hostname.split(".").length > 2 ? request.hostname.split(".")[0] : undefined;
        const slug = header || fromHost;
        const entry = slug && SLUG.test(slug) ? await this.directory.findBySlug(slug) : null;
        if (!entry) {
            throw new common_1.NotFoundException({ code: "TENANT_NOT_FOUND", message: "Colégio não encontrado." });
        }
        request.tenant = { entry, db: this.connections.get(entry) };
        return true;
    }
};
exports.TenantGuard = TenantGuard;
exports.TenantGuard = TenantGuard = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [tenant_directory_1.TenantDirectory,
        tenant_connections_1.TenantConnections])
], TenantGuard);
exports.CurrentTenant = (0, common_1.createParamDecorator)((_, context) => context.switchToHttp().getRequest().tenant);
//# sourceMappingURL=tenant-context.js.map