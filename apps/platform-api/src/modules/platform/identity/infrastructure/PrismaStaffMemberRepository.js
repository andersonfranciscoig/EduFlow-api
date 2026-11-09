"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrismaStaffMemberRepository = void 0;
const node_crypto_1 = require("node:crypto");
const access_control_1 = require("../domain/access-control");
const StaffMember_1 = require("../domain/StaffMember");
const EmailAddress_1 = require("../domain/value-objects/EmailAddress");
const FullName_1 = require("../domain/value-objects/FullName");
const PhoneNumber_1 = require("../domain/value-objects/PhoneNumber");
function toDomain(row) {
    const unwrap = (r) => {
        if (!r.ok)
            throw new Error(`Registo inválido em staff_members (${row.id})`);
        return r.value;
    };
    return StaffMember_1.StaffMember.restore({
        id: row.id,
        fullName: unwrap(FullName_1.FullName.create(row.fullName)),
        email: row.email ? unwrap(EmailAddress_1.EmailAddress.create(row.email)) : null,
        phone: row.phone ? unwrap(PhoneNumber_1.PhoneNumber.create(row.phone, "")) : null,
        passwordHash: row.passwordHash,
        role: row.role,
        status: row.status,
        extraPermissions: row.extraPermissions.filter(access_control_1.isPermission),
        failedLoginAttempts: row.failedLoginAttempts,
        lockedUntil: row.lockedUntil,
        lastLoginAt: row.lastLoginAt,
        createdAt: row.createdAt,
    });
}
class PrismaStaffMemberRepository {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    async findById(id) {
        const row = await this.prisma.staffMember.findUnique({ where: { id } });
        return row ? toDomain(row) : null;
    }
    async findByIdentifier(identifier) {
        const row = await this.prisma.staffMember.findUnique({
            where: identifier.kind === "email" ? { email: identifier.value } : { phone: identifier.value },
        });
        return row ? toDomain(row) : null;
    }
    async list(filter = {}) {
        const rows = await this.prisma.staffMember.findMany({
            where: { status: filter.status, role: filter.role },
            orderBy: [{ fullName: "asc" }],
        });
        return rows.map(toDomain);
    }
    count() {
        return this.prisma.staffMember.count();
    }
    countActiveAdmins() {
        return this.prisma.staffMember.count({ where: { role: "ADMIN", status: "ACTIVE" } });
    }
    async save(member) {
        const data = {
            fullName: member.fullName.value,
            email: member.email?.value ?? null,
            phone: member.phone?.value ?? null,
            passwordHash: member.passwordHash,
            role: member.role,
            status: member.status,
            extraPermissions: member.extraPermissions,
            failedLoginAttempts: member.failedLoginAttempts,
            lockedUntil: member.lockedUntil,
            lastLoginAt: member.lastLoginAt,
        };
        const events = member.pullEvents();
        await this.prisma.$transaction([
            this.prisma.staffMember.upsert({
                where: { id: member.id },
                create: { id: member.id, createdAt: member.createdAt, ...data },
                update: data,
            }),
            ...(events.length > 0
                ? [
                    this.prisma.staffActivity.createMany({
                        data: events.map((e) => ({
                            id: (0, node_crypto_1.randomUUID)(),
                            type: e.type,
                            subjectId: e.subjectId,
                            actorId: e.actorId,
                            details: (e.details ?? undefined),
                            occurredAt: e.occurredAt,
                        })),
                    }),
                ]
                : []),
        ]);
    }
}
exports.PrismaStaffMemberRepository = PrismaStaffMemberRepository;
//# sourceMappingURL=PrismaStaffMemberRepository.js.map