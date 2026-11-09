"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthenticateStaffMember = void 0;
const Result_1 = require("../../../../../../../../libs/kernel/src/domain/Result");
const errors_1 = require("../../domain/errors");
const LoginIdentifier_1 = require("../../domain/value-objects/LoginIdentifier");
class AuthenticateStaffMember {
    members;
    hasher;
    clock;
    settings;
    dummyHash;
    constructor(members, hasher, clock, settings) {
        this.members = members;
        this.hasher = hasher;
        this.clock = clock;
        this.settings = settings;
    }
    async execute(input) {
        const invalid = (remaining) => (0, Result_1.fail)((0, errors_1.identityError)("INVALID_CREDENTIALS", remaining !== undefined && remaining <= 2
            ? `Senha incorreta. Restam ${remaining} tentativa${remaining === 1 ? "" : "s"}.`
            : "Senha incorreta. Tente novamente.", { remaining }));
        const identifier = (0, LoginIdentifier_1.parseLoginIdentifier)(input.identifier, this.settings.defaultPhoneCountryCode);
        if (!identifier.ok)
            return invalid();
        const now = this.clock.now();
        const member = await this.members.findByIdentifier(identifier.value);
        if (!member) {
            this.dummyHash ??= this.hasher.hash("eduflow-timing-equalizer");
            await this.hasher.verify(input.password, await this.dummyHash);
            return invalid();
        }
        if (member.isLocked(now)) {
            const minutes = Math.ceil((member.lockedUntil.getTime() - now.getTime()) / 60_000);
            return (0, Result_1.fail)((0, errors_1.identityError)("ACCOUNT_LOCKED", `Demasiadas tentativas. Tente novamente dentro de ${minutes} minuto${minutes === 1 ? "" : "s"}.`, { minutes }));
        }
        const matches = await this.hasher.verify(input.password, member.passwordHash);
        if (!matches) {
            member.recordFailedLogin(now);
            await this.members.save(member);
            if (member.isLocked(now)) {
                return (0, Result_1.fail)((0, errors_1.identityError)("ACCOUNT_LOCKED", "Demasiadas tentativas. A conta foi bloqueada por 15 minutos."));
            }
            return invalid(member.remainingAttempts);
        }
        const allowed = member.ensureCanSignIn();
        if (!allowed.ok)
            return allowed;
        member.recordSuccessfulLogin(now);
        await this.members.save(member);
        return (0, Result_1.ok)({ id: member.id, fullName: member.fullName.value, role: member.role });
    }
}
exports.AuthenticateStaffMember = AuthenticateStaffMember;
//# sourceMappingURL=AuthenticateStaffMember.js.map