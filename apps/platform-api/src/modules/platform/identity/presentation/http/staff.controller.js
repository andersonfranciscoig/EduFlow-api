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
exports.StaffController = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const openapi_1 = require("../../../../../../../../libs/kernel/src/presentation/openapi");
const zod_validation_pipe_1 = require("../../../../../../../../libs/kernel/src/presentation/zod-validation.pipe");
const ManageStaffMember_1 = require("../../application/use-cases/staff/ManageStaffMember");
const QueryStaff_1 = require("../../application/use-cases/staff/QueryStaff");
const access_control_1 = require("../../domain/access-control");
const identity_http_error_1 = require("./identity-http-error");
const staff_auth_1 = require("./staff-auth");
const staff_schemas_1 = require("./staff.schemas");
const error = (0, openapi_1.openApi)(openapi_1.apiErrorSchema);
const detail = (0, openapi_1.openApi)(staff_schemas_1.staffDetailSchema, "output");
const idParam = new zod_validation_pipe_1.ZodValidationPipe(staff_schemas_1.memberIdSchema);
let StaffController = class StaffController {
    listStaff;
    getMember;
    getActivity;
    activateMember;
    suspendMember;
    changeRole;
    setPermissions;
    constructor(listStaff, getMember, getActivity, activateMember, suspendMember, changeRole, setPermissions) {
        this.listStaff = listStaff;
        this.getMember = getMember;
        this.getActivity = getActivity;
        this.activateMember = activateMember;
        this.suspendMember = suspendMember;
        this.changeRole = changeRole;
        this.setPermissions = setPermissions;
    }
    list(query) {
        return this.listStaff.execute(query);
    }
    catalog() {
        return access_control_1.PERMISSION_CATALOG;
    }
    async detail(id) {
        const result = await this.getMember.execute({ id });
        if (!result.ok)
            throw (0, identity_http_error_1.toHttpException)(result.error);
        return result.value;
    }
    async activity(id, query) {
        const result = await this.getActivity.execute({ id, ...query });
        if (!result.ok)
            throw (0, identity_http_error_1.toHttpException)(result.error);
        return result.value;
    }
    async activate(id, actor) {
        const result = await this.activateMember.execute({ actorId: actor.id, memberId: id });
        if (!result.ok)
            throw (0, identity_http_error_1.toHttpException)(result.error);
        return result.value;
    }
    async suspend(id, actor) {
        const result = await this.suspendMember.execute({ actorId: actor.id, memberId: id });
        if (!result.ok)
            throw (0, identity_http_error_1.toHttpException)(result.error);
        return result.value;
    }
    async role(id, body, actor) {
        const result = await this.changeRole.execute({ actorId: actor.id, memberId: id, role: body.role });
        if (!result.ok)
            throw (0, identity_http_error_1.toHttpException)(result.error);
        return result.value;
    }
    async permissions(id, body, actor) {
        const result = await this.setPermissions.execute({ actorId: actor.id, memberId: id, permissions: body.permissions });
        if (!result.ok)
            throw (0, identity_http_error_1.toHttpException)(result.error);
        return result.value;
    }
};
exports.StaffController = StaffController;
__decorate([
    (0, common_1.Get)(),
    (0, staff_auth_1.StaffAuth)("staff.view"),
    (0, swagger_1.ApiOperation)({ summary: "Listar membros da equipa", description: "Com contagens por estado." }),
    (0, swagger_1.ApiQuery)({ name: "status", required: false, enum: access_control_1.STAFF_STATUSES }),
    (0, swagger_1.ApiQuery)({ name: "role", required: false, enum: access_control_1.STAFF_ROLES }),
    (0, swagger_1.ApiResponse)({ status: 200, description: "Lista", schema: (0, openapi_1.openApi)(staff_schemas_1.staffListResponseSchema, "output") }),
    __param(0, (0, common_1.Query)(new zod_validation_pipe_1.ZodValidationPipe(staff_schemas_1.listStaffQuerySchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], StaffController.prototype, "list", null);
__decorate([
    (0, common_1.Get)("permissions"),
    (0, staff_auth_1.StaffAuth)(),
    (0, swagger_1.ApiOperation)({ summary: "Catálogo de permissões", description: "Todas as permissões que podem ser atribuídas." }),
    (0, swagger_1.ApiResponse)({ status: 200, description: "Catálogo", schema: (0, openapi_1.openApi)(staff_schemas_1.permissionCatalogSchema, "output") }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], StaffController.prototype, "catalog", null);
__decorate([
    (0, common_1.Get)(":id"),
    (0, staff_auth_1.StaffAuth)("staff.view"),
    (0, swagger_1.ApiOperation)({ summary: "Perfil de um membro" }),
    (0, swagger_1.ApiParam)({ name: "id", format: "uuid" }),
    (0, swagger_1.ApiResponse)({ status: 200, description: "Perfil", schema: detail }),
    (0, swagger_1.ApiResponse)({ status: 404, description: "Membro não encontrado", schema: error }),
    __param(0, (0, common_1.Param)("id", idParam)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], StaffController.prototype, "detail", null);
__decorate([
    (0, common_1.Get)(":id/activity"),
    (0, staff_auth_1.StaffAuth)("staff.view"),
    (0, swagger_1.ApiOperation)({
        summary: "Histórico de atividade",
        description: "Ações feitas pelo membro e ações feitas sobre ele, da mais recente para a mais antiga.",
    }),
    (0, swagger_1.ApiParam)({ name: "id", format: "uuid" }),
    (0, swagger_1.ApiQuery)({ name: "limit", required: false, type: Number }),
    (0, swagger_1.ApiQuery)({ name: "before", required: false, description: "ISO 8601 — paginação" }),
    (0, swagger_1.ApiResponse)({ status: 200, description: "Histórico", schema: (0, openapi_1.openApi)(staff_schemas_1.activityResponseSchema, "output") }),
    __param(0, (0, common_1.Param)("id", idParam)),
    __param(1, (0, common_1.Query)(new zod_validation_pipe_1.ZodValidationPipe(staff_schemas_1.activityQuerySchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], StaffController.prototype, "activity", null);
__decorate([
    (0, common_1.Post)(":id/activate"),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    (0, staff_auth_1.StaffAuth)("staff.manage"),
    (0, swagger_1.ApiOperation)({ summary: "Aprovar / reativar conta" }),
    (0, swagger_1.ApiParam)({ name: "id", format: "uuid" }),
    (0, swagger_1.ApiResponse)({ status: 200, description: "Perfil atualizado", schema: detail }),
    (0, swagger_1.ApiResponse)({ status: 409, description: "A conta já está ativa", schema: error }),
    __param(0, (0, common_1.Param)("id", idParam)),
    __param(1, (0, staff_auth_1.CurrentStaff)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], StaffController.prototype, "activate", null);
__decorate([
    (0, common_1.Post)(":id/suspend"),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    (0, staff_auth_1.StaffAuth)("staff.manage"),
    (0, swagger_1.ApiOperation)({ summary: "Desativar conta", description: "O membro perde o acesso imediatamente." }),
    (0, swagger_1.ApiParam)({ name: "id", format: "uuid" }),
    (0, swagger_1.ApiResponse)({ status: 200, description: "Perfil atualizado", schema: detail }),
    (0, swagger_1.ApiResponse)({ status: 409, description: "Já desativada, ou é o último administrador", schema: error }),
    __param(0, (0, common_1.Param)("id", idParam)),
    __param(1, (0, staff_auth_1.CurrentStaff)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], StaffController.prototype, "suspend", null);
__decorate([
    (0, common_1.Patch)(":id/role"),
    (0, staff_auth_1.StaffAuth)("staff.manage"),
    (0, swagger_1.ApiOperation)({ summary: "Alterar papel", description: "Só administradores. Nunca pode ficar sem admins ativos." }),
    (0, swagger_1.ApiParam)({ name: "id", format: "uuid" }),
    (0, swagger_1.ApiBody)({ schema: (0, openapi_1.openApi)(staff_schemas_1.changeRoleSchema) }),
    (0, swagger_1.ApiResponse)({ status: 200, description: "Perfil atualizado", schema: detail }),
    __param(0, (0, common_1.Param)("id", idParam)),
    __param(1, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(staff_schemas_1.changeRoleSchema))),
    __param(2, (0, staff_auth_1.CurrentStaff)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], StaffController.prototype, "role", null);
__decorate([
    (0, common_1.Put)(":id/permissions"),
    (0, staff_auth_1.StaffAuth)("staff.manage"),
    (0, swagger_1.ApiOperation)({
        summary: "Definir permissões extra",
        description: "Substitui as permissões atribuídas individualmente a um gestor (as do papel mantêm-se).",
    }),
    (0, swagger_1.ApiParam)({ name: "id", format: "uuid" }),
    (0, swagger_1.ApiBody)({ schema: (0, openapi_1.openApi)(staff_schemas_1.setPermissionsSchema) }),
    (0, swagger_1.ApiResponse)({ status: 200, description: "Perfil atualizado", schema: detail }),
    (0, swagger_1.ApiResponse)({ status: 422, description: "Permissão desconhecida", schema: error }),
    __param(0, (0, common_1.Param)("id", idParam)),
    __param(1, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(staff_schemas_1.setPermissionsSchema))),
    __param(2, (0, staff_auth_1.CurrentStaff)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], StaffController.prototype, "permissions", null);
exports.StaffController = StaffController = __decorate([
    (0, swagger_1.ApiTags)("Plataforma · Equipa"),
    (0, swagger_1.ApiBearerAuth)(),
    (0, swagger_1.ApiResponse)({ status: 401, description: "Sessão inválida ou expirada", schema: error }),
    (0, swagger_1.ApiResponse)({ status: 403, description: "Sem permissão", schema: error }),
    (0, common_1.Controller)("v1/platform/staff"),
    __metadata("design:paramtypes", [QueryStaff_1.ListStaffMembers,
        QueryStaff_1.GetStaffMember,
        QueryStaff_1.GetStaffActivity,
        ManageStaffMember_1.ActivateStaffMember,
        ManageStaffMember_1.SuspendStaffMember,
        ManageStaffMember_1.ChangeStaffRole,
        ManageStaffMember_1.SetStaffPermissions])
], StaffController);
//# sourceMappingURL=staff.controller.js.map