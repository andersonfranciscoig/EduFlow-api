"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.migrateTenant = migrateTenant;
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const MIGRATIONS_DIR = node_path_1.default.resolve("prisma/tenant/migrations");
function statements(sql) {
    return sql
        .split(/;\s*\n/)
        .map((s) => s
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim())
        .filter(Boolean);
}
async function migrateTenant(db) {
    await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "_tenant_migrations" ("name" TEXT PRIMARY KEY, "applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    const applied = new Set((await db.$queryRawUnsafe(`SELECT "name" FROM "_tenant_migrations"`)).map((r) => r.name));
    const pending = (0, node_fs_1.readdirSync)(MIGRATIONS_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !applied.has(d.name))
        .map((d) => d.name)
        .sort();
    for (const name of pending) {
        const sql = (0, node_fs_1.readFileSync)(node_path_1.default.join(MIGRATIONS_DIR, name, "migration.sql"), "utf8");
        await db.$transaction([
            ...statements(sql).map((s) => db.$executeRawUnsafe(s)),
            db.$executeRawUnsafe(`INSERT INTO "_tenant_migrations" ("name") VALUES ($1)`, name),
        ]);
    }
    return pending;
}
//# sourceMappingURL=tenant-migrator.js.map