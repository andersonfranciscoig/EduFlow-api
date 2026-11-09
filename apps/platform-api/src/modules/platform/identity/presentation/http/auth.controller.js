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
exports.AuthController = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const throttler_1 = require("@nestjs/throttler");
const openapi_1 = require("../../../../../../../../libs/kernel/src/presentation/openapi");
const zod_validation_pipe_1 = require("../../../../../../../../libs/kernel/src/presentation/zod-validation.pipe");
const ports_1 = require("../../application/ports");
const AuthenticateStaffMember_1 = require("../../application/use-cases/AuthenticateStaffMember");
const GetStaffProfile_1 = require("../../application/use-cases/GetStaffProfile");
const IdentifyStaffMember_1 = require("../../application/use-cases/IdentifyStaffMember");
const RegisterStaffMember_1 = require("../../application/use-cases/RegisterStaffMember");
const auth_schemas_1 = require("./auth.schemas");
const staff_schemas_1 = require("./staff.schemas");
const identity_http_error_1 = require("./identity-http-error");
const staff_auth_1 = require("./staff-auth");
const MINUTE = 60_000;
const error = (0, openapi_1.openApi)(openapi_1.apiErrorSchema);
const tooMany = { status: 429, description: "Demasiados pedidos — aguarde e tente de novo" };
let AuthController = class AuthController {
    identifyStaff;
    registerStaff;
    authenticateStaff;
    getProfile;
    tokens;
    constructor(identifyStaff, registerStaff, authenticateStaff, getProfile, tokens) {
        this.identifyStaff = identifyStaff;
        this.registerStaff = registerStaff;
        this.authenticateStaff = authenticateStaff;
        this.getProfile = getProfile;
        this.tokens = tokens;
    }
    async identify(body) {
        const result = await this.identifyStaff.execute(body);
        if (!result.ok)
            throw (0, identity_http_error_1.toHttpException)(result.error);
        return result.value;
    }
    async signIn(body) {
        const result = await this.authenticateStaff.execute(body);
        if (!result.ok)
            throw (0, identity_http_error_1.toHttpException)(result.error);
        return { staff: result.value, ...(await this.tokens.issue(result.value)) };
    }
    async signUp(body) {
        const result = await this.registerStaff.execute(body);
        if (!result.ok)
            throw (0, identity_http_error_1.toHttpException)(result.error);
        const { principal, role, status } = result.value;
        const session = status === "ACTIVE" ? await this.tokens.issue(principal) : null;
        return { staff: principal, role, status, ...session };
    }
    async me(staff) {
        const result = await this.getProfile.execute({ id: staff.id });
        if (!result.ok)
            throw (0, identity_http_error_1.toHttpException)(result.error);
        return result.value;
    }
};
exports.AuthController = AuthController;
__decorate([
    (0, common_1.Post)("identify"),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    (0, throttler_1.Throttle)({ default: { limit: 30, ttl: MINUTE } }),
    (0, swagger_1.ApiOperation)({
        summary: "Passo 1 — identificar a conta",
        description: "Recebe um email ou número de telefone, normaliza-o (telefones sem indicativo assumem +244) e indica se já existe uma conta.",
    }),
    (0, swagger_1.ApiBody)({ schema: (0, openapi_1.openApi)(auth_schemas_1.identifySchema) }),
    (0, swagger_1.ApiResponse)({ status: 200, description: "Resultado da identificação", schema: (0, openapi_1.openApi)(auth_schemas_1.identifyResponseSchema, "output") }),
    (0, swagger_1.ApiResponse)({ status: 422, description: "Email ou telefone inválido", schema: error }),
    (0, swagger_1.ApiResponse)(tooMany),
    __param(0, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(auth_schemas_1.identifySchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "identify", null);
__decorate([
    (0, common_1.Post)("sign-in"),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    (0, throttler_1.Throttle)({ default: { limit: 10, ttl: 5 * MINUTE } }),
    (0, swagger_1.ApiOperation)({
        summary: "Passo 2 — iniciar sessão",
        description: "Valida a senha e devolve um token de acesso. 5 tentativas falhadas bloqueiam a conta por 15 minutos.",
    }),
    (0, swagger_1.ApiBody)({ schema: (0, openapi_1.openApi)(auth_schemas_1.signInSchema) }),
    (0, swagger_1.ApiResponse)({ status: 200, description: "Sessão iniciada", schema: (0, openapi_1.openApi)(auth_schemas_1.sessionResponseSchema, "output") }),
    (0, swagger_1.ApiResponse)({ status: 401, description: "Credenciais inválidas (`meta.remaining` = tentativas restantes)", schema: error }),
    (0, swagger_1.ApiResponse)({ status: 403, description: "Conta a aguardar aprovação ou suspensa", schema: error }),
    (0, swagger_1.ApiResponse)({ status: 423, description: "Conta temporariamente bloqueada", schema: error }),
    (0, swagger_1.ApiResponse)(tooMany),
    __param(0, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(auth_schemas_1.signInSchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "signIn", null);
__decorate([
    (0, common_1.Post)("sign-up"),
    (0, throttler_1.Throttle)({ default: { limit: 5, ttl: 15 * MINUTE } }),
    (0, swagger_1.ApiOperation)({
        summary: "Criar conta da equipa",
        description: "O primeiro membro da plataforma torna-se ADMIN ativo e recebe logo um token. Os seguintes ficam como GESTOR a aguardar aprovação de um administrador (sem token).",
    }),
    (0, swagger_1.ApiBody)({ schema: (0, openapi_1.openApi)(auth_schemas_1.signUpSchema) }),
    (0, swagger_1.ApiResponse)({ status: 201, description: "Conta criada", schema: (0, openapi_1.openApi)(auth_schemas_1.signUpResponseSchema, "output") }),
    (0, swagger_1.ApiResponse)({ status: 409, description: "Já existe uma conta com este identificador", schema: error }),
    (0, swagger_1.ApiResponse)({ status: 422, description: "Dados inválidos (nome, email/telefone ou senha fraca)", schema: error }),
    (0, swagger_1.ApiResponse)(tooMany),
    __param(0, (0, common_1.Body)(new zod_validation_pipe_1.ZodValidationPipe(auth_schemas_1.signUpSchema))),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "signUp", null);
__decorate([
    (0, common_1.Get)("me"),
    (0, staff_auth_1.StaffAuth)(),
    (0, swagger_1.ApiBearerAuth)(),
    (0, swagger_1.ApiOperation)({
        summary: "Perfil do membro autenticado",
        description: "Lido sempre da base de dados, para refletir alterações de acesso imediatamente.",
    }),
    (0, swagger_1.ApiResponse)({ status: 200, description: "Perfil", schema: (0, openapi_1.openApi)(staff_schemas_1.staffDetailSchema, "output") }),
    (0, swagger_1.ApiResponse)({ status: 401, description: "Token em falta, inválido ou expirado", schema: error }),
    __param(0, (0, staff_auth_1.CurrentStaff)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "me", null);
exports.AuthController = AuthController = __decorate([
    (0, swagger_1.ApiTags)("Plataforma · Autenticação"),
    (0, common_1.Controller)("v1/platform/auth"),
    __param(4, (0, common_1.Inject)(ports_1.IDENTITY_TOKENS.AccessTokenService)),
    __metadata("design:paramtypes", [IdentifyStaffMember_1.IdentifyStaffMember,
        RegisterStaffMember_1.RegisterStaffMember,
        AuthenticateStaffMember_1.AuthenticateStaffMember,
        GetStaffProfile_1.GetStaffProfile, Object])
], AuthController);
//# sourceMappingURL=auth.controller.js.map