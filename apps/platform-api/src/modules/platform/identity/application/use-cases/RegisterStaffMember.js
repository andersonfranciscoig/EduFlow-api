"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RegisterStaffMember = void 0;
const Result_1 = require("../../../../../../../../libs/kernel/src/domain/Result");
const errors_1 = require("../../domain/errors");
const StaffMember_1 = require("../../domain/StaffMember");
const FullName_1 = require("../../domain/value-objects/FullName");
const LoginIdentifier_1 = require("../../domain/value-objects/LoginIdentifier");
const Password_1 = require("../../domain/value-objects/Password");
class RegisterStaffMember {
    members;
    hasher;
    ids;
    clock;
    settings;
    constructor(members, hasher, ids, clock, settings) {
        this.members = members;
        this.hasher = hasher;
        this.ids = ids;
        this.clock = clock;
        this.settings = settings;
    }
    async execute(input) {
        const identifier = (0, LoginIdentifier_1.parseLoginIdentifier)(input.identifier, this.settings.defaultPhoneCountryCode);
        if (!identifier.ok)
            return identifier;
        const fullName = FullName_1.FullName.create(input.fullName);
        if (!fullName.ok)
            return fullName;
        const password = Password_1.PlainPassword.create(input.password);
        if (!password.ok)
            return password;
        if (await this.members.findByIdentifier(identifier.value)) {
            return (0, Result_1.fail)((0, errors_1.identityError)("ACCOUNT_ALREADY_EXISTS", "Já existe uma conta com este identificador. Inicie sessão."));
        }
        const member = StaffMember_1.StaffMember.register({
            id: this.ids.next(),
            fullName: fullName.value,
            identifier: identifier.value,
            passwordHash: await this.hasher.hash(password.value.value),
            isFirstMember: (await this.members.count()) === 0,
            now: this.clock.now(),
        });
        await this.members.save(member);
        return (0, Result_1.ok)({
            principal: { id: member.id, fullName: member.fullName.value, role: member.role },
            role: member.role,
            status: member.status,
        });
    }
}
exports.RegisterStaffMember = RegisterStaffMember;
//# sourceMappingURL=RegisterStaffMember.js.map