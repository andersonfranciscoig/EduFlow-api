"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StaffMember = exports.LOCK_DURATION_MS = exports.MAX_FAILED_LOGINS = void 0;
const Result_1 = require("../../../../../../../libs/kernel/src/domain/Result");
const access_control_1 = require("./access-control");
const errors_1 = require("./errors");
exports.MAX_FAILED_LOGINS = 5;
exports.LOCK_DURATION_MS = 15 * 60 * 1000;
class StaffMember {
    props;
    events = [];
    constructor(props) {
        this.props = props;
    }
    static register(input) {
        const member = new StaffMember({
            id: input.id,
            fullName: input.fullName,
            email: input.identifier.kind === "email" ? input.identifier.email : null,
            phone: input.identifier.kind === "phone" ? input.identifier.phone : null,
            passwordHash: input.passwordHash,
            role: input.isFirstMember ? "ADMIN" : "GESTOR",
            status: input.isFirstMember ? "ACTIVE" : "PENDING_APPROVAL",
            extraPermissions: [],
            failedLoginAttempts: 0,
            lockedUntil: null,
            lastLoginAt: null,
            createdAt: input.now,
        });
        member.record("MEMBER_REGISTERED", input.id, input.now, { role: member.role, status: member.status });
        return member;
    }
    static restore(props) {
        return new StaffMember({ ...props, extraPermissions: [...props.extraPermissions] });
    }
    isLocked(now) {
        return this.props.lockedUntil !== null && this.props.lockedUntil > now;
    }
    ensureCanSignIn() {
        switch (this.props.status) {
            case "PENDING_APPROVAL":
                return (0, Result_1.fail)((0, errors_1.identityError)("ACCOUNT_PENDING_APPROVAL", "A sua conta foi criada e aguarda aprovação de um administrador."));
            case "SUSPENDED":
                return (0, Result_1.fail)((0, errors_1.identityError)("ACCOUNT_SUSPENDED", "Esta conta está desativada. Fale com um administrador."));
            default:
                return (0, Result_1.ok)(undefined);
        }
    }
    recordFailedLogin(now) {
        this.props.failedLoginAttempts += 1;
        if (this.props.failedLoginAttempts >= exports.MAX_FAILED_LOGINS) {
            this.props.lockedUntil = new Date(now.getTime() + exports.LOCK_DURATION_MS);
            this.props.failedLoginAttempts = 0;
            this.record("ACCOUNT_LOCKED", null, now, { minutes: exports.LOCK_DURATION_MS / 60_000 });
        }
        else {
            this.record("SIGN_IN_FAILED", null, now, { remaining: this.remainingAttempts });
        }
    }
    recordSuccessfulLogin(now) {
        this.props.failedLoginAttempts = 0;
        this.props.lockedUntil = null;
        this.props.lastLoginAt = now;
        this.record("SIGNED_IN", this.id, now, null);
    }
    activate(ctx) {
        const allowed = this.ensureManageableBy(ctx.actor);
        if (!allowed.ok)
            return allowed;
        if (this.props.status === "ACTIVE") {
            return (0, Result_1.fail)((0, errors_1.identityError)("INVALID_STATE", "Esta conta já está ativa."));
        }
        const previous = this.props.status;
        this.props.status = "ACTIVE";
        this.props.failedLoginAttempts = 0;
        this.props.lockedUntil = null;
        this.record("MEMBER_ACTIVATED", ctx.actor.id, ctx.now, { previousStatus: previous });
        return (0, Result_1.ok)(undefined);
    }
    suspend(ctx) {
        const allowed = this.ensureManageableBy(ctx.actor);
        if (!allowed.ok)
            return allowed;
        if (this.props.status === "SUSPENDED") {
            return (0, Result_1.fail)((0, errors_1.identityError)("INVALID_STATE", "Esta conta já está desativada."));
        }
        if (this.isActiveAdmin && ctx.activeAdminCount <= 1) {
            return (0, Result_1.fail)((0, errors_1.identityError)("LAST_ADMIN", "Não pode desativar o último administrador ativo."));
        }
        const previous = this.props.status;
        this.props.status = "SUSPENDED";
        this.record("MEMBER_SUSPENDED", ctx.actor.id, ctx.now, { previousStatus: previous });
        return (0, Result_1.ok)(undefined);
    }
    changeRole(role, ctx) {
        const allowed = this.ensureManageableBy(ctx.actor);
        if (!allowed.ok)
            return allowed;
        if (ctx.actor.role !== "ADMIN") {
            return (0, Result_1.fail)((0, errors_1.identityError)("ADMIN_REQUIRED", "Só um administrador pode alterar papéis."));
        }
        if (role === this.props.role) {
            return (0, Result_1.fail)((0, errors_1.identityError)("INVALID_STATE", `Este membro já é ${access_control_1.ROLE_LABELS[role]}.`));
        }
        if (this.isActiveAdmin && role !== "ADMIN" && ctx.activeAdminCount <= 1) {
            return (0, Result_1.fail)((0, errors_1.identityError)("LAST_ADMIN", "Tem de existir pelo menos um administrador ativo."));
        }
        const from = this.props.role;
        this.props.role = role;
        if (role === "ADMIN")
            this.props.extraPermissions = [];
        this.record("ROLE_CHANGED", ctx.actor.id, ctx.now, { from, to: role });
        return (0, Result_1.ok)(undefined);
    }
    setExtraPermissions(permissions, ctx) {
        const allowed = this.ensureManageableBy(ctx.actor);
        if (!allowed.ok)
            return allowed;
        if (this.props.role === "ADMIN") {
            return (0, Result_1.fail)((0, errors_1.identityError)("INVALID_STATE", "Administradores já têm acesso total."));
        }
        const invalid = permissions.filter((p) => !access_control_1.PERMISSIONS.includes(p));
        if (invalid.length > 0) {
            return (0, Result_1.fail)((0, errors_1.identityError)("INVALID_PERMISSION", `Permissão desconhecida: ${invalid.join(", ")}.`, { invalid }));
        }
        const actorPermissions = ctx.actor.permissions;
        const beyondActor = permissions.filter((p) => !actorPermissions.includes(p));
        if (beyondActor.length > 0) {
            return (0, Result_1.fail)((0, errors_1.identityError)("ADMIN_REQUIRED", "Não pode atribuir permissões que você próprio não tem.", { beyondActor }));
        }
        const next = access_control_1.PERMISSIONS.filter((p) => permissions.includes(p));
        const added = next.filter((p) => !this.props.extraPermissions.includes(p));
        const removed = this.props.extraPermissions.filter((p) => !next.includes(p));
        if (added.length === 0 && removed.length === 0)
            return (0, Result_1.ok)(undefined);
        this.props.extraPermissions = next;
        this.record("PERMISSIONS_CHANGED", ctx.actor.id, ctx.now, { added, removed });
        return (0, Result_1.ok)(undefined);
    }
    ensureManageableBy(actor) {
        if (actor.id === this.id) {
            return (0, Result_1.fail)((0, errors_1.identityError)("CANNOT_MANAGE_SELF", "Não pode alterar a sua própria conta."));
        }
        if (this.props.role === "ADMIN" && actor.role !== "ADMIN") {
            return (0, Result_1.fail)((0, errors_1.identityError)("ADMIN_REQUIRED", "Só um administrador pode alterar a conta de outro administrador."));
        }
        return (0, Result_1.ok)(undefined);
    }
    record(type, actorId, now, details) {
        this.events.push({ type, subjectId: this.id, actorId, details, occurredAt: now });
    }
    pullEvents() {
        const events = this.events;
        this.events = [];
        return events;
    }
    get id() { return this.props.id; }
    get fullName() { return this.props.fullName; }
    get email() { return this.props.email; }
    get phone() { return this.props.phone; }
    get passwordHash() { return this.props.passwordHash; }
    get role() { return this.props.role; }
    get status() { return this.props.status; }
    get extraPermissions() { return [...this.props.extraPermissions]; }
    get failedLoginAttempts() { return this.props.failedLoginAttempts; }
    get remainingAttempts() { return exports.MAX_FAILED_LOGINS - this.props.failedLoginAttempts; }
    get lockedUntil() { return this.props.lockedUntil; }
    get lastLoginAt() { return this.props.lastLoginAt; }
    get createdAt() { return this.props.createdAt; }
    get isActiveAdmin() { return this.props.role === "ADMIN" && this.props.status === "ACTIVE"; }
    get permissions() {
        return this.props.status === "ACTIVE" ? (0, access_control_1.effectivePermissions)(this.props.role, this.props.extraPermissions) : [];
    }
    can(permission) {
        return this.permissions.includes(permission);
    }
}
exports.StaffMember = StaffMember;
//# sourceMappingURL=StaffMember.js.map