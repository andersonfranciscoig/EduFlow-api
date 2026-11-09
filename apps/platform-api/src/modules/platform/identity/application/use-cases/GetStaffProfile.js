"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GetStaffProfile = void 0;
const Result_1 = require("../../../../../../../../libs/kernel/src/domain/Result");
const errors_1 = require("../../domain/errors");
const staff_dto_1 = require("../staff-dto");
class GetStaffProfile {
    members;
    constructor(members) {
        this.members = members;
    }
    async execute(input) {
        const member = await this.members.findById(input.id);
        if (!member || member.status !== "ACTIVE") {
            return (0, Result_1.fail)((0, errors_1.identityError)("ACCOUNT_NOT_FOUND", "Sessão inválida."));
        }
        return (0, Result_1.ok)((0, staff_dto_1.toStaffProfile)(member));
    }
}
exports.GetStaffProfile = GetStaffProfile;
//# sourceMappingURL=GetStaffProfile.js.map