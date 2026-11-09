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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CurrentStaff = exports.StaffAuth = exports.StaffPermissionsGuard = exports.StaffAuthGuard = void 0;
const common_1 = require("@nestjs/common");
const core_1 = require("@nestjs/core");
const ports_1 = require("../../application/ports");
const ResolveStaffAccess_1 = require("../../application/use-cases/staff/ResolveStaffAccess");
const PERMISSIONS_KEY = "platform:required-permissions";
let StaffAuthGuard = class StaffAuthGuard {
    tokens;
    resolveAccess;
    constructor(tokens, resolveAccess) {
        this.tokens = tokens;
        this.resolveAccess = resolveAccess;
    }
    async canActivate(context) {
        const request = context.switchToHttp().getRequest();
        const [scheme, token] = (request.headers.authorization ?? "").split(" ");
        const principal = scheme === "Bearer" && token ? await this.tokens.verify(token) : null;
        const access = principal ? await this.resolveAccess.execute({ id: principal.id }) : null;
        if (!access) {
            throw new common_1.UnauthorizedException({ code: "UNAUTHENTICATED", message: "Sessão expirada. Inicie sessão novamente." });
        }
        request.staff = access;
        return true;
    }
};
exports.StaffAuthGuard = StaffAuthGuard;
exports.StaffAuthGuard = StaffAuthGuard = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Inject)(ports_1.IDENTITY_TOKENS.AccessTokenService)),
    __metadata("design:paramtypes", [Object, ResolveStaffAccess_1.ResolveStaffAccess])
], StaffAuthGuard);
let StaffPermissionsGuard = class StaffPermissionsGuard {
    reflector;
    constructor(reflector) {
        this.reflector = reflector;
    }
    canActivate(context) {
        const required = this.reflector.getAllAndOverride(PERMISSIONS_KEY, [context.getHandler(), context.getClass()]) ?? [];
        const staff = context.switchToHttp().getRequest().staff;
        if (!staff || !required.every((p) => staff.permissions.includes(p))) {
            throw new common_1.ForbiddenException({ code: "FORBIDDEN", message: "Não tem permissão para esta ação." });
        }
        return true;
    }
};
exports.StaffPermissionsGuard = StaffPermissionsGuard;
exports.StaffPermissionsGuard = StaffPermissionsGuard = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [core_1.Reflector])
], StaffPermissionsGuard);
const StaffAuth = (...permissions) => (0, common_1.applyDecorators)((0, common_1.SetMetadata)(PERMISSIONS_KEY, permissions), (0, common_1.UseGuards)(StaffAuthGuard, StaffPermissionsGuard));
exports.StaffAuth = StaffAuth;
exports.CurrentStaff = (0, common_1.createParamDecorator)((_, context) => context.switchToHttp().getRequest().staff);
//# sourceMappingURL=staff-auth.js.map