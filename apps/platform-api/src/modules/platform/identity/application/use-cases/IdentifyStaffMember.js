"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IdentifyStaffMember = void 0;
const Result_1 = require("../../../../../../../../libs/kernel/src/domain/Result");
const LoginIdentifier_1 = require("../../domain/value-objects/LoginIdentifier");
class IdentifyStaffMember {
    members;
    settings;
    constructor(members, settings) {
        this.members = members;
        this.settings = settings;
    }
    async execute(input) {
        const identifier = (0, LoginIdentifier_1.parseLoginIdentifier)(input.identifier, this.settings.defaultPhoneCountryCode);
        if (!identifier.ok)
            return identifier;
        const member = await this.members.findByIdentifier(identifier.value);
        return (0, Result_1.ok)({
            exists: member !== null,
            kind: identifier.value.kind,
            normalized: identifier.value.value,
            firstName: member?.fullName.firstName ?? null,
        });
    }
}
exports.IdentifyStaffMember = IdentifyStaffMember;
//# sourceMappingURL=IdentifyStaffMember.js.map